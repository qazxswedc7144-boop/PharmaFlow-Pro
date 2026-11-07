import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  counters: new Map<string, { count: number; expiresAt: number }>(),
  redisFails: false,
  prismaCreate: vi.fn()
}));

vi.mock("ioredis", () => {
  class RedisMock {
    status = "ready";
    on() { return this; }
    connect = vi.fn(async () => { this.status = "ready"; });
    disconnect = vi.fn();
    eval = vi.fn(async (script: string, numberOfKeys: number, ...args: string[]) => {
      if (testState.redisFails) throw new Error("Redis unavailable");
      const keys = args.slice(0, numberOfKeys);
      const values = args.slice(numberOfKeys);
      const now = Date.now();

      for (const key of keys) {
        const current = testState.counters.get(key);
        if (current && current.expiresAt <= now) testState.counters.delete(key);
      }

      if (script.includes("INCR")) {
        const [windowMs, userLimit, ipLimit] = values.map(Number);
        const user = testState.counters.get(keys[0]);
        const ip = testState.counters.get(keys[1]);
        if ((user?.count || 0) >= userLimit || (ip?.count || 0) >= ipLimit) {
          return [0, user?.count || 0, ip?.count || 0, windowMs];
        }

        const expiresAt = now + windowMs;
        testState.counters.set(keys[0], {
          count: (user?.count || 0) + 1,
          expiresAt: user?.expiresAt || expiresAt
        });
        testState.counters.set(keys[1], {
          count: (ip?.count || 0) + 1,
          expiresAt: ip?.expiresAt || expiresAt
        });
        return [1, (user?.count || 0) + 1, (ip?.count || 0) + 1, windowMs];
      }

      for (const key of keys) {
        const current = testState.counters.get(key);
        if (!current) continue;
        if (current.count <= 1) testState.counters.delete(key);
        else testState.counters.set(key, { ...current, count: current.count - 1 });
      }
      return 1;
    });
  }

  return { default: RedisMock };
});

vi.mock("../database/prisma.js", () => ({
  prisma: {
    auditLog: {
      create: testState.prismaCreate
    }
  }
}));

import {
  loginAttemptGuard,
  recordFailedLoginAttempt,
  releaseLoginAttempt,
  LoginAttemptAuditError,
  LoginAttemptStoreError,
  resetLoginAttemptGuardForTests
} from "../security/loginAttemptGuard.js";

function makeRequest(username = "pharmacist", ip = "203.0.113.10") {
  return {
    body: { username },
    ip,
    socket: { remoteAddress: ip }
  } as any;
}

function makeResponse() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn()
  } as any;
}

async function runGuard(username: string, ip: string) {
  const req = makeRequest(username, ip);
  const res = makeResponse();
  const next = vi.fn();
  await loginAttemptGuard(req, res, next);
  return { req, res, next };
}

describe("Redis-backed atomic login attempt protection", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("REDIS_URL", "redis://test.invalid:6379");
    testState.counters.clear();
    testState.redisFails = false;
    vi.clearAllMocks();
    testState.prismaCreate.mockResolvedValue({ id: "audit-attempt-1" });
    resetLoginAttemptGuardForTests();
  });

  afterEach(() => {
    resetLoginAttemptGuardForTests();
    vi.unstubAllEnvs();
  });

  it("releases the reservation immediately after a successful password verification", async () => {
    const { req, next } = await runGuard("successful-user", "203.0.113.1");
    expect(next).toHaveBeenCalledOnce();
    expect(testState.counters.size).toBe(2);

    await releaseLoginAttempt(req);
    expect(testState.counters.size).toBe(0);
  });

  it("allows at most 10 reservations for the same username in 15 minutes", async () => {
    const results = await Promise.all(
      Array.from({ length: 11 }, (_, index) => runGuard("same-user", `203.0.113.${index + 1}`))
    );

    expect(results.filter(result => result.next.mock.calls.length === 1)).toHaveLength(10);
    expect(results.filter(result => result.res.status.mock.calls.some(([status]) => status === 429))).toHaveLength(1);
  });

  it("allows at most 100 reservations for the same IP across usernames", async () => {
    const results = await Promise.all(
      Array.from({ length: 101 }, (_, index) => runGuard(`user-${index}`, "203.0.113.77"))
    );

    expect(results.filter(result => result.next.mock.calls.length === 1)).toHaveLength(100);
    expect(results.filter(result => result.res.status.mock.calls.some(([status]) => status === 429))).toHaveLength(1);
  });

  it("does not exceed either limit under concurrent requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => runGuard("concurrent-user", "203.0.113.88"))
    );

    expect(results.filter(result => result.next.mock.calls.length === 1)).toHaveLength(10);
    expect(results.filter(result => result.res.status.mock.calls.some(([status]) => status === 429))).toHaveLength(15);
  });

  it("returns an explicit 503 and does not continue when Redis is unavailable", async () => {
    testState.redisFails = true;
    const { res, next } = await runGuard("redis-down-user", "203.0.113.99");

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: "AUTH_TEMPORARILY_UNAVAILABLE"
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed when REDIS_URL is not configured in production", async () => {
    vi.stubEnv("REDIS_URL", "");
    const { res, next } = await runGuard("missing-redis-url", "203.0.113.100");

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("persists failed attempts using the existing AuditLog schema", async () => {
    await recordFailedLoginAttempt("pharmacist", "203.0.113.10", "user-1", "tenant-1");

    expect(testState.prismaCreate).toHaveBeenCalledWith({
      data: {
        action: "USER_LOGIN",
        entity: "User",
        entityId: "pharmacist",
        userId: "user-1",
        tenantId: "tenant-1",
        after: JSON.stringify({ status: "FAILED" }),
        ipAddress: "203.0.113.10"
      }
    });
  });

  it("does not silently ignore failure to persist a failed login attempt", async () => {
    testState.prismaCreate.mockRejectedValue(new Error("write failed"));

    await expect(recordFailedLoginAttempt("pharmacist", "203.0.113.10"))
      .rejects.toBeInstanceOf(LoginAttemptAuditError);
  });

  it("exposes a typed store error for Redis failures", async () => {
    testState.pingFails = true;
    const { res } = await runGuard("store-error-user", "203.0.113.101");
    expect(res.status).toHaveBeenCalledWith(503);
    expect(LoginAttemptStoreError).toBeDefined();
  });
});
