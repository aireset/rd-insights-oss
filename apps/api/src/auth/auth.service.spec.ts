import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import type { Env } from '../config/env.schema';
import type { PrismaService } from '../prisma/prisma.service';
import type { TokenService } from './token.service';
import { createHash } from 'node:crypto';

function make(env: Partial<Env> = {}) {
  const users = new Map<string, { id: string; accountId: string; name: string; email: string; passwordHash: string; role: 'admin'; isSuperAdmin: boolean; passwordResetRequestedAt: Date | null; account: { name: string } }>();
  let seq = 0;
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    $queryRaw: vi.fn(async () => []),
    account: { create: vi.fn(async ({ data }: { data: { name: string } }) => ({ id: 'acc-1', name: data.name })) },
    user: {
      count: vi.fn(async () => users.size),
      findUnique: vi.fn(async ({ where }: { where: { email?: string; id?: string } }) => [...users.values()].find((u) => u.email === where.email || u.id === where.id) ?? null),
      create: vi.fn(async ({ data }: { data: { accountId: string; name: string; email: string; passwordHash: string; isSuperAdmin?: boolean } }) => { const u = { id: `u-${++seq}`, role: 'admin' as const, isSuperAdmin: false, passwordResetRequestedAt: null, account: { name: 'Acme' }, ...data }; users.set(u.id, u); return u; }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<{ isSuperAdmin: boolean; lastLoginAt: Date; passwordHash: string }> }) => { const u = users.get(where.id)!; Object.assign(u, data); return u; }),
      updateMany: vi.fn(async ({ where, data }: { where: { email: string; OR: [{ passwordResetRequestedAt: null }, { passwordResetRequestedAt: { lte: Date } }] }; data: { passwordResetRequestedAt: Date } }) => {
        const u = [...users.values()].find((candidate) => candidate.email === where.email);
        if (!u) return { count: 0 };
        if (u.passwordResetRequestedAt !== null && u.passwordResetRequestedAt > where.OR[1].passwordResetRequestedAt.lte) return { count: 0 };
        u.passwordResetRequestedAt = data.passwordResetRequestedAt;
        return { count: 1 };
      }),
    },
    passwordResetToken: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async ({ data }: { data: { userId: string; tokenHash: string; expiresAt: Date } }) => ({ id: 'reset-1', usedAt: null, ...data })),
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    userTwoFactor: { findUnique: vi.fn(async () => null) },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 1 })) },
  } as unknown as PrismaService;
  const tokens = { signAccess: vi.fn(() => 'access'), issueRefresh: vi.fn(async () => 'refresh'), rotateRefresh: vi.fn(), revoke: vi.fn() } as unknown as TokenService;
  const config = { get: (key: keyof Env) => (env as Record<string, unknown>)[key] } as unknown as ConfigService<Env, true>;
  const mail = { isConfigured: vi.fn(() => true), logUnavailable: vi.fn(), send: vi.fn(async () => true) };
  return { svc: new AuthService(prisma, new PasswordService(), tokens, config, mail as never), prisma, mail };
}

