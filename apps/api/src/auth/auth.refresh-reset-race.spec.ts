import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

describe('refresh/reset serialization', () => {
  it('does not leave a refresh token active when refresh overlaps password reset', async () => {
    const user = { id: 'user-1', accountId: 'account-1', name: 'Ana', email: 'ana@example.test', passwordHash: 'old-hash', role: 'admin' as const, isSuperAdmin: false, account: { name: 'Acme' } };
    const reset = { id: 'reset-1', userId: user.id, tokenHash: createHash('sha256').update('reset-token').digest('hex'), expiresAt: new Date(Date.now() + 60_000), usedAt: null as Date | null };
    const refreshRows: Array<{ id: string; userId: string; tokenHash: string; expiresAt: Date; revokedAt: Date | null }> = [];
    type RefreshWhere = { id?: string; userId?: string; tokenHash?: string; revokedAt?: Date | null; expiresAt?: { gt: Date } };
    const lockTails = new Map<string, Promise<void>>();
    let holdNextCreate = false;
    let signalCreate!: () => void;
    let resumeCreate!: () => void;
    let createEntered = Promise.resolve();
    let createGate = Promise.resolve();

    async function acquireUserLock(userId: string): Promise<() => void> {
      const previous = lockTails.get(userId) ?? Promise.resolve();
      let unlock!: () => void;
      const current = new Promise<void>((resolve) => { unlock = resolve; });
      const tail = previous.then(() => current);
      lockTails.set(userId, tail);
      await previous;
      return () => { unlock(); if (lockTails.get(userId) === tail) lockTails.delete(userId); };
    }

    const prisma = {
      user: {
        findUnique: vi.fn(async ({ where }: { where: { id?: string } }) => where.id === user.id ? user : null),
        update: vi.fn(async ({ data }: { data: { passwordHash: string } }) => Object.assign(user, data)),
      },
      passwordResetToken: {
        findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => where.tokenHash === reset.tokenHash ? reset : null),
        updateMany: vi.fn(async ({ where, data }: { where: { tokenHash: string; expiresAt: { gt: Date } }; data: { usedAt: Date } }) => {
          if (where.tokenHash !== reset.tokenHash || reset.usedAt || reset.expiresAt <= where.expiresAt.gt) return { count: 0 };
          Object.assign(reset, data);
          return { count: 1 };
        }),
      },
      refreshToken: {
        create: vi.fn(async ({ data }: { data: { userId: string; tokenHash: string; expiresAt: Date } }) => {
          if (holdNextCreate) {
            holdNextCreate = false;
            signalCreate();
            await createGate;
          }
          const row = { id: `refresh-${refreshRows.length + 1}`, revokedAt: null, ...data };
          refreshRows.push(row);
          return row;
        }),
        findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => refreshRows.find((row) => row.tokenHash === where.tokenHash) ?? null),
        updateMany: vi.fn(async ({ where, data }: { where: RefreshWhere; data: { revokedAt: Date } }) => {
          const rows = refreshRows.filter((row) => (!where.id || row.id === where.id) && (!where.tokenHash || row.tokenHash === where.tokenHash) && (!where.userId || row.userId === where.userId) && (!('revokedAt' in where) || row.revokedAt === where.revokedAt) && (!where.expiresAt || row.expiresAt > where.expiresAt.gt));
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        }),
      },
      $queryRaw: vi.fn(async () => []),
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const releases: Array<() => void> = [];
      const tx = Object.create(prisma);
      tx.$queryRaw = async (query: { values: unknown[] }) => {
        releases.push(await acquireUserLock(String(query.values[0])));
        return [{ id: user.id }];
      };
      try { return await fn(tx); }
      finally { releases.reverse().forEach((release) => release()); }
      },
    };

    const config = { get: (key: keyof Env) => ({ JWT_ACCESS_SECRET: 'test-secret-long-enough', JWT_REFRESH_TTL: '7d', NODE_ENV: 'test' })[key] } as unknown as ConfigService<Env, true>;
    const passwords = { hash: vi.fn(async () => 'new-password-hash') } as never;
    const tokens = new TokenService({ sign: () => 'access' } as never, config, prisma as PrismaService);
    const auth = new AuthService(prisma as PrismaService, passwords, tokens, config, {} as never);
    const oldRefresh = await tokens.issueRefresh(user.id);

    holdNextCreate = true;
    createEntered = new Promise<void>((resolve) => { signalCreate = resolve; });
    createGate = new Promise<void>((resolve) => { resumeCreate = resolve; });
    const rotating = tokens.rotateRefresh(oldRefresh);
    await createEntered;

    let resetFinished = false;
    const resetting = auth.resetPassword({ token: 'reset-token', password: 'new-password-valid' }).finally(() => { resetFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const wasSerialized = !resetFinished;
    resumeCreate();
    await Promise.all([rotating, resetting]);

    expect(wasSerialized).toBe(true);
    expect(refreshRows.filter((row) => row.revokedAt === null)).toHaveLength(0);
    expect(user.passwordHash).toBe('new-password-hash');
  });
});
