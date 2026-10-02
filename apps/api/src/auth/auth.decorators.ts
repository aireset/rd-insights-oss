import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from './auth.types';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
export const ADMIN_KEY = 'requireAdmin';
export const RequireAdmin = (): MethodDecorator & ClassDecorator => SetMetadata(ADMIN_KEY, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest<FastifyRequest & { user: AuthUser }>().user;
});
