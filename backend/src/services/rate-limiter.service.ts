import { config } from '../config/env';
import { redisConnection } from '../config/redis';

/**
 * Result of a rate-limit check.
 */
export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  /** Milliseconds until the next window opens (0 if allowed). */
  retryAfterMs: number;
  windowKey: string;
}

/**
 * Result of a minimum-send-delay check.
 */
export interface MinDelayResult {
  allowed: boolean;
  /** If not allowed, how many ms the caller must wait. */
  waitMs: number;
}

// ---------------------------------------------------------------------------
// Lua script: atomic fixed-window rate limiter
//
// KEYS[1] = rate-limit Redis key  (e.g. email-rate:global:174...)
// ARGV[1] = limit (integer)
// ARGV[2] = window TTL in seconds (for auto-expiry)
//
// Returns: [allowed (0|1), currentCount]
//
// Atomicity: The entire script executes as a single Redis command; no other
// client can interleave between the GET, INCR, and EXPIRE.
// ---------------------------------------------------------------------------
const RATE_LIMIT_LUA = `
local key     = KEYS[1]
local limit   = tonumber(ARGV[1])
local ttl_sec = tonumber(ARGV[2])

local current = tonumber(redis.call('GET', key) or '0')

if current < limit then
  local newVal = redis.call('INCR', key)
  -- Set TTL only on first increment so the window auto-expires
  if newVal == 1 then
    redis.call('EXPIRE', key, ttl_sec)
  end
  return {1, newVal}
else
  return {0, current}
end
`;

// ---------------------------------------------------------------------------
// Lua script: atomic minimum-send-delay gate
//
// KEYS[1] = last-send-time Redis key  (e.g. email-send:last-send)
// ARGV[1] = minimum delay in milliseconds
// ARGV[2] = current time in milliseconds (caller supplies)
//
// Returns: [allowed (0|1), waitMs]
// ---------------------------------------------------------------------------
const MIN_DELAY_LUA = `
local key       = KEYS[1]
local minDelay  = tonumber(ARGV[1])
local now       = tonumber(ARGV[2])

local lastSend = tonumber(redis.call('GET', key) or '0')
local elapsed  = now - lastSend

if elapsed >= minDelay then
  redis.call('SET', key, tostring(now))
  redis.call('PEXPIRE', key, minDelay * 2)
  return {1, 0}
else
  return {0, minDelay - elapsed}
end
`;

/**
 * Computes the fixed-window key suffix for a given timestamp.
 * Window = floor(timestampMs / (windowSeconds * 1000))
 */
function getWindowKey(nowMs: number, windowSeconds: number): string {
  return String(Math.floor(nowMs / (windowSeconds * 1000)));
}

/**
 * Computes the start of the next rate-limit window in epoch ms.
 */
function getNextWindowStartMs(nowMs: number, windowSeconds: number): number {
  const windowMs = windowSeconds * 1000;
  return (Math.floor(nowMs / windowMs) + 1) * windowMs;
}

export class RateLimiterService {
  /**
   * Check and atomically consume one rate-limit slot.
   *
   * @param scope  Scope identifier – "global" or a sender-specific key.
   * @param limit  Maximum sends per window (defaults to config).
   * @param windowSeconds  Window duration in seconds (defaults to config).
   */
  async checkRateLimit(
    scope: string = 'global',
    limit: number = config.rateLimit.emailHourlyLimit,
    windowSeconds: number = config.rateLimit.rateLimitWindowSeconds,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const windowKey = getWindowKey(now, windowSeconds);
    const redisKey = `email-rate:${scope}:${windowKey}`;

    // Lua script returns [allowed, count]
    const result = await redisConnection.eval(
      RATE_LIMIT_LUA,
      1,
      redisKey,
      String(limit),
      // TTL = windowSeconds + 120s buffer so the key outlives the window
      String(windowSeconds + 120),
    ) as [number, number];

    const allowed = result[0] === 1;
    const currentCount = result[1];

    let retryAfterMs = 0;
    if (!allowed) {
      retryAfterMs = Math.max(getNextWindowStartMs(now, windowSeconds) - now, 1000);
    }

    return { allowed, currentCount, limit, retryAfterMs, windowKey };
  }

  /**
   * Check whether the global minimum send delay has elapsed since the last
   * permitted send. If yes, atomically records the current time and allows.
   */
  async checkMinDelay(
    delayMs: number = config.rateLimit.minSendDelayMs,
  ): Promise<MinDelayResult> {
    if (delayMs <= 0) {
      return { allowed: true, waitMs: 0 };
    }

    const now = Date.now();
    const result = await redisConnection.eval(
      MIN_DELAY_LUA,
      1,
      'email-send:last-send',
      String(delayMs),
      String(now),
    ) as [number, number];

    return {
      allowed: result[0] === 1,
      waitMs: result[1],
    };
  }

  /**
   * Read the current counter for a given scope and window without
   * modifying it. Useful for diagnostics / tests.
   */
  async getCurrentCount(
    scope: string = 'global',
    windowSeconds: number = config.rateLimit.rateLimitWindowSeconds,
  ): Promise<number> {
    const windowKey = getWindowKey(Date.now(), windowSeconds);
    const redisKey = `email-rate:${scope}:${windowKey}`;
    const val = await redisConnection.get(redisKey);
    return val ? parseInt(val, 10) : 0;
  }

  /**
   * Reset rate-limit state for a scope. Test-only.
   */
  async resetScope(
    scope: string = 'global',
    windowSeconds: number = config.rateLimit.rateLimitWindowSeconds,
  ): Promise<void> {
    const windowKey = getWindowKey(Date.now(), windowSeconds);
    const redisKey = `email-rate:${scope}:${windowKey}`;
    await redisConnection.del(redisKey);
  }

  /**
   * Reset the min-delay timestamp. Test-only.
   */
  async resetMinDelay(): Promise<void> {
    await redisConnection.del('email-send:last-send');
  }
}

export const rateLimiterService = new RateLimiterService();
