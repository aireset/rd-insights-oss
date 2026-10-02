import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError, NotFoundError, RdProviderError } from '../common/errors';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { RdConnectionService } from './rd-connection.service';

type Subscription = { uuid?: string; event_type?: string; url?: string };
const EVENTS = ['WEBHOOK.CONVERTED', 'WEBHOOK.MARKED_OPPORTUNITY'] as const;

@Injectable()
export class RdWebhookSubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: RdConnectionService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async register(accountId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${accountId}, 84492))`;
      await this.registerLocked(accountId);
    }, { timeout: 120_000 });
  }

  private async registerLocked(accountId: string): Promise<void> {
    const connection = await this.prisma.rdConnection.findUnique({ where: { accountId } });
    if (!connection) throw new NotFoundError('Conexão RD não encontrada');
    try {
      let base: URL;
      try { base = new URL(this.config.get('APP_URL', { infer: true })); }
      catch { throw new BusinessError('APP_URL inválida para o webhook'); }
      if (base.protocol !== 'https:') throw new BusinessError('O callback do RD exige APP_URL com HTTPS');
      const client = await this.connections.client(accountId);
      const listed = await client.get<{ webhooks?: Subscription[] } | Subscription[]>('/integrations/webhooks');
      const rawSubscriptions = Array.isArray(listed) ? listed : listed?.webhooks;
      if (!Array.isArray(rawSubscriptions)) throw new Error('Invalid RD subscription list');
      // O RD lista event_type em minúsculas (webhook.converted); comparar sem diferença de caixa.
      const subscriptions = rawSubscriptions.map((sub) => ({ ...sub, event_type: sub.event_type?.toUpperCase() }));

      const knownUuids: string[] = Array.isArray(connection.webhookUuids) ? connection.webhookUuids : [];
      const endpoint = (token: string) => new URL(`/api/rd/webhooks/${encodeURIComponent(accountId)}/${token}`, base).toString();
      const endpointPath = new URL(endpoint('placeholder')).pathname.replace(/placeholder$/, '');
      let token: string | undefined;
      if (connection.webhookTokenHash) {
        for (const sub of subscriptions) {
          if (!sub.uuid || (!knownUuids.includes(sub.uuid) && sub.event_type !== EVENTS[0] && sub.event_type !== EVENTS[1]) || !sub.url) continue;
          try {
            const url = new URL(sub.url);
            if (url.origin !== base.origin || !url.pathname.startsWith(endpointPath)) continue;
            const candidate = decodeURIComponent(url.pathname.slice(endpointPath.length));
            if (candidate && safeEqual(hash(candidate), connection.webhookTokenHash)) { token = candidate; break; }
          } catch { /* Ignore unrelated or malformed webhook URLs. */ }
        }
      }

      const rotated = !token;
      token ??= randomBytes(32).toString('hex');
      const tokenHash = hash(token);
      if (rotated) await this.prisma.rdConnection.update({
        where: { accountId },
        data: { webhookTokenHash: tokenHash, webhookError: null },
      });

      const callback = endpoint(token);
      const savedUuids: string[] = [];
      const completedEvents = new Set<string>();
      for (const event_type of EVENTS) {
        const existing = subscriptions.find((sub) => sub.uuid && (knownUuids.includes(sub.uuid) || (!!sub.url && sub.url === callback)) && sub.event_type === event_type);
        const body = { event_type, entity_type: 'CONTACT', http_method: 'POST', include_relations: ['COMPANY', 'CONTACT_FUNNEL'], url: callback };
        let uuid = existing?.uuid;
        if (uuid) await client.put(`/integrations/webhooks/${encodeURIComponent(uuid)}`, body);
        else {
          const created = await client.post<{ uuid?: string }>('/integrations/webhooks', body);
          uuid = created?.uuid;
          if (!uuid) {
            const recovered = await client.get<{ webhooks?: Subscription[] } | Subscription[]>('/integrations/webhooks');
            const all = Array.isArray(recovered) ? recovered : recovered?.webhooks;
            uuid = Array.isArray(all) ? all.find((sub) => sub.event_type === event_type && sub.url === callback)?.uuid : undefined;
          }
        }
        if (!uuid) throw new Error('RD did not return a subscription id');
        if (!savedUuids.includes(uuid)) savedUuids.push(uuid);
        completedEvents.add(event_type);
        // Keep ownership of existing subscriptions still awaiting PUT. Their old
        // callback may no longer match after a hostname/token rotation.
        const remaining = subscriptions.filter((sub) => sub.uuid && knownUuids.includes(sub.uuid) && sub.event_type && EVENTS.some((event) => event === sub.event_type) && !completedEvents.has(sub.event_type)).map((sub) => sub.uuid!);
        await this.prisma.rdConnection.update({ where: { accountId }, data: { webhookUuids: [...new Set([...savedUuids, ...remaining])], webhookError: null } });
      }
      await this.prisma.rdConnection.update({ where: { accountId }, data: { webhookRegisteredAt: new Date(), webhookError: null } });
    } catch (error) {
      if (error instanceof RdProviderError && error.providerStatus === 401) await this.connections.marcarErro(accountId, error);
      await this.prisma.rdConnection.update({ where: { accountId }, data: { webhookError: 'Falha ao registrar webhooks do RD' } });
      if (error instanceof BusinessError || error instanceof RdProviderError) throw error;
      throw new BusinessError('Falha ao registrar webhooks do RD');
    }
  }
}

function hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
