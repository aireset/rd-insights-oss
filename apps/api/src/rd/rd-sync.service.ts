import { Injectable, Logger } from '@nestjs/common';
import type { LeadDataCoverage, LeadDataEndpointView, SyncRunPage, SyncRunsQuery, SyncRunView } from '@rd/shared';
import { BusinessError, NotFoundError, RdProviderError } from '../common/errors';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RdConnectionService } from './rd-connection.service';
import type { RdClient } from './rd-client';
import { assertRdFunnel, mapContact, rdEventKey, type RdContact, type RdEvent, type RdFunnel } from './rd-mapper';
import { RefreshBudgetExhaustedError } from './rd-refresh-budget.service';

const PAGE_SIZE = 125;
const EVENT_PAGE_SIZE = 10;
const CONCORRENCIA = 2;
export type SyncPhase = 'discovering' | 'importing' | 'enriching' | 'history' | 'completed';
export interface Stats {
  lidos: number; criados: number; atualizados: number; erros: number; primeiroErro?: string;
  phase: SyncPhase;
  contactsDiscovered: number; contactsImported: number; contactsEnriched: number; contactsWithHistory: number; contactsFailed: number;
  currentPage?: number; pageOffset?: number;
  [k: string]: number | string | undefined;
}

/** Mensagem curta e sem dados pessoais: erros do Prisma ecoam o payload, ficam só as linhas de diagnóstico. */
export function erroCurto(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (!m.includes('\n')) return m.slice(0, 200);
  return m.split('\n').find((l) => /^(Argument|Unique constraint|Foreign key|Value|Unknown)/.test(l))?.slice(0, 200) ?? (e instanceof Error ? e.name : 'falha');
}

/**
 * Carga inicial paginada e retomável. O cursor guarda a última página concluída;
 * stats guarda fase/posição dentro da página. Upserts tornam o replay seguro.
 * ponytail: BullMQ e coordenação multi-instância ficam para o Plano 2.
 */
@Injectable()
export class RdSyncService {
  private readonly log = new Logger(RdSyncService.name);
  private readonly emAndamento = new Set<string>();

  constructor(private readonly prisma: PrismaService, private readonly conn: RdConnectionService) {}

  /** Dispara em background e retoma um run incompleto ou interrompido. */
  async start(accountId: string): Promise<{ runId: string }> {
    this.reservar(accountId);
    try {
      const ultimo = await this.prisma.syncRun.findFirst({ where: { accountId, kind: 'full' }, orderBy: { startedAt: 'desc' } });
      const interrupted = ultimo?.error?.startsWith('Interrompido') ?? false;
      const unfinished = !!ultimo && ultimo.finishedAt == null;
      const fromCursor = ultimo && (interrupted || unfinished) ? ultimo.cursor : 0;
      const savedStats = ultimo && (interrupted || unfinished) ? ultimo.stats as Partial<Stats> : null;
      const run = unfinished ? ultimo : await this.prisma.syncRun.create({ data: { accountId, kind: 'full', cursor: fromCursor, ...(savedStats ? { stats: savedStats } : {}) } });
      if (run.error) {
        if (savedStats) { savedStats.erros = 0; savedStats.contactsFailed = 0; }
        await this.prisma.syncRun.update({ where: { id: run.id }, data: { error: null, ...(savedStats ? { stats: savedStats } : {}) } });
      }
      void this.executarFull(accountId, { fromCursor, runId: run.id, stats: savedStats }).catch((e) => this.log.error(`sync ${accountId}: ${erroCurto(e)}`));
      return { runId: run.id };
    } catch (e) {
      this.emAndamento.delete(accountId);
      throw e;
    }
  }

  async runFull(accountId: string, o: { fromCursor: number; runId?: string; stats?: Partial<Stats> | null }): Promise<void> {
    this.reservar(accountId);
    return this.executarFull(accountId, o);
  }

