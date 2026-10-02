import { describe, expect, it, vi } from 'vitest';
import { DashboardService } from './dashboard.service';

describe('DashboardService', () => {
  it('agrega leads por dia sem duplicar membership e preenche dias sem novos leads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'));
    const findMany = vi.fn(async () => [
      { id: 'lead-a', rdCreatedAt: new Date('2026-09-27T14:00:00.000Z') },
      { id: 'lead-b', rdCreatedAt: new Date('2026-09-27T23:00:00.000Z') },
      { id: 'lead-c', rdCreatedAt: new Date('2026-09-28T00:00:00.000Z') },
    ]);
    const service = new DashboardService({ lead: { findMany }, rdSegmentation: { findMany: vi.fn(async () => [{ rdId: 'seg-a' }]) } } as never);

    const result = await service.newLeads('account-1', { period: 7, segmentIds: ['seg-a'] });

    expect(result).toEqual({
      period: 7,
      timeZone: 'America/Sao_Paulo',
      total: 3,
      points: [
        { date: '2026-09-22', count: 0 }, { date: '2026-09-23', count: 0 },
        { date: '2026-09-24', count: 0 }, { date: '2026-09-25', count: 0 },
        { date: '2026-09-26', count: 0 }, { date: '2026-09-27', count: 3 },
        { date: '2026-09-28', count: 0 },
      ],
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ accountId: 'account-1', rdCreatedAt: expect.any(Object) }),
      select: { id: true, rdCreatedAt: true },
    }));
    const tokyo = await service.newLeads('account-1', { period: 7, timeZone: 'Asia/Tokyo' });
    expect(tokyo.points.map(({ date, count }) => [date, count])).toEqual([
      ['2026-09-22', 0], ['2026-09-23', 0], ['2026-09-24', 0], ['2026-09-25', 0],
      ['2026-09-26', 0], ['2026-09-27', 1], ['2026-09-28', 2],
    ]);
    vi.useRealTimers();
  });

  it('filtra por todos os segmentos solicitados e rejeita segmento fora da conta/pausado', async () => {
    const findLeads = vi.fn(async () => []);
    const findSegments = vi.fn(async () => [{ rdId: 'seg-a' }, { rdId: 'seg-b' }]);
    const service = new DashboardService({ lead: { findMany: findLeads }, rdSegmentation: { findMany: findSegments } } as never);

    await service.newLeads('account-1', { period: 30, segmentIds: ['seg-a', 'seg-b'], segmentMatch: 'all' });
    expect(findLeads).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        accountId: 'account-1',
        AND: [
          { segmentMemberships: { some: expect.objectContaining({ accountId: 'account-1', segmentationRdId: 'seg-a' }) } },
          { segmentMemberships: { some: expect.objectContaining({ accountId: 'account-1', segmentationRdId: 'seg-b' }) } },
        ],
      }),
    }));

    findSegments.mockResolvedValueOnce([{ rdId: 'seg-a' }]);
    await expect(service.newLeads('account-1', { period: 30, segmentIds: ['seg-a', 'foreign'] })).rejects.toMatchObject({ status: 404 });
    expect(findLeads).toHaveBeenCalledTimes(1);
  });

  it('compara tamanhos, sobreposição e união deduplicada apenas de segmentos ativos da conta', async () => {
    const counts = new Map([
      ['seg-a', 2], ['seg-b', 2], ['seg-a+seg-b', 1],
    ]);
    const count = vi.fn(async ({ where }: { where: { AND?: unknown[]; segmentMemberships?: unknown } }) => {
      const ids = where.AND?.map((item) => (item as { segmentMemberships: { some: { segmentationRdId: string } } }).segmentMemberships.some.segmentationRdId);
      const key = ids?.length === 2 ? `${ids[0]}+${ids[1]}` : ids?.[0] ?? (where.segmentMemberships as { some: { segmentationRdId: string } }).some.segmentationRdId;
      return counts.get(key) ?? 0;
    });
    const findSegments = vi.fn(async () => [{ rdId: 'seg-a' }, { rdId: 'seg-b' }]);
    const service = new DashboardService({ lead: { count }, rdSegmentation: { findMany: findSegments } } as never);

    await expect(service.compareSegments('account-1', 'seg-a', 'seg-b')).resolves.toEqual({ a: 2, b: 2, overlap: 1, union: 3 });
    expect(findSegments).toHaveBeenCalledWith({
      where: { accountId: 'account-1', rdId: { in: ['seg-a', 'seg-b'] }, selected: true, available: true },
      select: { rdId: true },
    });
    expect(count).toHaveBeenCalledTimes(3);
    for (const call of count.mock.calls) expect(call[0].where).toMatchObject({ accountId: 'account-1' });

    findSegments.mockResolvedValueOnce([{ rdId: 'seg-a' }]);
    await expect(service.compareSegments('account-1', 'seg-a', 'foreign')).rejects.toMatchObject({ status: 404 });
    expect(count).toHaveBeenCalledTimes(3);
  });

  it('resume estágio, tags, localidade, conversões e horário sem duplicar lead/tag/conversão', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'));
    const leads = vi.fn(async () => [
      { id: 'lead-a', lifecycleStage: null, tags: ['webinar', 'webinar'], city: 'Londrina', state: 'PR' },
      { id: 'lead-b', lifecycleStage: 'MQL', tags: ['webinar'], city: 'Londrina', state: 'PR' },
    ]);
    const events = vi.fn(async () => [
      { leadId: 'lead-a', identifier: 'ebook', occurredAt: new Date('2026-09-28T10:00:00.000Z') },
      { leadId: 'lead-a', identifier: 'ebook', occurredAt: new Date('2026-09-28T11:00:00.000Z') },
      { leadId: 'lead-b', identifier: 'demo', occurredAt: new Date('2026-09-27T10:00:00.000Z') },
    ]);
    const service = new DashboardService({ lead: { findMany: leads }, leadEvent: { findMany: events }, rdSegmentation: { findMany: vi.fn(async () => []) } } as never);

    const result = await service.summary('account-1', { period: 7 });

    expect(result.stages).toEqual([{ name: 'MQL', count: 1 }, { name: 'Sem estágio', count: 1 }]);
    expect(result.tags).toEqual([{ name: 'webinar', leadCount: 2 }]);
    expect(result.locations).toEqual([{ city: 'Londrina', state: 'PR', leadCount: 2 }]);
    expect(result.conversions).toEqual([{ identifier: 'demo', leadCount: 1 }, { identifier: 'ebook', leadCount: 1 }]);
    expect(result.period).toBe(7);
    expect(result.timeZone).toBe('America/Sao_Paulo');
    expect(result.heatmap).toEqual([{ dayOfWeek: 0, hour: 7, count: 1 }, { dayOfWeek: 1, hour: 7, count: 1 }, { dayOfWeek: 1, hour: 8, count: 1 }]);
    expect(leads).toHaveBeenCalledWith(expect.objectContaining({ where: { accountId: 'account-1' } }));
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ accountId: 'account-1', leadId: { in: ['lead-a', 'lead-b'] }, type: 'CONVERSION', occurredAt: { gte: expect.any(Date), lte: expect.any(Date) } }) }));
    vi.useRealTimers();
  });
});
