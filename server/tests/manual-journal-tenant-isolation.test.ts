import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  journalCreate: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  accountUpdate: vi.fn(),
  auditCreate: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  rollback: vi.fn(),
  runInTransaction: vi.fn()
}));

vi.mock("../core/database/transactionGuard.js", () => ({
  runInTransaction: mocks.runInTransaction
}));

vi.mock("../middleware/auth.middleware.js", () => ({
  authenticateToken: (req: any, _res: any, next: () => void) => {
    req.user = {
      userId: "user-tenant-a",
      username: "accountant-a",
      role: "ACCOUNTANT",
      tenantId: "TENANT-A"
    };
    next();
  },
  requireRoles: () => (_req: any, _res: any, next: () => void) => next()
}));

vi.mock("../middleware/validate.js", () => ({
  validateRequestBody: () => (_req: any, _res: any, next: () => void) => next()
}));

vi.mock("../modules/locking/locking.service.js", () => ({
  LockingService: {
    acquireLock: mocks.acquireLock,
    releaseLock: mocks.releaseLock
  }
}));

import { accountingRouter } from "../routes/accounting.routes.js";

describe("POST /api/accounting/journal tenant isolation", () => {
  let server: ReturnType<typeof appListen> | undefined;
  let baseUrl = "";

  function appListen() {
    const app = express();
    app.use(express.json());
    app.use("/api/accounting", accountingRouter);
    return app.listen(0);
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    mocks.acquireLock.mockResolvedValue({ id: "lock-1" });
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.queryRaw.mockResolvedValue([{ id: "account-a" }]);
    mocks.journalCreate.mockResolvedValue({ id: "journal-created" });
    mocks.findUnique.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      tenantId: where.id === "account-b" ? "TENANT-B" : "TENANT-A",
      version: 4
    }));
    mocks.findFirst.mockImplementation(async ({ where }: any) => (
      where.id === "account-b" ? null : {
        id: where.id,
        tenantId: "TENANT-A",
        version: 4
      }
    ));
    mocks.accountUpdate.mockResolvedValue({ id: "account-a" });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });

    mocks.runInTransaction.mockImplementation(async (_service: string, callback: (tx: any) => Promise<any>) => {
      const tx = {
        $queryRaw: mocks.queryRaw,
        journalEntry: { create: mocks.journalCreate },
        account: {
          findUnique: mocks.findUnique,
          findFirst: mocks.findFirst,
          update: mocks.accountUpdate
        },
        auditLog: { create: mocks.auditCreate }
      };

      try {
        return await callback(tx);
      } catch (error) {
        mocks.rollback();
        throw error;
      }
    });

    server = appListen();
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server!.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
      server = undefined;
    }
  });

  it("rejects a journal line targeting another tenant account and rolls back the transaction", async () => {
    const response = await fetch(`${baseUrl}/api/accounting/journal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: "Cross-tenant journal attempt",
        lines: [
          { accountId: "account-a", debit: 100, credit: 0 },
          { accountId: "account-b", debit: 0, credit: 100 }
        ]
      })
    });

    expect(response.status).toBe(400);
    expect(mocks.queryRaw).toHaveBeenCalled();
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: "account-b", tenantId: "TENANT-A" },
      select: { id: true, version: true }
    });
    const accountLockQuery = mocks.queryRaw.mock.calls[0][0];
    expect(accountLockQuery.sql.join(" ")).toContain('"tenantId"');
    expect(accountLockQuery.values).toContain("TENANT-A");
    expect(mocks.journalCreate).not.toHaveBeenCalled();
    expect(mocks.accountUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.rollback).toHaveBeenCalledTimes(1);
  });
});