  private async executarFull(accountId: string, o: { fromCursor: number; runId?: string; stats?: Partial<Stats> | null }): Promise<void> {
    let runId = o.runId;
    let cursor = o.fromCursor;
    const stats: Stats = {
      lidos: 0, criados: 0, atualizados: 0, erros: 0, phase: 'discovering',
      contactsDiscovered: 0, contactsImported: 0, contactsEnriched: 0, contactsWithHistory: 0, contactsFailed: 0,
      ...(o.stats ?? {}),
    };
    try {
      const activeRunId = runId ?? (await this.prisma.syncRun.create({ data: { accountId, kind: 'full', cursor: o.fromCursor } })).id;
      runId = activeRunId;
      const c = await this.prisma.rdConnection.findUnique({ where: { accountId } });
      if (!c?.segmentationId) throw new BusinessError('Escolha a segmentação antes de sincronizar');
      const client = await this.conn.client(accountId);
      for (let page = o.fromCursor + 1; ; page++) {
        if (stats.currentPage !== page) stats.phase = 'discovering';
        const r = await client.get<{ contacts: RdContact[] }>(`/platform/segmentations/${c.segmentationId}/contacts`, { page, page_size: PAGE_SIZE }, (h) => {
          const n = Number(h.get('pagination-total-pages'));
          if (Number.isFinite(n) && n > 0) stats.totalPaginas = n;
        });
        if (r.contacts.length === 0) break;

        if (stats.currentPage !== page) {
          stats.currentPage = page;
          stats.pageOffset = 0;
          stats.contactsDiscovered += r.contacts.length;
          stats.phase = 'importing';
          await this.checkpoint(activeRunId, cursor, stats);
        }

        if (stats.phase === 'importing') {
          await this.emLotes(r.contacts, CONCORRENCIA, async (start) => {
            for (let i = Math.max(start, stats.pageOffset ?? 0); i < Math.min(start + CONCORRENCIA, r.contacts.length); i++) {
              await this.importarContatoBase(accountId, r.contacts[i]);
              stats.contactsImported++;
              stats.lidos++;
              stats.pageOffset = i + 1;
              await this.checkpoint(activeRunId, cursor, stats);
            }
          });
          stats.phase = 'enriching';
          stats.pageOffset = 0;
          await this.checkpoint(activeRunId, cursor, stats);
        }

        if (stats.phase === 'enriching') {
          await this.emLotes(r.contacts, CONCORRENCIA, async (start) => {
            for (let i = Math.max(start, stats.pageOffset ?? 0); i < Math.min(start + CONCORRENCIA, r.contacts.length); i++) {
              await this.enriquecerContato(accountId, client, r.contacts[i].uuid);
              stats.contactsEnriched++;
              stats.pageOffset = i + 1;
              await this.checkpoint(activeRunId, cursor, stats);
            }
          });
          stats.phase = 'history';
          stats.pageOffset = 0;
          await this.checkpoint(activeRunId, cursor, stats);
        }

        if (stats.phase === 'history') {
          await this.emLotes(r.contacts, CONCORRENCIA, async (start) => {
            for (let i = Math.max(start, stats.pageOffset ?? 0); i < Math.min(start + CONCORRENCIA, r.contacts.length); i++) {
              await this.historicoContato(accountId, client, r.contacts[i].uuid);
              stats.contactsWithHistory++;
              stats.pageOffset = i + 1;
              await this.checkpoint(activeRunId, cursor, stats);
            }
          });
        }

        stats.phase = 'discovering';
        delete stats.currentPage;
        delete stats.pageOffset;
        cursor = page;
        await this.prisma.syncRun.update({ where: { id: activeRunId }, data: { cursor, stats, error: null } });
      }
      stats.phase = 'completed';
      delete stats.currentPage;
      delete stats.pageOffset;
      await this.prisma.syncRun.update({ where: { id: activeRunId }, data: { finishedAt: new Date(), stats, error: null } });
      await this.prisma.rdConnection.update({ where: { accountId }, data: { lastFullSyncAt: new Date(), status: 'active', lastError: null } });
    } catch (e) {
      const message = erroCurto(e);
      if (runId) {
        stats.erros++;
        stats.contactsFailed++;
        await this.prisma.syncRun.update({ where: { id: runId }, data: { cursor, stats, error: message } });
        await this.conn.marcarErro(accountId, e);
      }
      throw e;
    } finally { this.emAndamento.delete(accountId); }
  }

  private reservar(accountId: string): void {
    if (this.emAndamento.has(accountId)) throw new BusinessError('Já existe uma sincronização em andamento');
    this.emAndamento.add(accountId);
  }

