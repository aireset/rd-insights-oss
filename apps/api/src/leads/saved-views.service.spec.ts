import { describe, expect, it, vi } from 'vitest';
import { savedViewInputSchema } from '@rd/shared';
import { SavedViewsService } from './saved-views.service';

describe('SavedViewsService', () => {
  it('saves only validated filters and scopes reads by account and user', async () => {
    const findMany = vi.fn(async () => []);
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'view-1', ...data, createdAt: new Date(), updatedAt: new Date() }));
    const service = new SavedViewsService({ savedView: { findMany, create } } as never);

    await service.create('account-1', 'user-1', savedViewInputSchema.parse({ name: 'Leads quentes', filters: { aiScore: 'quente', segmentIds: ['seg-a'], page: 8, pageSize: 200, privateField: 'drop' } }));
    await service.list('account-1', 'user-1');

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ accountId: 'account-1', userId: 'user-1', name: 'Leads quentes', filters: expect.not.objectContaining({ page: expect.anything(), pageSize: expect.anything(), privateField: expect.anything() }) }) }));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { accountId: 'account-1', userId: 'user-1' } }));
  });

  it('returns 404 when another user updates or deletes a saved view', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const service = new SavedViewsService({ savedView: { updateMany, deleteMany } } as never);

    await expect(service.update('account-1', 'user-1', 'foreign-view', { name: 'X', filters: {} })).rejects.toMatchObject({ status: 404 });
    await expect(service.remove('account-1', 'user-1', 'foreign-view')).rejects.toMatchObject({ status: 404 });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'foreign-view', accountId: 'account-1', userId: 'user-1' } }));
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: 'foreign-view', accountId: 'account-1', userId: 'user-1' } });
  });
});
