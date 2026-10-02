import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { BusinessError, ConflictError, NotFoundError } from '../../common/errors';
import { decryptSecret } from '../../common/crypto-secrets';
import { PrismaService } from '../../prisma/prisma.service';
import { classificationHash, classificationInput, classificationMessages, MAX_OUTPUT_TOKENS, parseClassification } from './classification-input';
import { fetchClassification } from './provider-fetch';
import { getAiAccountUsage, lockAiAccountBudget, utcMonthStart } from '../llm/account-budget';

export const CLASSIFICATION_PROVIDER = Symbol('CLASSIFICATION_PROVIDER');
export const policySchema = z.object({ inputUsdPerMillion: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/), outputUsdPerMillion: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/) }).strict();
type PolicyInput = z.infer<typeof policySchema>;
type Provider = typeof fetchClassification;
const micros = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0')); };
const decimal = (value: bigint) => `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, '0')}`;
const tokenCost = (input: number, output: number, policy: { inputPriceMicros: bigint; outputPriceMicros: bigint }) => (BigInt(input) * policy.inputPriceMicros + BigInt(output) * policy.outputPriceMicros + 999_999n) / 1_000_000n;
const facts = (tx: Prisma.TransactionClient, accountId: string, leadId: string) => tx.lead.findFirst({ where: { accountId, id: leadId }, include: { events: { where: { accountId }, orderBy: [{ occurredAt: 'desc' }, { type: 'asc' }], take: 20 } } });