  /** Discover the entire membership generation before attempting optional detail/history work. */
  async reconcileSegment(accountId: string, segmentId: string, runId: string): Promise<void> {
    const run = await this.prisma.syncRun.findFirst({ where: { id: runId, accountId, segmentId, kind: { in: ['full', 'delta'] } } });
    if (!run) throw new NotFoundError('Execução não encontrada');
    if (run.finishedAt) return;
    const delta = run.kind === 'delta';
    this.reservar(accountId);
    let cursor = run.cursor;
    const stats: Stats = { lidos: 0, criados: 0, atualizados: 0, erros: 0, phase: 'discovering', contactsDiscovered: 0, contactsImported: 0, contactsEnriched: 0, contactsWithHistory: 0, contactsFailed: 0, ...(run.stats as Partial<Stats>) };
    stats.erros = 0; stats.contactsFailed = 0;
    const where = { accountId, segmentationRdId: segmentId };
    const runWhere = { id: runId, accountId };
    // ponytail: a one-hour freshness window avoids repeated overlap work; configurable budgets belong to #20.
    const freshSince = new Date(run.startedAt.getTime() - 60 * 60 * 1000);
    const eligible = async (tx: Prisma.TransactionClient = this.prisma): Promise<boolean> => {
      if (delta) {
        const connection = await tx.rdConnection.findUnique({ where: { accountId }, select: { status: true } });
        if (!connection || !['active', 'error'].includes(connection.status)) {
          await tx.syncRun.update({ where: runWhere, data: { status: 'paused', error: 'A conexão RD precisa estar ativa para reconciliar.' } });
          return false;
        }
      }
      const segment = await tx.rdSegmentation.findFirst({ where: { accountId, rdId: segmentId, selected: true, available: true } });
      if (segment) return true;
      await tx.syncRun.update({ where: runWhere, data: { status: 'paused', error: 'Monitoramento pausado ou segmentação indisponível' } });
      return false;
    };
    try {
      if (!await eligible()) return;
      const client = await this.conn.client(accountId);
      await this.prisma.syncRun.update({ where: runWhere, data: { status: 'running', error: null, stats } });
      if (stats.phase === 'discovering') {
        await this.prisma.rdSegmentation.update({ where: { accountId_rdId: { accountId, rdId: segmentId } }, data: { coverage: 'partial' } });
        for (let page = cursor + 1; ; page++) {
          if (!await eligible()) return;
          const response = await client.get<{ contacts: RdContact[] }>(`/platform/segmentations/${encodeURIComponent(segmentId)}/contacts`, { page, page_size: PAGE_SIZE });
          if (!Array.isArray(response.contacts) || response.contacts.some((c) => typeof c.uuid !== 'string' || !c.uuid.trim())) throw new BusinessError('Resposta inválida ao listar contatos do RD');
          const contacts = [...new Map(response.contacts.map((contact) => [contact.uuid, contact])).values()];
          if (!contacts.length) {
            const completed = await this.prisma.$transaction(async (tx) => {
              if (!await eligible(tx)) return false;
              await tx.leadSegmentMembership.updateMany({ where: { ...where, AND: [{ OR: [{ lastSeenRunId: null }, { lastSeenRunId: { not: runId } }] }, { OR: [{ lastMissingRunId: null }, { lastMissingRunId: { not: runId } }] }] }, data: { missingScans: { increment: 1 }, lastMissingRunId: runId } });
              await tx.leadSegmentMembership.deleteMany({ where: { ...where, missingScans: { gte: 2 } } });
              await tx.rdSegmentation.update({ where: { accountId_rdId: { accountId, rdId: segmentId } }, data: { coverage: 'complete', lastScanAt: new Date() } });
              await tx.syncRun.update({ where: runWhere, data: { stats: { ...stats, phase: 'enriching' } } });
              return true;
            });
            if (!completed) return;
            stats.phase = 'enriching';
            break;
          }
          // The page, memberships, and cursor commit together; replay never guesses previous page positions.
          const next = { ...stats };
          const persisted = await this.prisma.$transaction(async (tx) => {
            if (!await eligible(tx)) return false;
            for (const contact of contacts) {
              const previous = await tx.leadSegmentMembership.findUnique({ where: { accountId_segmentationRdId_leadRdUuid: { ...where, leadRdUuid: contact.uuid } } });
              const lead = await tx.lead.findUnique({ where: { accountId_rdUuid: { accountId, rdUuid: contact.uuid } }, select: { id: true, enrichedAt: true, historySyncedAt: true, lastConversionAt: true } });
              const hintValue = contact.last_conversion_date;
              const hint = typeof hintValue === 'string' && hintValue.trim() ? new Date(hintValue) : null;
              const validHint = hint && Number.isFinite(hint.getTime()) ? hint : null;
              const hintChanged = !!validHint && (!lead?.lastConversionAt || validHint > lead.lastConversionAt);
              const historyOld = !lead?.historySyncedAt || lead.historySyncedAt < freshSince;
              let eventsPending = !lead?.historySyncedAt || (validHint ? hintChanged : historyOld);
              if (previous?.lastSeenRunId === runId) eventsPending ||= previous.eventsPending;
              await tx.lead.upsert({ where: { accountId_rdUuid: { accountId, rdUuid: contact.uuid } }, create: { accountId, ...mapContact(contact, null, []).lead }, update: {} });
              await tx.leadSegmentMembership.upsert({
                where: { accountId_segmentationRdId_leadRdUuid: { ...where, leadRdUuid: contact.uuid } },
                create: { ...where, leadRdUuid: contact.uuid, lastSeenRunId: runId, ...(delta ? { eventsPending } : {}) },
                update: { lastSeenRunId: runId, lastSeenAt: new Date(), missingScans: 0, lastMissingRunId: null, ...(delta ? { eventsPending } : {}) },
              });
              if (previous?.lastSeenRunId !== runId) {
                next.contactsDiscovered++; next.contactsImported++; next.lidos++;
                if (lead) next.atualizados++; else next.criados++;
              }
            }
            await tx.syncRun.update({ where: runWhere, data: { cursor: page, stats: next } });
            return true;
          }, { timeout: 30_000 });
          if (!persisted) return;
          Object.assign(stats, next); cursor = page;
        }
      }
      for (const phase of ['enriching', 'history'] as const) {
        if (stats.phase !== phase) continue;
        for (;;) {
          if (!await eligible()) return;
          const members = await this.prisma.leadSegmentMembership.findMany({ where: { ...where, lastSeenRunId: runId, ...(typeof stats.afterUuid === 'string' ? { leadRdUuid: { gt: stats.afterUuid } } : {}) }, orderBy: { leadRdUuid: 'asc' }, take: PAGE_SIZE, include: { lead: { select: { enrichedAt: true, historySyncedAt: true } } } });
          if (!members.length) break;
          for (const member of members) {
            if (!await eligible()) return;
            const freshAt = phase === 'enriching' ? member.lead.enrichedAt : member.lead.historySyncedAt;
            const shouldProcess = delta
              ? phase === 'enriching' ? !member.lead.enrichedAt : member.eventsPending || !member.lead.historySyncedAt
              : !freshAt || freshAt < freshSince;
            if (shouldProcess) {
              if (phase === 'enriching') await this.enriquecerContato(accountId, client, member.leadRdUuid);
              else {
                await this.historicoContato(accountId, client, member.leadRdUuid);
                await this.prisma.leadSegmentMembership.update({ where: { accountId_segmentationRdId_leadRdUuid: { ...where, leadRdUuid: member.leadRdUuid } }, data: { eventsPending: false } });
              }
            }
            if (shouldProcess || !delta) {
              if (phase === 'enriching') stats.contactsEnriched++; else stats.contactsWithHistory++;
            }
            stats.afterUuid = member.leadRdUuid;
            await this.prisma.syncRun.update({ where: runWhere, data: { stats } });
          }
        }
        stats.phase = phase === 'enriching' ? 'history' : 'completed';
        delete stats.afterUuid;
        await this.prisma.syncRun.update({ where: runWhere, data: { stats } });
      }
      if (delta) {
        await this.prisma.$transaction(async (tx) => {
          if (!await eligible(tx)) return;
          await tx.syncRun.update({ where: runWhere, data: { finishedAt: new Date(), status: 'completed', error: null, stats } });
          await tx.rdSegmentation.update({ where: { accountId_rdId: { accountId, rdId: segmentId } }, data: { lastDeltaSyncAt: run.startedAt } });
        });
      } else {
        await this.prisma.syncRun.update({ where: runWhere, data: { finishedAt: new Date(), status: 'completed', error: null, stats } });
      }
    } catch (error) {
      stats.erros++;
      if (stats.phase === 'enriching' || stats.phase === 'history') stats.contactsFailed++;
      if (stats.phase === 'discovering' && error instanceof RdProviderError && error.providerStatus === 404) {
        await this.prisma.rdSegmentation.updateMany({ where: { accountId, rdId: segmentId }, data: { available: false } });
      }
      const reauth = delta && error instanceof RdProviderError && error.providerStatus === 401;
      await this.prisma.syncRun.update({ where: runWhere, data: { status: reauth ? 'paused' : cursor > 0 ? 'partial' : 'failed', stats, error: reauth ? 'Autorize novamente a conexão RD para retomar.' : 'Falha na sincronização RD; tente retomar.' } });
      await this.conn.marcarErro(accountId, error);
      throw error;
    } finally { this.emAndamento.delete(accountId); }
  }

