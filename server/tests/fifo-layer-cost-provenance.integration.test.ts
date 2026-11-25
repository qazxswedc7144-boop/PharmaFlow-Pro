import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { definePostgresHttpSuite } from "./helpers/postgres-http.integration.helpers.js";
import { FifoService } from "../modules/inventory/services/fifo.service.js";

function assertTestDatabase(): void {
  const raw = process.env.DATABASE_URL ?? "";
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, "");
  if (process.env.NODE_ENV !== "test" || !/(^|_)(test|ci)(_|$)/i.test(database)) {
    throw new Error("FIFO provenance tests require an explicitly named PostgreSQL test/CI database.");
  }
}

definePostgresHttpSuite("Phase 4C — PostgreSQL branch-scoped FIFO layer cost provenance", (getContext) => {
  it("enables RLS on every new server-managed finance and FIFO table", async () => {
    assertTestDatabase();
    const { prisma } = await import("../database/prisma.js");
    const rows = await prisma.$queryRaw<Array<{ table_name: string; rls_enabled: boolean }>>`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname IN (
          'accounting_periods',
          'inventory_layers',
          'fifo_consumption_log',
          'invoice_payment_allocations'
        )
      ORDER BY c.relname
    `;
    expect(rows.map((row) => row.table_name)).toEqual([
      "accounting_periods",
      "fifo_consumption_log",
      "inventory_layers",
      "invoice_payment_allocations"
    ]);
    expect(rows.every((row) => row.rls_enabled)).toBe(true);
  });

  it("keeps repeated receipts as separate cost layers and records exact FEFO/FIFO consumption", async () => {
    assertTestDatabase();
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const product = await prisma.product.create({
      data: {
        tenantId: ctx.tenantAId,
        name: `P4 FIFO ${suffix}`,
        sku: `P4-FIFO-${suffix}`,
        barcode: `P4-FIFO-${suffix}`,
        price: 30,
        cost: 10,
        stockQuantity: 0,
      },
    });

    try {
      const expiry = new Date("2099-12-31T00:00:00.000Z");
      await prisma.$transaction(async (tx) => {
        await FifoService.addStock(
          tx, product.id, `BATCH-P4-${suffix}`, 10, 10, expiry,
          `PUR-P4-A-${suffix}`, "INVOICE", "Phase 4 FIFO receipt A",
          ctx.tenantAId, ctx.branchAId, `PUR-LINE-A-${suffix}`,
        );
        await FifoService.addStock(
          tx, product.id, `BATCH-P4-${suffix}`, 5, 20, expiry,
          `PUR-P4-B-${suffix}`, "INVOICE", "Phase 4 FIFO receipt B",
          ctx.tenantAId, ctx.branchAId, `PUR-LINE-B-${suffix}`,
        );
      });

      const batchBefore = await prisma.inventoryBatch.findFirst({
        where: { tenantId: ctx.tenantAId, productId: product.id },
      });
      const layersBefore = await prisma.inventoryLayer.findMany({
        where: { tenantId: ctx.tenantAId, productId: product.id },
      });
      expect(batchBefore).toBeDefined();
      expect(batchBefore?.initialQty).toBe(15);
      expect(batchBefore?.stockQuantity).toBe(15);
      expect(Number(batchBefore?.cost)).toBeCloseTo(13.3333, 4);
      expect(layersBefore).toHaveLength(2);
      expect(layersBefore.map((layer) => Number(layer.unitCost)).sort((a, b) => a - b)).toEqual([10, 20]);
      expect(layersBefore.every((layer) => layer.quantityInitial === 10 || layer.quantityInitial === 5)).toBe(true);

      // Calculate the expected result using the same documented order: FEFO,
      // then receipt creation time, then stable layer ID for exact ties.
      const orderedLayers = [...layersBefore].sort((a, b) => {
        const expiryA = a.expiryDate?.getTime() ?? Number.POSITIVE_INFINITY;
        const expiryB = b.expiryDate?.getTime() ?? Number.POSITIVE_INFINITY;
        if (expiryA !== expiryB) return expiryA - expiryB;
        const created = a.createdAt.getTime() - b.createdAt.getTime();
        return created || a.id.localeCompare(b.id);
      });
      let needed = 12;
      let expectedCost = 0;
      for (const layer of orderedLayers) {
        const take = Math.min(layer.quantityRemaining, needed);
        expectedCost += take * Number(layer.unitCost);
        needed -= take;
        if (needed === 0) break;
      }
      expect(needed).toBe(0);

      let depletion: Awaited<ReturnType<typeof FifoService.depleteStock>> | undefined;
      await prisma.$transaction(async (tx) => {
        depletion = await FifoService.depleteStock(
          tx,
          product.id,
          12,
          `SALE-P4-${suffix}`,
          "INVOICE",
          "Phase 4 FIFO sale",
          ctx.tenantAId,
          `SALE-LINE-P4-${suffix}`,
          ctx.branchAId,
        );
      });

      expect(depletion?.totalCost).toBeCloseTo(expectedCost, 4);
      expect(depletion?.allocations.reduce((sum, allocation) => sum + allocation.qtyAllocated, 0)).toBe(12);

      const [layersAfter, consumptions, batchAfter, productAfter, movements] = await Promise.all([
        prisma.inventoryLayer.findMany({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
        prisma.fifoConsumption.findMany({ where: { tenantId: ctx.tenantAId, referenceId: `SALE-P4-${suffix}` } }),
        prisma.inventoryBatch.findFirst({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
        prisma.product.findFirst({ where: { id: product.id, tenantId: ctx.tenantAId } }),
        prisma.inventoryMovement.findMany({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
      ]);
      const remainingLayerQty = layersAfter.reduce((sum, layer) => sum + layer.quantityRemaining, 0);
      const consumedQty = consumptions.reduce((sum, row) => sum + row.quantity, 0);
      const consumedCost = consumptions.reduce((sum, row) => sum + Number(row.totalCost), 0);
      const remainingValue = layersAfter.reduce(
        (sum, layer) => sum + layer.quantityRemaining * Number(layer.unitCost),
        0,
      );

      expect(consumedQty).toBe(12);
      expect(consumedCost).toBeCloseTo(expectedCost, 4);
      expect(remainingLayerQty).toBe(3);
      expect(batchAfter?.stockQuantity).toBe(remainingLayerQty);
      expect(batchAfter?.initialQty).toBe(15);
      expect(Number(batchAfter?.cost)).toBeCloseTo(remainingValue / remainingLayerQty, 4);
      expect(productAfter?.stockQuantity).toBe(3);
      expect(movements.reduce((sum, movement) => sum + movement.qty, 0)).toBe(3);
      expect(consumptions.every((row) => row.tenantId === ctx.tenantAId)).toBe(true);
      expect(new Set(consumptions.map((row) => row.idempotencyKey)).size).toBe(consumptions.length);
    } finally {
      await prisma.fifoConsumption.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.branchInventory.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryMovement.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryLayer.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryBatch.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.product.deleteMany({ where: { id: product.id, tenantId: ctx.tenantAId } });
    }
  });

  it("never consumes another branch's FIFO layers and keeps branch stock projections synchronized", async () => {
    assertTestDatabase();
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const secondBranch = await prisma.branch.create({
      data: {
        tenantId: ctx.tenantAId,
        code: `P4-BR-${suffix}`,
        name: `P4 FIFO Branch B ${suffix}`,
        isActive: true
      }
    });
    const product = await prisma.product.create({
      data: {
        tenantId: ctx.tenantAId,
        name: `P4 Branch FIFO ${suffix}`,
        sku: `P4-BR-FIFO-${suffix}`,
        barcode: `P4-BR-FIFO-${suffix}`,
        price: 30,
        cost: 5,
        stockQuantity: 0
      }
    });

    try {
      await prisma.$transaction(async (tx) => {
        await FifoService.addStock(
          tx, product.id, `BATCH-A-${suffix}`, 2, 5, null,
          `PUR-A-${suffix}`, "INVOICE", "Branch A receipt",
          ctx.tenantAId, ctx.branchAId, `LINE-A-${suffix}`
        );
        await FifoService.addStock(
          tx, product.id, `BATCH-B-${suffix}`, 5, 9, null,
          `PUR-B-${suffix}`, "INVOICE", "Branch B receipt",
          ctx.tenantAId, secondBranch.id, `LINE-B-${suffix}`
        );
      });

      await expect(prisma.$transaction((tx) =>
        FifoService.depleteStock(
          tx, product.id, 3, `SALE-A-OVERDRAW-${suffix}`, "INVOICE",
          "Branch A cannot consume Branch B stock", ctx.tenantAId,
          `SALE-LINE-A-${suffix}`, ctx.branchAId
        )
      )).rejects.toThrow(/INSUFFICIENT_BRANCH_STOCK/);

      const branchAResult = await prisma.$transaction((tx) =>
        FifoService.depleteStock(
          tx, product.id, 3, `SALE-B-${suffix}`, "INVOICE",
          "Branch B consumes only its own stock", ctx.tenantAId,
          `SALE-LINE-B-${suffix}`, secondBranch.id
        )
      );

      const [branchAStock, branchBStock, layers, consumption, movements, productAfter] = await Promise.all([
        prisma.branchInventory.findUnique({
          where: { branchId_productId: { branchId: ctx.branchAId, productId: product.id } }
        }),
        prisma.branchInventory.findUnique({
          where: { branchId_productId: { branchId: secondBranch.id, productId: product.id } }
        }),
        prisma.inventoryLayer.findMany({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
        prisma.fifoConsumption.findMany({ where: { tenantId: ctx.tenantAId, referenceId: `SALE-B-${suffix}` } }),
        prisma.inventoryMovement.findMany({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
        prisma.product.findFirst({ where: { id: product.id, tenantId: ctx.tenantAId } })
      ]);

      expect(branchAResult.totalCost).toBe(27);
      expect(branchAStock?.stockQuantity).toBe(2);
      expect(branchBStock?.stockQuantity).toBe(2);
      expect(layers.find((layer) => layer.branchId === ctx.branchAId)?.quantityRemaining).toBe(2);
      expect(layers.find((layer) => layer.branchId === secondBranch.id)?.quantityRemaining).toBe(2);
      expect(consumption).toHaveLength(1);
      expect(consumption[0].branchId).toBe(secondBranch.id);
      expect(movements.filter((movement) => movement.qty < 0).every((movement) => movement.branchId === secondBranch.id)).toBe(true);
      expect(productAfter?.stockQuantity).toBe(4);
    } finally {
      await prisma.fifoConsumption.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.branchInventory.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryMovement.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryLayer.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryBatch.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.product.deleteMany({ where: { id: product.id, tenantId: ctx.tenantAId } });
      await prisma.branch.deleteMany({ where: { id: secondBranch.id, tenantId: ctx.tenantAId } });
    }
  });

  it("fails closed when eligible legacy stock has no verified branch assignment", async () => {
    assertTestDatabase();
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const product = await prisma.product.create({
      data: {
        tenantId: ctx.tenantAId,
        name: `P4 Unassigned Legacy ${suffix}`,
        sku: `P4-UNASSIGNED-${suffix}`,
        price: 20,
        cost: 8,
        stockQuantity: 1
      }
    });
    const batch = await prisma.inventoryBatch.create({
      data: {
        tenantId: ctx.tenantAId,
        productId: product.id,
        batchNumber: `LEGACY-UNASSIGNED-${suffix}`,
        initialQty: 1,
        stockQuantity: 1,
        cost: 8
      }
    });
    await prisma.inventoryLayer.create({
      data: {
        tenantId: ctx.tenantAId,
        productId: product.id,
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        sourceReferenceId: `LEGACY-UNASSIGNED-${suffix}`,
        sourceReferenceType: "LEGACY_BASELINE",
        sourceKey: `legacy-unassigned:${suffix}`,
        quantityInitial: 1,
        quantityRemaining: 1,
        unitCost: 8,
        isLegacyBaseline: true,
        branchId: null
      }
    });
    await prisma.branchInventory.create({
      data: {
        tenantId: ctx.tenantAId,
        branchId: ctx.branchAId,
        productId: product.id,
        stockQuantity: 0
      }
    });

    try {
      await expect(prisma.$transaction((tx) =>
        FifoService.depleteStock(
          tx, product.id, 1, `SALE-UNASSIGNED-${suffix}`, "INVOICE",
          "Unassigned stock must not be consumed by a branch", ctx.tenantAId,
          `SALE-LINE-UNASSIGNED-${suffix}`, ctx.branchAId
        )
      )).rejects.toThrow(/FIFO_UNASSIGNED_STOCK_REQUIRES_RECONCILIATION/);

      const [layer, productAfter, branchStock, consumptions] = await Promise.all([
        prisma.inventoryLayer.findFirst({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
        prisma.product.findFirst({ where: { id: product.id, tenantId: ctx.tenantAId } }),
        prisma.branchInventory.findUnique({
          where: { branchId_productId: { branchId: ctx.branchAId, productId: product.id } }
        }),
        prisma.fifoConsumption.findMany({ where: { tenantId: ctx.tenantAId, productId: product.id } })
      ]);
      expect(layer?.quantityRemaining).toBe(1);
      expect(productAfter?.stockQuantity).toBe(1);
      expect(branchStock?.stockQuantity).toBe(0);
      expect(consumptions).toHaveLength(0);
    } finally {
      await prisma.fifoConsumption.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.branchInventory.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryMovement.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryLayer.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryBatch.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.product.deleteMany({ where: { id: product.id, tenantId: ctx.tenantAId } });
    }
  });

  it("does not let a new receipt silently overwrite a divergent legacy branch projection", async () => {
    assertTestDatabase();
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const product = await prisma.product.create({
      data: {
        tenantId: ctx.tenantAId,
        name: `P4 Projection Mismatch ${suffix}`,
        sku: `P4-PROJECTION-${suffix}`,
        price: 20,
        cost: 8,
        stockQuantity: 1
      }
    });
    const batch = await prisma.inventoryBatch.create({
      data: {
        tenantId: ctx.tenantAId,
        productId: product.id,
        batchNumber: `P4-PROJECTION-BATCH-${suffix}`,
        initialQty: 1,
        stockQuantity: 1,
        cost: 8
      }
    });
    await prisma.inventoryLayer.create({
      data: {
        tenantId: ctx.tenantAId,
        productId: product.id,
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        sourceReferenceId: `P4-PROJECTION-LEGACY-${suffix}`,
        sourceReferenceType: "LEGACY_BASELINE",
        sourceKey: `p4-projection-legacy:${suffix}`,
        quantityInitial: 1,
        quantityRemaining: 1,
        unitCost: 8,
        isLegacyBaseline: true,
        branchId: ctx.branchAId
      }
    });
    await prisma.branchInventory.create({
      data: {
        tenantId: ctx.tenantAId,
        branchId: ctx.branchAId,
        productId: product.id,
        stockQuantity: 0
      }
    });

    try {
      await expect(prisma.$transaction((tx) =>
        FifoService.addStock(
          tx, product.id, `P4-NEW-BATCH-${suffix}`, 2, 12, null,
          `P4-NEW-RECEIPT-${suffix}`, "INVOICE", "Must not mask old projection mismatch",
          ctx.tenantAId, ctx.branchAId, `P4-NEW-LINE-${suffix}`
        )
      )).rejects.toThrow(/BRANCH_INVENTORY_LAYER_MISMATCH/);

      const [productAfter, branchStock, layers, batches] = await Promise.all([
        prisma.product.findFirst({ where: { id: product.id, tenantId: ctx.tenantAId } }),
        prisma.branchInventory.findUnique({
          where: { branchId_productId: { branchId: ctx.branchAId, productId: product.id } }
        }),
        prisma.inventoryLayer.findMany({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
        prisma.inventoryBatch.findMany({ where: { tenantId: ctx.tenantAId, productId: product.id } })
      ]);
      expect(productAfter?.stockQuantity).toBe(1);
      expect(branchStock?.stockQuantity).toBe(0);
      expect(layers).toHaveLength(1);
      expect(batches).toHaveLength(1);
    } finally {
      await prisma.fifoConsumption.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.branchInventory.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryMovement.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryLayer.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryBatch.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.product.deleteMany({ where: { id: product.id, tenantId: ctx.tenantAId } });
    }
  });

  it("prioritizes the earliest expiry before receipt age when both layers are eligible", async () => {
    assertTestDatabase();
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const product = await prisma.product.create({
      data: {
        tenantId: ctx.tenantAId,
        name: `P4 FIFO FEFO ${suffix}`,
        sku: `P4-FIFO-FEFO-${suffix}`,
        barcode: `P4-FIFO-FEFO-${suffix}`,
        price: 30,
        cost: 10,
        stockQuantity: 0,
      },
    });

    try {
      // The later-expiring receipt is deliberately inserted first.
      await prisma.$transaction(async (tx) => {
        await FifoService.addStock(
          tx, product.id, `BATCH-LATE-${suffix}`, 1, 50, new Date("2099-12-31T00:00:00.000Z"),
          `PUR-LATE-${suffix}`, "INVOICE", "Older receipt with later expiry",
          ctx.tenantAId, ctx.branchAId, `PUR-LINE-LATE-${suffix}`,
        );
        await FifoService.addStock(
          tx, product.id, `BATCH-EARLY-${suffix}`, 1, 10, new Date("2028-12-31T00:00:00.000Z"),
          `PUR-EARLY-${suffix}`, "INVOICE", "Newer receipt with earlier expiry",
          ctx.tenantAId, ctx.branchAId, `PUR-LINE-EARLY-${suffix}`,
        );
      });

      const earliestExpiryLayer = await prisma.inventoryLayer.findFirst({
        where: { tenantId: ctx.tenantAId, productId: product.id, batchNumber: `BATCH-EARLY-${suffix}` },
      });
      expect(earliestExpiryLayer).toBeDefined();

      const result = await prisma.$transaction((tx) =>
        FifoService.depleteStock(
          tx, product.id, 1, `SALE-FEFO-${suffix}`, "INVOICE",
          "FEFO priority verification", ctx.tenantAId,
          `SALE-LINE-FEFO-${suffix}`, ctx.branchAId,
        ),
      );

      const consumption = await prisma.fifoConsumption.findFirst({
        where: { tenantId: ctx.tenantAId, referenceId: `SALE-FEFO-${suffix}` },
      });
      expect(consumption?.layerId).toBe(earliestExpiryLayer?.id);
      expect(result.totalCost).toBe(10);
    } finally {
      await prisma.fifoConsumption.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.branchInventory.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryMovement.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryLayer.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryBatch.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.product.deleteMany({ where: { id: product.id, tenantId: ctx.tenantAId } });
    }
  });

  it("rejects a repeated consumption identity without decrementing stock twice", async () => {
    assertTestDatabase();
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const product = await prisma.product.create({
      data: {
        tenantId: ctx.tenantAId,
        name: `P4 FIFO idempotency ${suffix}`,
        sku: `P4-FIFO-IDEM-${suffix}`,
        barcode: `P4-FIFO-IDEM-${suffix}`,
        price: 20,
        cost: 7,
        stockQuantity: 0,
      },
    });

    try {
      await prisma.$transaction((tx) =>
        FifoService.addStock(
          tx, product.id, `BATCH-IDEM-${suffix}`, 2, 7, null,
          `PUR-IDEM-${suffix}`, "INVOICE", "Idempotency fixture",
          ctx.tenantAId, ctx.branchAId, `PUR-LINE-IDEM-${suffix}`,
        ),
      );

      const referenceId = `SALE-IDEM-${suffix}`;
      const referenceLineId = `SALE-LINE-IDEM-${suffix}`;
      await prisma.$transaction((tx) =>
        FifoService.depleteStock(
          tx, product.id, 1, referenceId, "INVOICE", "First posting",
          ctx.tenantAId, referenceLineId, ctx.branchAId,
        ),
      );

      await expect(prisma.$transaction((tx) =>
        FifoService.depleteStock(
          tx, product.id, 1, referenceId, "INVOICE", "Duplicate posting attempt",
          ctx.tenantAId, referenceLineId, ctx.branchAId,
        ),
      )).rejects.toThrow(/Unique constraint failed/);

      const [layer, consumptions, batch, currentProduct, movements] = await Promise.all([
        prisma.inventoryLayer.findFirst({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
        prisma.fifoConsumption.findMany({ where: { tenantId: ctx.tenantAId, referenceId } }),
        prisma.inventoryBatch.findFirst({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
        prisma.product.findFirst({ where: { id: product.id, tenantId: ctx.tenantAId } }),
        prisma.inventoryMovement.findMany({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
      ]);
      expect(layer?.quantityRemaining).toBe(1);
      expect(consumptions).toHaveLength(1);
      expect(batch?.stockQuantity).toBe(1);
      expect(currentProduct?.stockQuantity).toBe(1);
      expect(movements.reduce((sum, movement) => sum + movement.qty, 0)).toBe(1);
    } finally {
      await prisma.fifoConsumption.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.branchInventory.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryMovement.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryLayer.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryBatch.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.product.deleteMany({ where: { id: product.id, tenantId: ctx.tenantAId } });
    }
  });

  it("rolls back every layer, batch, movement and consumption write when stock is insufficient", async () => {
    assertTestDatabase();
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const product = await prisma.product.create({
      data: {
        tenantId: ctx.tenantAId,
        name: `P4 FIFO rollback ${suffix}`,
        sku: `P4-FIFO-RB-${suffix}`,
        barcode: `P4-FIFO-RB-${suffix}`,
        price: 20,
        cost: 8,
        stockQuantity: 0,
      },
    });

    try {
      await prisma.$transaction(async (tx) => {
        await FifoService.addStock(
          tx, product.id, `BATCH-RB-VALID-${suffix}`, 2, 8, null,
          `PUR-RB-VALID-${suffix}`, "INVOICE", "Valid rollback fixture",
          ctx.tenantAId, ctx.branchAId, `PUR-LINE-RB-VALID-${suffix}`,
        );
        await FifoService.addStock(
          tx, product.id, `BATCH-RB-EXPIRED-${suffix}`, 1, 9, new Date("2000-01-01T00:00:00.000Z"),
          `PUR-RB-EXPIRED-${suffix}`, "INVOICE", "Expired rollback fixture",
          ctx.tenantAId, ctx.branchAId, `PUR-LINE-RB-EXPIRED-${suffix}`,
        );
      });

      // The product projection includes the expired unit, but only two units
      // are eligible for sale. The full request must be rejected pre-write.
      await expect(prisma.$transaction(async (tx) => {
        await FifoService.depleteStock(
          tx,
          product.id,
          3,
          `SALE-RB-${suffix}`,
          "INVOICE",
          "Expected insufficient eligible FIFO stock",
          ctx.tenantAId,
          `SALE-LINE-RB-${suffix}`,
          ctx.branchAId,
        );
      })).rejects.toThrow(/INSUFFICIENT_FIFO_STOCK/);

      const [layers, consumptions, batches, currentProduct, movements] = await Promise.all([
        prisma.inventoryLayer.findMany({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
        prisma.fifoConsumption.findMany({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
        prisma.inventoryBatch.findMany({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
        prisma.product.findFirst({ where: { id: product.id, tenantId: ctx.tenantAId } }),
        prisma.inventoryMovement.findMany({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
      ]);
      expect(layers).toHaveLength(2);
      expect(layers.reduce((sum, layer) => sum + layer.quantityRemaining, 0)).toBe(3);
      expect(consumptions).toHaveLength(0);
      expect(batches.reduce((sum, batch) => sum + batch.stockQuantity, 0)).toBe(3);
      expect(currentProduct?.stockQuantity).toBe(3);
      expect(movements.reduce((sum, movement) => sum + movement.qty, 0)).toBe(3);
    } finally {
      await prisma.fifoConsumption.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.branchInventory.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryMovement.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryLayer.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryBatch.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.product.deleteMany({ where: { id: product.id, tenantId: ctx.tenantAId } });
    }
  });

  it("does not consume expired layers even when product stock projection reports enough units", async () => {
    assertTestDatabase();
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const product = await prisma.product.create({
      data: {
        tenantId: ctx.tenantAId,
        name: `P4 FIFO expired ${suffix}`,
        sku: `P4-FIFO-EX-${suffix}`,
        barcode: `P4-FIFO-EX-${suffix}`,
        price: 20,
        cost: 8,
        stockQuantity: 0,
      },
    });

    try {
      await prisma.$transaction(async (tx) => {
        await FifoService.addStock(
          tx, product.id, `BATCH-EX-${suffix}`, 4, 8, new Date("2000-01-01T00:00:00.000Z"),
          `PUR-EX-${suffix}`, "INVOICE", "Expired stock fixture",
          ctx.tenantAId, ctx.branchAId, `PUR-LINE-EX-${suffix}`,
        );
      });

      await expect(prisma.$transaction(async (tx) => {
        await FifoService.depleteStock(
          tx, product.id, 1, `SALE-EX-${suffix}`, "INVOICE",
          "Expired layer must not be consumed", ctx.tenantAId,
          `SALE-LINE-EX-${suffix}`, ctx.branchAId,
        );
      })).rejects.toThrow(/INSUFFICIENT_FIFO_STOCK/);

      const [layer, consumption, batch, currentProduct] = await Promise.all([
        prisma.inventoryLayer.findFirst({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
        prisma.fifoConsumption.findMany({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
        prisma.inventoryBatch.findFirst({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
        prisma.product.findFirst({ where: { id: product.id, tenantId: ctx.tenantAId } }),
      ]);
      expect(layer?.quantityRemaining).toBe(4);
      expect(consumption).toHaveLength(0);
      expect(batch?.stockQuantity).toBe(4);
      expect(currentProduct?.stockQuantity).toBe(4);
    } finally {
      await prisma.fifoConsumption.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.branchInventory.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryMovement.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryLayer.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryBatch.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.product.deleteMany({ where: { id: product.id, tenantId: ctx.tenantAId } });
    }
  });
});
