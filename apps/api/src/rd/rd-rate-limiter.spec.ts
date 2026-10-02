import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { RdRateLimiter } from './rd-rate-limiter';

const redisUrl = process.env.REDIS_TEST_URL;
const redisTests = redisUrl ? describe : describe.skip;

describe('RdRateLimiter', () => {
  it('fails closed when Redis is not configured', async () => {
    const limiter = new RdRateLimiter({ get: () => undefined } as never);
    await expect(limiter.tryAcquire('account-a', 'contacts.detail')).rejects.toThrow(/Redis|limite/i);
    await limiter.onApplicationShutdown();
  });

  it('fails closed when the configured Redis cannot be reached', async () => {
    const limiter = new RdRateLimiter({ get: (key: string) => key === 'REDIS_URL' ? 'redis://127.0.0.1:1' : 60 } as never);
    await expect(limiter.tryAcquire('account-a', 'contacts.detail')).rejects.toMatchObject({ status: 503 });
    await limiter.onApplicationShutdown();
  });
});

redisTests('RdRateLimiter shared across instances', () => {
  const limiters: RdRateLimiter[] = [];
  afterEach(async () => {
    await Promise.all(limiters.splice(0).map((limiter) => limiter.onApplicationShutdown()));
  });

  it('shares the global account budget across endpoints and limiter instances', async () => {
    const config = { get: (key: string) => key === 'REDIS_URL' ? redisUrl : key === 'RD_RATE_LIMIT_PER_MIN' ? 1 : 'test' } as never;
    const first = new RdRateLimiter(config);
    const second = new RdRateLimiter(config);
    limiters.push(first, second);
    const accountId = `rate-test-${randomUUID()}`;
    const outcomes = await Promise.all([
      first.tryAcquire(accountId, 'contacts.detail'),
      second.tryAcquire(accountId, 'contacts.events'),
    ]);
    expect(outcomes.filter((waitMs) => waitMs === 0)).toHaveLength(1);
    expect(outcomes.filter((waitMs) => waitMs > 0)).toHaveLength(1);
    await expect(first.tryAcquire(`other-${randomUUID()}`, 'contacts.detail')).resolves.toBe(0);
  });

  it('does not consume the account budget when an endpoint budget denies', async () => {
    const accountId = `rate-test-${randomUUID()}`;
    const accountKey = createHash('sha256').update(accountId).digest('hex');
    const endpointKey = createHash('sha256').update('contacts.detail').digest('hex');
    const redis = new Redis(redisUrl!);
    const bucketKey = `rd-rate:${accountKey}:endpoint:${endpointKey}`;
    try {
      const [seconds, microseconds] = await redis.time();
      const now = Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
      await redis.hset(bucketKey, 'tokens', '0', 'updatedAt', String(now));
      await redis.pexpire(bucketKey, 120_000);
    } finally { await redis.quit(); }

    const limiter = new RdRateLimiter({ get: (key: string) => key === 'REDIS_URL' ? redisUrl : key === 'RD_RATE_LIMIT_PER_MIN' ? 1 : 'test' } as never);
    limiters.push(limiter);
    await expect(limiter.tryAcquire(accountId, 'contacts.detail')).resolves.toBeGreaterThan(0);
    await expect(limiter.tryAcquire(accountId, 'contacts.events')).resolves.toBe(0);
  });
});
