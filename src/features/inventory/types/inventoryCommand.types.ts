// src/features/inventory/types/inventoryCommand.types.ts
/**
 * PharmaFlow PRO ERP — Unified Inventory Engine Command & Result Contracts
 * Phase 5 — Step 1: Foundation
 */

import type { VerifiedPeriodSnapshot } from '@/services/transactions/PeriodLockEngine';

export interface BaseInventoryCommand {
  /** Tenant ID for strict multi-tenant isolation */
  tenantId: string;
  /** Executing User ID or email for audit trail */
  userId: string;
  /** Branch identifier (defaults to BR-MAIN if omitted) */
  branchId?: string;
  /** Unique Transaction UUID / Idempotency Key to prevent double-execution */
  transactionUuid: string;
  /** Operational or audit notes */
  notes?: string;
  /** Optional transaction timestamp (ISO-8601) */
  timestamp?: string;
  /** Immutable pre-transaction authoritative period lock verification snapshot */
  periodVerification?: VerifiedPeriodSnapshot;
}

export interface InventoryItemMutationInput {
  productId: string;
  /** Positive quantity representing the amount to move */
  quantity: number;
  /** Cost per unit (mandatory for purchases, optional for sales) */
  unitCost?: number;
  /** Selling price per unit (optional) */
  unitPrice?: number;
  /** Pharmacy Batch ID or Batch Number */
  batchId?: string;
  batchNumber?: string;
  /** Pharmacy Expiration Date (ISO string YYYY-MM-DD) */
  expiryDate?: string;
}

export interface IssueSaleStockCommand extends BaseInventoryCommand {
  invoiceId: string;
  warehouseId: string;
  items: InventoryItemMutationInput[];
}

export interface ReceivePurchaseStockCommand extends BaseInventoryCommand {
  invoiceId: string;
  warehouseId: string;
  supplierId?: string;
  items: InventoryItemMutationInput[];
}

export interface ProcessSalesReturnStockCommand extends BaseInventoryCommand {
  returnInvoiceId: string;
  originalSaleId?: string;
  warehouseId: string;
  items: InventoryItemMutationInput[];
}

export interface ProcessPurchaseReturnStockCommand extends BaseInventoryCommand {
  returnInvoiceId: string;
  originalPurchaseId?: string;
  warehouseId: string;
  items: InventoryItemMutationInput[];
}

export interface ExecuteInventoryAdjustmentCommand extends BaseInventoryCommand {
  adjustmentId: string;
  warehouseId: string;
  productId: string;
  /** The counted actual quantity found physically in the warehouse */
  actualQuantity: number;
  reason: string;
  batchId?: string;
  unitCost?: number;
}

export interface TransferWarehouseStockCommand extends BaseInventoryCommand {
  transferId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  /** Optional target branch for inter-branch transfers */
  targetBranchId?: string;
  productId: string;
  quantity: number;
  batchId?: string;
  batchNumber?: string;
  expiryDate?: string;
  unitCost?: number;
}

export interface GenericMutationCommand extends BaseInventoryCommand {
  productId: string;
  warehouseId: string;
  delta: number;
  docType: string;
  docId: string;
  movementType?: string;
  unitCost?: number;
  unitPrice?: number;
  batchId?: string;
  batchNumber?: string;
  expiryDate?: string;
}

export interface ReverseDocumentStockCommand extends BaseInventoryCommand {
  originalDocumentId: string;
  originalDocumentType: 'SALE' | 'PURCHASE' | 'SALE_RETURN' | 'PURCHASE_RETURN' | 'ADJUSTMENT' | 'TRANSFER' | string;
  reason: string;
}

export interface ExecuteApprovedCorrectionCommand extends BaseInventoryCommand {
  caseId: string;
  productId: string;
  warehouseId: string;
  proposedQty: number;
  reason: string;
  approverId: string;
}

export interface InventoryMutationResult {
  success: boolean;
  transactionId: string;
  productId: string;
  warehouseId: string;
  previousStock: number;
  newStock: number;
  delta: number;
  calculatedCost?: number;
  timestamp: string;
}
