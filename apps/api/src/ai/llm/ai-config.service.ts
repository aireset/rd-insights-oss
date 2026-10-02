import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { encryptSecret, secretsKeyConfigured } from '../../common/crypto-secrets';
import { BusinessError } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { aiConfigInputSchema } from './ai-config.schema';
import type { infer as ZodInfer } from 'zod';
export type AiConfigInput = ZodInfer<typeof aiConfigInputSchema>;

type LookupAll = (hostname: string) => Promise<Array<{ address: string }>>;
export const AI_DNS_LOOKUP = Symbol('AI_DNS_LOOKUP');

function publicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113) || a! >= 224);
  }
  if (version !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    return isIP(mapped) === 4 && publicAddress(mapped);
  }
  // Only globally-routable unicast space (2000::/3); reject documentation range too.
  const [firstPart = '0', secondPart = '0'] = normalized.split(':');
  const first = Number.parseInt(firstPart, 16);
  const second = Number.parseInt(secondPart, 16);
  return (first & 0xe000) === 0x2000
    && !(first === 0x2001 && (second <= 0x01ff || normalized.startsWith('2001:db8:')))
    && first !== 0x2002
    && !(first === 0x3fff && second < 0x1000);
}

export async function assertSafeAiBaseUrl(value: string, resolve: LookupAll = async (host) => lookup(host, { all: true, verbatim: true })): Promise<void> {
  let url: URL;
  try { url = new URL(value); } catch { throw new BusinessError('URL do provider inválida'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new BusinessError('Use URL HTTPS pública, sem credenciais, query ou fragmento');
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await resolve(hostname).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new BusinessError('Host do provider não resolve para endereço público');
}

@Injectable()
export class AiConfigService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Optional() @Inject(AI_DNS_LOOKUP) private readonly resolve?: LookupAll) {}

  async get(accountId: string) {
    const config = await this.prisma.aiConfig.findUnique({ where: { accountId } });
    return config ? this.toPublic(config) : { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: '', enabled: false, monthlyBudgetCents: 1000, requestsPerMinute: 10, hasApiKey: false };
  }

  async save(accountId: string, input: AiConfigInput) {
    const parsed = aiConfigInputSchema.safeParse(input);
    if (!parsed.success) throw new BusinessError('Configuração de IA inválida');
    const data = parsed.data;
    await assertSafeAiBaseUrl(data.baseUrl, this.resolve);
    if (!secretsKeyConfigured()) throw new BusinessError('SECRETS_KEY precisa estar configurada para salvar a chave de IA');
    const existing = await this.prisma.aiConfig.findUnique({ where: { accountId }, select: { apiKey: true } });
    const key = data.apiKey?.trim() ? encryptSecret(data.apiKey.trim()) : existing?.apiKey;
    if (!key) throw new BusinessError('Informe a chave da API para configurar o provider');
    const fields = { provider: data.provider, baseUrl: data.baseUrl, model: data.model, enabled: data.enabled, monthlyBudgetCents: data.monthlyBudgetCents, requestsPerMinute: data.requestsPerMinute };
    const config = await this.prisma.aiConfig.upsert({ where: { accountId }, create: { accountId, ...fields, apiKey: key }, update: { ...fields, ...(data.apiKey?.trim() ? { apiKey: key } : {}) } });
    return this.toPublic(config);
  }

  private toPublic(config: { provider: string; baseUrl: string; model: string; enabled: boolean; monthlyBudgetCents: number; requestsPerMinute: number; apiKey: string }) {
    return { provider: config.provider, baseUrl: config.baseUrl, model: config.model, enabled: config.enabled, monthlyBudgetCents: config.monthlyBudgetCents, requestsPerMinute: config.requestsPerMinute, hasApiKey: Boolean(config.apiKey) };
  }
}
