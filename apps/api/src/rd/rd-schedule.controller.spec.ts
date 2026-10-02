import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ADMIN_KEY } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { RdScheduleController } from './rd-schedule.controller';

describe('RdScheduleController', () => {
  it('scopes daily status and budget updates and requires admin for refresh controls', async () => {
    const scheduler = { dailyStatus: vi.fn().mockResolvedValue({ enabled: true }), updateRefreshBudget: vi.fn() };
    const jobs = { enqueueRefresh: vi.fn() };
    const controller = Reflect.construct(RdScheduleController, [scheduler, jobs]) as RdScheduleController;
    const user = { accountId: 'tenant-daily' } as AuthUser;
    await controller.daily(user);
    await controller.budget(user, { dailyBudget: 7 });
    await controller.refresh(user);
    expect(scheduler.dailyStatus).toHaveBeenCalledWith('tenant-daily');
    expect(scheduler.updateRefreshBudget).toHaveBeenCalledWith('tenant-daily', 7);
    expect(jobs.enqueueRefresh).toHaveBeenCalledWith('tenant-daily');
    expect(Reflect.getMetadata(ADMIN_KEY, RdScheduleController.prototype.budget)).toBe(true);
    expect(Reflect.getMetadata(ADMIN_KEY, RdScheduleController.prototype.refresh)).toBe(true);
  });
  it('scopes schedule reads and reconciliation to the authenticated account', async () => {
    const scheduler = { status: vi.fn().mockResolvedValue({ state: 'scheduled' }), coverage: vi.fn().mockResolvedValue([]) };
    const jobs = { enqueueReconciliation: vi.fn().mockResolvedValue({ runId: 'delta-1', runIds: ['delta-1'] }) };
    const controller = Reflect.construct(RdScheduleController, [scheduler, jobs]) as RdScheduleController;
    const user = { accountId: 'tenant-1' } as AuthUser;
    expect(await controller.status(user)).toEqual({ state: 'scheduled' });
    expect(await controller.coverage(user)).toEqual([]);
    expect(scheduler.coverage).toHaveBeenCalledWith('tenant-1');
    expect(await controller.reconcile(user)).toEqual({ runId: 'delta-1', runIds: ['delta-1'] });
    expect(scheduler.status).toHaveBeenCalledWith('tenant-1');
    expect(jobs.enqueueReconciliation).toHaveBeenCalledWith('tenant-1');
  });

  it('requires admin for mutations while allowing authenticated schedule reads', () => {
    expect(Reflect.getMetadata(ADMIN_KEY, RdScheduleController.prototype.reconcile)).toBe(true);
    expect(Reflect.getMetadata(ADMIN_KEY, RdScheduleController.prototype.status)).toBeUndefined();
  });
});
