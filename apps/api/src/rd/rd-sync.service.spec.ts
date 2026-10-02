import { describe, expect, it, vi } from 'vitest';
import { mapContact } from './rd-mapper';
import { RdSyncService, erroCurto, type Stats } from './rd-sync.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RdConnectionService } from './rd-connection.service';

describe('mapContact', () => {
  it('extrai campos padrão, custom (cf_*), funil e eventos', () => {
    const lead = mapContact(
      { uuid: 'u1', name: 'Ana', email: 'a@x.com', personal_phone: '11 9', city: 'Londrina', state: 'PR', tags: ['vip'], cf_origem: 'insta', job_title: 'CEO' },
      { lifecycle_stage: 'Lead', opportunity: true, fit: 'A', interest: 70 },
      [
        { event_type: 'CONVERSION', event_identifier: 'forms - consultoria', event_timestamp: '2026-09-01T10:00:00Z', payload: {} },
        { event_type: 'CONVERSION', event_identifier: 'whatsapp', event_timestamp: '2026-09-20T10:00:00Z', payload: {} },
        { event_type: 'OPPORTUNITY', event_identifier: 'qualified', event_timestamp: '2026-09-25T10:00:00Z', payload: {} },
        { event_type: 'CONVERSION', event_identifier: 'whatsapp', event_timestamp: '2026-09-20T10:00:00Z', payload: {} },
      ],
    );
    expect(lead.lead).toMatchObject({ rdUuid: 'u1', name: 'Ana', phone: '11 9', city: 'Londrina', state: 'PR', tags: ['vip'], jobTitle: 'CEO', lifecycleStage: 'Lead', opportunity: true, fit: 'A', interest: 70, conversionsCount: 2, customFields: { cf_origem: 'insta' } });
    expect(lead.lead.firstConversionAt?.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(lead.lead.lastConversionAt?.toISOString()).toBe('2026-09-20T10:00:00.000Z');
    expect(lead.events.map((event) => event.type)).toEqual(['CONVERSION', 'CONVERSION', 'OPPORTUNITY']);
    expect(lead.lead.conversionsCount).toBe(2);
  });
});

describe('RdSyncService.runFull', () => {
  it('pagina a segmentação, grava cursor por página e retoma do cursor', async () => {
    const pages: Record<number, string[]> = { 1: ['a', 'b'], 2: ['c'], 3: [] };
    const client = {
      get: vi.fn(async (path: string, q?: { page?: number }, onH?: (h: Headers) => void) => {
        if (path.includes('/segmentations/')) onH?.(new Headers({ 'pagination-total-pages': '2' }));
        if (path.includes('/segmentations/')) return { contacts: (pages[q!.page!] ?? []).map((uuid) => ({ uuid, name: uuid })) };
        if (path.endsWith('/funnels/default')) return { lifecycle_stage: 'Lead', opportunity: false, fit: null, interest: null };
        if (path.endsWith('/events')) return { events: [] };
        return { uuid: path.split('uuid:')[1], name: 'n', tags: [] };
      }),
    };
    const runs: Array<{ cursor: number }> = [];
    const prisma = {
      rdConnection: { findUnique: vi.fn(async () => ({ accountId: 'acc', segmentationId: '9', status: 'active' })), update: vi.fn() },
      syncRun: { create: vi.fn(async () => ({ id: 'run-1' })), update: vi.fn(async ({ data }: { data: { cursor?: number } }) => { if (data.cursor !== undefined) runs.push({ cursor: data.cursor }); }), findFirst: vi.fn(async () => null) },
      lead: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({ id: 'l' })), update: vi.fn(async () => ({ id: 'l' })) },
      leadEvent: { createMany: vi.fn(async () => ({ count: 0 })) },
    } as unknown as PrismaService;
    const conn = { client: vi.fn(async () => client), marcarErro: vi.fn() } as unknown as RdConnectionService;
    const svc = new RdSyncService(withTransactions(prisma), conn);
    await svc.runFull('acc', { fromCursor: 0 });
    expect([...new Set(runs.map((r) => r.cursor).filter((cursor) => cursor > 0))]).toEqual([1, 2]);
    expect((prisma.syncRun.update as ReturnType<typeof vi.fn>).mock.calls.some(([a]) => (a as { data: { stats?: { totalPaginas?: number } } }).data.stats?.totalPaginas === 2)).toBe(true);
    expect((prisma.lead.upsert as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);

    (prisma.lead.upsert as ReturnType<typeof vi.fn>).mockClear();
    await svc.runFull('acc', { fromCursor: 1 }); // retoma: só a página 2
    expect((prisma.lead.upsert as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('busca todas as páginas de CONVERSION e OPPORTUNITY, sem teto de 50 páginas', async () => {
    const contacts = { 1: [{ uuid: 'lead-1', name: 'Ana' }], 2: [] };
    const calls: Array<{ type: string; page: number }> = [];
    const conversions = Array.from({ length: 510 }, (_, i) => ({ event_type: 'CONVERSION' as const, event_identifier: `conversion-${i}`, event_timestamp: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`, payload: {} }));
    const opportunity = { event_type: 'OPPORTUNITY' as const, event_identifier: 'opportunity-1', event_timestamp: '2026-09-28T10:00:00Z', payload: {} };
    const client = {
      get: vi.fn(async (path: string, q?: { page?: number; event_type?: string }) => {
        if (path.includes('/segmentations/')) return { contacts: contacts[q!.page!] ?? [] };
        if (path.endsWith('/funnels/default')) return { lifecycle_stage: 'Lead', opportunity: true, fit: null, interest: null };
        if (path.endsWith('/events')) {
          const type = q!.event_type!;
          const page = q!.page!;
          calls.push({ type, page });
          if (type === 'OPPORTUNITY') return { events: page === 1 ? [opportunity] : [] };
          const start = (page - 1) * 10;
          return { events: conversions.slice(start, start + 10) };
        }
        return { uuid: 'lead-1', name: 'Ana', tags: [] };
      }),
    };
    const createMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      rdConnection: { findUnique: vi.fn(async () => ({ accountId: 'acc', segmentationId: '9' })), update: vi.fn() },
      syncRun: { create: vi.fn(async () => ({ id: 'run-1' })), update: vi.fn(), findFirst: vi.fn() },
      lead: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({ id: 'lead-db-1' })), update: vi.fn(async () => ({ id: 'lead-db-1' })) },
      leadEvent: { createMany },
    } as unknown as PrismaService;
    const conn = { client: vi.fn(async () => client), marcarErro: vi.fn() } as unknown as RdConnectionService;
    await new RdSyncService(withTransactions(prisma), conn).runFull('acc', { fromCursor: 0 });

    expect(calls.filter((call) => call.type === 'CONVERSION').map((call) => call.page)).toEqual(Array.from({ length: 52 }, (_, i) => i + 1));
    expect(calls.filter((call) => call.type === 'OPPORTUNITY').map((call) => call.page)).toEqual([1]);
    expect(createMany.mock.calls[0][0].data).toHaveLength(511);
    const historyUpdate = (prisma.lead.update as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as { data: { conversionsCount: number } };
    expect(historyUpdate.data.conversionsCount).toBe(510);
  });

  it('deduplica evento repetido entre páginas antes de contar e persistir', async () => {
    const firstPage = Array.from({ length: 10 }, (_, i) => ({ event_type: 'CONVERSION' as const, event_identifier: `e-${i}`, event_timestamp: `2026-09-${String(i + 1).padStart(2, '0')}T10:00:00Z`, payload: {} }));
    const secondPage = [firstPage[9], ...Array.from({ length: 9 }, (_, i) => ({ event_type: 'CONVERSION' as const, event_identifier: `e-${i + 10}`, event_timestamp: `2026-09-${String(i + 11).padStart(2, '0')}T10:00:00Z`, payload: {} }))];
    const createMany = vi.fn(async () => ({ count: 0 }));
    const client = { get: vi.fn(async (path: string, q?: { page?: number; event_type?: string }) => {
      if (path.includes('/segmentations/')) return { contacts: q!.page === 1 ? [{ uuid: 'lead-1', name: 'Ana' }] : [] };
      if (path.endsWith('/funnels/default')) return {};
      if (path.endsWith('/events')) return { events: q!.event_type === 'CONVERSION' ? ([firstPage, secondPage][q!.page! - 1] ?? []) : [] };
      return { uuid: 'lead-1', name: 'Ana', tags: [] };
    }) };
    const prisma = {
      rdConnection: { findUnique: vi.fn(async () => ({ accountId: 'acc', segmentationId: '9' })), update: vi.fn() },
      syncRun: { create: vi.fn(async () => ({ id: 'run-1' })), update: vi.fn(), findFirst: vi.fn() },
      lead: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({ id: 'lead-db-1' })), update: vi.fn(async () => ({ id: 'lead-db-1' })) },
      leadEvent: { createMany },
    } as unknown as PrismaService;
    const conn = { client: vi.fn(async () => client), marcarErro: vi.fn() } as unknown as RdConnectionService;
    await new RdSyncService(withTransactions(prisma), conn).runFull('acc', { fromCursor: 0 });

    expect(createMany.mock.calls[0][0].data).toHaveLength(19);
    const historyUpdate = (prisma.lead.update as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as { data: { conversionsCount: number } };
    expect(historyUpdate.data.conversionsCount).toBe(19);
  });

  it('mantém o run parcial e retomável quando uma página intermediária falha', async () => {
    let fail = true;
    const writes: Array<{ cursor?: number; stats?: Record<string, unknown>; finishedAt?: Date; error?: string | null }> = [];
    const client = {
      get: vi.fn(async (path: string, q?: { page?: number; event_type?: string }) => {
        if (path.includes('/segmentations/')) return { contacts: q!.page === 1 ? [{ uuid: 'lead-1', name: 'Ana' }] : [] };
        if (path.endsWith('/funnels/default')) return {};
        if (path.endsWith('/events')) {
          if (q!.event_type === 'CONVERSION' && q!.page === 1) return { events: Array.from({ length: 10 }, (_, i) => ({ event_type: 'CONVERSION', event_identifier: `e-${i}`, event_timestamp: '2026-09-01T10:00:00Z' })) };
          if (q!.event_type === 'CONVERSION' && q!.page === 2 && fail) throw new Error('RD timeout on page 2');
          return { events: [] };
        }
        return { uuid: 'lead-1', name: 'Ana', tags: [] };
      }),
    };
    const prisma = {
      rdConnection: { findUnique: vi.fn(async () => ({ accountId: 'acc', segmentationId: '9' })), update: vi.fn() },
      syncRun: { create: vi.fn(async () => ({ id: 'run-1' })), update: vi.fn(async ({ data }: { data: typeof writes[number] }) => { writes.push(data); }), findFirst: vi.fn() },
      lead: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({ id: 'lead-db-1' })), update: vi.fn(async () => ({ id: 'lead-db-1' })) },
      leadEvent: { createMany: vi.fn(async () => ({ count: 0 })) },
    } as unknown as PrismaService;
    const conn = { client: vi.fn(async () => client), marcarErro: vi.fn() } as unknown as RdConnectionService;
    const svc = new RdSyncService(withTransactions(prisma), conn);

    await expect(svc.runFull('acc', { fromCursor: 0, runId: 'run-1' })).rejects.toThrow('RD timeout on page 2');
    const partial = writes.at(-1)!;
    expect(partial.cursor).toBe(0);
    expect(partial.finishedAt).toBeUndefined();
    expect(partial.error).toContain('RD timeout on page 2');
    expect(partial.stats).toMatchObject({ phase: 'history', currentPage: 1, pageOffset: 0, contactsFailed: 1 });

    fail = false;
    await svc.runFull('acc', { fromCursor: 0, runId: 'run-1', stats: partial.stats as Partial<Stats> });
    const completed = writes.at(-1)!;
    expect(completed.finishedAt).toBeInstanceOf(Date);
    expect(completed.stats).toMatchObject({ phase: 'completed', contactsImported: 1, contactsEnriched: 1, contactsWithHistory: 1 });
  });

  it('preserva última página concluída e retoma sem reler páginas anteriores', async () => {
    let fail = true;
    const pages: Record<number, string[]> = { 1: ['lead-1'], 2: ['lead-2'], 3: [] };
    const segmentPages: number[] = [];
    const writes: Array<{ cursor?: number; stats?: Record<string, unknown>; finishedAt?: Date; error?: string | null }> = [];
    const pageOneEvents = Array.from({ length: 10 }, (_, i) => ({ event_type: 'CONVERSION', event_identifier: `lead-2-${i}`, event_timestamp: '2026-09-01T10:00:00Z' }));
    const client = {
      get: vi.fn(async (path: string, q?: { page?: number; event_type?: string }) => {
        if (path.includes('/segmentations/')) {
          segmentPages.push(q!.page!);
          return { contacts: (pages[q!.page!] ?? []).map((uuid) => ({ uuid, name: uuid })) };
        }
        if (path.endsWith('/funnels/default')) return {};
        if (path.endsWith('/events')) {
          if (path.includes('lead-2') && q!.event_type === 'CONVERSION' && q!.page === 1) return { events: pageOneEvents };
          if (path.includes('lead-2') && q!.event_type === 'CONVERSION' && q!.page === 2 && fail) throw new Error('RD timeout on lead-2 page 2');
          return { events: [] };
        }
        return { uuid: path.split('uuid:')[1], name: 'Lead', tags: [] };
      }),
    };
    const prisma = {
      rdConnection: { findUnique: vi.fn(async () => ({ accountId: 'acc', segmentationId: '9' })), update: vi.fn() },
      syncRun: { create: vi.fn(async () => ({ id: 'run-1' })), update: vi.fn(async ({ data }: { data: typeof writes[number] }) => { writes.push({ ...data, stats: data.stats ? structuredClone(data.stats) : undefined }); }), findFirst: vi.fn() },
      lead: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({ id: 'lead-db' })), update: vi.fn(async () => ({ id: 'lead-db' })) },
      leadEvent: { createMany: vi.fn(async () => ({ count: 0 })) },
    } as unknown as PrismaService;
    const conn = { client: vi.fn(async () => client), marcarErro: vi.fn() } as unknown as RdConnectionService;
    const svc = new RdSyncService(withTransactions(prisma), conn);

    await expect(svc.runFull('acc', { fromCursor: 0, runId: 'run-1' })).rejects.toThrow('RD timeout on lead-2 page 2');
    const partial = writes.at(-1)!;
    expect(writes.filter((write) => write.stats?.currentPage === 2).every((write) => write.cursor === 1)).toBe(true);
    expect(partial.cursor).toBe(1);
    expect(partial.stats).toMatchObject({ phase: 'history', currentPage: 2, pageOffset: 0, contactsWithHistory: 1 });

    fail = false;
    segmentPages.length = 0;
    await svc.runFull('acc', { fromCursor: partial.cursor!, runId: 'run-1', stats: partial.stats as Partial<Stats> });

    expect(segmentPages).toEqual([2, 3]);
    expect(writes.at(-1)!.finishedAt).toBeInstanceOf(Date);
  });
});

describe('RdSyncService.start', () => {
  it('reserva a conta antes da primeira espera e rejeita POST concorrente', async () => {
    let releaseFind!: (value: { id: string; cursor: number; stats: Record<string, unknown>; error: null }) => void;
    const pendingFind = new Promise<{ id: string; cursor: number; stats: Record<string, unknown>; error: null }>((resolve) => { releaseFind = resolve; });
    const client = { get: vi.fn(async () => ({ contacts: [] })) };
    const prisma = {
      syncRun: {
        findFirst: vi.fn(() => pendingFind), create: vi.fn(), update: vi.fn(async () => ({})),
      },
      rdConnection: { findUnique: vi.fn(async () => ({ segmentationId: '9' })), update: vi.fn() },
    } as unknown as PrismaService;
    const conn = { client: vi.fn(async () => client), marcarErro: vi.fn() } as unknown as RdConnectionService;
    const svc = new RdSyncService(withTransactions(prisma), conn);

    const first = svc.start('acc');
    const second = svc.start('acc');
    releaseFind({ id: 'run-1', cursor: 0, stats: {}, error: null });
    const results = await Promise.allSettled([first, second]);
    expect(prisma.syncRun.findFirst).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { runId: 'run-1' } });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'Já existe uma sincronização em andamento' }) });
  });

  it('libera a reserva se criar SyncRun falhar, para a chamada seguinte poder iniciar', async () => {
    const client = { get: vi.fn(async () => ({ contacts: [] })) };
    const prisma = {
      syncRun: {
        findFirst: vi.fn(async () => null),
        create: vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValueOnce({ id: 'run-2' }),
        update: vi.fn(async () => ({})),
      },
      rdConnection: { findUnique: vi.fn(async () => ({ segmentationId: '9' })), update: vi.fn() },
    } as unknown as PrismaService;
    const conn = { client: vi.fn(async () => client), marcarErro: vi.fn() } as unknown as RdConnectionService;
    const svc = new RdSyncService(withTransactions(prisma), conn);

    await expect(svc.start('acc')).rejects.toThrow('database unavailable');
    await expect(svc.start('acc')).resolves.toEqual({ runId: 'run-2' });
  });
});

describe('RdSyncService.runFull setup failure', () => {
  it('releases account reservation when creating the run rejects so start can retry', async () => {
    const client = { get: vi.fn(async () => ({ contacts: [] })) };
    const prisma = {
      syncRun: {
        create: vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValueOnce({ id: 'run-2' }),
        findFirst: vi.fn(async () => null),
        update: vi.fn(async () => ({})),
      },
      rdConnection: { findUnique: vi.fn(async () => ({ segmentationId: '9' })), update: vi.fn() },
    } as unknown as PrismaService;
    const conn = { client: vi.fn(async () => client), marcarErro: vi.fn() } as unknown as RdConnectionService;
    const svc = new RdSyncService(withTransactions(prisma), conn);

    await expect(svc.runFull('acc', { fromCursor: 0 })).rejects.toThrow('database unavailable');
    await expect(svc.start('acc')).resolves.toEqual({ runId: 'run-2' });
    expect(prisma.syncRun.create).toHaveBeenCalledTimes(2);
  });
});

function withTransactions(prisma: PrismaService): PrismaService {
  type Event = { accountId: string; leadId: string; type: string; identifier: string; occurredAt: Date };
  const events: Event[] = [];
  const lead = (prisma as unknown as { lead?: Record<string, unknown> }).lead;
  if (lead && !lead.updateMany) lead.updateMany = vi.fn(async () => ({ count: 1 }));
  const tx = new Proxy(prisma as unknown as Record<string, unknown>, {
    get(target, property) {
      if (property === '$executeRaw') return vi.fn(async () => 1);
      const model = target[String(property)];
      if (!model || typeof model !== 'object') return model;
      return new Proxy(model as Record<string, (...args: unknown[]) => unknown>, {
        get(delegate, method) {
          if (property === 'leadEvent' && method === 'createMany') return async (args: { data: Event[] }) => {
            for (const event of args.data) if (!events.some((saved) => saved.leadId === event.leadId && saved.type === event.type && saved.identifier === event.identifier && saved.occurredAt.getTime() === event.occurredAt.getTime())) events.push(event);
            return delegate.createMany!(args);
          };
          if (property === 'leadEvent' && method === 'findMany') return async () => events.filter((event) => event.type === 'CONVERSION').sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()).map(({ occurredAt }) => ({ occurredAt }));
          if (property === 'lead' && method === 'findUnique') return async (args: { where?: { accountId_rdUuid?: unknown } }) => await delegate.findUnique!(args) ?? (args.where?.accountId_rdUuid ? { id: 'lead-db-1' } : null);
          return delegate[String(method)];
        },
      });
    },
  });
  (prisma as unknown as { $transaction: (callback: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).$transaction = (callback) => callback(tx);
  return prisma;
}
describe('sync órfão', () => {
  const mk = (ultimo: unknown) => {
    const prisma = { syncRun: { updateMany: vi.fn(), findFirst: vi.fn(async () => ultimo), create: vi.fn(async ({ data }: { data: object }) => ({ id: 'novo', ...data })), update: vi.fn() }, rdConnection: { findUnique: vi.fn(async () => null), update: vi.fn() } } as unknown as PrismaService;
    const conn = { client: vi.fn(), marcarErro: vi.fn() } as unknown as RdConnectionService;
    return { prisma, svc: new RdSyncService(prisma, conn) };
  };
  it('start retoma do cursor do run interrompido; senão começa do zero', async () => {
    const a = mk({ cursor: 7, error: 'Interrompido (servidor reiniciou). x' });
    await a.svc.start('acc');
    expect(a.prisma.syncRun.create).toHaveBeenCalledWith({ data: { accountId: 'acc', kind: 'full', cursor: 7 } });
    const b = mk({ cursor: 7, error: 'boom', finishedAt: new Date() });
    await b.svc.start('acc');
    expect(b.prisma.syncRun.create).toHaveBeenCalledWith({ data: { accountId: 'acc', kind: 'full', cursor: 0 } });
  });
  it('status expõe emAndamento e erroCurto tira o payload do Prisma', async () => {
    const { prisma, svc } = mk(null);
    (prisma.syncRun.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'r', kind: 'full', startedAt: new Date(), finishedAt: null, cursor: 0, stats: {}, error: null });
    expect((await svc.status('acc'))?.emAndamento).toBe(false);
    expect(erroCurto(new Error('\nInvalid x\n  email: "a@b.c"\nArgument `fit`: Invalid value'))).toBe('Argument `fit`: Invalid value');
  });
  it('fit numérico do RD vira string', () => {
    expect(mapContact({ uuid: 'u' }, { fit: 259 }, []).lead.fit).toBe('259');
  });
});
