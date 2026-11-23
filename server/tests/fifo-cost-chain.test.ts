import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { FifoService } from "../modules/inventory/services/fifo.service.js";
import { FinancialTransactionService } from "../modules/accounting/services/financialTransaction.service.js";

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
      tenantId: "TENANT-P0-01",
      branchId: "BRANCH-P0-01"
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
    branch: { findFirst: vi.fn().mockResolvedValue({ id: "BRANCH-P0-01" }) },
    branchInventory: { upsert: vi.fn().mockResolvedValue({ stockQuantity: 10 }) },
    inventoryLayer: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "layer-25" }),
      aggregate: vi.fn().mockResolvedValue({ _sum: { quantityRemaining: 10 } })
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


function createPurchasePostingTx() {
  let nextAccountId = 0;
  return {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([{
        id: "invoice-purchase-1",
        documentStatus: "ACTIVE",
        status: "DRAFT",
        date: new Date("2026-11-23T00:00:00.000Z")
      }])
      .mockResolvedValueOnce([{ id: "period-1", isLocked: false }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    account: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: `account-${++nextAccountId}`,
        ...data,
        version: 0
      })),
      findUnique: vi.fn().mockResolvedValue({ version: 0, name: "Test Account" }),
      update: vi.fn().mockResolvedValue({ id: "updated-account" })
    },
    journalEntry: { create: vi.fn().mockResolvedValue({ id: "journal-purchase-1" }) },
    invoice: { update: vi.fn().mockResolvedValue({ id: "invoice-purchase-1", documentStatus: "POSTED" }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-post-1" }) }
  } as any;
}