  /** Usado também para delta/webhook: executa as mesmas etapas sem cursor de página. */
  async upsertContato(accountId: string, client: RdClient, uuid: string, stats?: Stats): Promise<void> {
    const contato = await client.get<RdContact>(`/platform/contacts/uuid:${uuid}`);
    await this.importarContatoBase(accountId, contato, stats);
    await this.enriquecerContato(accountId, client, uuid);
    if (stats) stats.contactsEnriched++;
    await this.historicoContato(accountId, client, uuid);
    if (stats) stats.contactsWithHistory++;
  }

  private async importarContatoBase(accountId: string, contato: RdContact, stats?: Stats): Promise<void> {
    const m = mapContact(contato, null, []);
    let existente = false;
    const update: Record<string, unknown> = { syncedAt: new Date() };
    const fields: Array<[keyof RdContact, keyof typeof m.lead]> = [
      ['name', 'name'], ['email', 'email'], ['personal_phone', 'phone'], ['city', 'city'], ['state', 'state'],
      ['country', 'country'], ['job_title', 'jobTitle'], ['website', 'website'], ['tags', 'tags'], ['created_at', 'rdCreatedAt'],
    ];
    for (const [source, target] of fields) if (source in contato) update[target] = m.lead[target];
    const known = new Set(['uuid', 'name', 'email', 'personal_phone', 'mobile_phone', 'city', 'state', 'country', 'job_title', 'website', 'tags', 'created_at', 'links', 'extra_emails', 'legal_bases', 'bio', 'birthdate', 'twitter', 'facebook', 'linkedin']);
    if (Object.keys(contato).some((key) => !known.has(key))) update.customFields = m.lead.customFields;
    await this.prisma.$transaction(async (tx) => {
      await this.lockWebhookLead(tx, accountId, contato.uuid);
      const prior = await tx.lead.findUnique({ where: { accountId_rdUuid: { accountId, rdUuid: contato.uuid } }, select: { webhookProfileAt: true } });
      existente = !!prior;
      await tx.lead.upsert({ where: { accountId_rdUuid: { accountId, rdUuid: contato.uuid } }, create: { accountId, ...m.lead }, update: prior?.webhookProfileAt ? { syncedAt: update.syncedAt } : update });
    });
    if (stats) { if (existente) stats.atualizados++; else stats.criados++; }
  }

