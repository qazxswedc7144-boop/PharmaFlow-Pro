// src/features/inventory/services/UnifiedInventoryMutationEngine.ts
/**
 * PharmaFlow PRO ERP — Sovereign Enterprise Edition
 * Phase 5 — Step 1: Foundational Unified Inventory Mutation Engine
 * 
 * ARCHITECTURAL INVARIANTS:
 * 1. db.inventoryTransactions is the ONLY Canonical Inventory Ledger.
 * 2. UnifiedInventoryMutationEngine is the ONLY authorized Single Writer for inventory mutations.
 * 3. products.stock is the canonical product quantity projection.
 * 4. products.StockQuantity is a temporary legacy compatibility projection and MUST always equal products.stock.
 * 5. products.quantity and products.stock_qty MUST NOT be used.
 * 6. warehouseStock.quantity is a materialized warehouse balance projection.
 * 7. inventory_layers + fifo_consumption_log are the FIFO valuation / COGS subsystem.
 * 8. medicineBatches is the pharmacy batch / expiry / traceability subsystem.
 * 9. stock_movements is ONLY a temporary Legacy Compatibility Layer.
 * 10. Physical deletion of inventory movements is strictly forbidden.
 * 11. Reversal must always be represented by compensating movements.
 * 12. Negative stock policy is controlled exclusively by inventory.allowNegativeStock.
 * 13. Silent clamping of stock to zero is strictly forbidden.
 * 14. All inventory mutations must be atomic via db.safeTransaction.
 */

import { db } from '@/core/db';
import { configurationService } from '@/services/config/configurationService';
import { PeriodLockEngine } from '@/services/transactions/PeriodLockEngine';
import { FIFOEngine } from './fifoEngine';
import {
  IssueSaleStockCommand,
  ReceivePurchaseStockCommand,
  ProcessSalesReturnStockCommand,
  ProcessPurchaseReturnStockCommand,
  ExecuteInventoryAdjustmentCommand,
  TransferWarehouseStockCommand,
  ReverseDocumentStockCommand,
  ExecuteApprovedCorrectionCommand,
  GenericMutationCommand,
  InventoryMutationResult
} from '../types/inventoryCommand.types';
import {
  InsufficientStockError,
  ProductNotFoundError,
  ProductInactiveError,
  InvalidWarehouseError,
  PeriodLockedInventoryError
} from '../errors/inventoryDomainErrors';

export interface InternalItemMutationParams {
  productId: string;
  warehouseId: string;
  delta: number; // positive = IN, negative = OUT
  docType: 'SALE' | 'PURCHASE' | 'SALE_RETURN' | 'PURCHASE_RETURN' | 'ADJUSTMENT' | 'TRANSFER' | 'INITIAL' | 'CORRECTION' | 'REVERSAL' | string;
  docId: string;
  movementType: 'SALE' | 'PURCHASE' | 'RETURN' | 'ADJUSTMENT' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'DAMAGE' | 'CORRECTION' | 'REVERSAL' | string;
  unitCost?: number;
  unitPrice?: number;
  batchId?: string;
  batchNumber?: string;
  expiryDate?: string;
  userId: string;
  tenantId: string;
  branchId?: string;
  idempotencyKey: string;
  notes?: string;
  timestamp: string;
  reversedMovementId?: string;
}

export class UnifiedInventoryMutationEngine {
  private static instance: UnifiedInventoryMutationEngine;

  private constructor() {}

  public static getInstance(): UnifiedInventoryMutationEngine {
    if (!UnifiedInventoryMutationEngine.instance) {
      UnifiedInventoryMutationEngine.instance = new UnifiedInventoryMutationEngine();
    }
    return UnifiedInventoryMutationEngine.instance;
  }

  // =========================================================================
  // PUBLIC COMMAND APIS
  // =========================================================================

  /**
   * 1. Issue Sale Stock (Deduction for sales)
   */
  public async executeIssueSale(command: IssueSaleStockCommand): Promise<InventoryMutationResult[]> {
    this.validateCommandBasics(command, 'IssueSale');
    if (!Array.isArray(command.items) || command.items.length === 0) {
      throw new Error(`[UnifiedEngine] items[] is required and must be non-empty.`);
    }
    const timestamp = command.timestamp || new Date().toISOString();

    return await this.executeAtomicTransaction(async () => {
      const results: InventoryMutationResult[] = [];

      for (let i = 0; i < command.items.length; i++) {
        const item = command.items[i]!;
        const itemKey = `${command.transactionUuid}-${item.productId}-${i}`;

        const res = await this.mutateSingleItem({
          productId: item.productId,
          warehouseId: command.warehouseId,
          delta: -Math.abs(item.quantity),
          docType: 'SALE',
          docId: command.invoiceId,
          movementType: 'SALE',
          unitCost: item.unitCost,
          unitPrice: item.unitPrice,
          batchId: item.batchId,
          batchNumber: item.batchNumber,
          expiryDate: item.expiryDate,
          userId: command.userId,
          tenantId: command.tenantId,
          branchId: command.branchId,
          idempotencyKey: itemKey,
          notes: command.notes || `صرف مبيعات فاتورة #${command.invoiceId}`,
          timestamp
        });

        results.push(res);
      }

      return results;
    });
  }

  /**
   * 2. Receive Purchase Stock (Increase for purchases)
   */
  public async executeReceivePurchase(command: ReceivePurchaseStockCommand): Promise<InventoryMutationResult[]> {
    this.validateCommandBasics(command, 'ReceivePurchase');
    if (!Array.isArray(command.items) || command.items.length === 0) {
      throw new Error(`[UnifiedEngine] items[] is required and must be non-empty.`);
    }
    const timestamp = command.timestamp || new Date().toISOString();

    return await this.executeAtomicTransaction(async () => {
      const results: InventoryMutationResult[] = [];

      for (let i = 0; i < command.items.length; i++) {
        const item = command.items[i]!;
        const itemKey = `${command.transactionUuid}-${item.productId}-${i}`;

        const res = await this.mutateSingleItem({
          productId: item.productId,
          warehouseId: command.warehouseId,
          delta: Math.abs(item.quantity),
          docType: 'PURCHASE',
          docId: command.invoiceId,
          movementType: 'PURCHASE',
          unitCost: item.unitCost,
          unitPrice: item.unitPrice,
          batchId: item.batchId,
          batchNumber: item.batchNumber,
          expiryDate: item.expiryDate,
          userId: command.userId,
          tenantId: command.tenantId,
          branchId: command.branchId,
          idempotencyKey: itemKey,
          notes: command.notes || `استلام مشتريات فاتورة #${command.invoiceId}`,
          timestamp
        });

        results.push(res);
      }

      return results;
    });
  }

