import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import type { PrismaService } from '../prisma/prisma.service';
import type { EmailService } from '../auth/email.service';
import { PasswordService } from '../auth/password.service';
import { UsersService } from './users.service';
import type { AuthUser } from '../auth/auth.types';

const admin: AuthUser = { id: 'admin-a', name: 'Admin A', email: 'admin@a.test', role: 'admin', accountId: 'a', accountName: 'A', isSuperAdmin: false };
const viewer: AuthUser = { ...admin, id: 'viewer-a', role: 'viewer' };
type MockMember = { id: string; accountId: string; name: string; email: string; role: 'admin' | 'viewer'; isSuperAdmin: boolean; createdAt: Date; passwordHash?: string };
type MockInvite = { id: string; accountId: string; email: string; role: 'admin' | 'viewer'; tokenHash: string; expiresAt: Date; usedAt: Date | null; createdById: string };

function setup() {
  const invitations = new Map<string, MockInvite>();
  const members = new Map<string, MockMember>([
    ['admin-a', { id: 'admin-a', accountId: 'a', name: 'Admin A', email: 'admin@a.test', role: 'admin', isSuperAdmin: false, createdAt: new Date() }],
    ['viewer-a', { id: 'viewer-a', accountId: 'a', name: 'Viewer A', email: 'viewer@a.test', role: 'viewer', isSuperAdmin: false, createdAt: new Date() }],
    ['admin-b', { id: 'admin-b', accountId: 'b', name: 'Admin B', email: 'admin@b.test', role: 'admin', isSuperAdmin: false, createdAt: new Date() }],
  ]);
  const user = {
    findUnique: vi.fn(async ({ where }: { where: { email?: string; id?: string } }) => [...members.values()].find((u) => (where.email && u.email === where.email) || (where.id && u.id === where.id)) ?? null),
    findFirst: vi.fn(async ({ where }: { where: { id: string; accountId: string } }) => [...members.values()].find((u) => u.id === where.id && u.accountId === where.accountId) ?? null),
    findMany: vi.fn(async ({ where }: { where: { accountId: string } }) => [...members.values()].filter((u) => u.accountId === where.accountId)),
    count: vi.fn(async ({ where }: { where: { accountId: string; role?: 'admin' | 'viewer' } }) => [...members.values()].filter((u) => u.accountId === where.accountId && (!where.role || u.role === where.role)).length),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; accountId: string; role?: 'admin' | 'viewer' }; data: Partial<MockMember> }) => { const u = members.get(where.id); if (!u || u.accountId !== where.accountId || (where.role && u.role !== where.role)) return { count: 0 }; Object.assign(u, data); return { count: 1 }; }),
    create: vi.fn(async ({ data }: { data: Omit<MockMember, 'id' | 'isSuperAdmin' | 'createdAt'> }) => { const user: MockMember = { id: `user-${members.size}`, isSuperAdmin: false, createdAt: new Date(), ...data }; members.set(user.id, user); return user; }),
    deleteMany: vi.fn(async ({ where }: { where: { id: string; accountId: string } }) => { const u = members.get(where.id); if (!u || u.accountId !== where.accountId) return { count: 0 }; members.delete(where.id); return { count: 1 }; }),
  };
  const inviteToken = {
    findFirst: vi.fn(async ({ where }: { where: { id: string; accountId: string; usedAt: null } }) => [...invitations.values()].find((i) => i.id === where.id && i.accountId === where.accountId && !i.usedAt) ?? null),
    deleteMany: vi.fn(async ({ where }: { where: { id?: string; accountId: string; usedAt?: null; createdById?: string } }) => { let count = 0; for (const [k, i] of invitations) if (i.accountId === where.accountId && (!where.id || i.id === where.id) && (!where.createdById || i.createdById === where.createdById) && (where.usedAt === undefined || !i.usedAt)) { invitations.delete(k); count++; } return { count }; }),
    findUnique: vi.fn(async ({ where }: { where: { email?: string; tokenHash?: string } }) => [...invitations.values()].find((i) => (where.email && i.email === where.email) || (where.tokenHash && i.tokenHash === where.tokenHash)) ?? null),
    findMany: vi.fn(async ({ where }: { where: { accountId: string; usedAt: null; expiresAt: { gt: Date } } }) => [...invitations.values()].filter((i) => i.accountId === where.accountId && !i.usedAt && i.expiresAt > where.expiresAt.gt)),
    create: vi.fn(async ({ data }: { data: Omit<MockInvite, 'id' | 'usedAt'> }) => { const i: MockInvite = { id: `invite-${invitations.size}`, usedAt: null, ...data }; invitations.set(i.email, i); return i; }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<MockInvite> }) => { const i = [...invitations.values()].find((x) => x.id === where.id)!; Object.assign(i, data); return i; }),
    updateMany: vi.fn(async ({ where, data }: { where: { tokenHash: string; usedAt: null; expiresAt?: { gt: Date } }; data: Partial<MockInvite> }) => { const i = [...invitations.values()].find((x) => x.tokenHash === where.tokenHash && !x.usedAt && (!where.expiresAt || x.expiresAt > where.expiresAt.gt)); if (!i) return { count: 0 }; Object.assign(i, data); return { count: 1 }; }),
  };
  const fakeTx = { user, inviteToken };
  const prisma = { ...fakeTx, $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(fakeTx)) } as unknown as PrismaService;
  const email = { send: vi.fn(async () => true) } as unknown as EmailService;
  const config = { get: (key: keyof Env) => key === 'APP_URL' ? 'https://rd.example' : undefined } as unknown as ConfigService<Env, true>;
  const passwords = new PasswordService();
  const service = new UsersService(prisma, passwords, email, config);
  return { service, prisma, email, passwords, invitations, members };
}

