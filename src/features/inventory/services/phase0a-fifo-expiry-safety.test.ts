import { afterEach, describe, expect, it, vi } from "vitest";
import { FIFOEngine } from "./fifoEngine";
import { UnifiedInventoryMutationEngine } from "./UnifiedInventoryMutationEngine";
import { FifoService } from "../../../../server/modules/inventory/services/fifo.service";

const TENANT = "TENANT-PHASE-0A";
const BRANCH = "BRANCH-PHASE-0A";
const WAREHOUSE = "WH-PHASE-0A";
const PRODUCT = "PRODUCT-PHASE-0A";

function makeBatchTable(initial: any[] = []) {
  const rows = initial.map((row) => ({ ...row }));
  const table: any = {
    rows,
    get: vi.fn(async (id: string) => rows.find((row) => row.id === id)),
    update: vi.fn(async (id: string, patch: any) => {
      const row = rows.find((item) => item.id === id);
      if (!row) return 0;
      Object.assign(row, patch);
      return 1;
    }),
    filter: vi.fn((predicate: (row: any) => boolean) => {
      const selected = rows.filter(predicate);
      return {
        first: async () => selected[0],
        count: async () => selected.length,
        toArray: async () => selected,
      };
    }),
    where: vi.fn((field: string) => ({
      equals: (value: unknown) => ({
        filter: (predicate: (row: any) => boolean) => {
          const selected = rows.filter((row) => row[field] === value && predicate(row));
          return {
            sortBy: async (key: string) =>
              [...selected].sort((a, b) => String(a[key] ?? "").localeCompare(String(b[key] ?? ""))),
            count: async () => selected.length,
            first: async () => selected[0],
            toArray: async () => selected,
          };
        },
      }),
    })),
  };
  return table;
}

function makeFifoTable(initial: any[] = []) {
  const rows = initial.map((row) => ({ ...row }));
  return {
    rows,
    filter: vi.fn((predicate: (row: any) => boolean) => ({
      toArray: async () => rows.filter(predicate),
    })),
    update: vi.fn(async (id: string, patch: any) => {
      const row = rows.find((item) => item.id === id);
      if (!row) return 0;
      Object.assign(row, patch);
      return 1;
    }),
    bulkAdd: vi.fn(async (items: any[]) => { rows.push(...items); }),
  };
}

