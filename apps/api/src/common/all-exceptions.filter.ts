import { Catch, HttpException, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

type ReplyWithSendFile = FastifyReply & { sendFile?: (path: string) => unknown };
interface ErrorBody { statusCode: number; code: string; message: string; errors?: Array<{ path: string; message: string }>; details?: Record<string, unknown> }

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<ReplyWithSendFile>();
    const req = http.getRequest<FastifyRequest>();
    const body = this.toBody(exception);
    // SPA fallback: GET fora de /api com a API servindo o front → index.html.
    if (body.statusCode === 404 && req.method === 'GET' && !req.url.startsWith('/api') && typeof reply.sendFile === 'function') {
      void reply.type('text/html').sendFile('index.html');
      return;
    }
    if (body.statusCode >= 500) this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    void reply.status(body.statusCode).send(body);
  }

  toBody(exception: unknown): ErrorBody {
    if (exception instanceof ThrottlerException) return { statusCode: 429, code: 'RATE_LIMITED', message: 'Muitas tentativas seguidas. Aguarde um minuto.' };
    if (exception instanceof ZodError) return { statusCode: 422, code: 'VALIDATION', message: 'Dados inválidos', errors: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2025') return { statusCode: 404, code: 'NOT_FOUND', message: 'Recurso não encontrado' };
      if (exception.code === 'P2002') return { statusCode: 409, code: 'CONFLICT', message: 'Registro duplicado' };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') return { statusCode: status, code: 'ERROR', message: res };
      const r = res as { message?: string | string[]; code?: string; details?: Record<string, unknown> };
      return { statusCode: status, code: r.code ?? 'ERROR', message: Array.isArray(r.message) ? r.message.join('; ') : (r.message ?? 'Erro'), ...(r.details ? { details: r.details } : {}) };
    }
    return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, code: 'INTERNAL', message: 'Erro interno' };
  }
}
