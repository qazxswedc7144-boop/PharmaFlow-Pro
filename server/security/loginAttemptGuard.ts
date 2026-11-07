import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import Redis from "ioredis";
import { prisma } from "../database/prisma.js";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS_PER_USERNAME = 10;
const MAX_FAILED_ATTEMPTS_PER_IP = 100;
const USER_KEY_PREFIX = "pharmaflow:{auth-login}:user:";
const IP_KEY_PREFIX = "pharmaflow:{auth-login}:ip:";

type MemoryCounter = { count: number; expiresAt: number };
type Reservation = { usernameKey: string; ipKey: string };
const memoryCounters = new Map<string, MemoryCounter>();
const reservations = new WeakMap<Request, Reservation>();
let redisClient: Redis | null = null;
let redisConnectPromise: Promise<void> | null = null;

const ACQUIRE_SCRIPT = `
local userCount = tonumber(redis.call("GET", KEYS[1]) or "0")
local ipCount = tonumber(redis.call("GET", KEYS[2]) or "0")
local userTtl = redis.call("PTTL", KEYS[1])
local ipTtl = redis.call("PTTL", KEYS[2])
if userCount >= tonumber(ARGV[2]) or ipCount >= tonumber(ARGV[3]) then
  local retry = math.max(userTtl, ipTtl, 0)
  return {0, userCount, ipCount, retry}
end
userCount = redis.call("INCR", KEYS[1])
if userCount == 1 then redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[1])) end
ipCount = redis.call("INCR", KEYS[2])
if ipCount == 1 then redis.call("PEXPIRE", KEYS[2], tonumber(ARGV[1])) end
return {1, userCount, ipCount, math.max(redis.call("PTTL", KEYS[1]), redis.call("PTTL", KEYS[2]), 0)}
`;

const RELEASE_SCRIPT = `
for i = 1, #KEYS do
  local count = tonumber(redis.call("GET", KEYS[i]) or "0")
  if count > 1 then redis.call("DECR", KEYS[i]) else redis.call("DEL", KEYS[i]) end
end
return 1
`;

export class LoginAttemptAuditError extends Error {
  constructor() {
    super("LOGIN_ATTEMPT_AUDIT_UNAVAILABLE");
    this.name = "LoginAttemptAuditError";
  }
}

export class LoginAttemptStoreError extends Error {
  constructor() {
    super("LOGIN_ATTEMPT_STORE_UNAVAILABLE");
    this.name = "LoginAttemptStoreError";
  }
}

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function getRequestKeys(req: Request): Reservation {
  const username = typeof req.body?.username === "string" ? req.body.username.trim().toLocaleLowerCase("en-US") : "";
  const ipAddress = req.ip || req.socket.remoteAddress || "unknown";
  return {
    usernameKey: USER_KEY_PREFIX + digest(username),
    ipKey: IP_KEY_PREFIX + digest(ipAddress.toLowerCase())
  };
}

async function getRedisClient(): Promise<Redis> {
  const url = process.env.REDIS_URL?.trim();
  if (!url) throw new LoginAttemptStoreError();

  if (!redisClient || redisClient.status === "end") {
    redisClient = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2500,
      retryStrategy: () => null
    });
    redisClient.on("error", () => {
      // Request handlers return a generic 503; never log credentials or Redis URLs.
    });
  }

  if (redisClient.status === "wait") {
    if (!redisConnectPromise) {
      redisConnectPromise = redisClient.connect().then(() => undefined).finally(() => {
        redisConnectPromise = null;
      });
    }
    await redisConnectPromise;
  }

  if (redisClient.status !== "ready") throw new LoginAttemptStoreError();
  return redisClient;
}

function reserveInMemory(keys: Reservation): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  for (const key of [keys.usernameKey, keys.ipKey]) {
    const current = memoryCounters.get(key);
    if (current && current.expiresAt <= now) memoryCounters.delete(key);
  }

  const user = memoryCounters.get(keys.usernameKey);
  const ip = memoryCounters.get(keys.ipKey);
  if ((user?.count || 0) >= MAX_FAILED_ATTEMPTS_PER_USERNAME || (ip?.count || 0) >= MAX_FAILED_ATTEMPTS_PER_IP) {
    return {
      allowed: false,
      retryAfterMs: Math.max(0, (user?.expiresAt || 0) - now, (ip?.expiresAt || 0) - now)
    };
  }

  const expiresAt = now + WINDOW_MS;
  memoryCounters.set(keys.usernameKey, { count: (user?.count || 0) + 1, expiresAt: user?.expiresAt || expiresAt });
  memoryCounters.set(keys.ipKey, { count: (ip?.count || 0) + 1, expiresAt: ip?.expiresAt || expiresAt });
  return { allowed: true, retryAfterMs: WINDOW_MS };
}

async function reserveAttempt(keys: Reservation): Promise<{ allowed: boolean; retryAfterMs: number }> {
  if (!isProductionRuntime()) return reserveInMemory(keys);

  const redis = await getRedisClient();
  const result = await redis.eval(
    ACQUIRE_SCRIPT,
    2,
    keys.usernameKey,
    keys.ipKey,
    String(WINDOW_MS),
    String(MAX_FAILED_ATTEMPTS_PER_USERNAME),
    String(MAX_FAILED_ATTEMPTS_PER_IP)
  ) as [number, number, number, number];

  return { allowed: Number(result[0]) === 1, retryAfterMs: Math.max(0, Number(result[3]) || WINDOW_MS) };
}

export async function releaseLoginAttempt(req: Request): Promise<void> {
  const keys = reservations.get(req);
  if (!keys) return;

  if (!isProductionRuntime()) {
    for (const key of [keys.usernameKey, keys.ipKey]) {
      const current = memoryCounters.get(key);
      if (!current) continue;
      if (current.count <= 1) memoryCounters.delete(key);
      else memoryCounters.set(key, { ...current, count: current.count - 1 });
    }
    reservations.delete(req);
    return;
  }

  try {
    const redis = await getRedisClient();
    await redis.eval(RELEASE_SCRIPT, 2, keys.usernameKey, keys.ipKey);
    reservations.delete(req);
  } catch {
    throw new LoginAttemptStoreError();
  }
}

export async function loginAttemptGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  if (!username) {
    next();
    return;
  }

  const keys = getRequestKeys(req);
  try {
    const result = await reserveAttempt(keys);
    if (!result.allowed) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
      res.status(429).json({
        error: "RATE_LIMIT_EXCEEDED",
        message: "تم تقييد محاولات تسجيل الدخول مؤقتاً لحماية الحساب. يرجى المحاولة بعد انتهاء فترة الانتظار."
      });
      return;
    }
    reservations.set(req, keys);
    next();
  } catch {
    res.status(503).json({
      error: "AUTH_TEMPORARILY_UNAVAILABLE",
      message: "خدمة حماية تسجيل الدخول غير متاحة حالياً. يرجى المحاولة لاحقاً."
    });
  }
}

export async function recordFailedLoginAttempt(
  username: string,
  ipAddress?: string,
  userId?: string,
  tenantId?: string
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: "USER_LOGIN",
        entity: "User",
        entityId: username,
        userId: userId || null,
        tenantId: tenantId || "SYSTEM",
        after: JSON.stringify({ status: "FAILED" }),
        ipAddress: ipAddress || null
      }
    });
  } catch {
    throw new LoginAttemptAuditError();
  }
}

export function resetLoginAttemptGuardForTests(): void {
  memoryCounters.clear();
  redisClient?.disconnect();
  redisClient = null;
  redisConnectPromise = null;
}
