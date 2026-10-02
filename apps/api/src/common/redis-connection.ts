import type { ConnectionOptions } from 'bullmq';

export function redisConnectionOptions(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('REDIS_URL deve usar redis:// ou rediss://');
  const database = url.pathname.slice(1);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(database ? { db: Number(database) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: 1,
  };
}
