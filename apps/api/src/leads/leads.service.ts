import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { LEADS_DATE_TIME_ZONE } from '@rd/shared';
import type { LeadDetail, LeadFacets, LeadRow, LeadsQuery, Page } from '@rd/shared';
import { leadDataCoverageSchema } from '@rd/shared';
import { NotFoundError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

export function accountDayStart(day: Date, timeZone = LEADS_DATE_TIME_ZONE): Date {
  const accountDayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const civilDay = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const partsAt = (instant: number) => Object.fromEntries(accountDayFormatter.formatToParts(instant).map(({ type, value }) => [type, value]));
  const offsets = new Set<number>();
  for (const hours of [-48, -24, 0, 24, 48]) {
    const sample = civilDay + hours * 3_600_000;
    const parts = partsAt(sample);
    const localAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    offsets.add(localAsUtc - sample);
  }
  const starts = [...offsets].map((offset) => civilDay - offset).filter((instant) => {
    const parts = partsAt(instant);
    return Number(parts.year) === day.getUTCFullYear() && Number(parts.month) === day.getUTCMonth() + 1 && Number(parts.day) === day.getUTCDate();
  });
  if (!starts.length) throw new RangeError(`No start of civil day in ${LEADS_DATE_TIME_ZONE}`);
  return new Date(Math.min(...starts));
}

export function nextCivilDay(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1));
}

export function buildWhere(accountId: string, q: LeadsQuery): Prisma.LeadWhereInput {
  const w: Prisma.LeadWhereInput = { accountId };
  if (q.q) w.OR = ['name', 'email', 'phone', 'company'].map((f) => ({ [f]: { contains: q.q, mode: 'insensitive' } }));
  if (q.tags?.length) w.tags = { hasEvery: q.tags };
  if (q.aiScore) w.aiScore = q.aiScore;
  if (q.lifecycleStage?.length) w.lifecycleStage = { in: q.lifecycleStage };
  if (q.segmentIds?.length) {
    const activeSegment = { accountId, selected: true, available: true };
    if (q.segmentMatch === 'all') {
      w.AND = q.segmentIds.map((segmentationRdId) => ({
        segmentMemberships: { some: { accountId, segmentationRdId, segmentation: { is: activeSegment } } },
      }));
    } else {
      w.segmentMemberships = { some: { accountId, segmentationRdId: { in: q.segmentIds }, segmentation: { is: activeSegment } } };
    }
  }
  if (q.oportunidade !== undefined) w.opportunity = q.oportunidade;
  if (q.cidade) w.city = { contains: q.cidade, mode: 'insensitive' };
  if (q.uf?.length === 2) w.state = q.uf;
  if (q.aiScore) w.aiScore = q.aiScore;
  if (q.de || q.ate) {
    const endExclusive = q.ate ? accountDayStart(nextCivilDay(q.ate)) : undefined;
    w.lastConversionAt = { ...(q.de ? { gte: accountDayStart(q.de) } : {}), ...(endExclusive ? { lt: endExclusive } : {}) };
  }
  if (q.conversao) w.events = { some: { identifier: { contains: q.conversao, mode: 'insensitive' } } };
  return w;
}

