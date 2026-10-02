import { describe, expect, it, vi } from 'vitest';
import { leadsQuerySchema } from '@rd/shared';
import { LeadsService, buildWhere } from './leads.service';

describe('lead freshness', () => {
  it('returns safe endpoint coverage and independent timestamps for the authenticated account', async () => {
    const findFirst = vi.fn(async () => ({
      id: 'lead-1', rdUuid: 'uuid-1', segmentMemberships: [], events: [], customFields: {},
      firstConversionAt: null, lastConversionAt: new Date('2026-09-28T22:00:00Z'), rdCreatedAt: null,
      enrichedAt: new Date('2026-09-28T10:00:00Z'), historySyncedAt: null,
      dataCoverage: { funnel: { status: 'unavailable', checkedAt: '2026-09-28T10:00:00.000Z', reason: 'RD não disponibilizou o funil (404).' }, raw: { token: 'never-expose' } }, raw: { token: 'never-expose' },
    }));
    const svc = new LeadsService({ lead: { findFirst } } as never);
    const result = await svc.detail('account-1', 'lead-1');
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'lead-1', accountId: 'account-1' } }));
    expect(result.dataFreshness).toMatchObject({ enrichedAt: '2026-09-28T10:00:00.000Z', historySyncedAt: null, coverage: { details: { status: 'unknown' }, funnel: { status: 'unavailable' }, opportunities: { status: 'unknown' } } });
    expect(JSON.stringify(result)).not.toContain('never-expose');
  });
});

