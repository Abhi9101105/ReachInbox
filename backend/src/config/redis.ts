import { Redis, RedisOptions } from 'ioredis';
import { config } from './env';

export const redisConnectionOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: false,
  retryStrategy(times: number) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
};

export const redisConnection = new Redis(config.redisUrl, redisConnectionOptions);

redisConnection.on('connect', () => {
  console.log('Redis connected successfully.');
});

redisConnection.on('error', (err: Error) => {
  // Avoid noisy error logs during shutdown
  if (redisConnection.status === 'end' || redisConnection.status === 'close') {
    return;
  }
  console.error('Redis connection error:', err.message);
});

redisConnection.on('reconnecting', () => {
  if (redisConnection.status !== 'end' && redisConnection.status !== 'close') {
    console.log('Redis reconnecting...');
  }
});

export async function closeRedisConnection(): Promise<void> {
  if (redisConnection.status === 'end') {
    return;
  }

  try {
    // Attempt graceful quit with a 500ms timeout
    await Promise.race([
      redisConnection.quit(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Redis quit timed out')), 500)
      ),
    ]);
  } catch {
    // Force disconnect immediately if quit fails or times out
    try {
      redisConnection.disconnect(false);
    } catch {
      // ignore
    }
  }
}
