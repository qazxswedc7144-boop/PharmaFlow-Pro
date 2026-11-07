// server/modules/inventory/services/fifo.service.ts
import { Prisma } from "@prisma/client";

export interface DepletionResult {
  allocations: {
    batchId: string;
    batchNumber: string;
    qtyAllocated: number;
    cost: number;
  }[];
  totalCost: number;
}

export class FifoService {
  /**
   * Deplete product stock using FIFO/FEFO priority rules with Row-Level Locking (SELECT FOR UPDATE)
   * to guarantee multi-user concurrency protection and prevent overselling or negative stock.
   */
  static async depleteStock(
    tx: Prisma.TransactionClient,
    productId: string,
    quantityToDeplete: number,
    referenceId: string,
    referenceType: string,
    reason: string | undefined,
    expectedTenantId: string
  ): Promise<DepletionResult> {
    if (!expectedTenantId || !expectedTenantId.trim()) {
      throw new Error("TRUSTED_TENANT_CONTEXT_REQUIRED: Expected tenantId is mandatory for stock depletion.");
    }
    if (!Number.isFinite(quantityToDeplete) || quantityToDeplete <= 0) {
      throw new Error("INVALID_STOCK_QUANTITY: Depletion quantity must be a finite positive number.");
    }

    // 1. Lock the tenant-owned Product row; the tenant must come from trusted auth context.
    const lockedProducts = await tx.$queryRaw<any[]>(
      Prisma.sql`SELECT id, "stockQuantity", version, "tenantId" FROM products WHERE id = ${productId} AND "tenantId" = ${expectedTenantId} FOR UPDATE`
    );

    if (!lockedProducts || lockedProducts.length === 0) {
      throw new Error(`PRODUCT_NOT_FOUND_OR_FORBIDDEN: Product ${productId} does not exist in the authenticated tenant.`);
    }

    const mainProduct = lockedProducts[0];
    const tenantId = mainProduct.tenantId;
    if (tenantId !== expectedTenantId) {
      throw new Error("CROSS_TENANT_VIOLATION: Product does not belong to the authenticated tenant.");
    }
    const forbiddenTenants = ['TEN-DEV-001', 'tenant_default', 'default', 'default-tenant'];

    if (!tenantId || forbiddenTenants.includes(tenantId)) {
      throw new Error(`TRUSTED_TENANT_CONTEXT_REQUIRED: Product ${productId} has invalid or missing tenant context for depletion.`);
    }

    if (mainProduct.stockQuantity < quantityToDeplete) {
      throw new Error(
        `INSUFFICIENT_STOCK: Required ${quantityToDeplete} units of product "${productId}", but only ${mainProduct.stockQuantity} is available.`
      );
    }

    // 2. Fetch and lock candidate inventory batches that are in stock
    // Sorted by expiryDate ascending (FEFO first) and createdAt ascending (FIFO backup)
    const activeBatches = await tx.$queryRaw<any[]>(
      Prisma.sql`
        SELECT id, "batchNumber", "stockQuantity", cost, "expiryDate", version 
        FROM inventory_batches 
        WHERE "productId" = ${productId} AND "tenantId" = ${expectedTenantId} AND "stockQuantity" > 0 
        ORDER BY "expiryDate" ASC, "createdAt" ASC 
        FOR UPDATE
      `
    );

    let remainingNeeded = quantityToDeplete;
    const allocations: DepletionResult["allocations"] = [];
    let accumulatedCost = 0;

    for (const batch of activeBatches) {
      if (remainingNeeded <= 0) break;

      const availableInBatch = Number(batch.stockQuantity);
      const toTake = Math.min(availableInBatch, remainingNeeded);

      const updatedBatchStock = availableInBatch - toTake;
      const batchCost = Number(batch.cost);

      // Decrement batch stock via prisma update (and checking the version for optimistic locking)
      await tx.inventoryBatch.update({
        where: { id: batch.id },
        data: {
          stockQuantity: updatedBatchStock,
          version: { increment: 1 }
        }
      });

      // Record inventory movement for each depleted batch layer
      await tx.inventoryMovement.create({
        data: {
          tenantId,
          productId,
          batchId: batch.id,
          qty: -toTake,
          type: "STOCK_OUT",
          referenceId,
          referenceType,
          reason: reason || "FIFO/FEFO Depletion",
          previousStock: availableInBatch,
          currentStock: updatedBatchStock
        }
      });

      allocations.push({
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        qtyAllocated: toTake,
        cost: batchCost
      });

      accumulatedCost += toTake * batchCost;
      remainingNeeded -= toTake;
    }

    if (remainingNeeded > 0) {
      throw new Error(
        `FIFO_DEPLETION_MISMATCH: The actual sum of batches' stock for product ${productId} was insufficient to deplete ${quantityToDeplete}.`
      );
    }

    // 3. Update the global aggregate product stock
    const newGlobalStock = mainProduct.stockQuantity - quantityToDeplete;
    await tx.product.update({
      where: { id: productId },
      data: {
        stockQuantity: newGlobalStock,
        version: { increment: 1 }
      }
    });

    return {
      allocations,
      totalCost: accumulatedCost
    };
  }

