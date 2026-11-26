import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  idempotencyKey: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));

const tenantContextMock = vi.hoisted(() => ({
  getTenantContext: vi.fn(),
}));

vi.mock("../database/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../context/tenantContext.js", () => ({
  getTenantContext: tenantContextMock.getTenantContext,
}));

import { IdempotencyRepository } from "../modules/idempotency/idempotency.repository.js";
import { IdempotencyService } from "../modules/idempotency/idempotency.service.js";

describe("Phase 1.1 — Idempotency Lock Recovery & Durable Release Ordering", () => {
  const tenantA = "tenant-idem-p11-A";
  const tenantB = "tenant-idem-p11-B";
  let keyCounter = 0;
  const nextKey = (prefix: string) => `${prefix}-${Date.now()}-${++keyCounter}`;

  beforeEach(() => {
    vi.clearAllMocks();
    tenantContextMock.getTenantContext.mockReturnValue(undefined);
    prismaMock.$transaction.mockImplementation(async (callback: any) =>
      callback({
        idempotencyKey: prismaMock.idempotencyKey,
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("1. releaseLock returns explicit RELEASED result when durable PostgreSQL deleteMany removes an unresolved lock", async () => {
    const key = nextKey("release-ok");
    prismaMock.idempotencyKey.deleteMany.mockResolvedValueOnce({ count: 1 });

    const result = await IdempotencyRepository.releaseLock(key, tenantA);

    expect(prismaMock.idempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: {
        tenantId: tenantA,
        key,
        responseStatus: null,
      },
    });
    expect(result).toEqual({
      status: "RELEASED",
      released: true,
      releasedCount: 1,
      durableConfirmed: true,
    });
  });

  it("2. releaseLock returns explicit NOT_FOUND result when no releasable lock exists (never claims RELEASED from local memory)", async () => {
    const key = nextKey("release-missing");
    // Simulate a local memory fallback entry created during an earlier DB outage
    prismaMock.$transaction.mockRejectedValueOnce(new Error("P1001: Can't reach database server"));
    await IdempotencyRepository.acquireLock(key, "hash-missing", "/api/invoices/post", "POST", "u-1", tenantA);

    // DB returns online and confirms 0 durable unresolved rows exist
    prismaMock.idempotencyKey.deleteMany.mockResolvedValueOnce({ count: 0 });
    const result = await IdempotencyRepository.releaseLock(key, tenantA);

    expect(result).toEqual({
      status: "NOT_FOUND",
      released: false,
      releasedCount: 0,
      durableConfirmed: true,
    });
  });

  it("3. releaseLock returns explicit DB_ERROR when deleteMany fails due to PostgreSQL disconnect (never swallows as success)", async () => {
    const key = nextKey("release-db-down");
    const dbError = new Error("P1001: Can't reach database server at localhost:5432");
    prismaMock.idempotencyKey.deleteMany.mockRejectedValueOnce(dbError);

    const result = await IdempotencyRepository.releaseLock(key, tenantA);

    expect(result.status).toBe("DB_ERROR");
    expect(result.released).toBe(false);
    expect(result.releasedCount).toBe(0);
    expect(result.durableConfirmed).toBe(false);
    expect(result.error).toBe(dbError);
  });

  it("4. does NOT delete in-memory entry before durable DB deleteMany completes or when deleteMany fails", async () => {
    const key = nextKey("release-order");

    // Populate inMemoryFallbackStore naturally via acquireLock during DB outage
    prismaMock.$transaction.mockRejectedValueOnce(new Error("P1001: Can't reach database server"));
    const acquired = await IdempotencyRepository.acquireLock(
      key,
      "hash-order",
      "/api/invoices/post",
      "POST",
      "u-1",
      tenantA
    );
    expect(acquired.isNew).toBe(true);

    // 4a. When deleteMany fails, the in-memory entry MUST still exist
    prismaMock.idempotencyKey.deleteMany.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const failedResult = await IdempotencyRepository.releaseLock(key, tenantA);
    expect(failedResult.status).toBe("DB_ERROR");

    // findByKey returns the intact in-memory entry without hitting prisma.findUnique
    prismaMock.idempotencyKey.findUnique.mockResolvedValue(null);
    const stillPresentAfterFailure = await IdempotencyRepository.findByKey(key, tenantA);
    expect(stillPresentAfterFailure).not.toBeNull();
    expect(stillPresentAfterFailure?.key).toBe(key);
    expect(stillPresentAfterFailure?.processing).toBe(true);
    expect(prismaMock.idempotencyKey.findUnique).not.toHaveBeenCalled();

    // 4b. Even WHILE deleteMany is executing (before it resolves), memory entry MUST NOT have been deleted yet
    let presentDuringDeleteMany = false;
    prismaMock.idempotencyKey.deleteMany.mockImplementationOnce(async () => {
      const midCallRecord = await IdempotencyRepository.findByKey(key, tenantA);
      presentDuringDeleteMany = Boolean(midCallRecord && midCallRecord.key === key);
      return { count: 1 };
    });

    const recoveredResult = await IdempotencyRepository.releaseLock(key, tenantA);
    expect(presentDuringDeleteMany).toBe(true);
    expect(recoveredResult).toEqual({
      status: "RELEASED",
      released: true,
      releasedCount: 1,
      durableConfirmed: true,
    });

    // 4c. ONLY AFTER durable deleteMany succeeded is the memory entry cleared
    const afterSuccess = await IdempotencyRepository.findByKey(key, tenantA);
    expect(afterSuccess).toBeNull();
    expect(prismaMock.idempotencyKey.findUnique).toHaveBeenCalledTimes(1);
  });

  it("5. IdempotencyService retains inFlightKeys guard on DB_ERROR and allows clean retry after DB recovers", async () => {
    const key = nextKey("service-recovery");

    // Acquire lock cleanly via IdempotencyService.handlePreRequest
    prismaMock.idempotencyKey.findUnique.mockResolvedValueOnce(null);
    prismaMock.idempotencyKey.create.mockResolvedValueOnce({
      id: "row-svc-1",
      tenantId: tenantA,
      key,
      requestHash: IdempotencyService.generateRequestHash("/api/invoices/post", "POST", { invoiceId: "inv-1" }, "u-1"),
      endpoint: "/api/invoices/post",
      requestMethod: "POST",
      userId: "u-1",
      responseBody: null,
      responseStatus: null,
      processing: true,
      lockedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });

    const pre = await IdempotencyService.handlePreRequest(
      key,
      "/api/invoices/post",
      "POST",
      { invoiceId: "inv-1" },
      "u-1",
      tenantA
    );
    expect(pre.status).toBe("PROCESS");

    // First release attempt fails due to PostgreSQL disconnect
    prismaMock.idempotencyKey.deleteMany.mockRejectedValueOnce(new Error("P1001: Database unavailable"));
    const failedRelease = await IdempotencyService.releaseLock(key, tenantA);
    expect(failedRelease.status).toBe("DB_ERROR");
    expect(failedRelease.durableConfirmed).toBe(false);

    // Because durable DB release failed, in-flight guard MUST still block concurrent duplicate execution
    await expect(
      IdempotencyService.handlePreRequest(
        key,
        "/api/invoices/post",
        "POST",
        { invoiceId: "inv-1" },
        "u-1",
        tenantA
      )
    ).rejects.toThrow("CONCURRENT_LOCK");

    // DB returns online -> retry releaseLock succeeds and clears inFlightKeys
    prismaMock.idempotencyKey.deleteMany.mockResolvedValueOnce({ count: 1 });
    const recoveredRelease = await IdempotencyService.releaseLock(key, tenantA);
    expect(recoveredRelease).toEqual({
      status: "RELEASED",
      released: true,
      releasedCount: 1,
      durableConfirmed: true,
    });

    // Now the retried request can acquire the lock and proceed cleanly
    prismaMock.idempotencyKey.findUnique.mockResolvedValueOnce(null);
    prismaMock.idempotencyKey.create.mockResolvedValueOnce({
      id: "row-svc-2",
      tenantId: tenantA,
      key,
      requestHash: pre.hash,
      endpoint: "/api/invoices/post",
      requestMethod: "POST",
      userId: "u-1",
      responseBody: null,
      responseStatus: null,
      processing: true,
      lockedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });

    const retried = await IdempotencyService.handlePreRequest(
      key,
      "/api/invoices/post",
      "POST",
      { invoiceId: "inv-1" },
      "u-1",
      tenantA
    );
    expect(retried.status).toBe("PROCESS");

    // Cleanup lock
    prismaMock.idempotencyKey.deleteMany.mockResolvedValueOnce({ count: 1 });
    await IdempotencyService.releaseLock(key, tenantA);
  });

  it("6. enforces strict tenant isolation and NEVER releases another tenant's lock (in DB, memory, or inFlightKeys)", async () => {
    const sharedKey = nextKey("cross-tenant-lock");

    // Tenant A acquires lock (populate in-memory fallback too)
    prismaMock.$transaction.mockRejectedValueOnce(new Error("P1001: Can't reach database"));
    await IdempotencyRepository.acquireLock(sharedKey, "hash-A", "/api/invoices/post", "POST", "u-A", tenantA);

    // Also acquire service-level in-flight lock for Tenant A
    prismaMock.idempotencyKey.findUnique.mockResolvedValueOnce(null);
    prismaMock.idempotencyKey.create.mockResolvedValueOnce({
      id: "row-tenant-a",
      tenantId: tenantA,
      key: `${sharedKey}-svc`,
      requestHash: "hash-svc-A",
      endpoint: "/api/invoices/post",
      requestMethod: "POST",
      userId: "u-A",
      responseBody: null,
      responseStatus: null,
      processing: true,
      lockedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });
    await IdempotencyService.handlePreRequest(`${sharedKey}-svc`, "/api/invoices/post", "POST", { a: 1 }, "u-A", tenantA);

    // Tenant B attempts to release Tenant A's key
    prismaMock.idempotencyKey.deleteMany.mockImplementation(async ({ where }: any) => {
      expect(where.tenantId).toBe(tenantB);
      expect(where.responseStatus).toBeNull();
      return { count: 0 };
    });

    const repoCrossResult = await IdempotencyRepository.releaseLock(sharedKey, tenantB);
    expect(repoCrossResult).toEqual({
      status: "NOT_FOUND",
      released: false,
      releasedCount: 0,
      durableConfirmed: true,
    });

    // Tenant A's memory record is completely untouched
    const tenantARecord = await IdempotencyRepository.findByKey(sharedKey, tenantA);
    expect(tenantARecord).not.toBeNull();
    expect(tenantARecord?.tenantId).toBe(tenantA);

    // Tenant B attempting service-level releaseLock does NOT clear Tenant A's in-flight lock
    const svcCrossResult = await IdempotencyService.releaseLock(`${sharedKey}-svc`, tenantB);
    expect(svcCrossResult.status).toBe("NOT_FOUND");
    await expect(
      IdempotencyService.handlePreRequest(`${sharedKey}-svc`, "/api/invoices/post", "POST", { a: 1 }, "u-A", tenantA)
    ).rejects.toThrow("CONCURRENT_LOCK");

    // Missing tenantId must fail closed
    await expect(IdempotencyRepository.releaseLock(sharedKey, null)).rejects.toThrow(
      "TENANT_ID_REQUIRED_FOR_IDEMPOTENCY"
    );

    // Cleanup Tenant A locks
    prismaMock.idempotencyKey.deleteMany.mockResolvedValue({ count: 1 });
    await IdempotencyRepository.releaseLock(sharedKey, tenantA);
    await IdempotencyService.releaseLock(`${sharedKey}-svc`, tenantA);
  });

  it("7. NEVER releases a resolved record with non-null responseStatus in DB or in-memory cache", async () => {
    const key = nextKey("resolved-protected");

    // Create & resolve entry (simulating fallback store containing resolved 200 record)
    prismaMock.$transaction.mockRejectedValueOnce(new Error("P1001: Can't reach database"));
    await IdempotencyRepository.acquireLock(key, "hash-resolved", "/api/invoices/post", "POST", "u-1", tenantA);

    prismaMock.idempotencyKey.update.mockResolvedValueOnce({
      id: "row-res-1",
      tenantId: tenantA,
      key,
      requestHash: "hash-resolved",
      endpoint: "/api/invoices/post",
      requestMethod: "POST",
      userId: "u-1",
      responseBody: { invoiceId: "INV-200", posted: true },
      responseStatus: 200,
      processing: false,
      lockedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });
    await IdempotencyRepository.resolveKey(key, { invoiceId: "INV-200", posted: true }, 200, tenantA);

    // Attempting releaseLock must filter strictly by responseStatus: null -> 0 rows deleted
    prismaMock.idempotencyKey.deleteMany.mockImplementationOnce(async ({ where }: any) => {
      expect(where).toEqual({
        tenantId: tenantA,
        key,
        responseStatus: null,
      });
      return { count: 0 };
    });

    const result = await IdempotencyRepository.releaseLock(key, tenantA);
    expect(result).toEqual({
      status: "NOT_FOUND",
      released: false,
      releasedCount: 0,
      durableConfirmed: true,
    });

    // Resolved record MUST remain intact with responseStatus === 200
    const preserved = await IdempotencyRepository.findByKey(key, tenantA);
    expect(preserved).not.toBeNull();
    expect(preserved?.responseStatus).toBe(200);
    expect(preserved?.processing).toBe(false);
    expect(preserved?.responseBody).toEqual({ invoiceId: "INV-200", posted: true });
  });
});
