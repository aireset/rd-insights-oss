import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Prisma } from '@prisma/client';
import { UnauthorizedError } from '../common/errors';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from './auth.types';
import { lockUserSession } from './user-session-lock';

function durationToMs(v: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(v.trim());
  if (!m) throw new Error(`Duração inválida: ${v}`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService, private readonly config: ConfigService<Env, true>, private readonly prisma: PrismaService) {}

  signAccess(p: JwtPayload): string {
    return this.jwt.sign(p, { secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }), expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }) });
  }
  signTwoFactorChallenge(p: Pick<JwtPayload, 'sub' | 'accountId'>): string {
    return this.jwt.sign({ ...p, role: 'viewer', purpose: 'totp-challenge' }, { secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }), expiresIn: '5m' });
  }
  verifyTwoFactorChallenge(token: string): Pick<JwtPayload, 'sub' | 'accountId'> {
    try {
      const p = this.jwt.verify<JwtPayload>(token, { secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }) });
      if (p.purpose !== 'totp-challenge' || !p.sub || !p.accountId) throw new Error();
      return { sub: p.sub, accountId: p.accountId };
    } catch { throw new UnauthorizedError('Desafio 2FA inválido ou expirado'); }
  }
  verifyAccess(token: string): JwtPayload {
    try { return this.jwt.verify<JwtPayload>(token, { secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }) }); }
    catch { throw new UnauthorizedError('Token inválido ou expirado'); }
  }
  refreshMaxAgeMs(): number { return durationToMs(this.config.get('JWT_REFRESH_TTL', { infer: true })); }
  private hash(raw: string): string { return createHash('sha256').update(raw).digest('hex'); }

  private async createRefresh(tx: Pick<Prisma.TransactionClient, 'refreshToken'>, userId: string): Promise<string> {
    const raw = randomBytes(48).toString('hex');
    await tx.refreshToken.create({ data: { userId, tokenHash: this.hash(raw), expiresAt: new Date(Date.now() + this.refreshMaxAgeMs()) } });
    return raw;
  }

  issueRefresh(userId: string): Promise<string> { return this.createRefresh(this.prisma, userId); }

  /** Rotação: revoga o atual e emite novo; reuso de token revogado derruba a família toda. */
  async rotateRefresh(raw: string): Promise<{ userId: string; refresh: string }> {
    const tokenHash = this.hash(raw);
    const result = await this.prisma.$transaction(async (tx) => {
      const candidate = await tx.refreshToken.findUnique({ where: { tokenHash } });
      if (!candidate || candidate.expiresAt < new Date()) throw new UnauthorizedError('Sessão expirada');
      await lockUserSession(tx, candidate.userId);
      const existing = await tx.refreshToken.findUnique({ where: { tokenHash } });
      if (!existing || existing.userId !== candidate.userId || existing.expiresAt < new Date()) throw new UnauthorizedError('Sessão expirada');
      if (existing.revokedAt) {
        await tx.refreshToken.updateMany({ where: { userId: existing.userId, revokedAt: null }, data: { revokedAt: new Date() } });
        return null;
      }
      const now = new Date();
      const res = await tx.refreshToken.updateMany({ where: { id: existing.id, revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now } });
      if (res.count !== 1) throw new UnauthorizedError('Sessão inválida');
      return { userId: existing.userId, refresh: await this.createRefresh(tx, existing.userId) };
    });
    if (!result) throw new UnauthorizedError('Sessão inválida');
    return result;
  }

  async revoke(raw: string | undefined): Promise<void> {
    if (!raw) return;
    await this.prisma.refreshToken.updateMany({ where: { tokenHash: this.hash(raw), revokedAt: null }, data: { revokedAt: new Date() } });
  }
}
