import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { RdWebhookJobsService } from './rd-webhook-jobs.service';
import { RdWebhookService } from './rd-webhook.service';

const token = 'ab'.repeat(32);
const body = { event_type: 'WEBHOOK.CONVERTED', entity_type: 'CONTACT', event_identifier: 'form', event_timestamp: '2026-09-28T10:00:00Z', contact: { uuid: 'contact-1' } };
function fixture() {
  const db = { rdConnection: { findUnique: vi.fn().mockResolvedValue({ webhookTokenHash: createHash('sha256').update(token).digest('hex') }) }, webhookLog: { upsert: vi.fn().mockResolvedValue({ id: 'log-1', status: 'pending' }) } };
  const jobs = { enqueue: vi.fn().mockResolvedValue(undefined) };
  return { db, jobs, svc: new RdWebhookService(db as unknown as PrismaService, jobs as unknown as RdWebhookJobsService) };
}
describe('durable webhook ingress', () => {
  it('rejects invalid secret before parsing or writing', async () => {
    const { db, jobs, svc } = fixture();
    await expect(svc.receive('account-1', 'bad', body)).rejects.toMatchObject({ status: 401 });
    expect(db.webhookLog.upsert).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
  it('rejects malformed events without writes or enqueue', async () => {
    const { db, jobs, svc } = fixture();
    await expect(svc.receive('account-1', token, { ...body, event_timestamp: 'invalid' })).rejects.toMatchObject({ status: 400 });
    expect(db.webhookLog.upsert).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
  it('commits a scoped unique event before enqueue; returns without waiting for Redis', async () => {
    const { db, jobs, svc } = fixture();
    jobs.enqueue.mockImplementation(() => new Promise(() => undefined));
    await expect(svc.receive('account-1', token, body)).resolves.toEqual({ accepted: true });
    expect(db.webhookLog.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { accountId_eventKey: { accountId: 'account-1', eventKey: expect.any(String) } }, update: {} }));
    expect(db.webhookLog.upsert.mock.invocationCallOrder[0]).toBeLessThan(jobs.enqueue.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(db.webhookLog.upsert.mock.calls)).not.toContain(token);
  });
  it('keeps the persisted event when Redis rejects and never returns success on DB failure', async () => {
    const { db, jobs, svc } = fixture();
    jobs.enqueue.mockRejectedValue(new Error('Redis unavailable'));
    await expect(svc.receive('account-1', token, body)).resolves.toEqual({ accepted: true });
    db.webhookLog.upsert.mockRejectedValue(new Error(`secret URL /${token}`));
    await expect(svc.receive('account-1', token, body)).rejects.toMatchObject({ status: 503, message: 'Não foi possível registrar o evento. Tente novamente.' });
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
  });
  it('accepts an authenticated empty handshake without creating a fake lead/event', async () => {
    const { db, svc } = fixture();
    await expect(svc.receive('account-1', token, {})).resolves.toEqual({ accepted: true });
    expect(db.webhookLog.upsert).not.toHaveBeenCalled();
  });
});
