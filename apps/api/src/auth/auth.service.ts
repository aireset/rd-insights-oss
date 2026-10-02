import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthConfig, AuthResponse, LoginDto, PasswordResetDto, PasswordResetRequestDto, PasswordResetRequestResponse, RegisterDto, SessionUser } from '@rd/shared';
import { ConflictError, ForbiddenError, UnauthorizedError } from '../common/errors';
import { decryptSecret, encryptSecret, secretsKeyConfigured } from '../common/crypto-secrets';
import type { Env } from '../config/env.schema';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from './email.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { lockUserSession } from './user-session-lock';
import { createRecoveryCodes, createTotpSecret, hashRecoveryCode, matchingTotpStep } from './totp';
import type { AuthUser } from './auth.types';

export interface AuthResult extends AuthResponse { refresh: string }
export interface LoginChallenge { twoFactorRequired: true; challengeToken: string }
type UserRow = { id: string; name: string; email: string; role: 'admin' | 'viewer'; accountId: string; isSuperAdmin: boolean; account: { name: string } };
const PASSWORD_RESET_RESPONSE: PasswordResetRequestResponse = { message: 'Se o endereço estiver cadastrado, você receberá instruções para redefinir a senha.' };
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const PASSWORD_RESET_COOLDOWN_MS = 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly prisma: PrismaService, private readonly passwords: PasswordService, private readonly tokens: TokenService, private readonly config: ConfigService<Env, true>, private readonly email: EmailService) {}

  private view(u: UserRow): SessionUser { return { id: u.id, name: u.name, email: u.email, role: u.role, accountId: u.accountId, accountName: u.account.name, isSuperAdmin: u.isSuperAdmin }; }

  private async session(u: UserRow): Promise<AuthResult> {
    return { accessToken: this.tokens.signAccess({ sub: u.id, accountId: u.accountId, role: u.role }), refresh: await this.tokens.issueRefresh(u.id), user: this.view(u) };
  }

  private get superAdminEmail(): string | undefined { return this.config.get('SUPER_ADMIN_EMAIL', { infer: true }); }

  async register(dto: RegisterDto): Promise<AuthResult> {
    const registrationOpen = this.config.get('REGISTRATION_OPEN', { infer: true });
    const isSuperAdminEmail = dto.email === this.superAdminEmail;
    const isFirstUser = (await this.prisma.user.count()) === 0;
    if (!registrationOpen && !isFirstUser && !isSuperAdminEmail) throw new ForbiddenError('Cadastro fechado. Peça acesso ao administrador.');
    const passwordHash = await this.passwords.hash(dto.password);
    const user = await this.prisma.$transaction(async (tx) => {
      const account = await tx.account.create({ data: { name: dto.accountName } });
      return tx.user.create({ data: { accountId: account.id, name: dto.name, email: dto.email, passwordHash, role: 'admin', isSuperAdmin: isSuperAdminEmail }, include: { account: { select: { name: true } } } });
    });
    return this.session(user as UserRow);
  }

  async login(dto: LoginDto): Promise<AuthResult | LoginChallenge> {
    let user = await this.prisma.user.findUnique({ where: { email: dto.email }, include: { account: { select: { name: true } } } });
    // Mesma mensagem nos dois casos: não revela se o e-mail existe.
    if (!user || !(await this.passwords.verify(user.passwordHash, dto.password))) throw new UnauthorizedError('E-mail ou senha inválidos');
    if (user.email === this.superAdminEmail && !user.isSuperAdmin) {
      user = await this.prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: true }, include: { account: { select: { name: true } } } });
    }
    const requiresTwoFactor = await this.prisma.$transaction(async (tx) => {
      await lockUserSession(tx, user.id);
      const factor = await tx.userTwoFactor.findUnique({ where: { userId_accountId: { userId: user.id, accountId: user.accountId } } });
      if (factor?.enabledAt) return true;
      await tx.user.update({ where: { id: user.id, accountId: user.accountId }, data: { lastLoginAt: new Date() } });
      return false;
    });
    if (requiresTwoFactor) return { twoFactorRequired: true, challengeToken: this.tokens.signTwoFactorChallenge({ sub: user.id, accountId: user.accountId }) };
    return this.session(user as UserRow);
  }

  async verifyTwoFactorChallenge(dto: { challengeToken: string; code: string }): Promise<AuthResult> {
    const challenge = this.tokens.verifyTwoFactorChallenge(dto.challengeToken);
    const user = await this.prisma.user.findUnique({ where: { id: challenge.sub, accountId: challenge.accountId }, include: { account: { select: { name: true } } } });
    if (!user) throw new UnauthorizedError('Código inválido ou expirado');
    await this.prisma.$transaction(async (tx) => {
      await lockUserSession(tx, user.id);
      const factor = await tx.userTwoFactor.findUnique({ where: { userId_accountId: { userId: user.id, accountId: user.accountId } } });
      if (!factor?.enabledAt || factor.accountId !== user.accountId) throw new UnauthorizedError('Código inválido ou expirado');
      await this.consumeFactorCode(tx, factor, dto.code);
    });
    await this.prisma.user.update({ where: { id: user.id, accountId: user.accountId }, data: { lastLoginAt: new Date() } });
    return this.session(user as UserRow);
  }

  async twoFactorStatus(user: Pick<AuthUser, 'id' | 'accountId'>): Promise<{ enabled: boolean; recoveryCodesRemaining: number }> {
    const factor = await this.prisma.userTwoFactor.findFirst({ where: { accountId: user.accountId, userId: user.id, enabledAt: { not: null } }, select: { userId: true } });
    if (!factor) return { enabled: false, recoveryCodesRemaining: 0 };
    return { enabled: true, recoveryCodesRemaining: await this.prisma.userTwoFactorRecoveryCode.count({ where: { accountId: user.accountId, userId: user.id } }) };
  }

  async setupTwoFactor(user: Pick<AuthUser, 'id' | 'accountId' | 'email'>, password: string): Promise<{ secret: string; otpauthUri: string }> {
    if (!secretsKeyConfigured()) throw new ConflictError('A proteção de segredos precisa estar configurada antes de ativar 2FA.');
    const row = await this.prisma.user.findUnique({ where: { id: user.id, accountId: user.accountId }, select: { passwordHash: true } });
    if (!row || !(await this.passwords.verify(row.passwordHash, password))) throw new UnauthorizedError('Senha inválida');
    const secret = createTotpSecret();
    await this.prisma.$transaction(async (tx) => {
      await lockUserSession(tx, user.id);
      const existing = await tx.userTwoFactor.findUnique({ where: { userId_accountId: { userId: user.id, accountId: user.accountId } } });
      if (existing?.enabledAt) throw new ConflictError('Desative a verificação em duas etapas antes de configurar novamente.');
      await tx.userTwoFactor.upsert({
        where: { userId_accountId: { userId: user.id, accountId: user.accountId } },
        create: { accountId: user.accountId, userId: user.id, secret: encryptSecret(secret) },
        update: { accountId: user.accountId, secret: encryptSecret(secret), enabledAt: null, lastUsedStep: null },
      });
      await tx.userTwoFactorRecoveryCode.deleteMany({ where: { accountId: user.accountId, userId: user.id } });
    });
    const issuer = 'RD Insights';
    return { secret, otpauthUri: `otpauth://totp/${encodeURIComponent(`${issuer}:${user.email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30` };
  }

  async enableTwoFactor(user: Pick<AuthUser, 'id' | 'accountId'>, code: string): Promise<{ recoveryCodes: string[] }> {
    const codes = createRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await lockUserSession(tx, user.id);
      const factor = await tx.userTwoFactor.findUnique({ where: { userId_accountId: { userId: user.id, accountId: user.accountId } } });
      if (!factor || factor.accountId !== user.accountId || factor.enabledAt) throw new UnauthorizedError('Configuração 2FA inválida');
      const step = matchingTotpStep(decryptSecret(factor.secret), code);
      if (step === null) throw new UnauthorizedError('Código inválido ou expirado');
      const changed = await tx.userTwoFactor.updateMany({ where: { userId: user.id, accountId: user.accountId, enabledAt: null }, data: { enabledAt: new Date(), lastUsedStep: BigInt(step) } });
      if (changed.count !== 1) throw new UnauthorizedError('Configuração 2FA inválida');
      await tx.userTwoFactorRecoveryCode.createMany({ data: codes.map((c) => ({ accountId: user.accountId, userId: user.id, codeHash: hashRecoveryCode(c) })) });
      await tx.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    return { recoveryCodes: codes };
  }

  private async consumeFactorCode(tx: Prisma.TransactionClient, factor: { id: string; accountId: string; userId: string; secret: string; lastUsedStep: bigint | null }, code: string): Promise<void> {
    if (/^\d{6}$/.test(code)) {
      const step = matchingTotpStep(decryptSecret(factor.secret), code, Date.now(), Number(factor.lastUsedStep ?? -1n));
      if (step === null) throw new UnauthorizedError('Código inválido ou expirado');
      await tx.userTwoFactor.update({ where: { id: factor.id, accountId: factor.accountId }, data: { lastUsedStep: BigInt(step) } });
      return;
    }
    const used = await tx.userTwoFactorRecoveryCode.deleteMany({ where: { accountId: factor.accountId, userId: factor.userId, codeHash: hashRecoveryCode(code) } });
    if (used.count !== 1) throw new UnauthorizedError('Código inválido ou expirado');
  }

  async disableTwoFactor(user: Pick<AuthUser, 'id' | 'accountId'>, dto: { password: string; code: string }): Promise<void> {
    const row = await this.prisma.user.findUnique({ where: { id: user.id, accountId: user.accountId }, select: { passwordHash: true } });
    if (!row || !(await this.passwords.verify(row.passwordHash, dto.password))) throw new UnauthorizedError('Senha inválida');
    await this.prisma.$transaction(async (tx) => {
      await lockUserSession(tx, user.id);
      const factor = await tx.userTwoFactor.findUnique({ where: { userId_accountId: { userId: user.id, accountId: user.accountId } } });
      if (!factor || factor.accountId !== user.accountId || !factor.enabledAt) throw new ConflictError('A verificação em duas etapas não está ativa.');
      await this.consumeFactorCode(tx, factor, dto.code);
      await tx.userTwoFactor.deleteMany({ where: { accountId: user.accountId, userId: user.id } });
    });
  }

  async regenerateRecoveryCodes(user: Pick<AuthUser, 'id' | 'accountId'>, dto: { password: string; code: string }): Promise<{ recoveryCodes: string[] }> {
    const row = await this.prisma.user.findUnique({ where: { id: user.id, accountId: user.accountId }, select: { passwordHash: true } });
    if (!row || !(await this.passwords.verify(row.passwordHash, dto.password))) throw new UnauthorizedError('Senha inválida');
    const codes = createRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await lockUserSession(tx, user.id);
      const factor = await tx.userTwoFactor.findUnique({ where: { userId_accountId: { userId: user.id, accountId: user.accountId } } });
      if (!factor || factor.accountId !== user.accountId || !factor.enabledAt) throw new ConflictError('A verificação em duas etapas não está ativa.');
      await this.consumeFactorCode(tx, factor, dto.code);
      await tx.userTwoFactorRecoveryCode.deleteMany({ where: { accountId: user.accountId, userId: user.id } });
      await tx.userTwoFactorRecoveryCode.createMany({ data: codes.map((c) => ({ accountId: user.accountId, userId: user.id, codeHash: hashRecoveryCode(c) })) });
    });
    return { recoveryCodes: codes };
  }

  requestPasswordReset(dto: PasswordResetRequestDto): PasswordResetRequestResponse {
    // ponytail: setImmediate work can be lost on crash; add a durable outbox if resets must survive restarts.
    setImmediate(() => this.processPasswordResetRequest(dto));
    return PASSWORD_RESET_RESPONSE;
  }

  private async processPasswordResetRequest(dto: PasswordResetRequestDto): Promise<void> {
    try {

      const reset = await this.prisma.$transaction(async (tx) => {
        const requestedAt = new Date();
        const user = await tx.user.findUnique({ where: { email: dto.email } });
        const claimed = await tx.user.updateMany({
          where: {
            email: dto.email,
            OR: [
              { passwordResetRequestedAt: null },
              { passwordResetRequestedAt: { lte: new Date(requestedAt.getTime() - PASSWORD_RESET_COOLDOWN_MS) } },
            ],
          },
          data: { passwordResetRequestedAt: requestedAt },
        });
        if (!user || claimed.count !== 1) return null;

        const rawToken = randomBytes(32).toString('base64url');
        const tokenHash = createHash('sha256').update(rawToken).digest('hex');
        await tx.passwordResetToken.deleteMany({ where: { userId: user.id } });
        await tx.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt: new Date(requestedAt.getTime() + PASSWORD_RESET_TTL_MS) } });
        return { email: user.email, rawToken, tokenHash };
      });
      if (!reset) return;

      const resetUrl = new URL('/redefinir-senha', this.config.get('APP_URL', { infer: true }));
      resetUrl.hash = reset.rawToken;
      void this.email.send({
        to: reset.email,
        subject: 'Redefina sua senha do RD Insights',
        text: `Foi solicitada a redefinição de senha da sua conta. Acesse este link em até uma hora:\n\n${resetUrl.toString()}\n\nSe você não pediu a redefinição, ignore esta mensagem.`,
      }).then((sent) => {
        if (!sent) return this.prisma.passwordResetToken.deleteMany({ where: { tokenHash: reset.tokenHash } });
      }).catch(async () => {
        await this.prisma.passwordResetToken.deleteMany({ where: { tokenHash: reset.tokenHash } }).catch(() => undefined);
        this.logger.warn('Password reset email failed; recipient and token are redacted.');
      });
    } catch {
      this.logger.warn('Password reset request failed; recipient and token are redacted.');
    }
  }

  async resetPassword(dto: PasswordResetDto): Promise<void> {
    const tokenHash = createHash('sha256').update(dto.token).digest('hex');
    const passwordHash = await this.passwords.hash(dto.password);
    await this.prisma.$transaction(async (tx) => {
      const candidate = await tx.passwordResetToken.findUnique({ where: { tokenHash } });
      if (!candidate) throw new UnauthorizedError('Link inválido ou expirado');
      await lockUserSession(tx, candidate.userId);
      const token = await tx.passwordResetToken.findUnique({ where: { tokenHash } });
      const now = new Date();
      if (!token || token.userId !== candidate.userId || token.usedAt || token.expiresAt <= now) throw new UnauthorizedError('Link inválido ou expirado');
      const consumed = await tx.passwordResetToken.updateMany({
        where: { tokenHash, userId: token.userId, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) throw new UnauthorizedError('Link inválido ou expirado');
      await tx.user.update({ where: { id: token.userId }, data: { passwordHash } });
      await tx.refreshToken.updateMany({ where: { userId: token.userId, revokedAt: null }, data: { revokedAt: now } });
    });
  }

  async refresh(raw: string): Promise<AuthResult> {
    const { userId, refresh } = await this.tokens.rotateRefresh(raw);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { account: { select: { name: true } } } });
    if (!user) throw new UnauthorizedError('Sessão inválida');
    return { accessToken: this.tokens.signAccess({ sub: user.id, accountId: user.accountId, role: user.role }), refresh, user: this.view(user as UserRow) };
  }

  logout(raw: string | undefined): Promise<void> { return this.tokens.revoke(raw); }

  async authConfig(): Promise<AuthConfig> {
    const registrationOpen = this.config.get('REGISTRATION_OPEN', { infer: true }) || (await this.prisma.user.count()) === 0;
    return { registrationOpen, smtpConfigured: this.email.isConfigured() };
  }
}
