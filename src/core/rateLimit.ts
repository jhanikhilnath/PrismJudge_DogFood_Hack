import { FastifyRequest, FastifyReply } from 'fastify';

interface BucketEntry {
  timestamps: number[];
}

interface TierConfig {
  maxRequests: number;
  windowMs: number;
}

const TIERS: Record<string, TierConfig> = {
  auth: { maxRequests: 20, windowMs: 60 * 1000 },
  write: { maxRequests: 80, windowMs: 60 * 1000 },
  read: { maxRequests: 400, windowMs: 60 * 1000 },
};

// In-memory sliding window cache: key -> BucketEntry
const cache = new Map<string, BucketEntry>();

// Periodic garbage collection every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let lastCleanup = Date.now();

function purgeExpired(now: number): void {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, entry] of cache.entries()) {
    // Keep entries that have at least one timestamp within 5 minutes
    entry.timestamps = entry.timestamps.filter((ts) => now - ts < 5 * 60 * 1000);
    if (entry.timestamps.length === 0) {
      cache.delete(key);
    }
  }
}

/**
 * Creates a Fastify preHandler hook for multi-tier sliding-window rate limiting.
 * Adds standard RFC headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset.
 */
export function rateLimit(tier: 'auth' | 'write' | 'read' = 'read') {
  const config = TIERS[tier] || TIERS.read!;

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Whitelist in-memory local testing or bypassed runners if specified
    const clientKey = req.headers['x-forwarded-for']
      ? String(req.headers['x-forwarded-for']).split(',')[0]!.trim()
      : req.ip || '127.0.0.1';

    const key = `${tier}:${clientKey}`;
    const now = Date.now();
    purgeExpired(now);

    let entry = cache.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      cache.set(key, entry);
    }

    const windowStart = now - config.windowMs;
    // Filter timestamps within current sliding window
    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

    const count = entry.timestamps.length;
    const remaining = Math.max(0, config.maxRequests - count - 1);
    const oldestTimestamp = entry.timestamps[0] || now;
    const resetSeconds = Math.ceil(Math.max(1000, oldestTimestamp + config.windowMs - now) / 1000);

    reply.header('X-RateLimit-Limit', config.maxRequests);
    reply.header('X-RateLimit-Remaining', remaining);
    reply.header('X-RateLimit-Reset', resetSeconds);

    if (count >= config.maxRequests) {
      reply.header('Retry-After', resetSeconds);
      if (req.headers.accept?.includes('text/html')) {
        return reply.code(429).send(`
          <!DOCTYPE html>
          <html>
            <head><title>Too Many Requests</title></head>
            <body style="font-family: sans-serif; padding: 3rem; text-align: center;">
              <h1>429 — Rate Limit Exceeded</h1>
              <p>Too many requests sent from this address. Please wait ${resetSeconds} seconds before retrying.</p>
            </body>
          </html>
        `);
      }
      return reply.code(429).send({
        error: 'TooManyRequests',
        message: `Rate limit of ${config.maxRequests} requests per minute exceeded. Please retry in ${resetSeconds} seconds.`,
        retryAfter: resetSeconds,
      });
    }

    entry.timestamps.push(now);
  };
}

/**
 * Reset rate limit cache (useful in test teardowns).
 */
export function resetRateLimits(): void {
  cache.clear();
}