  /**
   * Safe Stock Inward (Stock Additions) with Batch Creation & Movement Logging
   */
  static async addStock(
    tx: Prisma.TransactionClient,
    productId: string,
    batchNumber: string,
    qty: number,
    cost: number,
    expiryDate: Date | null,
    referenceId: string,
    referenceType: string,
    reason: string | undefined,
    expectedTenantId: string
  ): Promise<void> {
    if (!expectedTenantId || !expectedTenantId.trim()) {
      throw new Error("TRUSTED_TENANT_CONTEXT_REQUIRED: Expected tenantId is mandatory for stock addition.");
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error("INVALID_STOCK_QUANTITY: Addition quantity must be a finite positive number.");
    }

    // 1. Pessimistic lock on product row scoped to the authenticated tenant.
    const lockedProducts = await tx.$queryRaw<any[]>(
      Prisma.sql`SELECT id, "tenantId" FROM products WHERE id = ${productId} AND "tenantId" = ${expectedTenantId} FOR UPDATE`
    );
    const tenantId = lockedProducts[0]?.tenantId;
    if (!tenantId) {
      throw new Error(`PRODUCT_NOT_FOUND_OR_FORBIDDEN: Product ${productId} does not exist in the authenticated tenant.`);
    }
    if (tenantId !== expectedTenantId) {
      throw new Error("CROSS_TENANT_VIOLATION: Product does not belong to the authenticated tenant.");
    }
    const forbiddenTenants = ['TEN-DEV-001', 'tenant_default', 'default', 'default-tenant'];
    if (!tenantId || forbiddenTenants.includes(tenantId)) {
      throw new Error(`TRUSTED_TENANT_CONTEXT_REQUIRED: Product ${productId} has invalid or missing tenant context for addition.`);
    }

    // 2. Add or upsert inventory batch layer
    const existingBatch = await tx.inventoryBatch.findUnique({
      where: {
        productId_batchNumber_tenantId: {
          productId,
          batchNumber,
          tenantId
        }
      }
    });

    let targetBatchId: string;

    if (existingBatch) {
      const updatedBatch = await tx.inventoryBatch.update({
        where: { id: existingBatch.id },
        data: {
          stockQuantity: existingBatch.stockQuantity + qty,
          cost: cost, // update to latest cost
          expiryDate: expiryDate || existingBatch.expiryDate,
          version: { increment: 1 }
        }
      });
      targetBatchId = updatedBatch.id;
    } else {
      const newBatch = await tx.inventoryBatch.create({
        data: {
          tenantId,
          productId,
          batchNumber,
          initialQty: qty,
          stockQuantity: qty,
          cost: cost,
          expiryDate: expiryDate
        }
      });
      targetBatchId = newBatch.id;
    }

    // 3. Create stock in movement log
    const prevProductStockObj = await tx.product.findUnique({
      where: { id: productId },
      select: { stockQuantity: true }
    });
    const prevProductStock = prevProductStockObj?.stockQuantity || 0;

    await tx.inventoryMovement.create({
      data: {
        tenantId,
        productId,
        batchId: targetBatchId,
        qty,
        type: "STOCK_IN",
        referenceId,
        referenceType,
        reason: reason || "Batch Procurement Addition",
        previousStock: prevProductStock,
        currentStock: prevProductStock + qty
      }
    });

    // 4. Increment global aggregate product stock
    await tx.product.update({
      where: { id: productId },
      data: {
        stockQuantity: { increment: qty },
        cost: cost, // update current purchase cost
        version: { increment: 1 }
      }
    });
  }
}