  private async enriquecerContato(accountId: string, client: RdClient, uuid: string): Promise<void> {
    const webhookProfileVersion = await this.webhookProfileVersion(accountId, uuid);
    const coverage = await this.cobertura(accountId, uuid);
    let contato: RdContact;
    try {
      contato = await client.get<RdContact>(`/platform/contacts/uuid:${uuid}`);
      if (!contato || contato.uuid !== uuid) throw new Error('Resposta inválida ao consultar contato RD');
      const textFields = ['name', 'email', 'personal_phone', 'mobile_phone', 'city', 'state', 'country', 'job_title', 'website'];
      if (textFields.some((field) => contato[field] != null && typeof contato[field] !== 'string')
        || (contato.tags != null && (!Array.isArray(contato.tags) || contato.tags.some((tag) => typeof tag !== 'string')))
        || (contato.created_at != null && (typeof contato.created_at !== 'string' || !Number.isFinite(new Date(contato.created_at).getTime())))) {
        throw new Error('Campos inválidos ao consultar contato RD');
      }
    } catch (error) {
      if (error instanceof RefreshBudgetExhaustedError) throw error;
      coverage.details = this.endpointError(error);
      await this.salvarCobertura(accountId, uuid, coverage);
      throw error;
    }
    coverage.details = this.endpointOk();
    let funil: RdFunnel | null = null;
    let funnelError: Error | undefined;
    try {
      funil = await client.get<RdFunnel>(`/platform/contacts/uuid:${uuid}/funnels/default`);
      assertRdFunnel(funil);
      coverage.funnel = this.endpointOk();
    } catch (error) {
      funil = null;
      coverage.funnel = this.endpointError(error);
      if (!(error instanceof RdProviderError && error.providerStatus === 404)) funnelError = error instanceof Error ? error : new Error('Falha ao consultar funil RD');
    }

    const mapped = mapContact(contato, funil, []);
    const update: Record<string, unknown> = {};
    const detailFields: Array<[keyof RdContact, keyof typeof mapped.lead]> = [
      ['name', 'name'], ['email', 'email'], ['city', 'city'], ['state', 'state'],
      ['country', 'country'], ['job_title', 'jobTitle'], ['website', 'website'], ['tags', 'tags'], ['created_at', 'rdCreatedAt'],
    ];
    for (const [source, target] of detailFields) if (source in contato) update[target] = mapped.lead[target];
    if ('personal_phone' in contato || 'mobile_phone' in contato) update.phone = mapped.lead.phone;
    for (const [source, target] of [['lifecycle_stage', 'lifecycleStage'], ['opportunity', 'opportunity'], ['fit', 'fit'], ['interest', 'interest']] as const) {
      if (funil && source in funil) update[target] = mapped.lead[target];
    }
    const known = new Set(['uuid', 'name', 'email', 'personal_phone', 'mobile_phone', 'city', 'state', 'country', 'job_title', 'website', 'tags', 'created_at', 'links', 'extra_emails', 'legal_bases', 'bio', 'birthdate', 'twitter', 'facebook', 'linkedin']);
    if (Object.keys(contato).some((key) => !known.has(key))) update.customFields = mapped.lead.customFields;
    const missing: string[] = [];
    for (const [field, present] of [
      ['name', 'name' in contato && contato.name != null], ['email', 'email' in contato && contato.email != null],
      ['phone', ('personal_phone' in contato && contato.personal_phone != null) || ('mobile_phone' in contato && contato.mobile_phone != null)],
      ['jobTitle', 'job_title' in contato && contato.job_title != null],
      ['city', 'city' in contato && contato.city != null], ['state', 'state' in contato && contato.state != null],
    ] as Array<[string, boolean]>) if (!present) missing.push(field);
    if (funil) for (const [field, source] of [['lifecycleStage', 'lifecycle_stage'], ['fit', 'fit'], ['interest', 'interest']]) {
      if (!(source in funil) || funil[source as keyof RdFunnel] == null) missing.push(field);
    }
    coverage.missingFields = missing as LeadDataCoverage['missingFields'];
    await this.updateProfileIfUnchanged(accountId, uuid, webhookProfileVersion, { ...update, ...(funnelError ? {} : { enrichedAt: new Date() }), dataCoverage: coverage as Prisma.InputJsonValue });
    if (funnelError) throw funnelError;
  }

  private async historicoContato(accountId: string, client: RdClient, uuid: string): Promise<void> {
    const coverage = await this.cobertura(accountId, uuid);
    const events: RdEvent[] = [];
    let conversionsComplete = false;
    for (const type of ['CONVERSION', 'OPPORTUNITY'] as const) {
      try {
        const found = await this.eventosTipo(client, uuid, type);
        events.push(...found);
        coverage[type === 'CONVERSION' ? 'conversions' : 'opportunities'] = this.endpointOk();
        if (type === 'CONVERSION') conversionsComplete = true;
      } catch (error) {
        coverage[type === 'CONVERSION' ? 'conversions' : 'opportunities'] = this.endpointError(error);
        await this.persistirEventos(accountId, uuid, events, coverage, conversionsComplete, false);
        throw error;
      }
    }
    await this.persistirEventos(accountId, uuid, events, coverage, true, true);
  }