  /**
   * 3. Process Sales Return (Customer return -> stock IN)
   */
  public async executeSalesReturn(command: ProcessSalesReturnStockCommand): Promise<InventoryMutationResult[]> {
    this.validateCommandBasics(command, 'ProcessSalesReturn');
    if (!Array.isArray(command.items) || command.items.length === 0) {
      throw new Error(`[UnifiedEngine] items[] is required and must be non-empty.`);
    }
    const timestamp = command.timestamp || new Date().toISOString();

    return await this.executeAtomicTransaction(async () => {
      const results: InventoryMutationResult[] = [];

      for (let i = 0; i < command.items.length; i++) {
        const item = command.items[i]!;
        const itemKey = `${command.transactionUuid}-${item.productId}-${i}`;

        const res = await this.mutateSingleItem({
          productId: item.productId,
          warehouseId: command.warehouseId,
          delta: Math.abs(item.quantity),
          docType: 'SALE_RETURN',
          docId: command.returnInvoiceId,
          movementType: 'RETURN',
          unitCost: item.unitCost,
          batchId: item.batchId,
          batchNumber: item.batchNumber,
          expiryDate: item.expiryDate,
          userId: command.userId,
          tenantId: command.tenantId,
          branchId: command.branchId,
          idempotencyKey: itemKey,
          notes: command.notes || `مرتجع مبيعات #${command.returnInvoiceId}`,
          timestamp
        });

        results.push(res);
      }

      return results;
    });
  }

  /**
   * 4. Process Purchase Return (Return to supplier -> stock OUT)
   */
  public async executePurchaseReturn(command: ProcessPurchaseReturnStockCommand): Promise<InventoryMutationResult[]> {
    this.validateCommandBasics(command, 'ProcessPurchaseReturn');
    if (!Array.isArray(command.items) || command.items.length === 0) {
      throw new Error(`[UnifiedEngine] items[] is required and must be non-empty.`);
    }
    const timestamp = command.timestamp || new Date().toISOString();

    return await this.executeAtomicTransaction(async () => {
      const results: InventoryMutationResult[] = [];

      for (let i = 0; i < command.items.length; i++) {
        const item = command.items[i]!;
        const itemKey = `${command.transactionUuid}-${item.productId}-${i}`;

        const res = await this.mutateSingleItem({
          productId: item.productId,
          warehouseId: command.warehouseId,
          delta: -Math.abs(item.quantity),
          docType: 'PURCHASE_RETURN',
          docId: command.returnInvoiceId,
          movementType: 'RETURN',
          unitCost: item.unitCost,
          batchId: item.batchId,
          batchNumber: item.batchNumber,
          expiryDate: item.expiryDate,
          userId: command.userId,
          tenantId: command.tenantId,
          branchId: command.branchId,
          idempotencyKey: itemKey,
          notes: command.notes || `مرتجع مشتريات #${command.returnInvoiceId}`,
          timestamp
        });

        results.push(res);
      }

      return results;
    });
  }

  /**
   * 5. Execute Inventory Adjustment (Physical count reconciliation)
   */
  public async executeAdjustment(command: ExecuteInventoryAdjustmentCommand): Promise<InventoryMutationResult> {
    this.validateCommandBasics(command, 'ExecuteAdjustment');
    const timestamp = command.timestamp || new Date().toISOString();

    const existingTx = await this.checkExistingIdempotentTransaction(command.transactionUuid, command.adjustmentId, 'ADJUSTMENT', command.productId, command.tenantId);
    if (existingTx) {
      return {
        success: true,
        transactionId: existingTx.TransactionID || existingTx.id,
        productId: command.productId,
        warehouseId: command.warehouseId,
        previousStock: Number(existingTx.before_qty ?? 0),
        newStock: Number(existingTx.after_qty ?? 0),
        delta: Number(existingTx.QuantityChange ?? existingTx.quantityChange ?? 0),
        calculatedCost: existingTx.unit_cost,
        timestamp: existingTx.TransactionDate || existingTx.created_at || timestamp
      };
    }

    return await this.executeAtomicTransaction(async () => {
      const ws = await this.readWarehouseStock(command.warehouseId, command.productId, command.tenantId);
      const currentWarehouseQty = ws ? ws.quantity : 0;
      const delta = command.actualQuantity - currentWarehouseQty;

      return await this.mutateSingleItem({
        productId: command.productId,
        warehouseId: command.warehouseId,
        delta,
        docType: 'ADJUSTMENT',
        docId: command.adjustmentId,
        movementType: 'ADJUSTMENT',
        unitCost: command.unitCost,
        batchId: command.batchId,
        userId: command.userId,
        tenantId: command.tenantId,
        branchId: command.branchId,
        idempotencyKey: command.transactionUuid,
        notes: command.notes || `تسوية جردية #${command.adjustmentId}: ${command.reason}`,
        timestamp
      });
    });
  }

