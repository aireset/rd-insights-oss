import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type UserRole } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import type { InviteAcceptDto, InviteCreateDto } from '@rd/shared';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../common/errors';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { EmailService } from '../auth/email.service';
import { PasswordService } from '../auth/password.service';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_USER_SELECT = { id: true, name: true, email: true, role: true, createdAt: true } as const;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService, private readonly passwords: PasswordService, private readonly email: EmailService, private readonly config: ConfigService<Env, true>) {}

  async listMembers(actor: AuthUser) {
    this.requireAdmin(actor);
    return this.prisma.user.findMany({ where: { accountId: actor.accountId }, select: SAFE_USER_SELECT, orderBy: { createdAt: 'asc' } });
  }

  async listInvites(actor: AuthUser) {
    this.requireAdmin(actor);
    return this.prisma.inviteToken.findMany({ where: { accountId: actor.accountId, usedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, email: true, role: true, expiresAt: true }, orderBy: { createdAt: 'desc' } });
  }

  async createInvite(actor: AuthUser, dto: InviteCreateDto): Promise<{ ok: true }> {
    this.requireAdmin(actor);
    const email = dto.email.trim().toLowerCase();
    if (email === this.config.get('SUPER_ADMIN_EMAIL', { infer: true })) throw new ConflictError('O e-mail do superadministrador não pode ser convidado para uma conta');
    if (await this.prisma.user.findUnique({ where: { email }, select: { id: true } })) throw new ConflictError('Este e-mail já possui acesso');

    const existing = await this.prisma.inviteToken.findUnique({ where: { email } });
    const now = new Date();
    if (existing && existing.accountId !== actor.accountId) throw new ConflictError('Este e-mail já está associado a um convite de outra conta');
    if (existing && existing.usedAt === null && existing.expiresAt > now) throw new ConflictError('Já existe um convite pendente para este e-mail');

    await this.issueInvite(actor, email, dto.role as UserRole, existing?.id);
    this.logger.log(`Invitation sent by user ${actor.id} for account ${actor.accountId}.`);
    return { ok: true };
  }

  async acceptInvite(dto: InviteAcceptDto): Promise<{ ok: true }> {
    const tokenHash = createHash('sha256').update(dto.token).digest('hex');
    const invite = await this.prisma.inviteToken.findUnique({ where: { tokenHash } });
    const now = new Date();
    if (!invite || invite.usedAt || invite.expiresAt <= now) throw new UnauthorizedError('Convite inválido ou expirado');
    const passwordHash = await this.passwords.hash(dto.password);
    try {
      await this.prisma.$transaction(async (tx) => {
        const consumedAt = new Date();
        const consumed = await tx.inviteToken.updateMany({ where: { tokenHash, usedAt: null, expiresAt: { gt: consumedAt } }, data: { usedAt: consumedAt } });
        if (consumed.count !== 1) throw new UnauthorizedError('Convite inválido ou expirado');
        await tx.user.create({ data: { accountId: invite.accountId, email: invite.email, name: dto.name, passwordHash, role: invite.role } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictError('Este e-mail já possui acesso');
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') throw new UnauthorizedError('Convite inválido ou expirado');
      throw error;
    }
    return { ok: true };
  }

  async updateRole(actor: AuthUser, userId: string, role: UserRole): Promise<{ ok: true }> {
    const target = await this.prisma.user.findFirst({ where: { id: userId, accountId: actor.accountId }, select: { id: true, role: true } });
    if (!target) throw new NotFoundError();
    this.requireAdmin(actor);
    if (target.role === 'admin' && role === 'viewer') {
      try {
        await this.prisma.$transaction(async (tx) => {
          const admins = await tx.user.count({ where: { accountId: actor.accountId, role: 'admin' } });
          if (admins <= 1) throw new ConflictError('A conta precisa manter pelo menos um administrador');
          const result = await tx.user.updateMany({ where: { id: userId, accountId: actor.accountId, role: 'admin' }, data: { role } });
          if (result.count !== 1) throw new ConflictError('O papel do usuário foi alterado por outra operação');
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') throw new ConflictError('A conta precisa manter pelo menos um administrador');
        throw error;
      }
    } else {
      const result = await this.prisma.user.updateMany({ where: { id: userId, accountId: actor.accountId }, data: { role } });
      if (result.count !== 1) throw new NotFoundError();
    }
    this.logger.log(`Role changed by user ${actor.id} for user ${userId} in account ${actor.accountId}.`);
    return { ok: true };
  }

  /** Gera token novo (hash sha256, 7 dias), grava e envia o e-mail; sem entrega o convite é invalidado. */
  private async issueInvite(actor: AuthUser, email: string, role: UserRole, existingId?: string): Promise<void> {
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const data = { accountId: actor.accountId, email, role, tokenHash, expiresAt: new Date(Date.now() + INVITE_TTL_MS), usedAt: null, createdById: actor.id };
    try {
      if (existingId) await this.prisma.inviteToken.update({ where: { id: existingId }, data });
      else await this.prisma.inviteToken.create({ data });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictError('Já existe um convite ou usuário com este e-mail');
      throw error;
    }
    const acceptUrl = new URL('/aceitar-convite', this.config.get('APP_URL', { infer: true }));
    acceptUrl.hash = rawToken;
    const sent = await this.email.send({ to: email, subject: 'Convite para o RD Insights', text: `Você recebeu um convite para acessar o RD Insights com o papel ${role}. O link expira em sete dias:\n\n${acceptUrl.toString()}\n\nSe não esperava este convite, ignore esta mensagem.` });
    if (!sent) {
      await this.prisma.inviteToken.updateMany({ where: { tokenHash, usedAt: null }, data: { usedAt: new Date() } });
      throw new ServiceUnavailableException('Não foi possível enviar o convite. Verifique a configuração de e-mail.');
    }
  }

  async resendInvite(actor: AuthUser, inviteId: string): Promise<{ ok: true }> {
    this.requireAdmin(actor);
    const invite = await this.prisma.inviteToken.findFirst({ where: { id: inviteId, accountId: actor.accountId, usedAt: null } });
    if (!invite) throw new NotFoundError();
    await this.issueInvite(actor, invite.email, invite.role, invite.id);
    this.logger.log(`Invitation resent by user ${actor.id} for account ${actor.accountId}.`);
    return { ok: true };
  }

  async cancelInvite(actor: AuthUser, inviteId: string): Promise<{ ok: true }> {
    this.requireAdmin(actor);
    const result = await this.prisma.inviteToken.deleteMany({ where: { id: inviteId, accountId: actor.accountId, usedAt: null } });
    if (result.count !== 1) throw new NotFoundError();
    return { ok: true };
  }

  async removeUser(actor: AuthUser, userId: string): Promise<{ ok: true }> {
    this.requireAdmin(actor);
    const target = await this.prisma.user.findFirst({ where: { id: userId, accountId: actor.accountId }, select: { id: true, role: true } });
    if (!target) throw new NotFoundError();
    if (target.id === actor.id) throw new ConflictError('Você não pode remover a si mesmo');
    try {
      await this.prisma.$transaction(async (tx) => {
        if (target.role === 'admin' && await tx.user.count({ where: { accountId: actor.accountId, role: 'admin' } }) <= 1) throw new ConflictError('A conta precisa manter pelo menos um administrador');
        // convites criados por ele referenciam o usuário (FK sem cascade)
        await tx.inviteToken.deleteMany({ where: { accountId: actor.accountId, createdById: userId } });
        const result = await tx.user.deleteMany({ where: { id: userId, accountId: actor.accountId } });
        if (result.count !== 1) throw new NotFoundError();
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') throw new ConflictError('A operação conflitou com outra alteração; tente novamente');
      throw error;
    }
    this.logger.log(`User ${userId} removed by ${actor.id} in account ${actor.accountId}.`);
    return { ok: true };
  }

  private requireAdmin(actor: AuthUser): void {
    if (actor.role !== 'admin') throw new ForbiddenError('Só administradores podem gerenciar usuários');
  }
}
