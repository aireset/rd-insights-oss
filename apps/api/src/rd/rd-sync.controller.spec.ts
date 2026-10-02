import { describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../auth/auth.types';
import { RdSyncController } from './rd-sync.controller';

describe('RdSyncController', () => {
  it('queues the account sync instead of starting in-process work', async () => {
    const jobs = {
      enqueueFullSync: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      start: vi.fn().mockResolvedValue({ runId: 'wrong' }),
    };
    const sync = { status: vi.fn() };
    const controller = Reflect.construct(RdSyncController, [jobs, sync]) as RdSyncController;

    await controller.start({ accountId: 'account-1' } as AuthUser);

    expect(jobs.enqueueFullSync).toHaveBeenCalledWith('account-1', undefined);
    expect(jobs.start).not.toHaveBeenCalled();
  });
});