async function flushResetJobs(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('AuthService', () => {
  it('register cria conta + admin com senha em argon2 e devolve sessão', async () => {
    const { svc, prisma } = make();
    const r = await svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    expect(r.accessToken).toBe('access');
    expect(r.user).toMatchObject({ email: 'ana@acme.com', role: 'admin', accountId: 'acc-1' });
    const created = (prisma.user.create as ReturnType<typeof vi.fn>).mock.calls[0]![0].data;
    expect(created.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('login com senha errada → 401 sem revelar se o e-mail existe', async () => {
    const { svc } = make();
    await svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    await expect(svc.login({ email: 'ana@acme.com', password: 'errada-errada' })).rejects.toThrow('E-mail ou senha inválidos');
    await expect(svc.login({ email: 'ninguem@acme.com', password: 'x' })).rejects.toThrow('E-mail ou senha inválidos');
  });

  it('registro fechado com usuário existente e e-mail comum → Forbidden', async () => {
    const { svc } = make({ REGISTRATION_OPEN: false });
    await svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    await expect(svc.register({ accountName: 'Beta', name: 'Bia', email: 'bia@beta.com', password: 'senha-forte-10' })).rejects.toThrow('Cadastro fechado');
  });

  it('e-mail do super admin passa mesmo com registro fechado e sai com isSuperAdmin: true', async () => {
    const { svc } = make({ REGISTRATION_OPEN: false, SUPER_ADMIN_EMAIL: 'owner@example.com' });
    await svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    const r = await svc.register({ accountName: 'Dono', name: 'Dono', email: 'owner@example.com', password: 'senha-forte-10' });
    expect(r.user.isSuperAdmin).toBe(true);
  });

  it('primeiro usuário (count 0) passa mesmo com registro fechado', async () => {
    const { svc } = make({ REGISTRATION_OPEN: false });
    const r = await svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    expect(r.user.email).toBe('ana@acme.com');
  });

  it('solicitação de reset tem mesma resposta para endereço cadastrado e ausente', async () => {
    const { svc } = make({ APP_URL: 'https://rd.example', NODE_ENV: 'test' });
    await svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    const known = await svc.requestPasswordReset({ email: 'ana@acme.com' });
    const unknown = await svc.requestPasswordReset({ email: 'ninguem@acme.com' });
    expect(known).toEqual(unknown);
    await flushResetJobs();
  });

  it('faz lookup e claim do cooldown na mesma transação para endereços presentes e ausentes', async () => {
    const known = make({ APP_URL: 'https://rd.example', NODE_ENV: 'test' });
    const unknown = make({ APP_URL: 'https://rd.example', NODE_ENV: 'test' });
    await known.svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    (known.prisma.$transaction as ReturnType<typeof vi.fn>).mockClear();
    (known.prisma.user.findUnique as ReturnType<typeof vi.fn>).mockClear();
    await known.svc.requestPasswordReset({ email: 'ana@acme.com' });
    await unknown.svc.requestPasswordReset({ email: 'ninguem@acme.com' });
    await flushResetJobs();
    expect(known.prisma.$transaction).toHaveBeenCalledOnce();
    expect(unknown.prisma.$transaction).toHaveBeenCalledOnce();
    expect(known.prisma.user.findUnique).toHaveBeenCalledOnce();
    expect(unknown.prisma.user.findUnique).toHaveBeenCalledOnce();
    expect(known.prisma.user.updateMany).toHaveBeenCalledOnce();
    expect(unknown.prisma.user.updateMany).toHaveBeenCalledOnce();
  });

  it('responde antes do job e só então processa a conta existente', async () => {
    const known = make({ APP_URL: 'https://rd.example', NODE_ENV: 'test' });
    const unknown = make({ APP_URL: 'https://rd.example', NODE_ENV: 'test' });
    await known.svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    const jobs: Array<() => Promise<void>> = [];
    const schedule = vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
      jobs.push(callback as unknown as () => Promise<void>);
      return {} as NodeJS.Immediate;
    });
    try {
      const knownController = new AuthController(known.svc, {} as never, {} as never);
      const unknownController = new AuthController(unknown.svc, {} as never, {} as never);
      const knownResponse = knownController.requestPasswordReset({ email: 'ana@acme.com' });
      const unknownResponse = unknownController.requestPasswordReset({ email: 'ninguem@acme.com' });
      expect(knownResponse).toEqual(unknownResponse);
      expect(knownResponse).toEqual({ message: 'Se o endereço estiver cadastrado, você receberá instruções para redefinir a senha.' });
      expect(known.prisma.user.findUnique).not.toHaveBeenCalled();
      expect(unknown.prisma.user.findUnique).not.toHaveBeenCalled();
      expect(known.prisma.passwordResetToken.create).not.toHaveBeenCalled();
      expect(known.mail.send).not.toHaveBeenCalled();
      expect(jobs).toHaveLength(2);

      await jobs[0]!();
      expect(known.prisma.passwordResetToken.create).toHaveBeenCalledOnce();
      await jobs[1]!();
      expect(unknown.prisma.passwordResetToken.create).not.toHaveBeenCalled();
    } finally {
      schedule.mockRestore();
    }
  });

  it('limita solicitações concorrentes e bloqueia novo envio durante 60 segundos', async () => {
    const { svc, prisma, mail } = make({ APP_URL: 'https://rd.example', NODE_ENV: 'test' });
    await svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    await Promise.all([
      svc.requestPasswordReset({ email: 'ana@acme.com' }),
      svc.requestPasswordReset({ email: 'ana@acme.com' }),
    ]);
    await svc.requestPasswordReset({ email: 'ana@acme.com' });
    await flushResetJobs();
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(3);
    expect(prisma.passwordResetToken.create).toHaveBeenCalledTimes(1);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it('responde sem aguardar promessa SMTP pendente', async () => {
    const { svc, mail } = make({ APP_URL: 'https://rd.example', NODE_ENV: 'test' });
    await svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    (mail.send as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => undefined));
    const jobs: Array<() => Promise<void>> = [];
    const schedule = vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
      jobs.push(callback as unknown as () => Promise<void>);
      return {} as NodeJS.Immediate;
    });
    try {
      expect(svc.requestPasswordReset({ email: 'ana@acme.com' })).toEqual({ message: 'Se o endereço estiver cadastrado, você receberá instruções para redefinir a senha.' });
      await jobs[0]!();
      expect(mail.send).toHaveBeenCalledOnce();
    } finally {
      schedule.mockRestore();
    }
  });

  it('guarda apenas hash do token aleatório e link vai pelo mailer', async () => {
    const { svc, prisma, mail } = make({ APP_URL: 'https://rd.example', NODE_ENV: 'test' });
    await svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    await svc.requestPasswordReset({ email: 'ana@acme.com' });
    await flushResetJobs();
    const tokenData = (prisma.passwordResetToken.create as ReturnType<typeof vi.fn>).mock.calls[0]![0].data;
    const sentText = (mail.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].text as string;
    const sentUrl = /https:\/\/rd\.example\/redefinir-senha#[A-Za-z0-9_-]+/.exec(sentText)?.[0] ?? '';
    const raw = new URL(sentUrl).hash.slice(1);
    expect(raw.length).toBeGreaterThan(40);
    expect(tokenData.tokenHash).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(tokenData.tokenHash).not.toContain(raw);
    expect(tokenData.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(tokenData.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });

  it('sem SMTP mantém a resposta genérica, gera o token, não envia e descarta o token', async () => {
    const { svc, prisma, mail } = make({ APP_URL: 'https://rd.example', NODE_ENV: 'production' });
    (mail.send as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    const response = await svc.requestPasswordReset({ email: 'ana@acme.com' });
    const unknown = await svc.requestPasswordReset({ email: 'ninguém@acme.com' });
    await flushResetJobs();
    expect(response.message).toMatch(/Se o endereço estiver cadastrado/);
    expect(response).toEqual(unknown);
    expect(mail.send).toHaveBeenCalledOnce();
    expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalled();
  });

  it('authConfig informa se o SMTP está configurado', async () => {
    const { svc, mail } = make({ NODE_ENV: 'production' });
    (mail.isConfigured as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(await svc.authConfig()).toMatchObject({ smtpConfigured: false });
    (mail.isConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    expect(await svc.authConfig()).toMatchObject({ smtpConfigured: true });
  });

  it('falha de entrega remove token pendente e mantém resposta genérica', async () => {
    const { svc, prisma, mail } = make({ APP_URL: 'https://rd.example', NODE_ENV: 'test' });
    (mail.send as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    const response = await svc.requestPasswordReset({ email: 'ana@acme.com' });
    await flushResetJobs();
    expect(response.message).toMatch(/Se o endereço estiver cadastrado/);
    expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tokenHash: expect.any(String) }) }));
  });

  it('redefinição consome token uma vez, muda hash e revoga sessões refresh', async () => {
    const { svc, prisma } = make({ APP_URL: 'https://rd.example', NODE_ENV: 'test' });
    (prisma.passwordResetToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'reset-1', userId: 'u-1', tokenHash: createHash('sha256').update('token-valido').digest('hex'), expiresAt: new Date(Date.now() + 60_000), usedAt: null });
    (prisma.passwordResetToken.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await svc.register({ accountName: 'Acme', name: 'Ana', email: 'ana@acme.com', password: 'senha-forte-10' });
    await svc.resetPassword({ token: 'token-valido', password: 'senha-nova-forte' });
    await expect(svc.resetPassword({ token: 'token-valido', password: 'outra-senha-forte' })).rejects.toThrow('Link inválido ou expirado');
    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tokenHash: createHash('sha256').update('token-valido').digest('hex'), usedAt: null, expiresAt: { gt: expect.any(Date) } }) }));
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u-1' }, data: { passwordHash: expect.stringMatching(/^\$argon2id\$/) } }));
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { userId: 'u-1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    await expect(svc.login({ email: 'ana@acme.com', password: 'senha-nova-forte' })).resolves.toMatchObject({ user: { email: 'ana@acme.com' } });
    await expect(svc.login({ email: 'ana@acme.com', password: 'senha-forte-10' })).rejects.toThrow('E-mail ou senha inválidos');
  });

  it('rejeita token expirado ou já usado sem mudar senha nem sessões', async () => {
    const { svc, prisma } = make({ APP_URL: 'https://rd.example', NODE_ENV: 'test' });
    (prisma.passwordResetToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'reset-1', userId: 'u-1', tokenHash: createHash('sha256').update('token-invalido').digest('hex'), expiresAt: new Date(Date.now() - 60_000), usedAt: null });
    (prisma.passwordResetToken.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    await expect(svc.resetPassword({ token: 'token-invalido', password: 'senha-nova-forte' })).rejects.toThrow('Link inválido ou expirado');
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });
});