  /**
   * 6. Transfer Warehouse Stock (Inter-warehouse transfer)
   */
  public async executeTransfer(command: TransferWarehouseStockCommand): Promise<{ sourceResult: InventoryMutationResult; targetResult: InventoryMutationResult }> {
    this.validateCommandBasics(command, 'TransferWarehouseStock');
    if (command.fromWarehouseId === command.toWarehouseId) {
      throw new InvalidWarehouseError(command.toWarehouseId, { message: 'Source and target warehouses cannot be identical.' });
    }
    const timestamp = command.timestamp || new Date().toISOString();
    const sourceKey = `${command.transactionUuid}-SOURCE`;
    const targetKey = `${command.transactionUuid}-TARGET`;

    // Idempotency check (tenant scoped)
    const existingSource = await db.inventoryTransactions
      .filter((tx: any) => tx.idempotencyKey === sourceKey && ((tx.tenantId || tx.tenant_id) === command.tenantId))
      .first();
    const existingTarget = await db.inventoryTransactions
      .filter((tx: any) => tx.idempotencyKey === targetKey && ((tx.tenantId || tx.tenant_id) === command.tenantId))
      .first();

    if (existingSource && existingTarget) {
      return {
        sourceResult: {
          success: true,
          transactionId: existingSource.TransactionID || existingSource.id,
          productId: command.productId,
          warehouseId: command.fromWarehouseId,
          previousStock: Number(existingSource.before_qty ?? 0),
          newStock: Number(existingSource.after_qty ?? 0),
          delta: Number(existingSource.QuantityChange ?? existingSource.quantityChange ?? 0),
          calculatedCost: existingSource.unit_cost,
          timestamp: existingSource.TransactionDate || existingSource.created_at || timestamp
        },
        targetResult: {
          success: true,
          transactionId: existingTarget.TransactionID || existingTarget.id,
          productId: command.productId,
          warehouseId: command.toWarehouseId,
          previousStock: Number(existingTarget.before_qty ?? 0),
          newStock: Number(existingTarget.after_qty ?? 0),
          delta: Number(existingTarget.QuantityChange ?? existingTarget.quantityChange ?? 0),
          calculatedCost: existingTarget.unit_cost,
          timestamp: existingTarget.TransactionDate || existingTarget.created_at || timestamp
        }
      };
    }

    return await this.executeAtomicTransaction(async () => {
      // Resolve batch info if batchId given
      let resolvedBatchNum = command.batchNumber;
      let resolvedExpiry = command.expiryDate;
      let resolvedCost = command.unitCost;

      if (command.batchId) {
        const srcBatch = await db.medicineBatches.get(command.batchId).catch(() => null);
        if (!srcBatch) {
          throw new Error(`[UnifiedEngine] BATCH_NOT_FOUND: Source batch '${command.batchId}' was not found for transfer.`);
        }
        const batchTenant = (srcBatch as any).tenantId || (srcBatch as any).tenant_id;
        if (!batchTenant || batchTenant !== command.tenantId) {
          throw new Error(`[UnifiedEngine] CROSS_TENANT_VIOLATION: Source batch '${command.batchId}' does not belong to authoritative tenant '${command.tenantId}' or lacks valid tenant binding.`);
        }
        resolvedBatchNum = resolvedBatchNum || srcBatch.batchNumber || srcBatch.batchId;
        resolvedExpiry = resolvedExpiry || srcBatch.expiryDate;
        resolvedCost = resolvedCost ?? srcBatch.unitCost ?? srcBatch.cost;
      }

      // 1. Deduct from source warehouse (does not alter global product stock because + and - cancel out)
      const sourceResult = await this.mutateSingleItem({
        productId: command.productId,
        warehouseId: command.fromWarehouseId,
        delta: -Math.abs(command.quantity),
        docType: 'TRANSFER',
        docId: command.transferId,
        movementType: 'TRANSFER_OUT',
        batchId: command.batchId,
        batchNumber: resolvedBatchNum,
        expiryDate: resolvedExpiry,
        unitCost: resolvedCost,
        userId: command.userId,
        tenantId: command.tenantId,
        branchId: command.branchId,
        idempotencyKey: sourceKey,
        notes: command.notes || `تحويل مخزني إلى ${command.toWarehouseId} (مستند #${command.transferId})`,
        timestamp
      });

      // 2. Add to target warehouse
      const targetResult = await this.mutateSingleItem({
        productId: command.productId,
        warehouseId: command.toWarehouseId,
        delta: Math.abs(command.quantity),
        docType: 'TRANSFER',
        docId: command.transferId,
        movementType: 'TRANSFER_IN',
        batchId: undefined, // Create/increment target batch in target warehouse
        batchNumber: resolvedBatchNum,
        expiryDate: resolvedExpiry,
        unitCost: resolvedCost,
        userId: command.userId,
        tenantId: command.tenantId,
        branchId: command.targetBranchId || command.branchId,
        idempotencyKey: targetKey,
        notes: command.notes || `استلام تحويل مخزني من ${command.fromWarehouseId} (مستند #${command.transferId})`,
        timestamp
      });

      return { sourceResult, targetResult };
    });
  }

  /**
   * 7. Reverse Document Stock (Compensating reversal movement - NO PHYSICAL DELETES)
   */
  public async executeReversal(command: ReverseDocumentStockCommand): Promise<InventoryMutationResult[]> {
    this.validateCommandBasics(command, 'ReverseDocumentStock');
    const timestamp = command.timestamp || new Date().toISOString();

    return await this.executeAtomicTransaction(async () => {
      // Find all original movements for this document belonging to authoritative tenant.
      // STRICTLY EXCLUDE any prior REVERSAL entries to prevent double-reversal corruption.
      const allMovements = await db.inventoryTransactions
        .where('source_doc_id')
        .equals(command.originalDocumentId)
        .filter((t: any) => ((t.tenantId || t.tenant_id) === command.tenantId))
        .toArray();

      const baseMovements = allMovements.length > 0
        ? allMovements
        : await db.inventoryTransactions
            .filter((t: any) =>
              t.SourceDocumentID === command.originalDocumentId &&
              ((t.tenantId || t.tenant_id) === command.tenantId)
            )
            .toArray();

      const alreadyReversedIds = new Set<string>(
        baseMovements
          .filter((t: any) => {
            const txType = t.TransactionType || t.transactionType || t.transaction_type;
            return txType === 'REVERSAL' && (t.reversedMovementId || t.reversal_of_id);
          })
          .map((t: any) => String(t.reversedMovementId || t.reversal_of_id))
      );

      const movementsToReverse = baseMovements.filter((t: any) => {
        const txType = t.TransactionType || t.transactionType || t.transaction_type;
        if (txType === 'REVERSAL') return false;
        const thisId = String(t.id || t.TransactionID);
        if (alreadyReversedIds.has(thisId)) return false;
        return true;
      });

      if (movementsToReverse.length === 0) {
        return [];
      }

      const results: InventoryMutationResult[] = [];

      for (let i = 0; i < movementsToReverse.length; i++) {
        const orig = movementsToReverse[i]!;
        const origQtyChange = Number(orig.QuantityChange ?? orig.quantityChange ?? 0);
        const reversedDelta = -origQtyChange;
        const revKey = `${command.transactionUuid}-REV-${orig.id || orig.TransactionID}-${i}`;

        const res = await this.mutateSingleItem({
          productId: orig.productId || orig.product_id,
          warehouseId: orig.warehouseId || orig.warehouse_id || 'WH-MAIN',
          delta: reversedDelta,
          docType: 'REVERSAL',
          docId: command.originalDocumentId,
          movementType: 'REVERSAL',
          unitCost: orig.unit_cost,
          userId: command.userId,
          tenantId: command.tenantId,
          branchId: command.branchId || orig.branchId,
          idempotencyKey: revKey,
          notes: `قيد عكسي تعويضي للمستند #${command.originalDocumentId}. السبب: ${command.reason}`,
          timestamp,
          reversedMovementId: String(orig.id || orig.TransactionID)
        });

        results.push(res);
      }

      return results;
    });
  }

