// server/modules/inventory/services/fifo.service.ts
import { Prisma } from "@prisma/client";

export interface DepletionResult {
  allocations: {
    layerId: string;
    batchId: string;
    batchNumber: string;
    qtyAllocated: number;
    cost: number;
  }[];
  totalCost: number;
}

export class FifoService {
  /**
   * Deplete immutable receipt layers using FEFO, then FIFO as a deterministic
   * tie-breaker. InventoryBatch remains the aggregate/UI projection; the layer
   * and consumption tables are the authoritative cost-provenance records.
   */
  static async depleteStock(
    tx: Prisma.TransactionClient,
    productId: string,
    quantityToDeplete: number,
    referenceId: string,
    referenceType: string,
    reason: string | undefined,
    expectedTenantId: string,
    referenceLineId?: string,
    branchId?: string | null
  ): Promise<DepletionResult> {
    if (!expectedTenantId || !expectedTenantId.trim()) {
      throw new Error("TRUSTED_TENANT_CONTEXT_REQUIRED: Expected tenantId is mandatory for stock depletion.");
    }
    if (!Number.isSafeInteger(quantityToDeplete) || quantityToDeplete <= 0) {
      throw new Error("INVALID_STOCK_QUANTITY: Depletion quantity must be a positive safe integer.");
    }
    if (!referenceId?.trim() || !referenceType?.trim()) {
      throw new Error("FIFO_REFERENCE_REQUIRED: A stable source reference and type are required.");
    }

    // The product row serializes every stock mutation for this tenant/product.
    const lockedProducts = await tx.$queryRaw<any[]>(
      Prisma.sql`SELECT id, "stockQuantity", version, "tenantId"
        FROM products
        WHERE id = ${productId} AND "tenantId" = ${expectedTenantId}
        FOR UPDATE`
    );
    if (!lockedProducts?.length) {
      throw new Error(`PRODUCT_NOT_FOUND_OR_FORBIDDEN: Product ${productId} does not exist in the authenticated tenant.`);
    }

    const product = lockedProducts[0];
    const tenantId = product.tenantId as string;
    const forbiddenTenants = ["TEN-DEV-001", "tenant_default", "default", "default-tenant"];
    if (tenantId !== expectedTenantId || forbiddenTenants.includes(tenantId)) {
      throw new Error("CROSS_TENANT_VIOLATION: Product does not belong to the authenticated tenant.");
    }

    const trustedBranchId = branchId?.trim();
    if (!trustedBranchId) {
      throw new Error("TRUSTED_BRANCH_CONTEXT_REQUIRED: Branch ID is mandatory for FIFO depletion.");
    }
    const branch = await tx.branch.findFirst({
      where: { id: trustedBranchId, tenantId },
      select: { id: true }
    });
    if (!branch) {
      throw new Error("BRANCH_NOT_FOUND_OR_FORBIDDEN: Branch does not belong to the authenticated tenant.");
    }

    const branchInventory = await tx.branchInventory.findUnique({
      where: { branchId_productId: { branchId: trustedBranchId, productId } },
      select: { stockQuantity: true }
    });
    if (!branchInventory) {
      throw new Error("BRANCH_INVENTORY_NOT_INITIALIZED: Branch stock projection is missing; reconcile branch stock before posting.");
    }
    const branchLayerTotal = await tx.inventoryLayer.aggregate({
      where: { tenantId, branchId: trustedBranchId, productId },
      _sum: { quantityRemaining: true }
    });
    const branchLayerQuantity = branchLayerTotal._sum.quantityRemaining ?? 0;
    if (branchInventory.stockQuantity !== branchLayerQuantity) {
      throw new Error(
        `BRANCH_INVENTORY_LAYER_MISMATCH: Branch projection ${branchInventory.stockQuantity} does not match ${branchLayerQuantity} remaining FIFO layer units for product ${productId}.`
      );
    }
    if (branchInventory.stockQuantity < quantityToDeplete) {
      const unassignedLayers = await tx.inventoryLayer.aggregate({
        where: {
          tenantId,
          productId,
          branchId: null,
          quantityRemaining: { gt: 0 },
          OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }]
        },
        _sum: { quantityRemaining: true }
      });
      if ((unassignedLayers._sum.quantityRemaining ?? 0) > 0) {
        throw new Error(
          "FIFO_UNASSIGNED_STOCK_REQUIRES_RECONCILIATION: Legacy stock is not assigned to this branch and cannot be consumed automatically."
        );
      }
      throw new Error(
        `INSUFFICIENT_BRANCH_STOCK: Branch ${trustedBranchId} has ${branchInventory.stockQuantity} units; ${quantityToDeplete} required.`
      );
    }

    if (Number(product.stockQuantity) < quantityToDeplete) {
      throw new Error(
        `INSUFFICIENT_STOCK: Required ${quantityToDeplete} units of product "${productId}", but only ${product.stockQuantity} are available.`
      );
    }

    // Lock the exact receipt layers. Expired stock is excluded; undated layers
    // remain eligible but are always considered after dated layers.
    const activeLayers = await tx.$queryRaw<any[]>(
      Prisma.sql`
        SELECT id, "batchId", "batchNumber", "quantityRemaining", "unitCost", "expiryDate", "createdAt"
        FROM inventory_layers
        WHERE "productId" = ${productId}
          AND "tenantId" = ${tenantId}
          AND "branchId" = ${trustedBranchId}
          AND "quantityRemaining" > 0
          AND ("expiryDate" IS NULL OR "expiryDate" > NOW())
        ORDER BY "expiryDate" ASC NULLS LAST, "createdAt" ASC, id ASC
        FOR UPDATE
      `
    );

    const eligibleQuantity = activeLayers.reduce(
      (sum, layer) => sum + Math.max(0, Number(layer.quantityRemaining) || 0),
      0
    );
    if (eligibleQuantity < quantityToDeplete) {
      const unassignedLayers = await tx.inventoryLayer.aggregate({
        where: {
          tenantId,
          productId,
          branchId: null,
          quantityRemaining: { gt: 0 },
          OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }]
        },
        _sum: { quantityRemaining: true }
      });
      if ((unassignedLayers._sum.quantityRemaining ?? 0) > 0) {
        throw new Error(
          "FIFO_UNASSIGNED_STOCK_REQUIRES_RECONCILIATION: Eligible legacy stock is not assigned to this branch and cannot be consumed automatically."
        );
      }
      throw new Error(
        `INSUFFICIENT_FIFO_STOCK: Branch ${trustedBranchId} has only ${eligibleQuantity} non-expired eligible units for product ${productId}; ${quantityToDeplete} required.`
      );
    }

    const lineIdentity = referenceLineId?.trim() || productId;
    let remainingNeeded = quantityToDeplete;
    let accumulatedCost = new Prisma.Decimal(0);
    const allocations: DepletionResult["allocations"] = [];
    const touchedBatchIds = new Set<string>();

    for (const layer of activeLayers) {
      if (remainingNeeded <= 0) break;
      const available = Number(layer.quantityRemaining);
      if (!Number.isSafeInteger(available) || available <= 0) continue;

      const quantity = Math.min(available, remainingNeeded);
      const unitCost = new Prisma.Decimal(String(layer.unitCost));
      const totalCost = unitCost.mul(quantity);
      const newLayerQuantity = available - quantity;

      const batch = await tx.inventoryBatch.findFirst({
        where: { id: layer.batchId, tenantId, productId },
        select: { id: true, batchNumber: true, stockQuantity: true }
      });
      if (!batch || batch.batchNumber !== layer.batchNumber) {
        throw new Error("FIFO_BATCH_LAYER_LINK_INVALID: A FIFO layer is not linked to its tenant-owned aggregate batch.");
      }
      if (batch.stockQuantity < quantity) {
        throw new Error(
          `FIFO_BATCH_STOCK_MISMATCH: Batch ${batch.id} has ${batch.stockQuantity} units but layer ${layer.id} requires ${quantity}.`
        );
      }

      await tx.inventoryLayer.update({
        where: { id: layer.id },
        data: { quantityRemaining: newLayerQuantity }
      });
      await tx.inventoryBatch.update({
        where: { id: batch.id },
        data: { stockQuantity: batch.stockQuantity - quantity, version: { increment: 1 } }
      });

      await tx.inventoryMovement.create({
        data: {
          tenantId,
          productId,
          batchId: batch.id,
          qty: -quantity,
          type: "STOCK_OUT",
          referenceId,
          referenceType,
          reason: reason || "FEFO/FIFO Depletion",
          previousStock: batch.stockQuantity,
          currentStock: batch.stockQuantity - quantity,
          branchId: trustedBranchId
        }
      });

      const idempotencyKey = [
        referenceType,
        referenceId,
        lineIdentity,
        layer.id
      ].join(":");
      await tx.fifoConsumption.create({
        data: {
          tenantId,
          productId,
          layerId: layer.id,
          referenceId,
          referenceType,
          referenceLineId: referenceLineId || null,
          quantity,
          unitCost,
          totalCost,
          idempotencyKey,
          branchId: trustedBranchId
        }
      });

      allocations.push({
        layerId: layer.id,
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        qtyAllocated: quantity,
        cost: unitCost.toNumber()
      });
      accumulatedCost = accumulatedCost.plus(totalCost);
      remainingNeeded -= quantity;
      touchedBatchIds.add(batch.id);
    }

    if (remainingNeeded > 0) {
      throw new Error(
        `FIFO_DEPLETION_MISMATCH: The eligible receipt layers could not satisfy ${quantityToDeplete} units of product ${productId}.`
      );
    }

    // Reconcile the aggregate batch projection from the exact remaining layers.
    // Its cost is a weighted current-stock average; each layer retains its own
    // immutable unit cost and is the source used for future COGS.
    for (const batchId of touchedBatchIds) {
      const remainingLayers = await tx.inventoryLayer.findMany({
        where: { batchId, tenantId, quantityRemaining: { gt: 0 } },
        select: { quantityRemaining: true, unitCost: true }
      });
      const layerQuantity = remainingLayers.reduce((sum, row) => sum + row.quantityRemaining, 0);
      const layerValue = remainingLayers.reduce(
        (sum, row) => sum.plus(new Prisma.Decimal(row.unitCost.toString()).mul(row.quantityRemaining)),
        new Prisma.Decimal(0)
      );
      const batch = await tx.inventoryBatch.findFirst({
        where: { id: batchId, tenantId, productId },
        select: { stockQuantity: true }
      });
      if (!batch || batch.stockQuantity !== layerQuantity) {
        throw new Error(
          `FIFO_BATCH_LAYER_QUANTITY_MISMATCH: Batch ${batchId} stock ${batch?.stockQuantity ?? "missing"} does not match remaining layer quantity ${layerQuantity}.`
        );
      }
      if (layerQuantity > 0) {
        await tx.inventoryBatch.update({
          where: { id: batchId },
          data: { cost: layerValue.div(layerQuantity) }
        });
      }
    }

    const newGlobalStock = Number(product.stockQuantity) - quantityToDeplete;
    await tx.product.update({
      where: { id: productId },
      data: { stockQuantity: newGlobalStock, version: { increment: 1 } }
    });

    const updatedBranchLayers = await tx.inventoryLayer.aggregate({
      where: { tenantId, branchId: trustedBranchId, productId },
      _sum: { quantityRemaining: true }
    });
    await tx.branchInventory.update({
      where: { branchId_productId: { branchId: trustedBranchId, productId } },
      data: { stockQuantity: updatedBranchLayers._sum.quantityRemaining ?? 0 }
    });

    return { allocations, totalCost: accumulatedCost.toNumber() };
  }

  /**
   * Add one immutable cost layer per source line. InventoryBatch remains a
   * batch-number aggregate for current stock and UI display.
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
    expectedTenantId: string,
    branchId?: string | null,
    sourceLineId?: string
  ): Promise<void> {
    if (!expectedTenantId || !expectedTenantId.trim()) {
      throw new Error("TRUSTED_TENANT_CONTEXT_REQUIRED: Expected tenantId is mandatory for stock addition.");
    }
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      throw new Error("INVALID_STOCK_QUANTITY: Addition quantity must be a positive safe integer.");
    }
    // TODO: F-22 - inventory.routes.ts must pass valid cost (separate PR).
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new Error(
        `FIFO_INVALID_COST: Cannot create inventory layer with cost ${cost} for product ${productId}. Cost must be a finite number > 0.`
      );
    }
    if (!batchNumber?.trim() || !referenceId?.trim() || !referenceType?.trim()) {
      throw new Error("FIFO_SOURCE_REQUIRED: Batch number and source reference are required.");
    }

    const lockedProducts = await tx.$queryRaw<any[]>(
      Prisma.sql`SELECT id, "tenantId" FROM products
        WHERE id = ${productId} AND "tenantId" = ${expectedTenantId}
        FOR UPDATE`
    );
    const tenantId = lockedProducts[0]?.tenantId as string | undefined;
    const forbiddenTenants = ["TEN-DEV-001", "tenant_default", "default", "default-tenant"];
    if (!tenantId) {
      throw new Error("PRODUCT_NOT_FOUND_OR_FORBIDDEN: Product does not exist in the authenticated tenant.");
    }
    if (tenantId !== expectedTenantId) {
      throw new Error("CROSS_TENANT_VIOLATION: Product does not belong to the authenticated tenant.");
    }
    if (forbiddenTenants.includes(tenantId)) {
      throw new Error("TRUSTED_TENANT_CONTEXT_REQUIRED: Product has an invalid tenant context for stock addition.");
    }

    const trustedBranchId = branchId?.trim();
    if (!trustedBranchId) {
      throw new Error("TRUSTED_BRANCH_CONTEXT_REQUIRED: Branch ID is mandatory for FIFO stock addition.");
    }
    const branch = await tx.branch.findFirst({
      where: { id: trustedBranchId, tenantId },
      select: { id: true }
    });
    if (!branch) {
      throw new Error("BRANCH_NOT_FOUND_OR_FORBIDDEN: Branch does not belong to the authenticated tenant.");
    }

    // Never let a new receipt silently repair or overwrite a divergent legacy
    // branch projection. The projection must already agree with existing layers.
    const existingBranchInventory = await tx.branchInventory.findUnique({
      where: { branchId_productId: { branchId: trustedBranchId, productId } },
      select: { stockQuantity: true }
    });
    const existingBranchLayers = await tx.inventoryLayer.aggregate({
      where: { tenantId, branchId: trustedBranchId, productId },
      _sum: { quantityRemaining: true }
    });
    const existingLayerQuantity = existingBranchLayers._sum.quantityRemaining ?? 0;
    if (existingBranchInventory && existingBranchInventory.stockQuantity !== existingLayerQuantity) {
      throw new Error(
        `BRANCH_INVENTORY_LAYER_MISMATCH: Existing branch projection ${existingBranchInventory.stockQuantity} does not match ${existingLayerQuantity} remaining FIFO layer units for product ${productId}.`
      );
    }
    if (!existingBranchInventory && existingLayerQuantity > 0) {
      throw new Error(
        "BRANCH_INVENTORY_NOT_INITIALIZED: Existing FIFO layers have no branch stock projection; reconcile before receiving more stock."
      );
    }

    const normalizedLineId = sourceLineId?.trim() || productId;
    const sourceKey = [referenceType, referenceId, normalizedLineId, batchNumber].join(":");
    const existingLayer = await tx.inventoryLayer.findFirst({
      where: { tenantId, sourceKey },
      select: { id: true }
    });
    if (existingLayer) {
      throw new Error("DUPLICATE_FIFO_SOURCE_LAYER: This purchase/adjustment line has already created a FIFO layer.");
    }

    const existingBatch = await tx.inventoryBatch.findUnique({
      where: { productId_batchNumber_tenantId: { productId, batchNumber, tenantId } }
    });

    let targetBatchId: string;
    if (existingBatch) {
      if (
        existingBatch.expiryDate &&
        expiryDate &&
        existingBatch.expiryDate.getTime() !== expiryDate.getTime()
      ) {
        throw new Error("BATCH_EXPIRY_MISMATCH: The same batch number cannot be reused with a different expiry date.");
      }

      const previousQty = existingBatch.stockQuantity;
      const nextQty = previousQty + qty;
      const weightedValue = new Prisma.Decimal(existingBatch.cost.toString())
        .mul(previousQty)
        .plus(new Prisma.Decimal(cost).mul(qty));
      const weightedCost = nextQty > 0 ? weightedValue.div(nextQty) : new Prisma.Decimal(cost);

      const updatedBatch = await tx.inventoryBatch.update({
        where: { id: existingBatch.id },
        data: {
          initialQty: { increment: qty },
          stockQuantity: nextQty,
          cost: weightedCost,
          expiryDate: existingBatch.expiryDate || expiryDate,
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
          cost: new Prisma.Decimal(cost),
          expiryDate
        }
      });
      targetBatchId = newBatch.id;
    }

    await tx.inventoryLayer.create({
      data: {
        tenantId,
        productId,
        batchId: targetBatchId,
        batchNumber,
        sourceReferenceId: referenceId,
        sourceReferenceType: referenceType,
        sourceLineId: sourceLineId || null,
        sourceKey,
        quantityInitial: qty,
        quantityRemaining: qty,
        unitCost: new Prisma.Decimal(cost),
        expiryDate,
        branchId: trustedBranchId
      }
    });

    const previousProduct = await tx.product.findFirst({
      where: { id: productId, tenantId },
      select: { stockQuantity: true }
    });
    if (!previousProduct) {
      throw new Error("PRODUCT_NOT_FOUND_OR_FORBIDDEN: Product disappeared during stock addition.");
    }

    await tx.inventoryMovement.create({
      data: {
        tenantId,
        productId,
        batchId: targetBatchId,
        qty,
        type: "STOCK_IN",
        referenceId,
        referenceType,
        branchId: branchId || null,
        reason: reason || "Batch Procurement Addition",
        previousStock: previousProduct.stockQuantity,
        currentStock: previousProduct.stockQuantity + qty
      }
    });

    await tx.product.update({
      where: { id: productId },
      data: {
        stockQuantity: { increment: qty },
        cost: new Prisma.Decimal(cost),
        version: { increment: 1 }
      }
    });

    const updatedBranchLayers = await tx.inventoryLayer.aggregate({
      where: { tenantId, branchId: trustedBranchId, productId },
      _sum: { quantityRemaining: true }
    });
    await tx.branchInventory.upsert({
      where: { branchId_productId: { branchId: trustedBranchId, productId } },
      create: {
        tenantId,
        branchId: trustedBranchId,
        productId,
        stockQuantity: updatedBranchLayers._sum.quantityRemaining ?? 0
      },
      update: { stockQuantity: updatedBranchLayers._sum.quantityRemaining ?? 0 }
    });
  }
}
