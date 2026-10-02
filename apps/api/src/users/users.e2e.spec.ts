import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { EMAIL_TRANSPORT } from '../auth/email.service';
import { PasswordService } from '../auth/password.service';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from '../auth/token.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'invitations-integration-test-secret';
process.env.APP_URL = 'https://invites.test';
process.env.REGISTRATION_OPEN = 'false';
process.env.SMTP_HOST = 'smtp.mock.test';
process.env.SMTP_FROM = 'no-reply@invites.test';

describe.skipIf(!databaseUrl)('user invitation HTTP integration (TEST_DATABASE_URL must be disposable)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let accountId: string;
  let foreignAccountId: string;
  let adminId: string;
  let foreignAdminId: string;
  let backupAdminId: string;
  let adminToken: string;
  let foreignAdminToken: string;
  let invitationEmail: { sendMail: ReturnType<typeof vi.fn> };
  let inviteeEmail: string;

  beforeAll(async () => {
    if (!databaseUrl || !/(?:test|disposable)/i.test(new URL(databaseUrl).pathname)) throw new Error('TEST_DATABASE_URL precisa apontar para um banco descartável com nome contendo test ou disposable');
    const testId = randomUUID();
    inviteeEmail = `new-${testId}@invites.test`;
    invitationEmail = { sendMail: vi.fn(async () => ({ accepted: ['new@a.test'] })) };
    const { AppModule } = await import('../app.module');
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_TRANSPORT).useValue(invitationEmail)
      .compile();
    app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    const a = await prisma.account.create({ data: { name: 'Invitation A' } });
    const b = await prisma.account.create({ data: { name: 'Invitation B' } });
    accountId = a.id; foreignAccountId = b.id;
    const hash = await new PasswordService().hash('admin-password-10');
    const admin = await prisma.user.create({ data: { accountId, email: `admin-a-${testId}@invites.test`, name: 'Admin A', passwordHash: hash, role: 'admin' } });
    const backup = await prisma.user.create({ data: { accountId, email: `backup-a-${testId}@invites.test`, name: 'Backup A', passwordHash: hash, role: 'admin' } });
    const foreign = await prisma.user.create({ data: { accountId: foreignAccountId, email: `admin-b-${testId}@invites.test`, name: 'Admin B', passwordHash: hash, role: 'admin' } });
    adminId = admin.id; backupAdminId = backup.id; foreignAdminId = foreign.id;
    const tokens = app.get(TokenService);
    adminToken = tokens.signAccess({ sub: admin.id, accountId, role: 'admin' });
    foreignAdminToken = tokens.signAccess({ sub: foreign.id, accountId: foreignAccountId, role: 'admin' });
  }, 30_000);

  afterAll(async () => { await app?.close(); });

  it('sends, accepts once, scopes membership, preserves the last admin, and keeps registration closed', async () => {
    const adminHeaders = { authorization: `Bearer ${adminToken}` };
    const created = await app.inject({ method: 'POST', url: '/api/users/invitations', headers: adminHeaders, payload: { email: inviteeEmail, role: 'viewer' } });
    expect(created.statusCode).toBe(201);
    expect(invitationEmail.sendMail).toHaveBeenCalledOnce();
    const sentText = invitationEmail.sendMail.mock.calls[0]![0].text as string;
    const rawToken = /https:\/\/invites\.test\/aceitar-convite#([A-Za-z0-9_-]+)/.exec(sentText)?.[1];
    expect(rawToken).toBeTruthy();

    const pending = await app.inject({ method: 'GET', url: '/api/users/invitations', headers: adminHeaders });
    expect(pending.json()).toMatchObject([{ email: inviteeEmail, role: 'viewer' }]);
    expect(JSON.stringify(pending.json())).not.toContain(rawToken);

    const accepted = await app.inject({ method: 'POST', url: '/api/users/invitations/accept', payload: { token: rawToken, name: 'New User', password: 'new-user-password-10' } });
    expect(accepted.statusCode).toBe(201);
    const newUser = await prisma.user.findUniqueOrThrow({ where: { email: inviteeEmail } });
    expect(newUser).toMatchObject({ accountId, role: 'viewer' });
    const viewerToken = app.get(TokenService).signAccess({ sub: newUser.id, accountId, role: 'viewer' });
    const viewerHeaders = { authorization: `Bearer ${viewerToken}` };
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: viewerHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/users/invitations', headers: viewerHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${foreignAdminId}/role`, headers: viewerHeaders, payload: { role: 'viewer' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/users/invitations/accept', payload: { token: rawToken, name: 'Another User', password: 'another-password-10' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/register', payload: { accountName: 'New', name: 'New', email: 'public@invites.test', password: 'public-password-10' } })).statusCode).toBe(403);

    const duplicate = await app.inject({ method: 'POST', url: '/api/users/invitations', headers: adminHeaders, payload: { email: (await prisma.user.findUniqueOrThrow({ where: { id: foreignAdminId } })).email, role: 'admin' } });
    expect(duplicate.statusCode).toBe(409);
    const foreignList = await app.inject({ method: 'GET', url: '/api/users', headers: foreignAdminToken ? { authorization: `Bearer ${foreignAdminToken}` } : {} });
    expect(foreignList.statusCode).toBe(200);
    expect(foreignList.json().map((m: { email: string }) => m.email)).toEqual([(await prisma.user.findUniqueOrThrow({ where: { id: foreignAdminId } })).email]);
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${backupAdminId}/role`, headers: adminHeaders, payload: { role: 'viewer' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${adminId}/role`, headers: adminHeaders, payload: { role: 'viewer' } })).statusCode).toBe(409);

    const raceEmail = `race-${randomUUID()}@invites.test`;
    const raceInvite = await app.inject({ method: 'POST', url: '/api/users/invitations', headers: adminHeaders, payload: { email: raceEmail, role: 'viewer' } });
    expect(raceInvite.statusCode).toBe(201);
    const raceText = invitationEmail.sendMail.mock.calls[1]![0].text as string;
    const raceToken = /https:\/\/invites\.test\/aceitar-convite#([A-Za-z0-9_-]+)/.exec(raceText)?.[1];
    const hash = await new PasswordService().hash('existing-user-password-10');
    await prisma.user.create({ data: { accountId: foreignAccountId, email: raceEmail, name: 'Existing User', passwordHash: hash, role: 'admin' } });
    expect((await app.inject({ method: 'POST', url: '/api/users/invitations/accept', payload: { token: raceToken, name: 'Duplicate', password: 'duplicate-password-10' } })).statusCode).toBe(409);

    const concurrentEmail = `concurrent-${randomUUID()}@invites.test`;
    expect((await app.inject({ method: 'POST', url: '/api/users/invitations', headers: adminHeaders, payload: { email: concurrentEmail, role: 'viewer' } })).statusCode).toBe(201);
    const concurrentText = invitationEmail.sendMail.mock.calls.at(-1)![0].text as string;
    const concurrentToken = /https:\/\/invites\.test\/aceitar-convite#([A-Za-z0-9_-]+)/.exec(concurrentText)?.[1];
    const accepts = await Promise.all([
      app.inject({ method: 'POST', url: '/api/users/invitations/accept', payload: { token: concurrentToken, name: 'Concurrent One', password: 'concurrent-password-10' } }),
      app.inject({ method: 'POST', url: '/api/users/invitations/accept', payload: { token: concurrentToken, name: 'Concurrent Two', password: 'concurrent-password-10' } }),
    ]);
    expect(accepts.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(accepts.filter((response) => response.statusCode === 401)).toHaveLength(1);
    expect(await prisma.user.count({ where: { email: concurrentEmail } })).toBe(1);

    const concurrencyAccount = await prisma.account.create({ data: { name: `Last admin ${randomUUID()}` } });
    const concurrencyHash = await new PasswordService().hash('concurrent-admin-password-10');
    const firstAdmin = await prisma.user.create({ data: { accountId: concurrencyAccount.id, email: `first-${randomUUID()}@invites.test`, name: 'First Admin', passwordHash: concurrencyHash, role: 'admin' } });
    const secondAdmin = await prisma.user.create({ data: { accountId: concurrencyAccount.id, email: `second-${randomUUID()}@invites.test`, name: 'Second Admin', passwordHash: concurrencyHash, role: 'admin' } });
    const concurrentTokenService = app.get(TokenService);
    const demotions = await Promise.all([
      app.inject({ method: 'PATCH', url: `/api/users/${firstAdmin.id}/role`, headers: { authorization: `Bearer ${concurrentTokenService.signAccess({ sub: firstAdmin.id, accountId: concurrencyAccount.id, role: 'admin' })}` }, payload: { role: 'viewer' } }),
      app.inject({ method: 'PATCH', url: `/api/users/${secondAdmin.id}/role`, headers: { authorization: `Bearer ${concurrentTokenService.signAccess({ sub: secondAdmin.id, accountId: concurrencyAccount.id, role: 'admin' })}` }, payload: { role: 'viewer' } }),
    ]);
    expect(demotions.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(demotions.filter((response) => response.statusCode === 409)).toHaveLength(1);
    expect(await prisma.user.count({ where: { accountId: concurrencyAccount.id, role: 'admin' } })).toBe(1);
  });

  it('reenvia/cancela convite e remove usuário só dentro da própria conta, sem remover a si nem o último admin', async () => {
    const testId = randomUUID();
    const hash = await new PasswordService().hash('manage-password-10');
    const mk = (a: string, role: 'admin' | 'viewer', tag: string) => prisma.user.create({ data: { accountId: a, email: `${tag}-${testId}@invites.test`, name: tag, passwordHash: hash, role } });
    const acc = await prisma.account.create({ data: { name: `Manage ${testId}` } });
    const other = await prisma.account.create({ data: { name: `Other ${testId}` } });
    const [boss, member, stranger] = await Promise.all([mk(acc.id, 'admin', 'boss'), mk(acc.id, 'viewer', 'member'), mk(other.id, 'admin', 'stranger')]);
    const tokens = app.get(TokenService);
    const h = (u: { id: string }, a: string, role: 'admin' | 'viewer') => ({ authorization: `Bearer ${tokens.signAccess({ sub: u.id, accountId: a, role })}` });
    const bossH = h(boss, acc.id, 'admin');
    const strangerH = h(stranger, other.id, 'admin');

    const email = `pend-${testId}@invites.test`;
    expect((await app.inject({ method: 'POST', url: '/api/users/invitations', headers: bossH, payload: { email, role: 'viewer' } })).statusCode).toBe(201);
    const invite = await prisma.inviteToken.findUniqueOrThrow({ where: { email } });
    expect((await app.inject({ method: 'POST', url: `/api/users/invitations/${invite.id}/resend`, headers: strangerH })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/users/invitations/${invite.id}`, headers: strangerH })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/users/invitations/${invite.id}/resend`, headers: bossH })).statusCode).toBe(200);
    expect((await prisma.inviteToken.findUniqueOrThrow({ where: { email } })).tokenHash).not.toBe(invite.tokenHash);
    expect((await app.inject({ method: 'DELETE', url: `/api/users/invitations/${invite.id}`, headers: bossH })).statusCode).toBe(200);
    expect(await prisma.inviteToken.count({ where: { email } })).toBe(0);

    expect((await app.inject({ method: 'DELETE', url: `/api/users/${member.id}`, headers: h(member, acc.id, 'viewer') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/users/${member.id}`, headers: strangerH })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/users/${boss.id}`, headers: bossH })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/users/${member.id}`, headers: bossH })).statusCode).toBe(200);
    expect(await prisma.user.count({ where: { accountId: acc.id } })).toBe(1);
    expect(await prisma.user.count({ where: { id: stranger.id } })).toBe(1);
  });
});