  private async eventosTipo(client: RdClient, uuid: string, type: RdEvent['event_type']): Promise<RdEvent[]> {
    const out = new Map<string, RdEvent>();
    for (let page = 1; ; page++) {
      const r = await client.get<{ events?: RdEvent[] } | RdEvent[]>(`/platform/contacts/${uuid}/events`, { event_type: type, page });
      const lista = Array.isArray(r) ? r : r?.events;
      if (!Array.isArray(lista)) throw new Error('Resposta inválida ao listar eventos RD');
      let novos = 0;
      for (const event of lista) {
        if (!event || !['CONVERSION', 'OPPORTUNITY'].includes(event.event_type) || typeof event.event_identifier !== 'string' || typeof event.event_timestamp !== 'string' || !Number.isFinite(new Date(event.event_timestamp).getTime())) throw new Error('Evento inválido recebido do RD');
        const key = rdEventKey(event);
        if (!out.has(key)) { out.set(key, event); novos++; }
      }
      if (lista.length < EVENT_PAGE_SIZE) break;
      if (novos === 0) throw new Error(`Paginação de eventos RD sem avanço (${type}, página ${page})`);
    }
    return [...out.values()];
  }

  private endpointOk(): LeadDataEndpointView { return { status: 'available', checkedAt: new Date().toISOString(), reason: null }; }
  private endpointError(error: unknown): LeadDataEndpointView {
    const status = error instanceof RdProviderError ? error.providerStatus : undefined;
    const unavailable = status === 403 || status === 404;
    return { status: unavailable ? 'unavailable' : 'partial', checkedAt: new Date().toISOString(), reason: unavailable ? `HTTP ${status}` : 'Falha temporária no provedor' };
  }

  private async cobertura(accountId: string, uuid: string): Promise<LeadDataCoverage> {
    const lead = await this.prisma.lead.findUnique({ where: { accountId_rdUuid: { accountId, rdUuid: uuid } }, select: { dataCoverage: true } });
    const raw = lead?.dataCoverage as Partial<LeadDataCoverage> | null;
    const unknown = (): LeadDataEndpointView => ({ status: 'unknown', checkedAt: null, reason: null });
    return {
      details: raw?.details ?? unknown(), funnel: raw?.funnel ?? unknown(), conversions: raw?.conversions ?? unknown(), opportunities: raw?.opportunities ?? unknown(),
      missingFields: raw?.missingFields ?? [],
    };
  }

  private async salvarCobertura(accountId: string, uuid: string, coverage: LeadDataCoverage): Promise<void> {
    await this.prisma.lead.update({ where: { accountId_rdUuid: { accountId, rdUuid: uuid } }, data: { dataCoverage: coverage as Prisma.InputJsonValue } });
  }

  private async persistirEventos(accountId: string, uuid: string, events: RdEvent[], coverage: LeadDataCoverage, conversionOk: boolean, complete: boolean): Promise<void> {
    const mapped = mapContact({ uuid }, null, events);
    await this.prisma.$transaction(async (tx) => {
      await this.lockWebhookLead(tx, accountId, uuid);
      const lead = await tx.lead.findUnique({ where: { accountId_rdUuid: { accountId, rdUuid: uuid } }, select: { id: true } });
      if (!lead) throw new NotFoundError('Lead não encontrado');
      if (mapped.events.length) await tx.leadEvent.createMany({ data: mapped.events.map((event) => ({ ...event, accountId, leadId: lead.id })), skipDuplicates: true });
      const aggregate = conversionOk ? await this.conversionAggregate(tx, accountId, lead.id) : {};
      await tx.lead.update({
        where: { accountId_rdUuid: { accountId, rdUuid: uuid } },
        data: { ...aggregate, dataCoverage: coverage as Prisma.InputJsonValue, ...(complete ? { historySyncedAt: new Date() } : {}) },
      });
    });
  }

  /** One-platform-request steps used by the budgeted rotating refresh. */
  async refreshDetails(accountId: string, client: RdClient, uuid: string): Promise<void> {
    const webhookProfileVersion = await this.webhookProfileVersion(accountId, uuid);
    const coverage = await this.cobertura(accountId, uuid);
    let contact: RdContact;
    try {
      contact = await client.get<RdContact>(`/platform/contacts/uuid:${uuid}`);
      if (!contact || contact.uuid !== uuid) throw new Error('Resposta inválida ao consultar contato RD');
      const textFields = ['name', 'email', 'personal_phone', 'mobile_phone', 'city', 'state', 'country', 'job_title', 'website'];
      if (textFields.some((field) => contact[field] != null && typeof contact[field] !== 'string')
        || (contact.tags != null && (!Array.isArray(contact.tags) || contact.tags.some((tag) => typeof tag !== 'string')))
        || (contact.created_at != null && (typeof contact.created_at !== 'string' || !Number.isFinite(new Date(contact.created_at).getTime())))) throw new Error('Campos inválidos ao consultar contato RD');
    } catch (error) {
      if (error instanceof RefreshBudgetExhaustedError) throw error;
      coverage.details = this.endpointError(error);
      await this.salvarCobertura(accountId, uuid, coverage);
      throw error;
    }
    coverage.details = this.endpointOk();
    const mapped = mapContact(contact, null, []).lead;
    coverage.missingFields = [];
    for (const [field, present] of [
      ['name', contact.name != null], ['email', contact.email != null],
      ['phone', contact.personal_phone != null || contact.mobile_phone != null],
      ['jobTitle', contact.job_title != null], ['city', contact.city != null], ['state', contact.state != null],
    ] as Array<[string, boolean]>) if (!present) coverage.missingFields.push(field as LeadDataCoverage['missingFields'][number]);
    const update: Record<string, unknown> = {};
    for (const [source, target] of [['name', 'name'], ['email', 'email'], ['personal_phone', 'phone'], ['mobile_phone', 'phone'], ['city', 'city'], ['state', 'state'], ['country', 'country'], ['job_title', 'jobTitle'], ['website', 'website'], ['tags', 'tags'], ['created_at', 'rdCreatedAt']] as const) {
      if (source in contact) update[target] = mapped[target as keyof typeof mapped];
    }
    const known = new Set(['uuid', 'name', 'email', 'personal_phone', 'mobile_phone', 'city', 'state', 'country', 'job_title', 'website', 'tags', 'created_at', 'links', 'extra_emails', 'legal_bases', 'bio', 'birthdate', 'twitter', 'facebook', 'linkedin']);
    if (Object.keys(contact).some((key) => !known.has(key))) update.customFields = mapped.customFields;
    await this.updateProfileIfUnchanged(accountId, uuid, webhookProfileVersion, { ...update, dataCoverage: coverage as Prisma.InputJsonValue });
  }

