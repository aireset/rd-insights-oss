import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RdConnectionView, RdCredentialsDto, RdSegmentation, RdSegmentationDto } from '@rd/shared';
import { BusinessError, NotFoundError, RdProviderError } from '../common/errors';
import { decryptSecret, encryptSecret } from '../common/crypto-secrets';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { RdClient, type RdTokens } from './rd-client';
import { RefreshBudgetExhaustedError } from './rd-refresh-budget.service';
import { RdRateLimiter } from './rd-rate-limiter';

@Injectable()
export class RdConnectionService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService<Env, true>, private readonly rateLimiter: RdRateLimiter) {}

  private get baseUrl(): string { return this.config.get('RD_API_BASE_URL', { infer: true }); }
  private get redirectUri(): string { return `${this.config.get('APP_URL', { infer: true })}/api/rd/callback`; }

  /** `state` assinado com o JWT secret: amarra o callback à conta que iniciou. */
  private signState(accountId: string): string {
    const sig = createHmac('sha256', this.config.get('JWT_ACCESS_SECRET', { infer: true })).update(accountId).digest('hex');
    return `${accountId}.${sig}`;
  }
  private verifyState(state: string): string {
    const [accountId, sig] = state.split('.');
    if (!accountId || !sig) throw new BusinessError('state inválido');
    const esperado = createHmac('sha256', this.config.get('JWT_ACCESS_SECRET', { infer: true })).update(accountId).digest('hex');
    if (sig.length !== esperado.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) throw new BusinessError('state inválido');
    return accountId;
  }

  /** Credenciais do RD para a conta: painel tem prioridade; senão cai no .env (RD_CLIENT_ID/RD_CLIENT_SECRET). */
  private async credenciais(accountId: string): Promise<{ clientId: string; clientSecret: string; origem: 'painel' | 'env' }> {
    const c = await this.prisma.rdConnection.findUnique({ where: { accountId } });
    if (c?.clientSecret) return { clientId: c.clientId, clientSecret: decryptSecret(c.clientSecret), origem: 'painel' };
    const envId = this.config.get('RD_CLIENT_ID', { infer: true });
    const envSecret = this.config.get('RD_CLIENT_SECRET', { infer: true });
    if (envId && envSecret) {
      if (!c) await this.prisma.rdConnection.create({ data: { accountId, clientId: envId, clientSecret: encryptSecret(''), status: 'pending' } });
      return { clientId: envId, clientSecret: envSecret, origem: 'env' };
    }
    throw new BusinessError('Informe client_id e client_secret no painel ou no .env');
  }

  async view(accountId: string): Promise<RdConnectionView> {
    const c = await this.prisma.rdConnection.findUnique({ where: { accountId } });
    const envId = this.config.get('RD_CLIENT_ID', { infer: true });
    const envSecret = this.config.get('RD_CLIENT_SECRET', { infer: true });
    const temFallbackEnv = !!envId && !!envSecret;
    if (!c) return { status: 'pending', hasClientSecret: temFallbackEnv, clientId: temFallbackEnv ? envId! : null, credencialOrigem: temFallbackEnv ? 'env' : null, segmentationId: null, segmentationName: null, segmentations: [], lastFullSyncAt: null, lastError: null };
    const selected = await this.prisma.rdSegmentation.findMany({ where: { accountId, selected: true }, orderBy: [{ name: 'asc' }, { rdId: 'asc' }] });
    const origem: 'painel' | 'env' | null = c.clientSecret ? 'painel' : temFallbackEnv ? 'env' : null;
    return { status: c.status, hasClientSecret: !!c.clientSecret || temFallbackEnv, clientId: c.clientId, credencialOrigem: origem, segmentationId: selected[0]?.rdId ?? c.segmentationId, segmentationName: selected[0]?.name ?? c.segmentationName, segmentations: selected.map((s) => this.toSegmentation(s)), lastFullSyncAt: c.lastFullSyncAt?.toISOString() ?? null, lastError: c.lastError };
  }

  async saveCredentials(accountId: string, dto: RdCredentialsDto): Promise<RdConnectionView> {
    await this.prisma.rdConnection.upsert({
      where: { accountId },
      create: { accountId, clientId: dto.clientId, clientSecret: encryptSecret(dto.clientSecret), status: 'pending' },
      update: { clientId: dto.clientId, clientSecret: encryptSecret(dto.clientSecret), status: 'pending', accessToken: null, refreshToken: null, expiresAt: null, lastError: null },
    });
    return this.view(accountId);
  }

  async authorizeUrl(accountId: string): Promise<string> {
    const { clientId } = await this.credenciais(accountId);
    return RdClient.authorizeUrl(this.baseUrl, clientId, this.redirectUri, this.signState(accountId));
  }

  /** Callback do RD: troca o code, grava tokens cifrados, status=authorized. Devolve a URL do front. */
  async handleCallback(code: string, state: string): Promise<string> {
    const accountId = this.verifyState(state);
    const { clientId, clientSecret } = await this.credenciais(accountId);
    try {
      const t = await RdClient.exchangeCode({ baseUrl: this.baseUrl, clientId, clientSecret, code, rateLimit: (endpoint) => this.rateLimiter.acquire(accountId, endpoint) });
      await this.saveTokens(accountId, t, 'authorized');
    } catch (e) {
      await this.prisma.rdConnection.update({ where: { accountId }, data: { status: 'error', lastError: e instanceof Error ? e.message : String(e) } });
    }
    return `${this.config.get('APP_URL', { infer: true })}/conectar`;
  }

  private async saveTokens(accountId: string, t: RdTokens, status?: 'authorized' | 'active'): Promise<void> {
    await this.prisma.rdConnection.update({ where: { accountId }, data: { accessToken: encryptSecret(t.accessToken), refreshToken: encryptSecret(t.refreshToken), expiresAt: t.expiresAt, lastError: null, ...(status ? { status } : {}) } });
  }

  /** Client autenticado da conta. 401 definitivo → marca reauth_required e relança. */
  async client(accountId: string, beforeRequest?: () => Promise<void>): Promise<RdClient> {
    const c = await this.prisma.rdConnection.findUnique({ where: { accountId } });
    if (!c?.accessToken || !c.refreshToken || !c.expiresAt) throw new BusinessError('Conta ainda não autorizada no RD');
    const { clientId, clientSecret } = await this.credenciais(accountId);
    return new RdClient({
      baseUrl: this.baseUrl, clientId, clientSecret,
      tokens: { accessToken: decryptSecret(c.accessToken), refreshToken: decryptSecret(c.refreshToken), expiresAt: c.expiresAt },
      onTokens: (t) => this.saveTokens(accountId, t),
      beforeRequest,
      rateLimit: (endpoint) => this.rateLimiter.acquire(accountId, endpoint),
    });
  }

  async marcarErro(accountId: string, e: unknown): Promise<void> {
    const reauth = e instanceof RdProviderError && e.providerStatus === 401;
    await this.prisma.rdConnection.update({ where: { accountId }, data: { status: reauth ? 'reauth_required' : 'error', lastError: (e instanceof Error ? e.message : String(e)).slice(0, 500) } });
  }

  private toSegmentation(s: { rdId: string; name: string; standard: boolean; selected: boolean; available: boolean; coverage: RdSegmentation['coverage'] }): RdSegmentation {
    return { id: s.rdId, name: s.name, standard: s.standard, selected: s.selected, available: s.available, coverage: s.coverage };
  }

  async segmentations(accountId: string, beforeRequest?: () => Promise<void>): Promise<RdSegmentation[]> {
    const client = await this.client(accountId, beforeRequest);
    try {
      const all: Array<{ id: number | string; name: string; standard?: boolean | null }> = [];
      for (let page = 1; ; page += 1) {
        const r = await client.get<{ segmentations: typeof all }>('/platform/segmentations', { page, page_size: 125 });
        if (!Array.isArray(r.segmentations)) throw new BusinessError('Resposta inválida ao listar segmentações do RD');
        if (r.segmentations.some((segment) => !segment || !['string', 'number'].includes(typeof segment.id) || !String(segment.id).trim() || typeof segment.name !== 'string')) throw new BusinessError('Segmentação inválida recebida do RD');
        all.push(...r.segmentations);
        if (r.segmentations.length < 125) break;
      }
      await this.prisma.$transaction(async (tx) => {
        for (const s of all) {
          await tx.rdSegmentation.upsert({
            where: { accountId_rdId: { accountId, rdId: String(s.id) } },
            create: { accountId, rdId: String(s.id), name: s.name, standard: s.standard === true, available: true },
            update: { name: s.name, standard: s.standard === true, available: true },
          });
        }
        await tx.rdSegmentation.updateMany({ where: { accountId, rdId: { notIn: all.map((s) => String(s.id)) } }, data: { available: false } });
      });
      const rows = await this.prisma.rdSegmentation.findMany({ where: { accountId }, orderBy: [{ name: 'asc' }, { rdId: 'asc' }] });
      return rows.map((s) => this.toSegmentation(s));
    } catch (e) { if (!(e instanceof RefreshBudgetExhaustedError)) await this.marcarErro(accountId, e); throw e; }
  }

  async setSegmentations(accountId: string, ids: string[]): Promise<RdConnectionView> {
    await this.prisma.$transaction(async (tx) => {
      const records = await tx.rdSegmentation.findMany({ where: { accountId, rdId: { in: ids } } });
      if (records.length !== ids.length) throw new NotFoundError('Uma ou mais segmentações não estão disponíveis para esta conta; atualize o catálogo');
      const selected = records.filter((s) => s.available);
      const selectedIds = selected.map((s) => s.rdId);
      const sorted = [...selected].sort((a, b) => a.name.localeCompare(b.name) || a.rdId.localeCompare(b.rdId));
      await tx.rdSegmentation.updateMany({ where: { accountId, selected: true }, data: { selected: false } });
      if (selectedIds.length) {
        const changed = await tx.rdSegmentation.updateMany({ where: { accountId, rdId: { in: selectedIds }, available: true }, data: { selected: true } });
        if (changed.count !== selectedIds.length) throw new BusinessError('O catálogo mudou durante a seleção; atualize e tente novamente');
      }
      await tx.rdConnection.update({
        where: { accountId },
        data: { segmentationId: sorted[0]?.rdId ?? null, segmentationName: sorted[0]?.name ?? null, status: 'active' },
      });
    });
    return this.view(accountId);
  }

  async chooseSegmentation(accountId: string, dto: RdSegmentationDto): Promise<RdConnectionView> {
    return this.setSegmentations(accountId, [dto.segmentationId]);
  }
}
