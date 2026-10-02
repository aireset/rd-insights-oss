import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parseWebhookPayload } from './rd-webhook-payload';

type LeadProfileFields = Pick<Prisma.LeadUncheckedCreateInput,
  'name' | 'email' | 'phone' | 'city' | 'state' | 'country' | 'jobTitle' | 'website' | 'tags' | 'company' | 'lifecycleStage' | 'opportunity' | 'fit' | 'interest' | 'customFields'>;

@Injectable()
export class RdWebhookProcessorService {
  constructor(private readonly prisma: PrismaService) {}

  async process(accountId: string, logId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      let log = await tx.webhookLog.findFirst({ where: { id: logId, accountId } });
      if (!log) throw new Error('Webhook pendente não encontrado');
      if (log.status !== 'pending') return;

      const payload = parseWebhookPayload(log.payload);
      if (payload.contact.uuid !== log.rdUuid || payload.event_type !== log.eventType) throw new Error('Webhook inválido');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rd-webhook-lead:${accountId}:${payload.contact.uuid}`}, 6))`;

      log = await tx.webhookLog.findFirst({ where: { id: logId, accountId } });
      if (!log || log.status !== 'pending') return;

      const occurredAt = new Date(payload.event_timestamp);
      const prior = await tx.lead.findUnique({ where: { accountId_rdUuid: { accountId, rdUuid: payload.contact.uuid } } });
      const profileIsFresh = !prior || (occurredAt >= (prior.webhookProfileAt ?? new Date(0)) && occurredAt >= (prior.enrichedAt ?? new Date(0)));
      const profile = profileIsFresh ? profileFields(payload.contact) : {};
      if (prior && profile.customFields) profile.customFields = { ...(prior.customFields as Record<string, unknown>), ...(profile.customFields as Record<string, unknown>) } as Prisma.InputJsonValue;
      const isOpportunity = payload.event_type === 'WEBHOOK.MARKED_OPPORTUNITY';
      const lead = prior
        ? await tx.lead.update({ where: { id: prior.id, accountId }, data: {
          ...profile,
          ...(profileIsFresh ? { webhookProfileAt: occurredAt, webhookProfileVersion: { increment: 1 }, ...(isOpportunity ? { opportunity: true } : {}) } : {}),
        } })
        : await tx.lead.create({ data: {
          accountId, rdUuid: payload.contact.uuid, ...profileFields(payload.contact), webhookProfileAt: occurredAt, webhookProfileVersion: 1,
          ...(isOpportunity ? { opportunity: true } : {}),
        } });

      const type = isOpportunity ? 'OPPORTUNITY' : 'CONVERSION';
      const event = await tx.leadEvent.findFirst({ where: { accountId, leadId: lead.id, type, identifier: payload.event_identifier, occurredAt } });
      if (!event) {
        await tx.leadEvent.create({ data: { accountId, leadId: lead.id, type, identifier: payload.event_identifier, occurredAt } });
        if (type === 'CONVERSION') {
          await tx.lead.update({ where: { id: lead.id, accountId }, data: {
            conversionsCount: { increment: 1 },
            ...(prior?.firstConversionAt && prior.firstConversionAt <= occurredAt ? {} : { firstConversionAt: occurredAt }),
            ...(prior?.lastConversionAt && prior.lastConversionAt >= occurredAt ? {} : { lastConversionAt: occurredAt }),
          } });
        }
      }

      await tx.webhookLog.update({ where: { id: logId, accountId }, data: { status: 'completed', processedAt: new Date() } });
    });
  }
}

function profileFields(contact: ReturnType<typeof parseWebhookPayload>['contact']): LeadProfileFields {
  const data: LeadProfileFields = {};
  const assign = (source: object, sourceKey: string, targetKey: keyof LeadProfileFields) => {
    if (Object.hasOwn(source, sourceKey)) (data as Record<string, unknown>)[targetKey] = (source as Record<string, unknown>)[sourceKey];
  };
  assign(contact, 'name', 'name');
  assign(contact, 'email', 'email');
  if (contact.personal_phone != null) assign(contact, 'personal_phone', 'phone');
  else if (Object.hasOwn(contact, 'mobile_phone')) assign(contact, 'mobile_phone', 'phone');
  else assign(contact, 'personal_phone', 'phone');
  assign(contact, 'city', 'city');
  assign(contact, 'state', 'state');
  assign(contact, 'country', 'country');
  assign(contact, 'job_title', 'jobTitle');
  assign(contact, 'website', 'website');
  assign(contact, 'tags', 'tags');
  if (contact.company && Object.hasOwn(contact.company, 'name')) data.company = contact.company.name;
  if (contact.funnel) {
    assign(contact.funnel, 'lifecycle_stage', 'lifecycleStage');
    assign(contact.funnel, 'opportunity', 'opportunity');
    if (Object.hasOwn(contact.funnel, 'fit')) data.fit = contact.funnel.fit == null ? null : String(contact.funnel.fit);
    assign(contact.funnel, 'interest', 'interest');
  }
  const customFields = Object.fromEntries(Object.entries(contact).filter(([key]) => key.startsWith('cf_')));
  if (Object.keys(customFields).length) data.customFields = customFields as Prisma.InputJsonValue;
  return data;
}
