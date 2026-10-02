import { createHash } from 'node:crypto';
import { z } from 'zod';

const profile = z.object({
  uuid: z.string().min(1),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  personal_phone: z.string().nullable().optional(),
  mobile_phone: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  job_title: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  company: z.object({ name: z.string().nullable().optional() }).passthrough().optional(),
  funnel: z.object({
    lifecycle_stage: z.string().nullable().optional(),
    opportunity: z.boolean().optional(),
    fit: z.union([z.string(), z.number()]).nullable().optional(),
    interest: z.number().int().nullable().optional(),
  }).passthrough().optional(),
}).passthrough();

const webhookPayload = z.object({
  event_type: z.enum(['WEBHOOK.CONVERTED', 'WEBHOOK.MARKED_OPPORTUNITY']),
  entity_type: z.literal('CONTACT'),
  event_identifier: z.string().refine((value) => value.trim().length > 0),
  timestamp: z.string().datetime({ offset: true }).optional(),
  event_timestamp: z.string().datetime({ offset: true }),
  contact: profile,
});

export type RdWebhookPayload = z.infer<typeof webhookPayload>;

export function parseWebhookPayload(body: unknown): RdWebhookPayload {
  return webhookPayload.parse(body);
}

export function webhookEventKey(payload: RdWebhookPayload): string {
  const occurredAt = new Date(payload.event_timestamp).getTime();
  return createHash('sha256').update(JSON.stringify([
    payload.contact.uuid, payload.event_type, payload.event_identifier, occurredAt,
  ])).digest('hex');
}