  async refreshFunnel(accountId: string, client: RdClient, uuid: string): Promise<void> {
    const webhookProfileVersion = await this.webhookProfileVersion(accountId, uuid);
    const coverage = await this.cobertura(accountId, uuid);
    let funnel: RdFunnel | null = null;
    try {
      funnel = await client.get<RdFunnel>(`/platform/contacts/uuid:${uuid}/funnels/default`);
      assertRdFunnel(funnel);
      coverage.funnel = this.endpointOk();
    } catch (error) {
      if (error instanceof RefreshBudgetExhaustedError) throw error;
      coverage.funnel = this.endpointError(error);
      await this.salvarCobertura(accountId, uuid, coverage);
      if (!(error instanceof RdProviderError && error.providerStatus === 404)) throw error;
    }
    if (funnel) for (const [field, source] of [['lifecycleStage', 'lifecycle_stage'], ['fit', 'fit'], ['interest', 'interest']] as const) {
      if (!(source in funnel) || funnel[source] == null) coverage.missingFields.push(field);
    }
    const mapped = mapContact({ uuid }, funnel, []).lead;
    const update: Record<string, unknown> = {};
    if (funnel) for (const [source, target] of [['lifecycle_stage', 'lifecycleStage'], ['opportunity', 'opportunity'], ['fit', 'fit'], ['interest', 'interest']] as const) {
      if (source in funnel) update[target] = mapped[target];
    }
    await this.updateProfileIfUnchanged(accountId, uuid, webhookProfileVersion, { ...update, enrichedAt: new Date(), dataCoverage: coverage as Prisma.InputJsonValue });
  }

  async refreshEventPage(accountId: string, client: RdClient, uuid: string, type: RdEvent['event_type'], page: number): Promise<boolean> {
    const coverage = await this.cobertura(accountId, uuid);
    try {
      const response = await client.get<{ events?: RdEvent[] } | RdEvent[]>(`/platform/contacts/${uuid}/events`, { event_type: type, page });
      const events = Array.isArray(response) ? response : response?.events;
      if (!Array.isArray(events)) throw new Error('Resposta inválida ao listar eventos RD');
      for (const event of events) if (!event || event.event_type !== type || typeof event.event_identifier !== 'string' || typeof event.event_timestamp !== 'string' || !Number.isFinite(new Date(event.event_timestamp).getTime())) throw new Error('Evento inválido recebido do RD');
      const mapped = mapContact({ uuid }, null, events).events;
      const more = events.length === EVENT_PAGE_SIZE;
      coverage[type === 'CONVERSION' ? 'conversions' : 'opportunities'] = more
        ? { status: 'partial', checkedAt: new Date().toISOString(), reason: null }
        : this.endpointOk();
      await this.prisma.$transaction(async (tx) => {
        await this.lockWebhookLead(tx, accountId, uuid);
        const lead = await tx.lead.findUniqueOrThrow({ where: { accountId_rdUuid: { accountId, rdUuid: uuid } }, select: { id: true } });
        if (mapped.length) await tx.leadEvent.createMany({ data: mapped.map((event) => ({ ...event, accountId, leadId: lead.id })), skipDuplicates: true });
        const aggregate = type === 'CONVERSION' ? await this.conversionAggregate(tx, accountId, lead.id) : {};
        await tx.lead.update({ where: { accountId_rdUuid: { accountId, rdUuid: uuid } }, data: { ...aggregate, dataCoverage: coverage as Prisma.InputJsonValue } });
      });
      return more;
    } catch (error) {
      if (error instanceof RefreshBudgetExhaustedError) throw error;
      coverage[type === 'CONVERSION' ? 'conversions' : 'opportunities'] = this.endpointError(error);
      await this.salvarCobertura(accountId, uuid, coverage);
      throw error;
    }
  }

