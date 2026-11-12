import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/core/db";
import { FIFOEngine } from "./fifoEngine";
import { UnifiedInventoryMutationEngine } from "./UnifiedInventoryMutationEngine";
import { FifoService } from "../../../../server/modules/inventory/services/fifo.service";
import { getExpiryStatus } from "@/utils/expiryUtils";

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

  it("T-03: records the current null-expiry utility behavior without declaring it an accepted stock policy", () => {
    // Characterization only: getExpiryStatus(null) currently treats the date as unknown,
    // not expired. Product policy for missing expiry dates remains an explicit decision.
    expect(getExpiryStatus(null).isExpired).toBe(false);
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
        .mockResolvedValueOnce([{
          id: "SERVER-EXPIRED",
          batchNumber: "SERVER-EXPIRED-06",
          stockQuantity: 5,
          cost: 12,
          expiryDate: new Date("2000-01-01T00:00:00.000Z"),
          version: 0,
        }]),
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
    )).rejects.toThrow(/EXPIRED|EXPIRY|NO_ELIGIBLE_BATCH/i);

    expect(tx.inventoryBatch.update).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });
});
