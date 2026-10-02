import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports each dependency and readiness failure without payload details', async () => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const jobs = { readiness: vi.fn().mockResolvedValue({ redis: 'down', worker: 'stopped' }) };
    const reply = { status: vi.fn().mockReturnThis() };
    const controller = Reflect.construct(HealthController, [prisma, jobs]) as HealthController;

    const result = await Reflect.apply(controller.get, controller, [reply]);

    expect(result).toEqual({ ok: false, db: 'up', redis: 'down', worker: 'stopped' });
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(result)).not.toContain('account-1');
  });
});