describe('UsersService', () => {
  it('admin envia convite hash-only com conta/papel e prazo, usando EmailService', async () => {
    const { service, prisma, email } = setup();
    await service.createInvite(admin, { email: 'new@a.test', role: 'viewer' });
    const create = (prisma.inviteToken.create as ReturnType<typeof vi.fn>).mock.calls[0]![0].data;
    const text = (email.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].text as string;
    const token = /aceitar-convite#([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';
    expect(token.length).toBeGreaterThan(40);
    expect(create).toMatchObject({ email: 'new@a.test', role: 'viewer', accountId: 'a', createdById: admin.id });
    expect(create.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(create.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('não cria convite para e-mail já cadastrado globalmente', async () => {
    const { service, prisma } = setup();
    await expect(service.createInvite(admin, { email: 'admin@b.test', role: 'viewer' })).rejects.toThrow('já possui acesso');
    expect(prisma.inviteToken.create).not.toHaveBeenCalled();
  });

  it('invalida convite que o EmailService não conseguiu entregar', async () => {
    const { service, email, invitations } = setup();
    (email.send as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(service.createInvite(admin, { email: 'undelivered@a.test', role: 'viewer' })).rejects.toThrow('Não foi possível enviar o convite');
    expect(invitations.get('undelivered@a.test')?.usedAt).toBeInstanceOf(Date);
  });

  it('aceita convite uma única vez e cria usuário na conta e papel indicados', async () => {
    const { service, prisma, invitations } = setup();
    const token = 't'.repeat(48);
    const hash = createHash('sha256').update(token).digest('hex');
    const invite = { id: 'i-1', email: 'new@a.test', accountId: 'a', role: 'viewer', tokenHash: hash, usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    (prisma.inviteToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(invite);
    invitations.set(invite.email, invite);
    await service.acceptInvite({ token, name: 'New User', password: 'senha-segura-10' });
    expect(prisma.user.create).toHaveBeenCalledWith({ data: expect.objectContaining({ accountId: 'a', email: 'new@a.test', role: 'viewer', passwordHash: expect.stringMatching(/^\$argon2id\$/) }) });
    expect(prisma.inviteToken.updateMany).toHaveBeenCalledWith({ where: { tokenHash: hash, usedAt: null, expiresAt: { gt: expect.any(Date) } }, data: { usedAt: expect.any(Date) } });
  });

  it('nega convite expirado ou consumido sem criar usuário', async () => {
    const { service, prisma } = setup();
    (prisma.inviteToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'i-1', email: 'new@a.test', accountId: 'a', role: 'viewer', usedAt: new Date(), expiresAt: new Date(Date.now() - 1) });
    await expect(service.acceptInvite({ token: 'x'.repeat(40), name: 'New User', password: 'senha-segura-10' })).rejects.toThrow('inválido ou expirado');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('recusa aceite se o convite expira enquanto a senha está sendo hashada', async () => {
    vi.useFakeTimers();
    const expiresAt = new Date('2026-09-28T20:00:00.000Z');
    vi.setSystemTime(new Date(expiresAt.getTime() - 1));
    try {
      const { service, prisma, passwords, invitations } = setup();
      const token = 'e'.repeat(48);
      const hash = createHash('sha256').update(token).digest('hex');
      const invite = { id: 'i-expiring', email: 'expiring@a.test', accountId: 'a', role: 'viewer' as const, tokenHash: hash, usedAt: null, expiresAt };
      (prisma.inviteToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(invite);
      invitations.set(invite.email, invite);
      vi.spyOn(passwords, 'hash').mockImplementation(async () => {
        vi.setSystemTime(expiresAt);
        return 'hashed-password';
      });

      await expect(service.acceptInvite({ token, name: 'New User', password: 'senha-segura-10' })).rejects.toThrow('inválido ou expirado');
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.inviteToken.updateMany).toHaveBeenCalledWith({ where: { tokenHash: hash, usedAt: null, expiresAt: { gt: expiresAt } }, data: { usedAt: expiresAt } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lista e altera apenas membros da conta; usuário estrangeiro resulta em 404', async () => {
    const { service, prisma } = setup();
    const members = await service.listMembers(admin);
    expect(members.map((u: { id: string }) => u.id)).toEqual(['admin-a', 'viewer-a']);
    await expect(service.updateRole(viewer, 'admin-b', 'viewer')).rejects.toMatchObject({ status: 404 });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('admin muda papel na própria conta; viewer não consegue alterar nem o próprio usuário', async () => {
    const { service, prisma } = setup();
    await service.updateRole(admin, 'viewer-a', 'admin');
    expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id: 'viewer-a', accountId: 'a' }, data: { role: 'admin' } });
    await expect(service.updateRole(viewer, 'viewer-a', 'admin')).rejects.toMatchObject({ status: 403 });
  });

  it('reenvia convite com token novo e cancela; convite de outra conta é 404', async () => {
    const { service, email, invitations } = setup();
    await service.createInvite(admin, { email: 'new@a.test', role: 'viewer' });
    const first = invitations.get('new@a.test')!;
    const oldHash = first.tokenHash;
    await service.resendInvite(admin, first.id);
    expect(invitations.get('new@a.test')!.tokenHash).not.toBe(oldHash);
    expect(email.send).toHaveBeenCalledTimes(2);
    await expect(service.resendInvite({ ...admin, accountId: 'b', id: 'admin-b' }, first.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.cancelInvite({ ...admin, accountId: 'b', id: 'admin-b' }, first.id)).rejects.toMatchObject({ status: 404 });
    await service.cancelInvite(admin, first.id);
    expect(invitations.size).toBe(0);
    await expect(service.cancelInvite(viewer, first.id)).rejects.toMatchObject({ status: 403 });
  });

  it('remove usuário da conta; não remove a si mesmo, o último admin, viewer-actor ou usuário de outra conta', async () => {
    const { service, members } = setup();
    await expect(service.removeUser(admin, 'admin-a')).rejects.toThrow('a si mesmo');
    await expect(service.removeUser(viewer, 'admin-a')).rejects.toMatchObject({ status: 403 });
    await expect(service.removeUser(admin, 'admin-b')).rejects.toMatchObject({ status: 404 });
    await service.removeUser(admin, 'viewer-a');
    expect(members.has('viewer-a')).toBe(false);
    // actor admin de sessão antiga (já sem registro) tentando remover o único admin: a guarda de último admin barra
    await expect(service.removeUser({ ...admin, id: 'ghost' }, 'admin-a')).rejects.toThrow('pelo menos um administrador');
  });

  it('impede rebaixar o último admin da conta', async () => {
    const { service, prisma, members } = setup();
    members.delete('viewer-a');
    await expect(service.updateRole(admin, 'admin-a', 'viewer')).rejects.toThrow('pelo menos um administrador');
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});
