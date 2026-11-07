import { describe, expect, it, vi } from "vitest";
import { FifoService } from "../modules/inventory/services/fifo.service.js";

function createTx(productRows: any[]) {
  return {
    $queryRaw: vi.fn().mockResolvedValue(productRows),
    inventoryBatch: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn()
    },
    inventoryMovement: {
      create: vi.fn()
    },
    product: {
      findUnique: vi.fn(),
      update: vi.fn()
    }
  } as any;
}

describe("FifoService trusted tenant boundary", () => {
  it("rejects depletion when the product belongs to a different tenant before any stock mutation", async () => {
    const tx = createTx([{ id: "product-b", tenantId: "TENANT-B", stockQuantity: 20 }]);

    await expect(
      FifoService.depleteStock(
        tx,
        "product-b",
        2,
        "sale-1",
        "INVOICE",
        "test sale",
        "TENANT-A"
      )
    ).rejects.toThrow(/CROSS_TENANT_VIOLATION|PRODUCT_NOT_FOUND_OR_FORBIDDEN/);

    expect(tx.inventoryBatch.update).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("rejects stock addition when the product belongs to a different tenant before creating a batch", async () => {
    const tx = createTx([{ id: "product-b", tenantId: "TENANT-B" }]);

    await expect(
      FifoService.addStock(
        tx,
        "product-b",
        "BATCH-1",
        5,
        10,
        null,
        "adjustment-1",
        "ADJUSTMENT",
        "test intake",
        "TENANT-A"
      )
    ).rejects.toThrow(/CROSS_TENANT_VIOLATION/);

    expect(tx.inventoryBatch.findUnique).not.toHaveBeenCalled();
    expect(tx.inventoryBatch.create).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("fails closed when the trusted tenant is missing", async () => {
    const tx = createTx([{ id: "product-a", tenantId: "TENANT-A", stockQuantity: 20 }]);

    await expect(
      FifoService.depleteStock(
        tx,
        "product-a",
        1,
        "sale-1",
        "INVOICE",
        undefined,
        ""
      )
    ).rejects.toThrow(/TRUSTED_TENANT_CONTEXT_REQUIRED/);

    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("rejects zero, negative, NaN, or infinite stock quantities", async () => {
    const tx = createTx([{ id: "product-a", tenantId: "TENANT-A", stockQuantity: 20 }]);

    for (const quantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        FifoService.depleteStock(
          tx,
          "product-a",
          quantity,
          "sale-1",
          "INVOICE",
          undefined,
          "TENANT-A"
        )
      ).rejects.toThrow(/INVALID_STOCK_QUANTITY/);
    }

    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });
});
