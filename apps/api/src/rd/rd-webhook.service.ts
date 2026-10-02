import { createHash, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RdWebhookJobsService } from './rd-webhook-jobs.service';
import { parseWebhookPayload, webhookEventKey } from './rd-webhook-payload';

@Injectable()
export class RdWebhookService {
  constructor(private readonly prisma: PrismaService, private readonly jobs: RdWebhookJobsService) {}

  async receive(accountId: string, token: string, body: unknown): Promise<{ accepted: true }> {
    let hash: string | null | undefined;
    try {
      hash = (await this.prisma.rdConnection.findUnique({ where: { accountId }, select: { webhookTokenHash: true } }))?.webhookTokenHash;
    } catch { throw new ServiceUnavailableException('Não foi possível registrar o evento. Tente novamente.'); }
    const actual = createHash('sha256').update(token).digest();
    if (!/^[a-f0-9]{64}$/.test(token) || !hash || !/^[a-f0-9]{64}$/.test(hash) || !timingSafeEqual(actual, Buffer.from(hash, 'hex'))) throw new UnauthorizedException('Webhook não autorizado');
    // RD can verify a callback before delivering a contact. Never invent an event.
    if (body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) return { accepted: true };
    let payload;
    try { payload = parseWebhookPayload(body); }
    catch { throw new BadRequestException('Evento RD inválido'); }
    let log;
    try {
      log = await this.prisma.webhookLog.upsert({
        where: { accountId_eventKey: { accountId, eventKey: webhookEventKey(payload) } },
        create: { accountId, eventKey: webhookEventKey(payload), eventType: payload.event_type, rdUuid: payload.contact.uuid, payload: payload as Prisma.InputJsonValue },
        update: {},
      });
    } catch (error) {
      // Prisma can emulate an empty-update upsert; concurrent first deliveries may race.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        try { log = await this.prisma.webhookLog.findUnique({ where: { accountId_eventKey: { accountId, eventKey: webhookEventKey(payload) } } }); }
        catch { /* Return a safe retryable failure below. */ }
      }
      if (!log) throw new ServiceUnavailableException('Não foi possível registrar o evento. Tente novamente.');
    }
    // PostgreSQL is the outbox. Redis may be down or slow; recovery publishes later.
    if (log.status === 'pending') void this.jobs.enqueue(accountId, log.id).catch(() => undefined);
    return { accepted: true };
  }
}
