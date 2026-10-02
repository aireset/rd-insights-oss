import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { ADMIN_KEY, IS_PUBLIC_KEY } from './auth.decorators';
import type { AuthUser } from './auth.types';
import { TokenService } from './token.service';

/** Fail-closed: toda rota exige Bearer, salvo @Public(). @RequireAdmin() exige role admin. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly tokens: TokenService, private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: AuthUser }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError();
    const payload = this.tokens.verifyAccess(header.slice(7));
    if (payload.purpose) throw new UnauthorizedError('Sessão inválida');
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, include: { account: { select: { name: true } } } });
    if (!user) throw new UnauthorizedError('Sessão inválida');
    req.user = { id: user.id, name: user.name, email: user.email, role: user.role, accountId: user.accountId, accountName: user.account.name, isSuperAdmin: user.isSuperAdmin };
    if (this.reflector.getAllAndOverride<boolean>(ADMIN_KEY, targets) && user.role !== 'admin') throw new ForbiddenError('Só administradores');
    return true;
  }
}
