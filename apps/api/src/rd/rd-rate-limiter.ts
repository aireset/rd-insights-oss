import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Env } from '../config/env.schema';
import { createHash } from 'node:crypto';

const TAKE_TOKEN = `
local limit = tonumber(ARGV[1])
local nowParts = redis.call('TIME')
local now = nowParts[1] * 1000 + math.floor(nowParts[2] / 1000)
local interval = 60000 / limit
local function refill(key)
  local values = redis.call('HMGET', key, 'tokens', 'updatedAt')
  local tokens = tonumber(values[1]) or limit
  local updatedAt = tonumber(values[2]) or now
  return math.min(limit, tokens + math.max(0, now - updatedAt) / interval)
end
local globalTokens = refill(KEYS[1])
local endpointTokens = refill(KEYS[2])
local globalWait = globalTokens >= 1 and 0 or math.ceil((1 - globalTokens) * interval)
local endpointWait = endpointTokens >= 1 and 0 or math.ceil((1 - endpointTokens) * interval)
if globalWait == 0 and endpointWait == 0 then
  globalTokens = globalTokens - 1
  endpointTokens = endpointTokens - 1
end
redis.call('HSET', KEYS[1], 'tokens', globalTokens, 'updatedAt', now)
redis.call('HSET', KEYS[2], 'tokens', endpointTokens, 'updatedAt', now)
redis.call('PEXPIRE', KEYS[1], 120000)
redis.call('PEXPIRE', KEYS[2], 120000)
return math.max(globalWait, endpointWait)
`;

@Injectable()
export class RdRateLimiter implements OnApplicationShutdown {
  private readonly redis?: Redis;
  private readonly limitPerMinute: number;
  private connecting?: Promise<void>;

  constructor(@Inject(ConfigService) config: ConfigService<Env, true>) {
    const url = config.get('REDIS_URL', { infer: true });
    this.limitPerMinute = config.get('RD_RATE_LIMIT_PER_MIN', { infer: true });
    if (url) {
      this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 5_000, commandTimeout: 5_000 });
      this.redis.on('error', () => undefined);
    }
  }

  async tryAcquire(accountId: string, endpoint: string): Promise<number> {
    if (!this.redis) throw new ServiceUnavailableException('Limite RD indisponível: Redis não configurado');
    const accountKey = createHash('sha256').update(accountId).digest('hex');
    const endpointKey = createHash('sha256').update(endpoint).digest('hex');
    try {
      if (this.redis.status !== 'ready') {
        this.connecting ??= (this.redis.status === 'wait' || this.redis.status === 'end'
          ? this.redis.connect()
          : new Promise<void>((resolve, reject) => {
            this.redis!.once('ready', resolve);
            this.redis!.once('error', reject);
          })).finally(() => { this.connecting = undefined; });
        await this.connecting;
      }
      return Number(await this.redis.eval(TAKE_TOKEN, 2, `rd-rate:${accountKey}:global`, `rd-rate:${accountKey}:endpoint:${endpointKey}`, this.limitPerMinute));
    } catch {
      throw new ServiceUnavailableException('Limite RD indisponível: Redis sem resposta');
    }
  }

  async acquire(accountId: string, endpoint: string): Promise<void> {
    for (;;) {
      const waitMs = await this.tryAcquire(accountId, endpoint);
      if (waitMs === 0) return;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  onApplicationShutdown(): void {
    this.redis?.disconnect();
  }
}