  /**
   * 8. Execute Approved Correction (Regulatory correction case)
   */
  public async executeCorrection(command: ExecuteApprovedCorrectionCommand): Promise<InventoryMutationResult> {
    this.validateCommandBasics(command, 'ExecuteApprovedCorrection');
    const timestamp = command.timestamp || new Date().toISOString();

    if (!command.approverId || typeof command.approverId !== 'string' || command.approverId.trim() === '') {
      throw new Error(`[UnifiedEngine] approverId is required for ExecuteApprovedCorrection (case #${command.caseId}).`);
    }

    const existingTx = await this.checkExistingIdempotentTransaction(command.transactionUuid, command.caseId, 'CORRECTION', command.productId, command.tenantId);
    if (existingTx) {
      return {
        success: true,
        transactionId: existingTx.TransactionID || existingTx.id,
        productId: command.productId,
        warehouseId: command.warehouseId,
        previousStock: Number(existingTx.before_qty ?? 0),
        newStock: Number(existingTx.after_qty ?? 0),
        delta: Number(existingTx.QuantityChange ?? existingTx.quantityChange ?? 0),
        calculatedCost: existingTx.unit_cost,
        timestamp: existingTx.TransactionDate || existingTx.created_at || timestamp
      };
    }

    return await this.executeAtomicTransaction(async () => {
      const ws = await this.readWarehouseStock(command.warehouseId, command.productId, command.tenantId);
      const currentWarehouseQty = ws ? ws.quantity : 0;
      const delta = command.proposedQty - currentWarehouseQty;

      return await this.mutateSingleItem({
        productId: command.productId,
        warehouseId: command.warehouseId,
        delta,
        docType: 'CORRECTION',
        docId: command.caseId,
        movementType: 'CORRECTION',
        userId: command.approverId,
        tenantId: command.tenantId,
        branchId: command.branchId,
        idempotencyKey: command.transactionUuid,
        notes: `تصحيح رقابي معتمد لقضية #${command.caseId}: ${command.reason}`,
        timestamp
      });
    });
  }

  /**
   * 9. Execute Single Generic Mutation (Single Authorized Portal for legacy callers)
   */
  public async executeMutation(command: GenericMutationCommand): Promise<InventoryMutationResult> {
    this.validateCommandBasics(command, 'ExecuteMutation');
    const timestamp = command.timestamp || new Date().toISOString();

    return await this.executeAtomicTransaction(async () => {
      const resolvedMovement = command.movementType || (command.delta >= 0 ? 'PURCHASE' : 'SALE');
      return await this.mutateSingleItem({
        productId: command.productId,
        warehouseId: command.warehouseId,
        delta: command.delta,
        docType: command.docType as any,
        docId: command.docId,
        movementType: resolvedMovement as any,
        unitCost: command.unitCost,
        unitPrice: command.unitPrice,
        batchId: command.batchId,
        batchNumber: command.batchNumber,
        expiryDate: command.expiryDate,
        userId: command.userId,
        tenantId: command.tenantId,
        branchId: command.branchId,
        idempotencyKey: command.transactionUuid,
        notes: command.notes,
        timestamp
      });
    });
  }

