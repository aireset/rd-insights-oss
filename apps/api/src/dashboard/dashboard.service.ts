import { Injectable } from '@nestjs/common';
import { leadsQuerySchema } from '@rd/shared';
import type { DashboardSummaryView } from '@rd/shared';
import type { Prisma } from '@prisma/client';
import { NotFoundError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { accountDayStart, buildWhere } from '../leads/leads.service';
import { LEADS_DATE_TIME_ZONE } from '@rd/shared';

export type DashboardPeriod = 7 | 30 | 90;

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async newLeads(accountId: string, input: { period: DashboardPeriod; timeZone?: string; segmentIds?: string[]; segmentMatch?: 'any' | 'all' }) {
    const { period } = input;
    const timeZone = input.timeZone ?? LEADS_DATE_TIME_ZONE;
    const end = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const todayParts = Object.fromEntries(formatter.formatToParts(end).map(({ type, value }) => [type, value]));
    const today = new Date(Date.UTC(Number(todayParts.year), Number(todayParts.month) - 1, Number(todayParts.day)));
    const firstDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - period + 1));
    const start = accountDayStart(firstDay, timeZone);
    const eventDateFormatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const where = { ...await this.segmentWhere(accountId, input), rdCreatedAt: { gte: start, lte: end } };
    const counts = new Map<string, number>();
    let cursor: string | undefined;
    while (true) {
      const leads = await this.prisma.lead.findMany({
        where, select: { id: true, rdCreatedAt: true }, orderBy: { id: 'asc' }, take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const lead of leads) {
        if (!lead.rdCreatedAt) continue;
        const parts = Object.fromEntries(eventDateFormatter.formatToParts(lead.rdCreatedAt).map(({ type, value }) => [type, value]));
        const date = `${parts.year}-${parts.month}-${parts.day}`;
        counts.set(date, (counts.get(date) ?? 0) + 1);
      }
      if (leads.length < 500) break;
      cursor = leads.at(-1)!.id;
    }

    const points = Array.from({ length: period }, (_, i) => {
      const date = new Date(firstDay);
      date.setUTCDate(firstDay.getUTCDate() + i);
      const key = date.toISOString().slice(0, 10);
      return { date: key, count: counts.get(key) ?? 0 };
    });
    return { period, timeZone, total: points.reduce((sum, point) => sum + point.count, 0), points };
  }

  async summary(accountId: string, input: { period: DashboardPeriod; timeZone?: string; segmentIds?: string[]; segmentMatch?: 'any' | 'all' }): Promise<DashboardSummaryView> {
    const where = await this.segmentWhere(accountId, input);
    const { period } = input;
    const timeZone = input.timeZone ?? LEADS_DATE_TIME_ZONE;
    const end = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
    const todayParts = Object.fromEntries(formatter.formatToParts(end).map(({ type, value }) => [type, value]));
    const today = new Date(Date.UTC(Number(todayParts.year), Number(todayParts.month) - 1, Number(todayParts.day)));
    const firstDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - period + 1));
    const start = accountDayStart(firstDay, timeZone);
    const stages = new Map<string, number>();
    const tags = new Map<string, number>();
    const locations = new Map<string, { city: string; state: string | null; leadCount: number }>();
    const conversions = new Map<string, number>();
    const heatmap = new Map<string, { dayOfWeek: number; hour: number; count: number }>();
    let cursor: string | undefined;
    while (true) {
      const leads = await this.prisma.lead.findMany({
        where, select: { id: true, lifecycleStage: true, tags: true, city: true, state: true }, orderBy: { id: 'asc' }, take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!leads.length) break;
      for (const lead of leads) {
        const stage = lead.lifecycleStage ?? 'Sem estágio';
        stages.set(stage, (stages.get(stage) ?? 0) + 1);
        for (const tag of new Set(lead.tags)) tags.set(tag, (tags.get(tag) ?? 0) + 1);
        if (lead.city) {
          const key = `${lead.city}\0${lead.state ?? ''}`;
          const location = locations.get(key) ?? { city: lead.city, state: lead.state, leadCount: 0 };
          location.leadCount++;
          locations.set(key, location);
        }
      }
      const events = await this.prisma.leadEvent.findMany({
        where: { accountId, leadId: { in: leads.map(({ id }) => id) }, type: 'CONVERSION', occurredAt: { gte: start, lte: end } },
        select: { leadId: true, identifier: true, occurredAt: true },
      });
      const seenConversions = new Set<string>();
      for (const event of events) {
        const conversionKey = `${event.leadId}\0${event.identifier}`;
        if (!seenConversions.has(conversionKey)) {
          seenConversions.add(conversionKey);
          conversions.set(event.identifier, (conversions.get(event.identifier) ?? 0) + 1);
        }
        const date = event.occurredAt;
        const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
        const dayOfWeek = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))).getUTCDay();
        const hour = Number(parts.hour);
        const key = `${dayOfWeek}:${hour}`;
        const cell = heatmap.get(key) ?? { dayOfWeek, hour, count: 0 };
        cell.count++;
        heatmap.set(key, cell);
      }
      if (leads.length < 500) break;
      cursor = leads.at(-1)!.id;
    }
    const ranked = <T extends { count?: number; leadCount?: number; name?: string; identifier?: string }>(items: T[]) => items.sort((a, b) =>
      (b.leadCount ?? b.count ?? 0) - (a.leadCount ?? a.count ?? 0) || (a.name ?? a.identifier ?? '').localeCompare(b.name ?? b.identifier ?? ''),
    );
    const rankedLocations = [...locations.values()].sort((a, b) => b.leadCount - a.leadCount || a.city.localeCompare(b.city) || (a.state ?? '').localeCompare(b.state ?? ''));
    return {
      period, timeZone,
      stages: ranked([...stages].map(([name, count]) => ({ name, count }))),
      tags: ranked([...tags].map(([name, leadCount]) => ({ name, leadCount }))).slice(0, 10),
      locations: rankedLocations.slice(0, 10),
      conversions: ranked([...conversions].map(([identifier, leadCount]) => ({ identifier, leadCount }))).slice(0, 10),
      heatmap: [...heatmap.values()].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.hour - b.hour),
    };
  }

  async compareSegments(accountId: string, segmentAId: string, segmentBId: string) {
    const ids = [...new Set([segmentAId, segmentBId])];
    const active = await this.prisma.rdSegmentation.findMany({
      where: { accountId, rdId: { in: ids }, selected: true, available: true },
      select: { rdId: true },
    });
    if (active.length !== ids.length) throw new NotFoundError('Segmentação não encontrada');

    const member = (segmentationRdId: string): Prisma.LeadWhereInput => ({
      segmentMemberships: { some: { accountId, segmentationRdId, segmentation: { is: { accountId, selected: true, available: true } } } },
    });
    const [a, b, overlap] = await Promise.all([
      this.prisma.lead.count({ where: { accountId, ...member(segmentAId) } }),
      this.prisma.lead.count({ where: { accountId, ...member(segmentBId) } }),
      this.prisma.lead.count({ where: { accountId, AND: [member(segmentAId), member(segmentBId)] } }),
    ]);
    return { a, b, overlap, union: a + b - overlap };
  }

  private async segmentWhere(accountId: string, input: { period: DashboardPeriod; segmentIds?: string[]; segmentMatch?: 'any' | 'all' }): Promise<Prisma.LeadWhereInput> {
    const { segmentIds, segmentMatch = 'any' } = input;
    if (segmentIds?.length) {
      const active = await this.prisma.rdSegmentation.findMany({
        where: { accountId, rdId: { in: segmentIds }, selected: true, available: true },
        select: { rdId: true },
      });
      if (active.length !== segmentIds.length) throw new NotFoundError('Segmentação não encontrada');
    }
    return buildWhere(accountId, leadsQuerySchema.parse({ segmentIds, segmentMatch }));
  }
}
