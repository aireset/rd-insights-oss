import type { Prisma } from '@prisma/client';
import { BusinessError } from '../../common/errors';

/** One account-wide lock serializes reservations across all AI features. */
export const AI_ACCOUNT_LOCK_SEED = 12014;
export const CLASSIFICATION_FEATURE_PREFIX = 'classification.';

type BudgetReader = Pick<Prisma.TransactionClient, 'aiClassificationAttempt' | 'aiLog'>;

export const utcMonthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

export const isClassificationAiFeature = (feature: string) => feature.startsWith(CLASSIFICATION_FEATURE_PREFIX);

export const combineCommittedMicros = (attempts: bigint | null | undefined, logs: bigint | null | undefined) => (attempts ?? 0n) + (logs ?? 0n);

export async function lockAiAccountBudget(tx: Prisma.TransactionClient, accountId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${accountId}, ${AI_ACCOUNT_LOCK_SEED}))`;
}

/**
 * Returns shared monthly committed cost and RPM timestamps. Classification logs
 * mirror attempts, so they are deliberately excluded from both totals.
 */
export async function getAiAccountUsage(
  client: BudgetReader,
  accountId: string,
  monthStart = utcMonthStart(),
  minuteStart = new Date(Date.now() - 60_000),
) {
  const nonClassificationLogs = { NOT: { feature: { startsWith: CLASSIFICATION_FEATURE_PREFIX } } };
  const [attemptTotal, otherLogTotal, attempts, otherLogs] = await Promise.all([
    client.aiClassificationAttempt.aggregate({ where: { accountId, createdAt: { gte: monthStart } }, _sum: { chargedMicros: true } }),
    client.aiLog.aggregate({ where: { accountId, createdAt: { gte: monthStart }, ...nonClassificationLogs }, _sum: { costMicros: true } }),
    client.aiClassificationAttempt.findMany({ where: { accountId, createdAt: { gte: minuteStart } }, select: { createdAt: true } }),
    client.aiLog.findMany({ where: { accountId, createdAt: { gte: minuteStart }, ...nonClassificationLogs }, select: { createdAt: true } }),
  ]);
  return {
    committedMicros: combineCommittedMicros(attemptTotal._sum.chargedMicros, otherLogTotal._sum.costMicros),
    recentRequestTimes: [...attempts, ...otherLogs].map(({ createdAt }) => createdAt).sort((a, b) => a.getTime() - b.getTime()),
  };
}

export type AiLogReservation = {
  accountId: string;
  feature: string;
  provider: string;
  model: string;
  monthlyBudgetCents: number;
  requestsPerMinute: number;
  reservedMicros: bigint;
};

/** Locks, checks the shared budget/RPM and persists a reservation before provider I/O. */
export async function reserveAiLog(tx: Prisma.TransactionClient, input: AiLogReservation) {
  await lockAiAccountBudget(tx, input.accountId);
  const usage = await getAiAccountUsage(tx, input.accountId);
  if (usage.recentRequestTimes.length >= input.requestsPerMinute) {
    throw new BusinessError('Limite de chamadas por minuto atingido. Aguarde e tente novamente.');
  }
  if (usage.committedMicros + input.reservedMicros > BigInt(input.monthlyBudgetCents) * 10_000n) {
    throw new BusinessError('Orçamento mensal insuficiente para reservar esta chamada.');
  }
  return tx.aiLog.create({ data: {
    accountId: input.accountId,
    feature: input.feature,
    provider: input.provider,
    model: input.model,
    costMicros: input.reservedMicros,
  } });
}
