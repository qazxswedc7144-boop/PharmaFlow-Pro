import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FifoService } from "../modules/inventory/services/fifo.service.js";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  incrementUsage: vi.fn(),
  productFindMany: vi.fn(),
  invoiceFindFirst: vi.fn(),
  invoiceCreate: vi.fn(),
  auditCreate: vi.fn()
}));

vi.mock("../database/tenantPrisma.js", () => ({
  tenantPrisma: { $transaction: mocks.transaction }
}));

vi.mock("../middleware/auth.middleware.js", () => ({
  authenticateToken: (req: any, _res: any, next: () => void) => {
    req.user = {
      userId: "p0-01-user",
      role: "ACCOUNTANT",
      tenantId: "TENANT-P0-01"
    };
    next();
  },
  requireRoles: () => (_req: any, _res: any, next: () => void) => next()
}));

vi.mock("../modules/saas/saas.service.js", () => ({
  SaasService: {
    checkSubscriptionLimit: vi.fn().mockResolvedValue({ allowed: true }),
    incrementUsage: mocks.incrementUsage
  }
}));

import { invoiceRouter } from "../routes/invoice.routes.js";

const TENANT_ID = "TENANT-P0-01";
const PRODUCT_ID = "8c0fce38-5f6e-4c76-9a2f-71e6cb87bfa1";

function createAddStockTx() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: PRODUCT_ID, tenantId: TENANT_ID }]),
    inventoryLayer: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "layer-25" })
    },
    inventoryBatch: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "batch-25" }),
      update: vi.fn()
    },
    inventoryMovement: { create: vi.fn().mockResolvedValue({ id: "movement-in" }) },
    product: {
      findFirst: vi.fn().mockResolvedValue({ stockQuantity: 0 }),
      update: vi.fn()
    }
  } as any;
}

function createDepleteTx() {
  return {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([{ id: PRODUCT_ID, tenantId: TENANT_ID, stockQuantity: 10, version: 0 }])
      .mockResolvedValueOnce([{
        id: "layer-25",
        batchId: "batch-25",
        batchNumber: "BATCH-25",
        quantityRemaining: 10,
        unitCost: 25,
        expiryDate: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z")
      }]),
    inventoryLayer: {
      update: vi.fn(),
      findMany: vi.fn().mockResolvedValue([])
    },
    inventoryBatch: {
      findFirst: vi.fn()
        .mockResolvedValueOnce({ id: "batch-25", batchNumber: "BATCH-25", stockQuantity: 10 })
        .mockResolvedValueOnce({ stockQuantity: 0 }),
      update: vi.fn()
    },
    inventoryMovement: { create: vi.fn() },
    fifoConsumption: { create: vi.fn() },
    product: { update: vi.fn() }
  } as any;
}

describe("P0-01 purchase-to-FIFO cost chain", () => {
  let server: ReturnType<typeof appListen> | undefined;
  let baseUrl = "";

  function appListen() {
    const app = express();
    app.use(express.json());
    app.use("/api/invoices", invoiceRouter);
    return app.listen(0);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const tx = {
      invoice: {
        findFirst: mocks.invoiceFindFirst,
        create: mocks.invoiceCreate
      },
      product: { findMany: mocks.productFindMany },
      auditLog: { create: mocks.auditCreate }
    };
    mocks.invoiceFindFirst.mockResolvedValue(null);
    mocks.productFindMany.mockResolvedValue([{
      id: PRODUCT_ID,
      price: 50
    }]);
    mocks.invoiceCreate.mockImplementation(async ({ data }: any) => ({
      id: "invoice-purchase-1",
      ...data,
      items: data.items.create
    }));
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.incrementUsage.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (callback: (value: any) => Promise<any>) => callback(tx));

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

  it("creates a PURCHASE invoice with cost equal to supplier price, not zero", async () => {
    const response = await fetch(`${baseUrl}/api/invoices/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invoiceNumber: "PUR-P0-01-001",
        type: "PURCHASE",
        totalAmount: 25,
        paymentStatus: "UNPAID",
        items: [{ productId: PRODUCT_ID, qty: 1, price: 25 }]
      })
    });

    expect(response.status).toBe(201);
    const body = await response.json() as any;
    expect(Number(body.invoice.items[0].cost)).toBe(25);
    expect(Number(body.invoice.items[0].price)).toBe(25);
  });

  it("returns HTTP 422 for a PURCHASE with price zero", async () => {
    const response = await fetch(`${baseUrl}/api/invoices/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invoiceNumber: "PUR-P0-01-ZERO",
        type: "PURCHASE",
        totalAmount: 0,
        paymentStatus: "UNPAID",
        items: [{ productId: PRODUCT_ID, qty: 1, price: 0 }]
      })
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "INVALID_PURCHASE_COST" });
    expect(mocks.invoiceCreate).not.toHaveBeenCalled();
  });

  it("rejects a PURCHASE item with missing price at request validation", async () => {
    const response = await fetch(`${baseUrl}/api/invoices/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invoiceNumber: "PUR-P0-01-MISSING",
        type: "PURCHASE",
        totalAmount: 25,
        paymentStatus: "UNPAID",
        items: [{ productId: PRODUCT_ID, qty: 1 }]
      })
    });

    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("creates a FIFO layer at 25 and depletes 10 units with COGS of 250", async () => {
    const addTx = createAddStockTx();
    await FifoService.addStock(
      addTx,
      PRODUCT_ID,
      "BATCH-25",
      10,
      25,
      null,
      "PUR-P0-01-POSTED",
      "INVOICE",
      "P0-01 purchase fixture",
      TENANT_ID,
      "BRANCH-P0-01",
      "PUR-LINE-P0-01"
    );

    const layerWrite = addTx.inventoryLayer.create.mock.calls[0][0].data;
    expect(Number(layerWrite.unitCost)).toBe(25);
    expect(layerWrite.quantityInitial).toBe(10);

    const saleTx = createDepleteTx();
    const result = await FifoService.depleteStock(
      saleTx,
      PRODUCT_ID,
      10,
      "SALE-P0-01",
      "INVOICE",
      "P0-01 sale fixture",
      TENANT_ID,
      "SALE-LINE-P0-01",
      "BRANCH-P0-01"
    );

    expect(result.totalCost).toBe(250);
    expect(result.allocations).toEqual([{
      layerId: "layer-25",
      batchId: "batch-25",
      batchNumber: "BATCH-25",
      qtyAllocated: 10,
      cost: 25
    }]);
    expect(Number(saleTx.fifoConsumption.create.mock.calls[0][0].data.totalCost)).toBe(250);
  });

  it("rejects zero, negative, NaN and infinite unit costs before any FIFO write", async () => {
    for (const invalidCost of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const tx = createAddStockTx();
      await expect(FifoService.addStock(
        tx,
        PRODUCT_ID,
        "BATCH-INVALID",
        1,
        invalidCost,
        null,
        "PUR-INVALID",
        "INVOICE",
        "invalid cost test",
        TENANT_ID
      )).rejects.toThrow(/FIFO_INVALID_COST/);

      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx.inventoryLayer.create).not.toHaveBeenCalled();
      expect(tx.inventoryBatch.create).not.toHaveBeenCalled();
    }
  });
});