  /**
   * 10. Execute Batch Generic Mutations
   */
  public async executeBatch(commands: GenericMutationCommand[]): Promise<InventoryMutationResult[]> {
    if (!Array.isArray(commands) || commands.length === 0) {
      return [];
    }

    return await this.executeAtomicTransaction(async () => {
      const results: InventoryMutationResult[] = [];
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i]!;
        this.validateCommandBasics(cmd, `ExecuteBatch[${i}]`);
        const timestamp = cmd.timestamp || new Date().toISOString();
        const resolvedMovement = cmd.movementType || (cmd.delta >= 0 ? 'PURCHASE' : 'SALE');

        const res = await this.mutateSingleItem({
          productId: cmd.productId,
          warehouseId: cmd.warehouseId,
          delta: cmd.delta,
          docType: cmd.docType as any,
          docId: cmd.docId,
          movementType: resolvedMovement as any,
          unitCost: cmd.unitCost,
          unitPrice: cmd.unitPrice,
          batchId: cmd.batchId,
          batchNumber: cmd.batchNumber,
          expiryDate: cmd.expiryDate,
          userId: cmd.userId,
          tenantId: cmd.tenantId,
          branchId: cmd.branchId,
          idempotencyKey: cmd.transactionUuid,
          notes: cmd.notes,
          timestamp
        });
        results.push(res);
      }
      return results;
    });
  }

  // =========================================================================
  // INTERNAL SINGLE-WRITER MUTATION CORE (STRICTLY PRIVATE)
  // =========================================================================

  private async mutateSingleItem(params: InternalItemMutationParams): Promise<InventoryMutationResult> {
    const {
      productId,
      warehouseId,
      delta,
      docType,
      docId,
      movementType,
      unitCost,
      unitPrice,
      batchId,
      batchNumber,
      expiryDate,
      userId,
      tenantId,
      branchId,
      idempotencyKey,
      notes,
      timestamp
    } = params;

    // 1. Idempotency Check (tenant scoped)
    const existingTx = await this.checkExistingIdempotentTransaction(idempotencyKey, docId, docType, productId, tenantId);
    if (existingTx) {
      return {
        success: true,
        transactionId: existingTx.TransactionID || existingTx.id,
        productId,
        warehouseId,
        previousStock: Number(existingTx.before_qty ?? 0),
        newStock: Number(existingTx.after_qty ?? 0),
        delta: Number(existingTx.QuantityChange ?? existingTx.quantityChange ?? 0),
        calculatedCost: existingTx.unit_cost,
        timestamp: existingTx.TransactionDate || existingTx.created_at || timestamp
      };
    }

    // No-op guard: do not create zero-quantity ledger entries or empty batches
    if (delta === 0) {
      return {
        success: true,
        transactionId: null as any,
        productId,
        warehouseId,
        previousStock: 0,
        newStock: 0,
        delta: 0,
        calculatedCost: 0,
        timestamp
      };
    }

    // 2. Validate Product Existence, Active Status & Strict Tenant Binding
    const product = await db.products.get(productId);
    if (!product) {
      throw new ProductNotFoundError(productId);
    }
    const productTenant = (product as any).tenantId || (product as any).tenant_id;
    if (!productTenant || productTenant !== tenantId) {
      throw new Error(`[UnifiedEngine] CROSS_TENANT_VIOLATION: Product '${productId}' does not belong to authoritative tenant '${tenantId}' or lacks valid tenant binding.`);
    }
    const isInactive = product.is_active === false || product.isActive === false || product.Is_Active === false;
    if (isInactive) {
      throw new ProductInactiveError(productId, product.name || product.Name);
    }

    // 3. Validate Warehouse
    if (!warehouseId || typeof warehouseId !== 'string' || warehouseId.trim() === '') {
      throw new InvalidWarehouseError(warehouseId || 'EMPTY_WAREHOUSE_ID');
    }

    // 4. Validate Period Lock
    const isLocked = await PeriodLockEngine.isPeriodLocked(timestamp);
    if (isLocked) {
      throw new PeriodLockedInventoryError(timestamp, movementType);
    }

    // 5. Read Existing Balances (Snapshot Before)
    const ws = await this.readWarehouseStock(warehouseId, productId, tenantId);
    const beforeWarehouseQty = ws ? Number(ws.quantity || 0) : 0;
    
    // Product Master stock: canonical is 'stock'
    const beforeProductStock = (typeof product.stock === 'number') 
      ? product.stock 
      : ((typeof product.StockQuantity === 'number') ? product.StockQuantity : 0);

    // 6. Calculate New Balances (Snapshot After)
    const afterWarehouseQty = beforeWarehouseQty + delta;

    // Maintain Product Projection Invariant: products.stock = SUM(warehouseStock.quantity) within authoritative tenant
    const allWhs = await db.warehouseStock
      .filter((w: any) => 
        (w.productId === productId || w.product_id === productId) &&
        ((w.tenantId || w.tenant_id) === tenantId)
      )
      .toArray();

    let afterProductStock: number;
    if (allWhs.length > 0) {
      const otherWhsSum = allWhs
        .filter((w: any) => (w.warehouseId || w.warehouse_id) !== warehouseId)
        .reduce((sum: number, w: any) => sum + Number(w.quantity || 0), 0);
      afterProductStock = otherWhsSum + afterWarehouseQty;
    } else {
      afterProductStock = beforeProductStock + delta;
    }

    // 7. Enforce Negative Stock Policy
    if (delta < 0 && (afterWarehouseQty < 0 || afterProductStock < 0)) {
      const allowNegative = 
        configurationService.getSync<boolean>('inventory.allowNegativeStock') ??
        configurationService.getSync<boolean>('sales.allow_negative_stock') ??
        false;
      if (!allowNegative) {
        throw new InsufficientStockError({
          message: `Insufficient stock for product '${product.name || productId}' in warehouse '${warehouseId}'. Available: ${beforeWarehouseQty}, Requested deduction: ${Math.abs(delta)}, Resulting: ${afterWarehouseQty}.`,
          arabicMessage: `الكمية غير متوفرة في المستودع "${warehouseId}" للصنف "${product.name || productId}". المتوفر حالياً: ${beforeWarehouseQty}، المطلوب: ${Math.abs(delta)}.`,
          module: 'INVENTORY',
          metadata: { productId, warehouseId, beforeWarehouseQty, delta, requested: Math.abs(delta), afterWarehouseQty }
        });
      }
      // If allowNegative is true: DO NOT CLAMP TO ZERO. Record exact negative balance.
    }

    // 8. Cost Calculation & FIFO Subsystem
    let resolvedUnitCost = unitCost ?? (product.costPrice || product.CostPrice || product.cost || 0);
    const isInward = delta > 0 && ['PURCHASE', 'RECEIVE', 'TRANSFER_IN', 'ADJUSTMENT', 'CORRECTION', 'RETURN', 'INITIAL'].includes(movementType);
    const isOutward = delta < 0 && ['SALE', 'DISPATCH', 'TRANSFER_OUT', 'ADJUSTMENT', 'CORRECTION', 'DAMAGE', 'RETURN'].includes(movementType);

    if (isInward) {
      await FIFOEngine.addPurchaseLayer(productId, Math.abs(delta), resolvedUnitCost, docId, tenantId);
    } else if (isOutward) {
      const fifoConsumption = await FIFOEngine.consumeFIFO(docId, productId, Math.abs(delta), tenantId);
      if (fifoConsumption && fifoConsumption.unitCost > 0) {
        resolvedUnitCost = fifoConsumption.unitCost;
      }
    } else if (movementType === 'REVERSAL') {
      if (delta > 0) {
        await FIFOEngine.reverseFIFO(docId);
      } else if (delta < 0) {
        await FIFOEngine.removePurchaseLayer(docId);
      }
    }

    // 9. Batch & Expiry Subsystem (Pharmacy Tracking)
    await this.mutateMedicineBatch({
      productId,
      warehouseId,
      delta,
      movementType,
      batchId,
      batchNumber,
      expiryDate,
      unitCost: resolvedUnitCost,
      docId,
      tenantId,
      branchId,
      timestamp
    });

    // 10. Record Canonical Ledger Entry (db.inventoryTransactions)
    const txId = db.generateId('ITX');
    const ledgerRecord: any = {
      id: txId,
      TransactionID: txId,
      productId,
      product_id: productId,
      warehouseId,
      warehouse_id: warehouseId,
      branchId: branchId,
      branch_id: branchId,
      tenantId: tenantId,
      tenant_id: tenantId,
      SourceDocumentType: docType,
      sourceDocType: docType,
      SourceDocumentID: docId,
      sourceDocId: docId,
      source_doc_id: docId,
      TransactionType: movementType,
      transactionType: movementType,
      transaction_type: movementType,
      QuantityChange: delta,
      quantityChange: delta,
      before_qty: beforeWarehouseQty,
      after_qty: afterWarehouseQty,
      unit_cost: resolvedUnitCost,
      unit_price: unitPrice ?? 0,
      total_cost: Math.abs(delta) * resolvedUnitCost,
      TransactionDate: timestamp,
      transactionDate: timestamp,
      transaction_date: timestamp,
      UserID: userId || 'system',
      Created_By: userId || 'system',
      Created_At: timestamp,
      created_at: timestamp,
      lastModified: timestamp,
      notes: notes || `[UnifiedEngine] ${movementType}: ${delta}`,
      idempotencyKey: idempotencyKey || null,
      reversedMovementId: params.reversedMovementId || null,
      reversal_of_id: params.reversedMovementId || null
    };

    await db.inventoryTransactions.add(ledgerRecord);

    // 11. Update Product Projections (products.stock = canonical, StockQuantity mirrors stock)
    await db.products.update(productId, {
      stock: afterProductStock,
      StockQuantity: afterProductStock,
      updated_at: timestamp,
      updatedAt: timestamp,
      lastModified: timestamp
    });

    // 12. Update Warehouse Balance Projection (warehouseStock[warehouseId+productId].quantity)
    if (ws) {
      const wsTenant = (ws as any).tenantId || (ws as any).tenant_id;
      if (!wsTenant || wsTenant !== tenantId) {
        throw new Error(`[UnifiedEngine] CROSS_TENANT_VIOLATION: Warehouse stock record '${ws.id}' does not belong to authoritative tenant '${tenantId}' or lacks valid tenant binding.`);
      }
      await db.warehouseStock.update(ws.id, {
        quantity: afterWarehouseQty,
        lastUpdated: timestamp,
        lastModified: timestamp
      });
    } else {
      await db.warehouseStock.add({
        id: db.generateId('WHS'),
        warehouseId,
        productId,
        quantity: afterWarehouseQty,
        lastUpdated: timestamp,
        lastModified: timestamp,
        tenantId: tenantId,
        tenant_id: tenantId,
        branchId: branchId
      });
    }

    // 13. Update Branch Inventory Projection (branchInventory[branchId+productId].stockQuantity)
const activeBranchId = branchId;
if (!activeBranchId) {
   throw new Error(`[UnifiedEngine] activeBranchId is missing for branchInventory projection update for product ${productId}`);
}

// 🚨 SECURITY FIX (P0): Filter by tenant INSIDE the query (same DoS fix as readWarehouseStock).
// A record belonging to another tenant with the same [branchId+productId] must NOT block
// this tenant's legitimate operation — it is simply invisible to us.
const brInv = await db.branchInventory
  .where('[branchId+productId]')
  .equals([activeBranchId, productId])
  .filter((b: any) => ((b.tenantId || b.tenant_id) === tenantId))
  .first();

    // Enforce negative stock policy at the branch projection level as well
    if (delta < 0) {
      const currentBrQty = brInv ? Number(brInv.stockQuantity || 0) : 0;
      const projectedBrQty = currentBrQty + delta;
      if (projectedBrQty < 0) {
        const allowNegative =
          configurationService.getSync<boolean>('inventory.allowNegativeStock') ??
          configurationService.getSync<boolean>('sales.allow_negative_stock') ??
          false;
        if (!allowNegative) {
          throw new InsufficientStockError({
            message: `Insufficient branch stock for product '${productId}' in branch '${activeBranchId}'. Available: ${currentBrQty}, Requested: ${Math.abs(delta)}.`,
            arabicMessage: `الكمية غير متوفرة في الفرع "${activeBranchId}" للصنف "${productId}". المتوفر: ${currentBrQty}، المطلوب: ${Math.abs(delta)}.`,
            module: 'INVENTORY',
            metadata: { productId, branchId: activeBranchId, currentBrQty, delta, projectedBrQty }
          });
        }
      }
    }

    if (brInv) {
      const newBrQty = (brInv.stockQuantity || 0) + delta;
      await db.branchInventory.update(brInv.id, {
        stockQuantity: newBrQty,
        updatedAt: timestamp
      });
    } else {
      await db.branchInventory.add({
        id: `INV-${activeBranchId}-${productId}`,
        branchId: activeBranchId,
        productId,
        stockQuantity: delta,
        reorderPoint: 10,
        reorderQuantity: 50,
        createdAt: timestamp,
        updatedAt: timestamp,
        tenantId: tenantId,
        tenant_id: tenantId
      });
    }

    return {
      success: true,
      transactionId: txId,
      productId,
      warehouseId,
      previousStock: beforeWarehouseQty,
      newStock: afterWarehouseQty,
      delta,
      calculatedCost: resolvedUnitCost,
      timestamp
    };
  }

  // =========================================================================
  // HELPER METHODS
  // =========================================================================

  private async executeAtomicTransaction<T>(operation: () => Promise<T>): Promise<T> {
    const tables = [
      'products',
      'inventoryTransactions',
      'warehouseStock',
      'branchInventory',
      'inventory_layers',
      'fifo_consumption_log',
      'medicineBatches',
      'stock_movements',
      'accountingPeriods',
      'settings',
      'systemSettings'
    ];

    return await db.safeTransaction('rw', tables, async () => {
      return await operation();
    });
  }

  private async readWarehouseStock(warehouseId: string, productId: string, tenantId: string): Promise<any | null> {
  if (!tenantId) {
    throw new Error(`[UnifiedEngine] TRUSTED_TENANT_CONTEXT_REQUIRED: tenantId is required for readWarehouseStock.`);
  }

  // 🚨 SECURITY FIX (P0): Filter by tenant INSIDE the query — prevents DoS when
  // another tenant has a record with the same [warehouseId+productId] compound key.
  // This is a READ-ONLY function: it must return null for "no record for THIS tenant",
  // not throw when another tenant's record exists.
  try {
    const byCompound = await db.warehouseStock
      .where('[warehouseId+productId]')
      .equals([warehouseId, productId])
      .filter((ws: any) => ((ws.tenantId || ws.tenant_id) === tenantId))
      .first();
    if (byCompound) return byCompound;
  } catch {
    // Fallback if compound index is not directly accessible
  }

  // 🚨 SECURITY FIX (P0): Apply the same tenant filter in the fallback path.
  const byFilter = await db.warehouseStock
    .filter((ws: any) =>
      (ws.warehouseId === warehouseId || ws.warehouse_id === warehouseId) &&
      (ws.productId === productId || ws.product_id === productId) &&
      ((ws.tenantId || ws.tenant_id) === tenantId)
    )
    .first();

  return byFilter || null;
  }

  private async checkExistingIdempotentTransaction(
    idempotencyKey: string,
    docId: string,
    docType: string,
    productId: string,
    tenantId: string
  ): Promise<any | null> {
    if (!tenantId) {
      throw new Error(`[UnifiedEngine] TRUSTED_TENANT_CONTEXT_REQUIRED: tenantId is required for checkExistingIdempotentTransaction.`);
    }
    if (!idempotencyKey) return null;

    const matchingTxs = await db.inventoryTransactions
      .filter((t: any) => t.idempotencyKey === idempotencyKey)
      .toArray();

    for (const tx of matchingTxs) {
      const txTenant = (tx as any).tenantId || (tx as any).tenant_id;
      if (!txTenant) {
        throw new Error(`[UnifiedEngine] CROSS_TENANT_VIOLATION: Transaction '${tx.id || tx.TransactionID}' lacks tenant binding.`);
      }
      if (txTenant === tenantId) {
        return tx;
      }
      // If txTenant !== tenantId, ignore cross-tenant transaction.
    }

    return null;
  }

  private async mutateMedicineBatch(params: {
    productId: string;
    warehouseId: string;
    delta: number;
    movementType: string;
    batchId?: string;
    batchNumber?: string;
    expiryDate?: string;
    unitCost?: number;
    docId: string;
    tenantId: string;
    branchId?: string;
    timestamp: string;
  }): Promise<void> {
    const { productId, warehouseId, delta, batchId, batchNumber, expiryDate, unitCost, docId, tenantId, branchId, timestamp } = params;

    // 1. Inward movements (PURCHASE, TRANSFER_IN, positive ADJUSTMENT, positive CORRECTION, positive REVERSAL)
    if (delta > 0) {
      if (batchNumber || expiryDate || batchId) {
        const resolvedBatchNum = String(batchNumber || batchId || `B-${Date.now().toString().slice(-6)}`);
        
        // Search if matching batch already exists in this warehouse for the authoritative tenant
        const existingBatch = await db.medicineBatches
          .filter((b: any) => 
            (b.productId === productId || b.product_id === productId) &&
            (b.batchNumber === resolvedBatchNum || b.batchId === resolvedBatchNum) &&
            (!b.warehouseId || b.warehouseId === warehouseId) &&
            ((b.tenantId || b.tenant_id) === tenantId)
          )
          .first();

        if (existingBatch) {
          const newQty = Number(existingBatch.quantity || 0) + delta;
          await db.medicineBatches.update(existingBatch.id, {
            quantity: newQty,
            unitCost: unitCost || existingBatch.unitCost || 0,
            cost: unitCost || existingBatch.cost || 0,
            updated_at: timestamp,
            lastModified: timestamp
          });
        } else {
          const newBatchId = batchId || `BATCH_${docId}_${warehouseId}_${productId}_${resolvedBatchNum}`;
          await db.medicineBatches.put({
            id: newBatchId,
            batchId: resolvedBatchNum,
            batchNumber: resolvedBatchNum,
            productId,
            warehouseId,
            warehouse_id: warehouseId,
            quantity: delta,
            expiryDate: expiryDate || '',
            unitCost: unitCost || 0,
            cost: unitCost || 0,
            sourceInvoiceId: docId,
            reference_id: docId,
            tenantId: tenantId,
            tenant_id: tenantId,
            branchId: branchId,
            created_at: timestamp,
            updated_at: timestamp,
            lastModified: timestamp
          });
        }
      }
    } else if (delta < 0) {
      // 2. Outward movements (SALE, TRANSFER_OUT, negative ADJUSTMENT, negative CORRECTION, DAMAGE, negative REVERSAL)
      const deductQty = Math.abs(delta);

      if (batchId) {
        const batch = await db.medicineBatches.get(batchId).catch(() => null);
        if (!batch) {
          throw new Error(`[UnifiedEngine] BATCH_NOT_FOUND: Specified batchId '${batchId}' does not exist for deduction.`);
        }
        const bTenant = (batch as any).tenantId || (batch as any).tenant_id;
        if (!bTenant || bTenant !== tenantId) {
          throw new Error(`[UnifiedEngine] CROSS_TENANT_VIOLATION: Batch '${batchId}' does not belong to authoritative tenant '${tenantId}' or lacks valid tenant binding.`);
        }
        const currentQty = Number(batch.quantity || 0);
        if (currentQty < deductQty) {
          throw new InsufficientStockError({
            message: `Insufficient quantity in batch '${batch.batchNumber || batchId}'. Available: ${currentQty}, Requested: ${deductQty}.`,
            arabicMessage: `الكمية غير متوفرة في التشغيلة "${batch.batchNumber || batchId}". المتوفر: ${currentQty}، المطلوب: ${deductQty}.`,
            module: 'INVENTORY',
            metadata: { productId, warehouseId, batchId, currentQty, deductQty }
          });
        }
        await db.medicineBatches.update(batch.id, {
          quantity: currentQty - deductQty,
          updated_at: timestamp,
          lastModified: timestamp
        });
      } else if (batchNumber) {
        const batch = await db.medicineBatches
          .filter((b: any) => 
            (b.productId === productId || b.product_id === productId) &&
            (b.batchNumber === batchNumber || b.batchId === batchNumber) &&
            (!b.warehouseId || b.warehouseId === warehouseId) &&
            ((b.tenantId || b.tenant_id) === tenantId)
          )
          .first();
        if (!batch) {
          throw new Error(`[UnifiedEngine] BATCH_NOT_FOUND: Specified batchNumber '${batchNumber}' does not exist in warehouse '${warehouseId}' for tenant '${tenantId}'.`);
        }
        const bTenant = (batch as any).tenantId || (batch as any).tenant_id;
        if (!bTenant || bTenant !== tenantId) {
          throw new Error(`[UnifiedEngine] CROSS_TENANT_VIOLATION: Batch '${batch.id}' does not belong to authoritative tenant '${tenantId}' or lacks valid tenant binding.`);
        }
        const currentQty = Number(batch.quantity || 0);
        if (currentQty < deductQty) {
          throw new InsufficientStockError({
            message: `Insufficient quantity in batch '${batchNumber}'. Available: ${currentQty}, Requested: ${deductQty}.`,
            arabicMessage: `الكمية غير متوفرة في التشغيلة "${batchNumber}". المتوفر: ${currentQty}، المطلوب: ${deductQty}.`,
            module: 'INVENTORY',
            metadata: { productId, warehouseId, batchNumber, currentQty, deductQty }
          });
        }
        await db.medicineBatches.update(batch.id, {
          quantity: currentQty - deductQty,
          updated_at: timestamp,
          lastModified: timestamp
        });
      } else {
        // Deduct from earliest expiring batch (FEFO) in warehouse (or globally for product) within authoritative tenant
        let batches = await db.medicineBatches
          .where('productId')
          .equals(productId)
          .filter((b: any) => 
            ((b.tenantId || b.tenant_id) === tenantId) &&
            Number(b.quantity || 0) > 0 &&
            (!b.warehouseId || b.warehouseId === warehouseId)
          )
          .sortBy('expiryDate');

        if (batches.length === 0) {
          batches = await db.medicineBatches
            .where('productId')
            .equals(productId)
            .filter((b: any) => 
              ((b.tenantId || b.tenant_id) === tenantId) &&
              Number(b.quantity || 0) > 0
            )
            .sortBy('expiryDate');
        }

        if (batches.length === 0) {
          // Check if any batches exist for this product in this tenant
          const anyBatchesCount = await db.medicineBatches
            .where('productId')
            .equals(productId)
            .filter((b: any) => ((b.tenantId || b.tenant_id) === tenantId))
            .count();

          if (anyBatchesCount > 0) {
            throw new InsufficientStockError({
              message: `Insufficient batch stock for product '${productId}' under FEFO. Available in batches: 0, Requested deduction: ${deductQty}.`,
              arabicMessage: `لا توجد كميات متوفرة في تشغيلات الصنف "${productId}" لتنفيذ خصم FEFO. المطلوب: ${deductQty}.`,
              module: 'INVENTORY',
              metadata: { productId, warehouseId, totalBatchQty: 0, deductQty }
            });
          }
          // Non-batched product: allowed to proceed with product-level inventory mutation
          return;
        }

        // Pre-flight check: ensure total available across batches covers the required deduction
        const totalBatchQty = batches.reduce((sum: number, b: any) => sum + Number(b.quantity || 0), 0);
        if (totalBatchQty < deductQty) {
          throw new InsufficientStockError({
            message: `Insufficient batch stock for product '${productId}' under FEFO. Available in batches: ${totalBatchQty}, Requested deduction: ${deductQty}.`,
            arabicMessage: `الكمية المتوفرة في تشغيلات الصنف "${productId}" غير كافية لخصم FEFO. المتوفر بالتشغيلات: ${totalBatchQty}، المطلوب: ${deductQty}.`,
            module: 'INVENTORY',
            metadata: { productId, warehouseId, totalBatchQty, deductQty }
          });
        }

        let remainingToDeduct = deductQty;
        for (const b of batches) {
          if (remainingToDeduct <= 0) break;
          const currentBQty = Number(b.quantity || 0);
          const deductFromThis = Math.min(currentBQty, remainingToDeduct);
          await db.medicineBatches.update(b.id, {
            quantity: currentBQty - deductFromThis,
            updated_at: timestamp,
            lastModified: timestamp
          });
          remainingToDeduct -= deductFromThis;
        }
      }
    }
  }

  private validateCommandBasics(command: any, opName: string): void {
    if (!command) {
      throw new Error(`[UnifiedEngine] Invalid command provided to ${opName}.`);
    }
    const forbiddenTenants = ['TEN-DEV-001', 'tenant_default', 'default', 'default-tenant'];
    if (!command.tenantId || forbiddenTenants.includes(command.tenantId)) {
      throw new Error(`[UnifiedEngine] TRUSTED_TENANT_CONTEXT_REQUIRED: Valid tenantId is required for ${opName}. Got: ${command.tenantId}`);
    }
    const forbiddenBranches = ['BR-MAIN', 'branch_default', 'default'];
    if (!command.branchId || forbiddenBranches.includes(command.branchId)) {
      throw new Error(`[UnifiedEngine] TRUSTED_BRANCH_CONTEXT_REQUIRED: Valid branchId is required for ${opName}. Got: ${command.branchId}`);
    }
    if (!command.userId) {
      throw new Error(`[UnifiedEngine] userId is required for ${opName}.`);
    }
    if (!command.transactionUuid) {
      throw new Error(`[UnifiedEngine] transactionUuid (Idempotency Key) is required for ${opName}.`);
    }
  }
}

export const unifiedInventoryMutationEngine = UnifiedInventoryMutationEngine.getInstance();