const rowSelect = (accountId: string) => ({
  id: true, rdUuid: true, name: true, email: true, phone: true, city: true, state: true, company: true, jobTitle: true,
  tags: true, lifecycleStage: true, opportunity: true, fit: true, interest: true, conversionsCount: true, aiScore: true,
  firstConversionAt: true, lastConversionAt: true, rdCreatedAt: true,
  segmentMemberships: {
    where: { accountId, segmentation: { is: { accountId, selected: true, available: true } } },
    select: { segmentation: { select: { rdId: true, name: true } } },
  },
} as const);
type Row = Prisma.LeadGetPayload<{ select: ReturnType<typeof rowSelect> }>;
const iso = (d: Date | null): string | null => d?.toISOString() ?? null;
const csvCell = (value: unknown): string => {
  let text = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join(' | ') : value == null ? '' : typeof value === 'boolean' ? value ? 'Sim' : 'Não' : String(value);
  if (/^[\s=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};
const toRow = (l: Row): LeadRow => ({
  id: l.id, rdUuid: l.rdUuid, name: l.name, email: l.email, phone: l.phone, city: l.city, state: l.state,
  company: l.company, jobTitle: l.jobTitle, tags: l.tags, lifecycleStage: l.lifecycleStage, opportunity: l.opportunity,
  fit: l.fit, interest: l.interest, conversionsCount: l.conversionsCount,
  aiScore: l.aiScore,
  firstConversionAt: iso(l.firstConversionAt), lastConversionAt: iso(l.lastConversionAt), rdCreatedAt: iso(l.rdCreatedAt),
  segments: l.segmentMemberships.map(({ segmentation }) => ({ id: segmentation.rdId, name: segmentation.name })).sort((a, b) => a.name.localeCompare(b.name)),
});

@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(accountId: string, q: LeadsQuery): Promise<Page<LeadRow>> {
    await this.validateSegmentFilter(accountId, q);
    const where = buildWhere(accountId, q);
    const [items, total] = await Promise.all([
      this.prisma.lead.findMany({ where, select: rowSelect(accountId), orderBy: [{ [q.sort]: q.dir }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.lead.count({ where }),
    ]);
    return { items: items.map(toRow), total, page: q.page, pageSize: q.pageSize };
  }

  async exportCsv(accountId: string, q: LeadsQuery): Promise<AsyncGenerator<string>> {
    await this.validateSegmentFilter(accountId, q);
    return this.streamCsv(accountId, q);
  }

  private async *streamCsv(accountId: string, q: LeadsQuery): AsyncGenerator<string> {
    const where = buildWhere(accountId, q);
    const columns: Array<(lead: Row) => unknown> = [
      (lead) => lead.name, (lead) => lead.email, (lead) => lead.phone, (lead) => lead.company, (lead) => lead.jobTitle,
      (lead) => lead.lifecycleStage, (lead) => lead.opportunity, (lead) => lead.tags, (lead) => lead.conversionsCount,
      (lead) => lead.firstConversionAt, (lead) => lead.lastConversionAt, (lead) => lead.city, (lead) => lead.state,
      (lead) => lead.rdCreatedAt, (lead) => lead.segmentMemberships.map(({ segmentation }) => segmentation.name),
    ];
    yield '\uFEFF"Nome";"E-mail";"Telefone";"Empresa";"Cargo";"Estágio";"Oportunidade";"Tags";"Conversões";"Primeira conversão";"Última conversão";"Cidade";"UF";"Criado em";"Segmentações"\r\n';
    let cursor: string | undefined;
    while (true) {
      const leads = await this.prisma.lead.findMany({
        where, select: rowSelect(accountId), orderBy: [{ [q.sort]: q.dir }, { id: 'asc' }], take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const lead of leads) yield `${columns.map((value) => csvCell(value(lead))).join(';')}\r\n`;
      if (leads.length < 500) break;
      cursor = leads.at(-1)!.id;
    }
  }

  async facets(accountId: string, q: LeadsQuery): Promise<LeadFacets> {
    await this.validateSegmentFilter(accountId, q);
    const where = buildWhere(accountId, q);
    const tagCounts = new Map<string, number>();
    const stageCounts = new Map<string, number>();
    const conversionCounts = new Map<string, number>();
    let cursor: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const leads = await this.prisma.lead.findMany({
        where, select: { id: true, tags: true, lifecycleStage: true }, orderBy: { id: 'asc' }, take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!leads.length) break;
      for (const lead of leads) {
        for (const tag of new Set(lead.tags)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        if (lead.lifecycleStage !== null) stageCounts.set(lead.lifecycleStage, (stageCounts.get(lead.lifecycleStage) ?? 0) + 1);
      }
      const events = await this.prisma.leadEvent.findMany({
        where: { accountId, leadId: { in: leads.map(({ id }) => id) }, type: 'CONVERSION' },
        select: { leadId: true, identifier: true }, distinct: ['leadId', 'identifier'],
      });
      const seenEvents = new Set<string>();
      for (const event of events) {
        const key = `${event.leadId}\0${event.identifier}`;
        if (seenEvents.has(key)) continue;
        seenEvents.add(key);
        conversionCounts.set(event.identifier, (conversionCounts.get(event.identifier) ?? 0) + 1);
      }
      cursor = leads.at(-1)!.id;
      hasMore = leads.length === 500;
    }
    const sorted = (counts: Map<string, number>, limit = Number.MAX_SAFE_INTEGER) => [...counts].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, limit);
    return {
      tags: sorted(tagCounts, 100),
      lifecycleStages: sorted(stageCounts),
      conversoes: sorted(conversionCounts, 50),
    };
  }

  async detail(accountId: string, id: string): Promise<LeadDetail> {
    // Corte por conta no próprio where: lead de outra conta → 404, nunca 403.
    const l = await this.prisma.lead.findFirst({ where: { id, accountId }, select: { ...rowSelect(accountId), customFields: true, enrichedAt: true, historySyncedAt: true, dataCoverage: true, events: { orderBy: { occurredAt: 'desc' }, select: { id: true, type: true, identifier: true, occurredAt: true, payload: true } } } });
    if (!l) throw new NotFoundError('Lead não encontrado');
    return { ...toRow(l), dataFreshness: { enrichedAt: iso(l.enrichedAt), historySyncedAt: iso(l.historySyncedAt), coverage: leadDataCoverageSchema.parse(l.dataCoverage ?? {}) }, customFields: (l.customFields ?? {}) as Record<string, unknown>, events: l.events.map((e) => ({ id: e.id, type: e.type, identifier: e.identifier, occurredAt: e.occurredAt.toISOString(), payload: (e.payload ?? {}) as Record<string, unknown> })) };
  }

  async validateSegmentFilter(accountId: string, q: LeadsQuery): Promise<void> {
    if (!q.segmentIds?.length) return;
    const active = await this.prisma.rdSegmentation.findMany({
      where: { accountId, rdId: { in: q.segmentIds }, selected: true, available: true },
      select: { rdId: true },
    });
    if (active.length !== q.segmentIds.length) throw new NotFoundError('Segmentação não encontrada');
  }
}
