import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TokenService } from '../auth/token.service';
import { PrismaService } from '../prisma/prisma.service';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { RdWebhookController } from './rd-webhook.controller';
import { RdWebhookService } from './rd-webhook.service';
import { RdWebhookJobsService } from './rd-webhook-jobs.service';
import { RdWebhookSubscriptionsService } from './rd-webhook-subscriptions.service';

describe('webhook HTTP authorization and IP throttling', () => {
  let app: NestFastifyApplication;
  const receive = vi.fn().mockResolvedValue({ accepted: true });
  const register = vi.fn().mockResolvedValue(undefined);
  const retry = vi.fn().mockResolvedValue(undefined);
  const status = vi.fn().mockResolvedValue({ pending: 0 });
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }])],
      controllers: [RdWebhookController],
      providers: [
        { provide: RdWebhookService, useValue: { receive } },
        { provide: RdWebhookJobsService, useValue: { retry, status } },
        { provide: RdWebhookSubscriptionsService, useValue: { register } },
        { provide: TokenService, useValue: { verifyAccess: (token: string) => ({ sub: token }) } },
        { provide: PrismaService, useValue: { user: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, role: where.id === 'admin' ? 'admin' : 'viewer', accountId: 'session-account', account: { name: 'Fixture' } }) } } },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => { await app?.close(); });
  it('keeps status private and register/retry admin-only, scoped to authenticated account', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/rd/webhooks/status' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/rd/webhooks/register', headers: { authorization: 'Bearer viewer' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/rd/webhooks/retry/log-id', headers: { authorization: 'Bearer viewer' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/rd/webhooks/retry/log-id', headers: { authorization: 'Bearer admin' } })).statusCode).toBe(204);
    expect(retry).toHaveBeenCalledWith('session-account', 'log-id');
    expect((await app.inject({ method: 'POST', url: '/api/rd/webhooks/register', headers: { authorization: 'Bearer admin' } })).statusCode).toBe(204);
    expect(register).toHaveBeenCalledWith('session-account');
  });
  it('serves a public authenticated callback quickly and throttles by IP across secret guesses', async () => {
    const start = Date.now();
    const response = await app.inject({ method: 'POST', url: '/api/rd/webhooks/account/secret', payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
    expect(Date.now() - start).toBeLessThan(5_000);
    for (let i = 0; i < 299; i++) await app.inject({ method: 'POST', url: `/api/rd/webhooks/account/guess-${i}`, payload: {} });
    expect((await app.inject({ method: 'POST', url: '/api/rd/webhooks/account/another-secret', payload: {} })).statusCode).toBe(429);
    expect(receive).toHaveBeenCalledTimes(300);
  });
});
