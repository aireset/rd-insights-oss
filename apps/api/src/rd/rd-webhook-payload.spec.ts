import { describe, expect, it } from 'vitest';
import { parseWebhookPayload, webhookEventKey } from './rd-webhook-payload';

const payload = {
  event_type: 'WEBHOOK.CONVERTED', entity_type: 'CONTACT', event_identifier: 'newsletter',
  timestamp: '2026-09-28T10:00:00.000Z', event_timestamp: '2026-09-28T09:59:00-03:00',
  contact: { uuid: 'contact-1', name: 'Ana', company: { name: 'Acme' }, funnel: { lifecycle_stage: 'Lead', opportunity: false }, cf_plan: ['A'] },
};

describe('RD Marketing webhook payload', () => {
  it('accepts supported contact events and keeps optional profile fields', () => {
    expect(parseWebhookPayload(payload)).toMatchObject({ event_type: 'WEBHOOK.CONVERTED', contact: payload.contact });
    expect(parseWebhookPayload({ ...payload, event_type: 'WEBHOOK.MARKED_OPPORTUNITY' }).event_type).toBe('WEBHOOK.MARKED_OPPORTUNITY');
  });

  it.each([
    [{ ...payload, event_type: 'crm_deal_created' }],
    [{ ...payload, entity_type: 'COMPANY' }],
    [{ ...payload, event_identifier: '  ' }],
    [{ ...payload, event_timestamp: 'invalid' }],
    [{ ...payload, contact: { ...payload.contact, uuid: '' } }],
    [{ ...payload, contact: { ...payload.contact, funnel: { opportunity: null } } }],
    [{ ...payload, contact: { ...payload.contact, funnel: { interest: 1.5 } } }],
  ])('rejects invalid payloads', (invalid) => {
    expect(() => parseWebhookPayload(invalid)).toThrow();
  });

  it('hashes event identity without depending on delivery timestamp', () => {
    const first = parseWebhookPayload(payload);
    const replay = parseWebhookPayload({ ...payload, timestamp: '2026-09-28T11:00:00Z' });
    expect(webhookEventKey(first)).toBe(webhookEventKey(replay));
    expect(webhookEventKey(first)).not.toBe(webhookEventKey(parseWebhookPayload({ ...payload, event_identifier: 'other' })));
  });

  it('preserves the RD identifier while stripping unrelated root secrets', () => {
    const parsed = parseWebhookPayload({ ...payload, event_identifier: ' form ', token_rdstation: 'secret' });
    expect(parsed.event_identifier).toBe(' form ');
    expect(parsed).not.toHaveProperty('token_rdstation');
  });
});
