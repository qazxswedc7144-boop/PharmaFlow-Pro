import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  failConnection: false,
  constructorCalls: 0,
  findUniqueCalls: 0,
}));

vi.mock("@prisma/client", () => {
  class PrismaClientMock {
    idempotencyKey = {
      findUnique: vi.fn(async () => {
        state.findUniqueCalls++;
        if (state.failConnection) {
          throw Object.assign(new Error("Connection pool timeout"), { code: "P2024" });
        }
        return { id: "recovered-record" };
      }),
    };
    $disconnect = vi.fn(async () => {});
    constructorMarker = ++state.constructorCalls;
  }
  return { PrismaClient: PrismaClientMock };
});

describe("Prisma offline recovery proxy", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
    state.failConnection = false;
    state.constructorCalls = 0;
    state.findUniqueCalls = 0;
  });

  it("preserves model delegates while offline and retries after the cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T00:00:00.000Z"));
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");

    const { prisma, OfflineDatabaseError } = await import("../database/prisma.js");
    state.failConnection = true;

    await expect(prisma.idempotencyKey.findUnique({ where: { id: "first" } }))
      .rejects.toBeInstanceOf(OfflineDatabaseError);

    expect(typeof prisma.idempotencyKey.findUnique).toBe("function");
    await expect(prisma.idempotencyKey.findUnique({ where: { id: "offline" } }))
      .rejects.toBeInstanceOf(OfflineDatabaseError);

    state.failConnection = false;
    await vi.advanceTimersByTimeAsync(5_001);

    await expect(prisma.idempotencyKey.findUnique({ where: { id: "recovered" } }))
      .resolves.toEqual({ id: "recovered-record" });
    expect(state.constructorCalls).toBeGreaterThanOrEqual(2);
  });
});
