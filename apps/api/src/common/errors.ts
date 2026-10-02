import { HttpException, HttpStatus } from '@nestjs/common';

export class AppError extends HttpException {
  constructor(message: string, status: HttpStatus, code: string, details?: Record<string, unknown>) {
    super(details ? { message, code, details } : { message, code }, status);
  }
}
export class NotFoundError extends AppError { constructor(m = 'Recurso não encontrado') { super(m, HttpStatus.NOT_FOUND, 'NOT_FOUND'); } }
export class ConflictError extends AppError { constructor(m = 'Conflito de estado', d?: Record<string, unknown>) { super(m, HttpStatus.CONFLICT, 'CONFLICT', d); } }
export class ForbiddenError extends AppError { constructor(m = 'Acesso negado') { super(m, HttpStatus.FORBIDDEN, 'FORBIDDEN'); } }
export class UnauthorizedError extends AppError { constructor(m = 'Não autenticado') { super(m, HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED'); } }
export class BusinessError extends AppError { constructor(m: string) { super(m, HttpStatus.UNPROCESSABLE_ENTITY, 'BUSINESS_RULE'); } }
/** Falha do RD (401 após refresh, 5xx, rede) — 502 sem vazar corpo/URL. */
export class RdProviderError extends AppError { constructor(m: string, readonly providerStatus?: number) { super(m, HttpStatus.BAD_GATEWAY, 'RD_PROVIDER_ERROR'); } }
