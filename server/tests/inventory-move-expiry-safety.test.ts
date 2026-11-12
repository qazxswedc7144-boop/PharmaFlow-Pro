import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  batchUpdate: vi.fn(),
  movementCreate: vi.fn(),
  productUpdate: vi.fn(),
  auditCreate: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  rollback: vi.fn(),
  runInTransaction: vi.fn()
}));

vi.mock("../database/tenantPrisma.js", () => ({
  tenantPrisma: {
    inventoryBatch: { findMany: vi.fn() },
    product: { findMany: vi.fn() }
  }
}));

vi.mock("../core/database/transactionGuard.js", () => ({
  runInTransaction: mocks.runInTransaction
}));

vi.mock("../middleware/auth.middleware.js", () => ({
  authenticateToken: (req: any, _res: any, next: () => void) => {
    req.user = {
      userId: "inventory-user-a",
      role: "INVENTORY_MANAGER",
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

import { inventoryRouter } from "../routes/inventory.routes.js";

describe("POST /api/inventory/move — expired/NULL FEFO safety", () => {
  let server: ReturnType<typeof appListen> | undefined;
  let baseUrl = "";

  function appListen() {
    const app = express();
    app.use(express.json());
    app.use("/api/inventory", inventoryRouter);
    return app.listen(0);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue({ id: "inventory-lock-1" });
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.queryRaw
      .mockResolvedValueOnce([{ id: "PRODUCT-A", tenantId: "TENANT-A", stockQuantity: 10, version: 0 }])
      .mockResolvedValueOnce([]);
    mocks.runInTransaction.mockImplementation(async (_service: string, callback: (tx: any) => Promise<any>) => {
      const tx = {
        $queryRaw: mocks.queryRaw,
        inventoryBatch: { update: mocks.batchUpdate },
        inventoryMovement: { create: mocks.movementCreate },
        product: { update: mocks.productUpdate },
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

  it("returns HTTP 400 and rolls back when no non-expired batch (including NULL-last candidates) can be allocated", async () => {
    const response = await fetch(`${baseUrl}/api/inventory/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        productId: "PRODUCT-A",
        qty: -2,
        batchNumber: "WRITE-OFF",
        cost: 1,
        reason: "expired stock write-off test"
      })
    });

    expect(response.status).toBe(400);
    const query = mocks.queryRaw.mock.calls[1][0];
    expect(query.sql).toContain('"expiryDate" IS NULL OR "expiryDate" > NOW()');
    expect(query.sql).toContain('"expiryDate" ASC NULLS LAST');
    expect(mocks.batchUpdate).not.toHaveBeenCalled();
    expect(mocks.movementCreate).not.toHaveBeenCalled();
    expect(mocks.productUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.rollback).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });
});