describe('buildWhere', () => {
  it('sempre corta por accountId e combina filtros', () => {
    const w = buildWhere('acc', leadsQuerySchema.parse({ q: 'ana', tags: 'vip,quente', lifecycleStage: 'Lead', oportunidade: 'true', uf: 'PR', de: '2026-09-01', conversao: 'forms' }));
    expect(w.accountId).toBe('acc');
    expect(w.tags).toEqual({ hasEvery: ['vip', 'quente'] });
    expect(w.lifecycleStage).toEqual({ in: ['Lead'] });
    expect(w.opportunity).toBe(true);
    expect(w.state).toBe('PR');
    expect(w.lastConversionAt).toEqual({ gte: new Date('2026-09-01T03:00:00.000Z') });
    expect(w.events).toEqual({ some: { identifier: { contains: 'forms', mode: 'insensitive' } } });
    expect(w.OR).toHaveLength(4);
  });
  it('trata datas como dias civis inclusivos no fuso padrão da conta', () => {
    const w = buildWhere('acc', leadsQuerySchema.parse({ cidade: 'Londrina', uf: 'PR', de: '2026-09-01', ate: '2026-09-28' }));
    expect(w.city).toEqual({ contains: 'Londrina', mode: 'insensitive' });
    expect(w.state).toBe('PR');
    expect(w.lastConversionAt).toEqual({ gte: new Date('2026-09-01T03:00:00.000Z'), lt: new Date('2026-09-29T03:00:00.000Z') });
  });
  it('inicia no primeiro horário válido quando o fuso pula meia-noite por horário de verão', () => {
    const w = buildWhere('acc', leadsQuerySchema.parse({ de: '2018-11-04' }));
    expect(w.lastConversionAt).toEqual({ gte: new Date('2018-11-04T03:00:00.000Z') });
  });
  it('filtra a classificação IA pelo score persistido no lead', () => {
    const w = buildWhere('acc', leadsQuerySchema.parse({ aiScore: 'quente' }));
    expect(w.aiScore).toBe('quente');
  });
  it('ignora UF parcial até haver os dois caracteres', () => {
    expect(buildWhere('acc', leadsQuerySchema.parse({ uf: 'P' }))).toEqual({ accountId: 'acc' });
  });
  it('sem filtros → só accountId', () => {
    expect(buildWhere('acc', leadsQuerySchema.parse({}))).toEqual({ accountId: 'acc' });
  });
  it('desempata a ordenação por id para manter as páginas estáveis', async () => {
    const findMany = vi.fn(async () => []);
    const svc = new LeadsService({ lead: { findMany, count: async () => 0 } } as never);
    await svc.list('account-1', leadsQuerySchema.parse({ sort: 'name', page: 2 }));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: [{ name: 'desc' }, { id: 'asc' }], skip: 50 }));
  });
  it('deduplica segmentIds CSV e aplica any/all só a membership ativa da conta', () => {
    const any = leadsQuerySchema.parse({ segmentIds: 'seg-a,seg-b,seg-a' });
    expect(any.segmentIds).toEqual(['seg-a', 'seg-b']);
    expect(any.segmentMatch).toBe('any');
    expect(buildWhere('acc', any)).toEqual({
      accountId: 'acc',
      segmentMemberships: { some: { accountId: 'acc', segmentationRdId: { in: ['seg-a', 'seg-b'] }, segmentation: { is: { accountId: 'acc', selected: true, available: true } } } },
    });
    expect(buildWhere('acc', leadsQuerySchema.parse({ segmentIds: ['seg-a', 'seg-a'], segmentMatch: 'all' }))).toEqual({
      accountId: 'acc',
      AND: [{ segmentMemberships: { some: { accountId: 'acc', segmentationRdId: 'seg-a', segmentation: { is: { accountId: 'acc', selected: true, available: true } } } } }],
    });
  });
  it('retorna 404 sem consultar leads quando os segmentos não são ativos da conta', async () => {
    const findMany = vi.fn(async () => []);
    const leadFindMany = vi.fn(async () => []);
    const svc = new LeadsService({
      rdSegmentation: { findMany },
      lead: { findMany: leadFindMany, count: async () => 0 },
    } as never);
    const q = leadsQuerySchema.parse({ segmentIds: ['foreign-or-paused'] });

    await expect(svc.list('account-1', q)).rejects.toMatchObject({ status: 404 });
    expect(findMany).toHaveBeenCalledWith({ where: { accountId: 'account-1', rdId: { in: ['foreign-or-paused'] }, selected: true, available: true }, select: { rdId: true } });
    expect(leadFindMany).not.toHaveBeenCalled();
  });

  it('restringe facetas ao filtro de segmentos e conta leads distintos por tag, estágio e conversão', async () => {
    const query = leadsQuerySchema.parse({ segmentIds: 'seg-a,seg-b', segmentMatch: 'all' });
    const findSegments = vi.fn(async () => [{ rdId: 'seg-a' }, { rdId: 'seg-b' }]);
    const findLeads = vi.fn(async () => [
      { id: 'lead-1', tags: ['vip', 'vip'], lifecycleStage: 'Lead' },
      { id: 'lead-2', tags: ['vip'], lifecycleStage: 'Lead' },
    ]);
    const findEvents = vi.fn(async () => [
      { leadId: 'lead-1', identifier: 'form' },
      { leadId: 'lead-1', identifier: 'form' },
      { leadId: 'lead-2', identifier: 'form' },
    ]);
    const svc = new LeadsService({
      rdSegmentation: { findMany: findSegments },
      lead: { findMany: findLeads },
      leadEvent: { findMany: findEvents },
    } as never);

    await expect(svc.facets('account-1', query)).resolves.toEqual({
      tags: [{ value: 'vip', count: 2 }],
      lifecycleStages: [{ value: 'Lead', count: 2 }],
      conversoes: [{ value: 'form', count: 2 }],
    });
    expect(findSegments).toHaveBeenCalledWith({ where: { accountId: 'account-1', rdId: { in: ['seg-a', 'seg-b'] }, selected: true, available: true }, select: { rdId: true } });
    expect(findLeads).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ AND: [
      { segmentMemberships: { some: { accountId: 'account-1', segmentationRdId: 'seg-a', segmentation: { is: { accountId: 'account-1', selected: true, available: true } } } } },
      { segmentMemberships: { some: { accountId: 'account-1', segmentationRdId: 'seg-b', segmentation: { is: { accountId: 'account-1', selected: true, available: true } } } } },
    ] }) }));
    expect(findEvents).toHaveBeenCalledWith(expect.objectContaining({ distinct: ['leadId', 'identifier'] }));
  });

  it('aplica any nas facetas usando memberships ativas e escopo da conta', async () => {
    const query = leadsQuerySchema.parse({ segmentIds: ['seg-a', 'seg-b'], segmentMatch: 'any' });
    const findSegments = vi.fn(async () => [{ rdId: 'seg-a' }, { rdId: 'seg-b' }]);
    const findLeads = vi.fn(async () => [{ id: 'lead-1', tags: ['vip'], lifecycleStage: null }]);
    const svc = new LeadsService({
      rdSegmentation: { findMany: findSegments },
      lead: { findMany: findLeads },
      leadEvent: { findMany: vi.fn(async () => []) },
    } as never);

    await svc.facets('account-1', query);

    expect(findLeads).toHaveBeenCalledWith(expect.objectContaining({ where: {
      accountId: 'account-1',
      segmentMemberships: { some: { accountId: 'account-1', segmentationRdId: { in: ['seg-a', 'seg-b'] }, segmentation: { is: { accountId: 'account-1', selected: true, available: true } } } },
    } }));
  });

  it('retorna 404 nas facetas para segmentação desconhecida, de outra conta ou pausada', async () => {
    const findSegments = vi.fn(async () => [{ rdId: 'seg-a' }]);
    const findLeads = vi.fn(async () => []);
    const svc = new LeadsService({
      rdSegmentation: { findMany: findSegments },
      lead: { findMany: findLeads },
      leadEvent: { findMany: vi.fn(async () => []) },
    } as never);

    await expect(svc.facets('account-1', leadsQuerySchema.parse({ segmentIds: ['seg-a', 'foreign'] }))).rejects.toMatchObject({ status: 404 });
    expect(findLeads).not.toHaveBeenCalled();
  });

  it('retorna apenas badges de memberships vinculadas a segmentações ativas da conta', async () => {
    const findMany = vi.fn(async () => [{
      id: 'lead-1', rdUuid: 'rd-1', name: 'Ana', email: null, phone: null, city: null, state: null,
      company: null, jobTitle: null, tags: [], lifecycleStage: null, opportunity: false, fit: null, interest: null,
      conversionsCount: 0, firstConversionAt: null, lastConversionAt: null, rdCreatedAt: null,
      segmentMemberships: [{ segmentation: { rdId: 'seg-a', name: 'Ativos' } }],
    }]);
    const svc = new LeadsService({ lead: { findMany, count: vi.fn(async () => 1) } } as never);

    const page = await svc.list('account-1', leadsQuerySchema.parse({}));

    expect(page.items[0].segments).toEqual([{ id: 'seg-a', name: 'Ativos' }]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({
      segmentMemberships: { where: { accountId: 'account-1', segmentation: { is: { accountId: 'account-1', selected: true, available: true } } }, select: { segmentation: { select: { rdId: true, name: true } } } },
    }) }));
  });

  it('retorna badges ativos no detalhe sem remover o corte por conta', async () => {
    const findFirst = vi.fn(async () => ({
      id: 'lead-1', rdUuid: 'rd-1', name: 'Ana', email: null, phone: null, city: null, state: null,
      company: null, jobTitle: null, tags: [], lifecycleStage: null, opportunity: false, fit: null, interest: null,
      conversionsCount: 0, firstConversionAt: null, lastConversionAt: null, rdCreatedAt: null,
      customFields: {}, events: [], segmentMemberships: [{ segmentation: { rdId: 'seg-a', name: 'Ativos' } }],
    }));
    const svc = new LeadsService({ lead: { findFirst } } as never);

    const detail = await svc.detail('account-1', 'lead-1');

    expect(detail.segments).toEqual([{ id: 'seg-a', name: 'Ativos' }]);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'lead-1', accountId: 'account-1' } }));
  });

  it('exporta todos os leads filtrados como CSV seguro para planilha, sem dados brutos', async () => {
    const findMany = vi.fn(async () => [{
      id: 'lead-1', rdUuid: 'rd-1', name: '=1+1; "Ana"', email: 'ana@example.com', phone: '11999990000', city: 'Londrina', state: 'PR',
      company: 'Example Company', jobTitle: null, tags: ['vip', 'cliente'], lifecycleStage: 'Lead', opportunity: true, fit: null, interest: null,
      conversionsCount: 2, firstConversionAt: new Date('2026-09-01T10:00:00.000Z'), lastConversionAt: new Date('2026-09-02T10:00:00.000Z'), rdCreatedAt: null,
      segmentMemberships: [{ segmentation: { rdId: 'seg-a', name: 'Ativos' } }],
    }]);
    const svc = new LeadsService({ lead: { findMany }, rdSegmentation: { findMany: vi.fn(async () => [{ rdId: 'seg-a' }]) } } as never);

    const chunks: string[] = [];
    for await (const chunk of await svc.exportCsv('account-1', leadsQuerySchema.parse({ segmentIds: 'seg-a', page: 3 }))) chunks.push(chunk);
    const csv = chunks.join('');

    expect(csv.startsWith('\uFEFF"Nome";"E-mail"')).toBe(true);
    expect(csv).toContain("\"'=1+1; \"\"Ana\"\"\"");
    expect(csv).toContain('"ana@example.com"');
    expect(csv).toContain('"Ativos"');
    expect(csv).not.toContain('customFields');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ accountId: 'account-1' }), take: 500 }));
    expect(findMany.mock.calls[0][0]).not.toHaveProperty('skip');
  });

  it('starts streaming with the header before reading database pages', async () => {
    const findMany = vi.fn(async () => []);
    const svc = new LeadsService({ lead: { findMany } } as never);
    const stream = await svc.exportCsv('account-1', leadsQuerySchema.parse({}));
    expect((await stream.next()).value).toContain('\uFEFF"Nome"');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('rejects an unavailable segment before starting the CSV stream', async () => {
    const findMany = vi.fn(async () => []);
    const svc = new LeadsService({ lead: { findMany }, rdSegmentation: { findMany: vi.fn(async () => []) } } as never);
    await expect(svc.exportCsv('account-1', leadsQuerySchema.parse({ segmentIds: 'foreign' }))).rejects.toMatchObject({ status: 404 });
    expect(findMany).not.toHaveBeenCalled();
  });
});