describe("Phase 0A — FIFO & Expiry safety (tests only)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("T-01: rejects an explicitly selected expired batch before changing its quantity", async () => {
    const batches = makeBatchTable([{
      id: "BATCH-EXPIRED",
      productId: PRODUCT,
      batchNumber: "EXPIRED-01",
      quantity: 8,
      expiryDate: "2000-01-01",
      tenantId: TENANT,
      warehouseId: WAREHOUSE,
    }]);
    const tx = { table: vi.fn(() => batches) };
    const engine = UnifiedInventoryMutationEngine.getInstance();

    await expect((engine as any).mutateMedicineBatch({
      productId: PRODUCT,
      warehouseId: WAREHOUSE,
      delta: -1,
      movementType: "SALE",
      batchId: "BATCH-EXPIRED",
      docId: "SALE-T01",
      tenantId: TENANT,
      branchId: BRANCH,
      timestamp: new Date().toISOString(),
    }, tx)).rejects.toThrow(/EXPIRED|EXPIRY|صلاحية/i);

    expect(batches.rows[0].quantity).toBe(8);
    expect(batches.update).not.toHaveBeenCalled();
  });

  it("T-02: FEFO deduction skips expired batches and consumes the earliest valid batch", async () => {
    const batches = makeBatchTable([
      {
        id: "BATCH-EXPIRED",
        productId: PRODUCT,
        batchNumber: "EXPIRED-02",
        quantity: 4,
        expiryDate: "2000-01-01",
        tenantId: TENANT,
        warehouseId: WAREHOUSE,
      },
      {
        id: "BATCH-VALID",
        productId: PRODUCT,
        batchNumber: "VALID-02",
        quantity: 6,
        expiryDate: "2099-12-31",
        tenantId: TENANT,
        warehouseId: WAREHOUSE,
      },
    ]);
    const tx = { table: vi.fn(() => batches) };
    const engine = UnifiedInventoryMutationEngine.getInstance();

    await (engine as any).mutateMedicineBatch({
      productId: PRODUCT,
      warehouseId: WAREHOUSE,
      delta: -2,
      movementType: "SALE",
      docId: "SALE-T02",
      tenantId: TENANT,
      branchId: BRANCH,
      timestamp: new Date().toISOString(),
    }, tx);

    expect(batches.rows.find((row) => row.id === "BATCH-EXPIRED")?.quantity).toBe(4);
    expect(batches.rows.find((row) => row.id === "BATCH-VALID")?.quantity).toBe(4);
  });

  it("T-03: consumes dated valid layers before NULL layers and allows NULL-only stock", async () => {
    const layers = makeFifoTable([
      { id: "LAYER-VALID", item_id: PRODUCT, quantity_initial: 2, quantity_remaining: 2, unit_cost: 10, expiry_date: "2099-12-31", created_at: "2026-01-01", tenantId: TENANT },
      { id: "LAYER-NULL", item_id: PRODUCT, quantity_initial: 5, quantity_remaining: 5, unit_cost: 20, expiry_date: null, created_at: "2026-01-02", tenantId: TENANT },
      { id: "LAYER-EXPIRED", item_id: PRODUCT, quantity_initial: 7, quantity_remaining: 7, unit_cost: 30, expiry_date: "2000-01-01", created_at: "2025-01-01", tenantId: TENANT },
    ]);
    const logs = makeFifoTable([]);
    const tx = { table: vi.fn((name: string) => name === "inventory_layers" ? layers : logs) };

    await FIFOEngine.consumeFIFO("SALE-T03-A", PRODUCT, 3, TENANT, tx);

    expect(layers.rows.find((row) => row.id === "LAYER-VALID")?.quantity_remaining).toBe(0);
    expect(layers.rows.find((row) => row.id === "LAYER-NULL")?.quantity_remaining).toBe(4);
    expect(layers.rows.find((row) => row.id === "LAYER-EXPIRED")?.quantity_remaining).toBe(7);
    expect(logs.rows.map((row) => row.layer_id)).toEqual(["LAYER-VALID", "LAYER-NULL"]);

    // The pharmacy batch projection must apply the same FEFO + NULLS LAST policy.
    const medicineBatches = makeBatchTable([
      { id: "MED-VALID", productId: PRODUCT, batchNumber: "MED-VALID", quantity: 2, expiryDate: "2099-12-31", tenantId: TENANT, warehouseId: WAREHOUSE },
      { id: "MED-NULL", productId: PRODUCT, batchNumber: "MED-NULL", quantity: 5, expiryDate: null, tenantId: TENANT, warehouseId: WAREHOUSE },
      { id: "MED-EXPIRED", productId: PRODUCT, batchNumber: "MED-EXPIRED", quantity: 7, expiryDate: "2000-01-01", tenantId: TENANT, warehouseId: WAREHOUSE },
    ]);
    const medicineTx = { table: vi.fn(() => medicineBatches) };
    await (UnifiedInventoryMutationEngine.getInstance() as any).mutateMedicineBatch({
      productId: PRODUCT,
      warehouseId: WAREHOUSE,
      delta: -3,
      movementType: "SALE",
      docId: "SALE-T03-MED",
      tenantId: TENANT,
      branchId: BRANCH,
      timestamp: new Date().toISOString(),
    }, medicineTx);
    expect(medicineBatches.rows.find((row) => row.id === "MED-VALID")?.quantity).toBe(0);
    expect(medicineBatches.rows.find((row) => row.id === "MED-NULL")?.quantity).toBe(4);
    expect(medicineBatches.rows.find((row) => row.id === "MED-EXPIRED")?.quantity).toBe(7);

    const nullOnlyBatches = makeBatchTable([
      { id: "MED-NULL-ONLY", productId: PRODUCT, batchNumber: "MED-NULL-ONLY", quantity: 2, expiryDate: "", tenantId: TENANT, warehouseId: WAREHOUSE },
    ]);
    await (UnifiedInventoryMutationEngine.getInstance() as any).mutateMedicineBatch({
      productId: PRODUCT,
      warehouseId: WAREHOUSE,
      delta: -1,
      movementType: "SALE",
      docId: "SALE-T03-MED-NULL",
      tenantId: TENANT,
      branchId: BRANCH,
      timestamp: new Date().toISOString(),
    }, { table: vi.fn(() => nullOnlyBatches) });
    expect(nullOnlyBatches.rows[0].quantity).toBe(1);

    const nullOnlyLayers = makeFifoTable([
      { id: "LAYER-NULL-ONLY", item_id: PRODUCT, quantity_initial: 2, quantity_remaining: 2, unit_cost: 15, expiry_date: "", created_at: "2026-01-03", tenantId: TENANT },
    ]);
    const nullOnlyLogs = makeFifoTable([]);
    const nullOnlyTx = { table: vi.fn((name: string) => name === "inventory_layers" ? nullOnlyLayers : nullOnlyLogs) };

    await expect(FIFOEngine.consumeFIFO("SALE-T03-B", PRODUCT, 1, TENANT, nullOnlyTx))
      .resolves.toMatchObject({ totalCost: 15, unitCost: 15 });
    expect(nullOnlyLayers.rows[0].quantity_remaining).toBe(1);
  });

  it("stores expiry_date and batch_number on purchase FIFO layers", async () => {
    const rows: any[] = [];
    const layers = { add: vi.fn(async (row: any) => { rows.push(row); }) };
    const tx = { table: vi.fn(() => layers) };

    await FIFOEngine.addPurchaseLayer("PROD-META", 4, 12, "PUR-META", TENANT, tx, "2099-10-01", "BATCH-META");

    expect(layers.add).toHaveBeenCalledWith(expect.objectContaining({
      expiry_date: "2099-10-01",
      batch_number: "BATCH-META",
    }));
  });

  it("T-04: rejects FIFO consumption when requested quantity exceeds all available layers", async () => {
    const layers = makeFifoTable([
      { id: "LAYER-T04", item_id: PRODUCT, quantity_initial: 2, quantity_remaining: 2, unit_cost: 10, created_at: "2026-01-01", tenantId: TENANT },
    ]);
    const logs = makeFifoTable([]);
    const tx = {
      table: vi.fn((name: string) => name === "inventory_layers" ? layers : logs),
    };

    await expect(FIFOEngine.consumeFIFO("SALE-T04", PRODUCT, 3, TENANT, tx))
      .rejects.toThrow(/INSUFFICIENT_FIFO_STOCK|FIFO_UNDERFLOW|INSUFFICIENT/i);
  });

  it("T-05: FIFO underflow leaves every layer and consumption log unchanged", async () => {
    const layers = makeFifoTable([
      { id: "LAYER-T05-A", item_id: PRODUCT, quantity_initial: 1, quantity_remaining: 1, unit_cost: 10, created_at: "2026-01-01", tenantId: TENANT },
      { id: "LAYER-T05-B", item_id: PRODUCT, quantity_initial: 1, quantity_remaining: 1, unit_cost: 20, created_at: "2026-01-02", tenantId: TENANT },
    ]);
    const logs = makeFifoTable([]);
    const tx = {
      table: vi.fn((name: string) => name === "inventory_layers" ? layers : logs),
    };

    await expect(FIFOEngine.consumeFIFO("SALE-T05", PRODUCT, 5, TENANT, tx))
      .rejects.toThrow(/INSUFFICIENT_FIFO_STOCK|FIFO_UNDERFLOW|INSUFFICIENT/i);

    expect(layers.rows.map((row) => row.quantity_remaining)).toEqual([1, 1]);
    expect(layers.update).not.toHaveBeenCalled();
    expect(logs.rows).toHaveLength(0);
    expect(logs.bulkAdd).not.toHaveBeenCalled();
  });

  it("T-06: server FEFO depletion refuses expired batches and does not mutate stock", async () => {
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ id: PRODUCT, tenantId: TENANT, stockQuantity: 10, version: 0 }])
        .mockResolvedValueOnce([]),
      inventoryBatch: { update: vi.fn() },
      inventoryMovement: { create: vi.fn() },
      product: { update: vi.fn() },
    } as any;

    await expect(FifoService.depleteStock(
      tx,
      PRODUCT,
      1,
      "SALE-T06",
      "INVOICE",
      "Phase 0A expired batch test",
      TENANT,
    )).rejects.toThrow(/FIFO_DEPLETION_MISMATCH|INSUFFICIENT_FIFO_STOCK/i);

    const batchQuery = tx.$queryRaw.mock.calls[1][0];
    expect(batchQuery.sql).toContain('"expiryDate" IS NULL OR "expiryDate" > NOW()');
    expect(batchQuery.sql).toContain('"expiryDate" ASC NULLS LAST');
    expect(tx.inventoryBatch.update).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });
});