@Injectable()
export class ClassificationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Optional() @Inject(CLASSIFICATION_PROVIDER) private readonly provider: Provider = fetchClassification) {}

  async getPolicy(accountId: string) {
    const [policy, config, usage, pending, failed] = await Promise.all([
      this.prisma.aiClassificationPolicy.findUnique({ where: { accountId } }),
      this.prisma.aiConfig.findUnique({ where: { accountId }, select: { enabled: true, monthlyBudgetCents: true, requestsPerMinute: true } }),
      getAiAccountUsage(this.prisma, accountId, utcMonthStart()),
      this.prisma.aiClassificationTask.count({ where: { accountId, status: { in: ['pending', 'processing'] } } }),
      this.prisma.aiClassificationTask.count({ where: { accountId, status: 'failed' } }),
    ]);
    return { currency: 'USD', inputUsdPerMillion: policy ? decimal(policy.inputPriceMicros) : null, outputUsdPerMillion: policy ? decimal(policy.outputPriceMicros) : null, enabled: config?.enabled ?? false, monthlyBudgetCents: config?.monthlyBudgetCents ?? 0, requestsPerMinute: config?.requestsPerMinute ?? 0, committedMicros: usage.committedMicros.toString(), cooldownUntil: policy?.cooldownUntil?.toISOString() ?? null, pending, failed, error: !policy ? 'Configure os preços por milhão de tokens antes de classificar.' : !config?.enabled ? 'Ative a configuração de IA para classificar.' : null };
  }
  async savePolicy(accountId: string, input: PolicyInput) {
    const parsed = policySchema.safeParse(input);
    if (!parsed.success) throw new BusinessError('Preços inválidos; use USD com até seis casas decimais.');
    const data = { inputPriceMicros: micros(parsed.data.inputUsdPerMillion), outputPriceMicros: micros(parsed.data.outputUsdPerMillion) };
    await this.prisma.aiClassificationPolicy.upsert({ where: { accountId }, create: { accountId, ...data }, update: data });
    // Resume only configuration failures that never reached the provider.
    await this.prisma.aiClassificationTask.updateMany({ where: { accountId, status: 'failed', error: 'Configure os preços por milhão de tokens antes de classificar.', attempts: { none: {} } }, data: { status: 'pending', error: null, nextAttemptAt: new Date() } });
    return this.getPolicy(accountId);
  }
  async enqueue(accountId: string, leadId: string, source: 'initial' | 'refresh' | 'conversion' | 'manual') {
    const checkedAt = new Date();
    return this.prisma.$transaction(async (tx) => {
      await lockAiAccountBudget(tx, accountId);
      const lead = await facts(tx, accountId, leadId);
      if (!lead) throw new NotFoundError('Lead não encontrado');
      const config = await tx.aiConfig.findUnique({ where: { accountId } });
      const inputHash = classificationHash(classificationInput(lead), config?.provider ?? '', config?.model ?? '', config?.baseUrl ?? '');
      const task = await tx.aiClassificationTask.upsert({ where: { accountId_leadId_inputHash: { accountId, leadId, inputHash } }, create: { accountId, leadId, inputHash, source }, update: {} });
      await tx.lead.update({ where: { accountId, id: leadId }, data: { aiCheckedAt: checkedAt } });
      return task;
    });
  }
  async retry(accountId: string, leadId: string) {
    const task = await this.enqueue(accountId, leadId, 'manual');
    return this.prisma.$transaction(async (tx) => {
      await lockAiAccountBudget(tx, accountId);
      const active = await tx.aiClassificationTask.count({ where: { accountId, leadId, status: 'processing' } });
      if (active) throw new ConflictError('Classificação em andamento; aguarde a conclusão.');
      return tx.aiClassificationTask.update({ where: { accountId, id: task.id }, data: { status: 'pending', error: null, source: 'manual', nextAttemptAt: new Date() } });
    });
  }
  /** Provider ligado, com chave e preços declarados — sem isso nenhuma classificação sai. */
  async isConfigured(accountId: string): Promise<boolean> {
    const [config, policy] = await Promise.all([
      this.prisma.aiConfig.findUnique({ where: { accountId }, select: { enabled: true, apiKey: true } }),
      this.prisma.aiClassificationPolicy.count({ where: { accountId } }),
    ]);
    return !!(config?.enabled && config.apiKey && policy);
  }

  /** Distribuição quente/morno/frio da conta (leads sem classificação ficam em `semClassificacao`). */
  async distribution(accountId: string) {
    const [groups, configured, pending, failed] = await Promise.all([
      this.prisma.lead.groupBy({ by: ['aiScore'], where: { accountId }, _count: { _all: true } }),
      this.isConfigured(accountId),
      this.prisma.aiClassificationTask.count({ where: { accountId, status: { in: ['pending', 'processing'] } } }),
      this.prisma.aiClassificationTask.count({ where: { accountId, status: 'failed' } }),
    ]);
    const n = (score: string | null) => groups.find((g) => g.aiScore === score)?._count._all ?? 0;
    const total = groups.reduce((sum, g) => sum + g._count._all, 0);
    return { configured, total, quente: n('quente'), morno: n('morno'), frio: n('frio'), semClassificacao: n(null), pending, failed };
  }

  private readonly bulk = new Set<string>();
  /** "Classificar todos": enfileira os leads sem classificação; o worker aplica o limite por minuto e retoma sozinho. */
  async enqueueUnclassified(accountId: string): Promise<{ total: number; started: boolean }> {
    if (!await this.isConfigured(accountId)) throw new BusinessError('IA não configurada: ative o provider e informe os preços antes de classificar.');
    const ids = (await this.prisma.lead.findMany({ where: { accountId, aiScore: null }, select: { id: true }, orderBy: { id: 'asc' } })).map((l) => l.id);
    if (this.bulk.has(accountId)) return { total: ids.length, started: false };
    this.bulk.add(accountId);
    void (async () => {
      try { for (const id of ids) await this.enqueue(accountId, id, 'manual').catch(() => undefined); }
      finally { this.bulk.delete(accountId); }
    })();
    return { total: ids.length, started: true };
  }

  async leadStatus(accountId: string, leadId: string) {
    const configured = await this.isConfigured(accountId);
    const lead = await this.prisma.lead.findFirst({ where: { accountId, id: leadId }, select: { aiScore: true, aiReason: true, aiSummary: true, aiAt: true, aiModel: true } });
    if (!lead) throw new NotFoundError('Lead não encontrado');
    const task = await this.prisma.aiClassificationTask.findFirst({ where: { accountId, leadId }, orderBy: { updatedAt: 'desc' } });
    return { configured, score: lead.aiScore, reason: lead.aiReason, summary: lead.aiSummary, classifiedAt: lead.aiAt?.toISOString() ?? null, model: lead.aiModel, status: task?.status ?? 'not_requested', error: task?.error ?? null, nextAttemptAt: task?.status === 'pending' ? task.nextAttemptAt.toISOString() : null, dataUsed: ['Atributos importados', 'Até 20 eventos recentes (tipo e data)', 'Cobertura dos endpoints'] };
  }
  /** Short database reservation; no lock is held during the provider request. */
  async process(accountId: string, taskId: string): Promise<number | void> {
    const reservation = await this.prisma.$transaction(async (tx) => {
      await lockAiAccountBudget(tx, accountId);
      const task = await tx.aiClassificationTask.findFirst({ where: { accountId, id: taskId } });
      if (!task || task.status !== 'pending') return;
      const delay = task.nextAttemptAt.getTime() - Date.now();
      if (delay > 0) return { delay };
      const [config, policy, lead] = await Promise.all([tx.aiConfig.findUnique({ where: { accountId } }), tx.aiClassificationPolicy.findUnique({ where: { accountId } }), facts(tx, accountId, task.leadId)]);
      const fail = async (error: string) => { await tx.aiClassificationTask.update({ where: { accountId, id: taskId }, data: { status: 'failed', error } }); };
      if (!config?.enabled || !config.apiKey) { await fail('Ative e configure a IA antes de classificar.'); return; }
      if (!policy) { await fail('Configure os preços por milhão de tokens antes de classificar.'); return; }
      if (!lead) return;
      const input = classificationInput(lead);
      if (classificationHash(input, config.provider, config.model, config.baseUrl) !== task.inputHash) { await tx.aiClassificationTask.update({ where: { accountId, id: taskId }, data: { status: 'superseded' } }); return; }
      const active = await tx.aiClassificationTask.count({ where: { accountId, leadId: task.leadId, status: 'processing' } });
      const usage = await getAiAccountUsage(tx, accountId);
      const wait = Math.max(active ? 5_000 : 0, policy.cooldownUntil ? policy.cooldownUntil.getTime() - Date.now() : 0, usage.recentRequestTimes.length >= config.requestsPerMinute ? usage.recentRequestTimes[0]!.getTime() + 60_001 - Date.now() : 0);
      if (wait > 0) { await tx.aiClassificationTask.update({ where: { accountId, id: taskId }, data: { nextAttemptAt: new Date(Date.now() + wait) } }); return { delay: wait }; }
      const messages = classificationMessages(input);
      // UTF-8 bytes overestimate ordinary text tokens; fixed allowance covers message framing.
      const reservedMicros = tokenCost(Buffer.byteLength(JSON.stringify(messages)) + 1024, MAX_OUTPUT_TOKENS, policy);
      if (usage.committedMicros + reservedMicros > BigInt(config.monthlyBudgetCents) * 10_000n) { await fail('Orçamento mensal insuficiente para reservar esta chamada.'); return; }
      const attempt = await tx.aiClassificationAttempt.create({ data: { accountId, taskId, reservedMicros, chargedMicros: reservedMicros } });
      await tx.aiClassificationTask.update({ where: { accountId, id: taskId }, data: { status: 'processing', error: null } });
      return { config, policy, task, attempt, messages };
    });
    if (!reservation) return;
    if ('delay' in reservation) return reservation.delay;
    const { config, policy, task, attempt, messages } = reservation;
    let result: Awaited<ReturnType<Provider>> | undefined;
    let failure: string | undefined;
    let rateLimited = false;
    let retryAfterMs = 60_000;
    try { result = await this.provider({ baseUrl: config.baseUrl, apiKey: decryptSecret(config.apiKey), model: config.model }, messages); }
    catch (error) {
      rateLimited = (error as { code?: string })?.code === 'rate_limit';
      retryAfterMs = Math.max(1_000, Math.min(3_600_000, Number((error as { retryAfterMs?: number })?.retryAfterMs) || 60_000));
      failure = rateLimited ? 'Provider limitou chamadas; nova tentativa agendada.' : 'Provider indisponível ou resposta inválida. Revise antes de tentar novamente.';
    }
    let output: ReturnType<typeof parseClassification> | undefined;
    if (result) { try { output = parseClassification(result.content); } catch { failure = 'Resposta de IA inválida; classificação anterior preservada.'; } }
    const measured = result?.costMicros ?? (result?.inputTokens != null && result.outputTokens != null ? tokenCost(result.inputTokens, result.outputTokens, policy) : null);
    await this.prisma.$transaction(async (tx) => {
      await lockAiAccountBudget(tx, accountId);
      // A crashed/stalled worker may be marked uncertain by recovery. Never apply its late result.
      const currentTask = await tx.aiClassificationTask.findFirst({ where: { accountId, id: taskId, status: 'processing' } });
      if (!currentTask) return;
      await tx.$queryRaw`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND id = ${task.leadId} FOR UPDATE`;
      await tx.aiClassificationAttempt.update({ where: { id: attempt.id, accountId }, data: { chargedMicros: measured ?? (rateLimited ? 0n : attempt.reservedMicros), costSource: result?.costMicros != null ? 'provider' : measured != null ? 'tokens' : rateLimited ? 'rejected' : 'reserved', completedAt: new Date() } });
      await tx.aiLog.create({ data: { accountId, feature: `classification.${task.source}`, provider: config.provider, model: config.model, inputTokens: result?.inputTokens, outputTokens: result?.outputTokens, costMicros: measured } });
      const lead = await facts(tx, accountId, task.leadId);
      const currentConfig = await tx.aiConfig.findUnique({ where: { accountId } });
      const stale = !lead || !currentConfig?.enabled || classificationHash(classificationInput(lead), currentConfig.provider, currentConfig.model, currentConfig.baseUrl) !== task.inputHash;
      if (rateLimited) {
        const currentPolicy = await tx.aiClassificationPolicy.findUnique({ where: { accountId } });
        retryAfterMs = Math.max(retryAfterMs, (currentPolicy?.cooldownUntil?.getTime() ?? 0) - Date.now());
        await tx.aiClassificationPolicy.update({ where: { accountId }, data: { cooldownUntil: new Date(Date.now() + retryAfterMs) } });
      }
      await tx.aiClassificationTask.update({ where: { accountId, id: taskId }, data: { status: stale ? 'superseded' : rateLimited ? 'pending' : failure ? 'failed' : 'completed', error: failure ?? null, ...(rateLimited ? { nextAttemptAt: new Date(Date.now() + retryAfterMs) } : {}) } });
      if (output && !stale) await tx.lead.update({ where: { accountId, id: task.leadId }, data: { aiScore: output.score, aiReason: output.reason, aiSummary: output.summary, aiAt: new Date(), aiModel: config.model, aiInputHash: task.inputHash } });
    });
    if (rateLimited) return retryAfterMs;
  }

  async discover(): Promise<void> {
    const configs = await this.prisma.aiConfig.findMany({ where: { enabled: true }, select: { accountId: true }, orderBy: { accountId: 'asc' } });
    for (const { accountId } of configs) {
      const candidates = await this.prisma.$queryRaw<Array<{ id: string; initial: boolean; conversion: boolean }>>`
        SELECT l.id, (l."aiCheckedAt" IS NULL) AS initial,
          EXISTS(SELECT 1 FROM "LeadEvent" e WHERE e."accountId" = ${accountId} AND e."leadId" = l.id AND e."ingestedAt" > l."aiCheckedAt") AS conversion
        FROM "Lead" l JOIN "AiConfig" c ON c."accountId" = l."accountId"
        WHERE l."accountId" = ${accountId} AND EXISTS (
          SELECT 1 FROM "LeadSegmentMembership" m JOIN "RdSegmentation" s ON s."accountId" = m."accountId" AND s."rdId" = m."segmentationRdId"
          WHERE m."accountId" = ${accountId} AND m."leadRdUuid" = l."rdUuid" AND s.selected AND s.available)
        AND (l."aiCheckedAt" IS NULL OR l."syncedAt" > l."aiCheckedAt" OR l."enrichedAt" > l."aiCheckedAt" OR c."updatedAt" > l."aiCheckedAt"
          OR EXISTS(SELECT 1 FROM "LeadEvent" e WHERE e."accountId" = ${accountId} AND e."leadId" = l.id AND e."ingestedAt" > l."aiCheckedAt"))
        ORDER BY l."aiCheckedAt" NULLS FIRST, l.id LIMIT 50`;
      for (const lead of candidates) await this.enqueue(accountId, lead.id, lead.initial ? 'initial' : lead.conversion ? 'conversion' : 'refresh');
    }
  }
  async recoverUncertain(): Promise<void> {
    // A request is bounded to 20s. After 5 minutes, leave cost reserved and require manual retry.
    await this.prisma.aiClassificationTask.updateMany({ where: { status: 'processing', updatedAt: { lt: new Date(Date.now() - 300_000) } }, data: { status: 'failed', error: 'Execução interrompida; custo reservado. Revise antes de tentar novamente.' } });
  }
}