  async completeRefreshHistory(accountId: string, uuid: string, conversionsComplete: boolean): Promise<void> {
    if (!conversionsComplete) return;
    const coverage = await this.cobertura(accountId, uuid);
    await this.prisma.$transaction(async (tx) => {
      await this.lockWebhookLead(tx, accountId, uuid);
      const lead = await tx.lead.findUniqueOrThrow({ where: { accountId_rdUuid: { accountId, rdUuid: uuid } }, select: { id: true } });
      const aggregate = await this.conversionAggregate(tx, accountId, lead.id);
      await tx.lead.update({ where: { accountId_rdUuid: { accountId, rdUuid: uuid } }, data: { ...aggregate, historySyncedAt: new Date(), dataCoverage: coverage as Prisma.InputJsonValue } });
    });
  }

  private async lockWebhookLead(tx: Prisma.TransactionClient, accountId: string, uuid: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rd-webhook-lead:${accountId}:${uuid}`}, 6))`;
  }

  private async webhookProfileVersion(accountId: string, uuid: string): Promise<number> {
    const lead = await this.prisma.lead.findUnique({ where: { accountId_rdUuid: { accountId, rdUuid: uuid } }, select: { webhookProfileVersion: true } });
    return lead?.webhookProfileVersion ?? 0;
  }

  private async updateProfileIfUnchanged(accountId: string, uuid: string, webhookProfileVersion: number, data: Record<string, unknown>): Promise<void> {
    await this.prisma.lead.updateMany({ where: { accountId, rdUuid: uuid, webhookProfileVersion }, data: data as Prisma.LeadUpdateManyMutationInput });
  }

  private async conversionAggregate(tx: Prisma.TransactionClient, accountId: string, leadId: string): Promise<{ conversionsCount: number; firstConversionAt: Date | null; lastConversionAt: Date | null }> {
    const events = await tx.leadEvent.findMany({ where: { accountId, leadId, type: 'CONVERSION' }, select: { occurredAt: true }, orderBy: { occurredAt: 'asc' } });
    return { conversionsCount: events.length, firstConversionAt: events[0]?.occurredAt ?? null, lastConversionAt: events.at(-1)?.occurredAt ?? null };
  }

  private async checkpoint(runId: string, cursor: number, stats: Stats): Promise<void> {
    await this.prisma.syncRun.update({ where: { id: runId }, data: { cursor, stats, error: null } });
  }

  private async emLotes<T>(itens: T[], n: number, fn: (start: number) => Promise<void>): Promise<void> {
    for (let i = 0; i < itens.length; i += n) await fn(i);
  }

  async status(accountId: string): Promise<SyncRunView | null> {
    const r = await this.prisma.syncRun.findFirst({ where: { accountId }, orderBy: { startedAt: 'desc' } });
    return r ? { id: r.id, segmentId: r.segmentId, status: r.status as SyncRunView['status'], kind: r.kind, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, cursor: r.cursor, stats: r.stats as unknown as SyncRunView['stats'], error: r.error, emAndamento: this.emAndamento.has(accountId) } : null;
  }

  async runs(accountId: string, query: SyncRunsQuery, queueStatuses: ReadonlyMap<string, { status: 'queued' | 'running' | 'partial'; error?: string; emAndamento: boolean }> = new Map()): Promise<SyncRunPage> {
    if (query.segmentId && !await this.prisma.rdSegmentation.findUnique({ where: { accountId_rdId: { accountId, rdId: query.segmentId } }, select: { id: true } })) {
      throw new NotFoundError('Segmentação não encontrada');
    }
    if (query.cursor && !await this.prisma.syncRun.findFirst({ where: { accountId, id: query.cursor }, select: { id: true } })) {
      throw new NotFoundError('Execução não encontrada');
    }
    const where: Prisma.SyncRunWhereInput = {
      accountId,
      ...(query.segmentId ? { segmentId: query.segmentId } : {}),
      ...(query.status ? { OR: [{ status: query.status }, { id: { in: [...queueStatuses.keys()] } }] } : {}),
    };
    const found: SyncRunView[] = [];
    let cursor = query.cursor;
    let hasNextPage = false;
    while (found.length <= query.pageSize) {
      const batch = await this.prisma.syncRun.findMany({
        where,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: query.pageSize + 1,
      });
      if (!batch.length) break;
      for (const r of batch) {
        cursor = r.id;
        const queueState = queueStatuses.get(r.id);
        const status = queueState?.status ?? r.status as SyncRunView['status'];
        const run: SyncRunView = {
          id: r.id, segmentId: r.segmentId, status, kind: r.kind, startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt?.toISOString() ?? null, cursor: r.cursor, stats: r.stats as unknown as SyncRunView['stats'],
          error: r.error ?? queueState?.error ?? null, emAndamento: queueState?.emAndamento ?? (!r.finishedAt && !r.error && ['queued', 'running'].includes(r.status)),
        };
        if (!query.status || run.status === query.status) found.push(run);
        if (found.length > query.pageSize) { hasNextPage = true; break; }
      }
      if (hasNextPage || batch.length < query.pageSize + 1) break;
    }
    const items = found.slice(0, query.pageSize);
    return { items, nextCursor: hasNextPage ? items.at(-1)?.id ?? null : null, hasPreviousPage: Boolean(query.cursor) };
  }
}