function createSalesPostingTx() {
  let nextAccountId = 0;
  return {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([{
        id: "invoice-sale-1",
        documentStatus: "ACTIVE",
        status: "DRAFT",
        date: new Date("2026-11-23T00:00:00.000Z")
      }])
      .mockResolvedValueOnce([{ id: "period-1", isLocked: false }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    tenantSalesPolicy: {
      findUnique: vi.fn().mockResolvedValue({
        maxDiscountPercent: 0,
        taxRatePercent: 0,
        taxMode: "NONE"
      })
    },
    account: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: `sales-account-${++nextAccountId}`,
        ...data,
        version: 0
      })),
      findUnique: vi.fn().mockResolvedValue({ version: 0, name: "Test Account" }),
      update: vi.fn().mockResolvedValue({ id: "updated-account" })
    },
    invoiceItem: { update: vi.fn().mockResolvedValue({ id: "SALE-LINE-P0-01" }) },
    journalEntry: { create: vi.fn().mockImplementation(async ({ data }: any) => ({
      id: "journal-sale-1",
      lines: data.lines.create
    })) },
    invoice: { update: vi.fn().mockResolvedValue({ id: "invoice-sale-1", documentStatus: "POSTED" }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-sale-1" }) }
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
    branch: { findFirst: vi.fn().mockResolvedValue({ id: "BRANCH-P0-01" }) },
    branchInventory: {
      findUnique: vi.fn().mockResolvedValue({ stockQuantity: 10 }),
      update: vi.fn().mockResolvedValue({ stockQuantity: 0 })
    },
    inventoryLayer: {
      update: vi.fn(),
      aggregate: vi.fn()
        .mockResolvedValueOnce({ _sum: { quantityRemaining: 10 } })
        .mockResolvedValueOnce({ _sum: { quantityRemaining: 0 } }),
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
      branch: { findFirst: vi.fn().mockResolvedValue({ id: "BRANCH-P0-01" }) },
      branchUser: { findFirst: vi.fn().mockResolvedValue({ id: "branch-user-p0-01" }) },
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

    const postingTx = createPurchasePostingTx();
    const addStockSpy = vi.spyOn(FifoService, "addStock").mockResolvedValue(undefined);
    try {
      await FinancialTransactionService.executeInvoiceLedgerPosting(
        postingTx,
        {
          id: "invoice-purchase-1",
          invoiceNumber: "PUR-P0-01-POSTED",
          type: "PURCHASE",
          date: new Date("2026-11-23T00:00:00.000Z"),
          documentStatus: "ACTIVE",
          status: "DRAFT",
          totalAmount: new Prisma.Decimal(250),
          paymentStatus: "UNPAID",
          tenantId: TENANT_ID,
          branchId: "BRANCH-P0-01",
          items: [{
            id: "PUR-LINE-P0-01",
            productId: PRODUCT_ID,
            qty: 10,
            cost: new Prisma.Decimal(25),
            price: new Prisma.Decimal(25),
            expiryDate: null,
            note: "BATCH-25",
            product: { price: new Prisma.Decimal(40) }
          }]
        } as any,
        null,
        null,
        TENANT_ID
      );
      expect(addStockSpy).toHaveBeenCalledWith(
        postingTx,
        PRODUCT_ID,
        "BATCH-25",
        10,
        25,
        null,
        "invoice-purchase-1",
        "INVOICE",
        expect.any(String),
        TENANT_ID,
        "BRANCH-P0-01",
        "PUR-LINE-P0-01"
      );
    } finally {
      addStockSpy.mockRestore();
    }

    const invalidPostingTx = createPurchasePostingTx();
    const guardedAddStockSpy = vi.spyOn(FifoService, "addStock").mockResolvedValue(undefined);
    try {
      await expect(FinancialTransactionService.executeInvoiceLedgerPosting(
        invalidPostingTx,
        {
          id: "invoice-purchase-zero",
          invoiceNumber: "PUR-P0-01-ZERO",
          type: "PURCHASE",
          date: new Date("2026-11-23T00:00:00.000Z"),
          documentStatus: "ACTIVE",
          status: "DRAFT",
          totalAmount: new Prisma.Decimal(0),
          paymentStatus: "UNPAID",
          tenantId: TENANT_ID,
          branchId: "BRANCH-P0-01",
          items: [{
            id: "PUR-LINE-P0-01-ZERO",
            productId: PRODUCT_ID,
            qty: 1,
            cost: new Prisma.Decimal(0),
            price: new Prisma.Decimal(0),
            expiryDate: null,
            note: "BATCH-ZERO"
          }]
        } as any,
        null,
        null,
        TENANT_ID
      )).rejects.toMatchObject({ code: "PURCHASE_ITEM_COST_MISSING" });
      expect(guardedAddStockSpy).not.toHaveBeenCalled();
    } finally {
      guardedAddStockSpy.mockRestore();
    }

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

  it("posts SALE COGS debit and inventory credit from FIFO at exactly 250", async () => {
    const tx = createSalesPostingTx();
    const depleteSpy = vi.spyOn(FifoService, "depleteStock").mockResolvedValue({
      allocations: [{
        layerId: "layer-25",
        batchId: "batch-25",
        batchNumber: "BATCH-25",
        qtyAllocated: 10,
        cost: 25
      }],
      totalCost: 250
    });

    try {
      const result = await FinancialTransactionService.executeInvoiceLedgerPosting(
        tx,
        {
          id: "invoice-sale-1",
          invoiceNumber: "SALE-P0-01-001",
          type: "SALE",
          date: new Date("2026-11-23T00:00:00.000Z"),
          documentStatus: "ACTIVE",
          status: "DRAFT",
          totalAmount: new Prisma.Decimal(400),
          subtotalAmount: new Prisma.Decimal(400),
          discountPercent: new Prisma.Decimal(0),
          discountAmount: new Prisma.Decimal(0),
          taxAmount: new Prisma.Decimal(0),
          taxMode: "NONE",
          paymentStatus: "UNPAID",
          tenantId: TENANT_ID,
          branchId: "BRANCH-P0-01",
          items: [{
            id: "SALE-LINE-P0-01",
            productId: PRODUCT_ID,
            qty: 10,
            price: new Prisma.Decimal(40),
            cost: new Prisma.Decimal(0),
            expiryDate: null,
            note: null,
            product: { price: new Prisma.Decimal(40) }
          }]
        } as any,
        null,
        null,
        TENANT_ID
      );

      expect(result.cogs).toBe(250);
      expect(depleteSpy).toHaveBeenCalledTimes(1);
      const journalLines = tx.journalEntry.create.mock.calls[0][0].data.lines.create;
      const cogsLine = journalLines.find((line: any) => line.description.includes("تكلفة مبيعات"));
      const inventoryLine = journalLines.find((line: any) => line.description.includes("انخفاض المخزون"));
      expect(cogsLine).toBeDefined();
      expect(inventoryLine).toBeDefined();
      expect(Number(cogsLine.debit)).toBe(250);
      expect(Number(cogsLine.credit)).toBe(0);
      expect(Number(inventoryLine.debit)).toBe(0);
      expect(Number(inventoryLine.credit)).toBe(250);
    } finally {
      depleteSpy.mockRestore();
    }
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
