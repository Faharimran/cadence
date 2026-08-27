import Redis from "ioredis";
import { env } from "@/lib/env";

declare global {
  var __cadenceRedis: Redis | undefined;
}

/**
 * Shared connection for conversation snapshots and rate limiting.
 *
 * BullMQ deliberately does NOT use this one — it requires
 * `maxRetriesPerRequest: null` and blocking commands, which would make this
 * client unusable for ordinary reads. Workers create their own.
 */
export const redis =
  globalThis.__cadenceRedis ??
  new Redis(env.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
  });

if (env.NODE_ENV !== "production") globalThis.__cadenceRedis = redis;
