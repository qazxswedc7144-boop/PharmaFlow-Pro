import { db } from '@/core/db';
import { InvoiceItem, InvoiceStatus, Receipt, Payment, TransferStatus, JournalLine } from '@/types';
import { TransactionService } from '@/services/transactions/TransactionService';
import { FaultService } from '@/services/integrity/FaultService';
import { InvoiceRepository } from '@/database/repositories/invoice.repository';
import { AccountingRepository } from '@/database/repositories/AccountingRepository';
import { FinancialTransactionRepository } from '@/database/repositories/FinancialTransactionRepository';
import { SupplierRepository } from '@/database/repositories/SupplierRepository';
import { authService } from '@features/auth/services/authService';
import { useAuthStore } from '@/store/authStore';
import { GlobalGuard } from '@/services/security/GlobalGuard';
import { BackupService } from '@/services/backupService';
import { SubscriptionEntitlementService } from '@/services/saas/subscriptionEntitlementService';
import { UsageMeterService } from '@/services/saas/usageMeterService';
import { generateTransactionUuid } from '@/utils/uuid';
import { AuditService } from '@/services/system/AuditService';
import { ProjectionEventBus } from '@/services/system/ProjectionEventBus';
import { LockService } from '@features/locking/lock.service';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';

import { WorkflowOrchestrator } from '@/core/workflow';
import { purchaseWorkflow } from '@features/purchases/workflows/PurchaseWorkflow';
import { salesWorkflow } from '@features/sales/workflows/SalesWorkflow';
import { inventoryAdjustmentWorkflow } from '@features/inventory/workflows/InventoryAdjustmentWorkflow';
import { inventoryTransferWorkflow } from '@features/inventory/workflows/InventoryTransferWorkflow';
import { voucherWorkflow } from '@features/accounting/workflows/VoucherWorkflow';
import { unifiedInventoryMutationEngine } from '@features/inventory/services/UnifiedInventoryMutationEngine';

export interface WorkflowSalePayload {
  customerId?: string;
  items: InvoiceItem[];
  total: number;
  id?: string;
  date?: string;
  notes?: string;
  attachment?: string;
  transactionUuid?: string;
}

export interface WorkflowPurchasePayload {
  supplierId?: string;
  items: InvoiceItem[];
  total: number;
  id?: string;
  date?: string;
  notes?: string;
  attachment?: string;
  transactionUuid?: string;
}

export interface WorkflowInvoiceOptions {
  isCash?: boolean;
  isReturn?: boolean;
  invoiceStatus?: InvoiceStatus;
  warehouseId?: string;
  currency?: string;
  paymentStatus?: 'Cash' | 'Credit';
  date?: string;
}

export interface WorkflowVoucherParams {
  partnerId: string;
  amount: number;
  notes?: string;
  date?: string;
  paymentMethod?: 'CASH' | 'TRANSFER';
  allocations?: Record<string, number | { amount: number; note?: string }>;
  transactionUuid?: string;
}

export interface WorkflowStockAdjustmentParams {
  productId: string;
  warehouseId: string;
  actualQty: number;
  userId: string;
  notes?: string;
  transactionUuid?: string;
}

export interface WorkflowStockTransferCreateParams {
  sourceBranchId: string;
  targetBranchId: string;
  notes?: string;
  items: Array<{ productId: string; qty: number; batchNumber?: string; expiryDate?: string }>;
  transactionUuid?: string;
}

export interface WorkflowStockTransferStatusParams {
  transferId: string;
  newStatus: TransferStatus;
  updatedBy: string;
  receivedQuantities?: Record<string, number>;
}

export const PURCHASE_WORKFLOW_TABLES = [
  'invoices', 'invoiceItems', 'products', 'inventoryTransactions', 
  'inventory_layers', 'suppliers', 'journalEntries', 'journalLines', 
  'accounts', 'financialTransactions', 'auditLogs', 'idempotencyKeys', 
  'projectionEvents', 'customers', 'vouchers'
];

export const SALES_WORKFLOW_TABLES = [
  'invoices', 'invoiceItems', 'products', 'inventoryTransactions', 
  'inventory_layers', 'fifo_consumption_log', 'customers', 'journalEntries', 
  'journalLines', 'accounts', 'financialTransactions', 'auditLogs', 
  'idempotencyKeys', 'projectionEvents', 'vouchers', 'suppliers'
];

export const ADJUSTMENT_WORKFLOW_TABLES = [
  'inventoryTransactions', 'products', 'journalEntries', 'journalLines', 
  'accounts', 'auditLogs', 'idempotencyKeys', 'projectionEvents'
];

export const VOUCHER_WORKFLOW_TABLES = [
  'vouchers', 'invoices', 'suppliers', 'customers', 'financialTransactions', 
  'journalEntries', 'journalLines', 'accounts', 'auditLogs', 
  'idempotencyKeys', 'projectionEvents'
];

const STOCK_TRANSFER_WORKFLOW_TABLES = [
  'branchTransfers', 'branchTransferItems', 'branchInventory', 
  'products', 'warehouseStock', 'inventoryTransactions', 'inventory_layers', 'medicineBatches',
  'auditLogs', 'idempotencyKeys', 'projectionEvents'
];

const UNPOST_WORKFLOW_TABLES = [
  'invoices', 'invoiceItems', 'products', 'inventoryTransactions', 
  'inventory_layers', 'fifo_consumption_log', 'suppliers', 'customers', 
  'journalEntries', 'journalLines', 'accounts', 'financialTransactions', 
  'auditLogs', 'projectionEvents'
];

/**
 * Unified Business Workflow Orchestrator
 * Top-level central execution engine enforcing Atomic, Idempotent, Rollback-Safe,
 * Event-Driven, and Audit-Logged transaction processing across all ERP workflows.
 */
export class UnifiedBusinessWorkflowOrchestrator {

  /**
   * Check Trial plan usage bounds and assert subscription entitlement
   */
  public static async checkTrialLimit(isEdit = false, operationName = 'عملية تجارية'): Promise<void> {
    await SubscriptionEntitlementService.assertOperationAllowed(operationName, { isEdit });
  }

  /**
   * Manage idempotency lifecycle before entering critical execution section
   */
  public static async acquireIdempotencyKey(key: string): Promise<void> {
    if (!key) return;

    // Retrieve and enforce trusted tenant context (Fail closed)
    const user = authService.getCurrentUser?.() || useAuthStore.getState().user;
    const authState = useAuthStore.getState();
    const tenantId = (user as any)?.tenantId || (user as any)?.tenant_id || authState.tenantId || null;
    const branchId = (user as any)?.branchId || (user as any)?.branch_id || authState.branchId || null;

    if (!tenantId || tenantId === 'default' || tenantId === 'default-tenant') {
      throw new Error("FAIL_CLOSED: لا يمكن حجز مفتاح Idempotency بدون سياق مؤسسة موثوق (Trusted Tenant Context Required).");
    }

    const effectiveBranchId = branchId && branchId !== 'main' ? branchId : 'BRH-DEFAULT';

    const existing = await IdempotencyRegistry.get(key);
    if (existing) {
      if (existing.status === 'COMMITTED') {
        return;
      }
      if (existing.status === 'PROCESSING') {
        throw new Error("⚠️ العملية قيد المعالجة حالياً، يرجى الانتظار... ⏳");
      }
    } else {
      await IdempotencyRegistry.save({
        key,
        status: 'PROCESSING',
        tenantId,
        branchId: effectiveBranchId,
        operationType: 'WORKFLOW',
        entityType: 'INVOICE',
        fingerprint: key,
        createdAt: new Date().toISOString()
      });
    }

    try {
      await TransactionService.ensureIdempotency(key);
    } catch (err) {
      await IdempotencyRegistry.delete(key).catch(() => null);
      throw err;
    }
  }

  /**
   * Finalize idempotency key status to COMPLETED and invalidate usage meter cache
   */
  public static async markIdempotencyCompleted(key: string): Promise<void> {
    if (!key) return;
    TransactionService.registerCompletedUuid(key);
    await IdempotencyRegistry.updateStatus(key, 'COMMITTED').catch(() => null);
    // Invalidate meter cache to update counters in real-time
    UsageMeterService.invalidate();
  }

  /**
   * Release processing idempotency key on error
   */
  public static async releaseIdempotencyKey(key: string): Promise<void> {
    if (!key) return;
    try {
      const rec = await IdempotencyRegistry.get(key);
      if (rec && rec.status === 'PROCESSING') {
        await IdempotencyRegistry.delete(key);
      }
    } catch (e) {
      console.warn('[WorkflowOrchestrator] Failed to release idempotency key:', e);
    }
  }

  // =========================================================================
  // 1. PURCHASE WORKFLOW (Delegated to PurchaseWorkflow)
  // =========================================================================
  public static async processPurchase(
    payload: WorkflowPurchasePayload,
    options?: WorkflowInvoiceOptions
  ): Promise<{ success: boolean; refId: string }> {
    const transactionUuid = payload.transactionUuid || generateTransactionUuid('PURCHASE');
    payload.transactionUuid = transactionUuid;

    const result = await WorkflowOrchestrator.execute(
      purchaseWorkflow,
      {
        supplierId: payload.supplierId,
        items: payload.items,
        total: payload.total,
        id: payload.id,
        date: payload.date || options?.date,
        notes: payload.notes,
        attachment: payload.attachment,
        isCash: options?.isCash,
        isReturn: options?.isReturn,
        invoiceStatus: options?.invoiceStatus,
        currency: options?.currency,
        isEdit: !!payload.id
      },
      { idempotencyKey: transactionUuid }
    );

    if (!result.success) {
      throw new Error(result.error?.message || 'فشلت معالجة فاتورة المشتريات');
    }

    return {
      success: true,
      refId: result.data!.refId
    };
  }

  // =========================================================================
  // 2. SALES WORKFLOW (Delegated to SalesWorkflow)
  // =========================================================================
  public static async processSale(
    payload: WorkflowSalePayload,
    options?: WorkflowInvoiceOptions
  ): Promise<{ success: boolean; refId: string }> {
    const transactionUuid = payload.transactionUuid || generateTransactionUuid('SALE');
    payload.transactionUuid = transactionUuid;

    const result = await WorkflowOrchestrator.execute(
      salesWorkflow,
      {
        customerId: payload.customerId,
        items: payload.items,
        total: payload.total,
        id: payload.id,
        date: payload.date || options?.date,
        notes: payload.notes,
        attachment: payload.attachment,
        isCash: options?.isCash,
        isReturn: options?.isReturn,
        invoiceStatus: options?.invoiceStatus,
        currency: options?.currency,
        isEdit: !!payload.id
      },
      { idempotencyKey: transactionUuid }
    );

    if (!result.success) {
      throw new Error(result.error?.message || 'فشلت معالجة فاتورة المبيعات');
    }

    return {
      success: true,
      refId: result.data!.refId
    };
  }

  // =========================================================================
  // 3. INVENTORY ADJUSTMENT WORKFLOW (Delegated to InventoryAdjustmentWorkflow)
  // =========================================================================
  public static async processInventoryAdjustment(
    params: WorkflowStockAdjustmentParams
  ): Promise<{ success: boolean; refId: string }> {
    const transactionUuid = params.transactionUuid || generateTransactionUuid('ADJUSTMENT' as any);

    const result = await WorkflowOrchestrator.execute(
      inventoryAdjustmentWorkflow,
      {
        productId: params.productId,
        warehouseId: params.warehouseId,
        actualQty: params.actualQty,
        userId: params.userId,
        notes: params.notes
      },
      { idempotencyKey: transactionUuid }
    );

    if (!result.success) {
      throw new Error(result.error?.message || 'فشلت تسوية المخزون');
    }

    return {
      success: true,
      refId: result.data!.adjustmentId
    };
  }

  // =========================================================================
  // 4. SUPPLIER PAYMENT WORKFLOW (Delegated to VoucherWorkflow)
  // =========================================================================
  public static async processSupplierPayment(
    params: WorkflowVoucherParams
  ): Promise<{ success: boolean; payment: Payment }> {
    const user = authService.getCurrentUser?.() || useAuthStore.getState().user;
    const authState = useAuthStore.getState();
    const tenantId = (user as any)?.tenantId || (user as any)?.tenant_id || authState.tenantId || null;
    const branchId = (user as any)?.branchId || (user as any)?.branch_id || authState.branchId || null;

    if (!tenantId || tenantId === 'default' || tenantId === 'default-tenant') {
      throw new Error("FAIL_CLOSED: عملية سداد المورد تتطلب سياق مؤسسة موثوق (Trusted Tenant Context Required).");
    }

    const transactionUuid = params.idempotencyKey || params.transactionUuid || generateTransactionUuid('PAYMENT');

    const result = await WorkflowOrchestrator.execute(
      voucherWorkflow,
      {
        type: 'PAYMENT',
        partnerId: params.partnerId,
        amount: params.amount,
        notes: params.notes,
        date: params.date,
        paymentMethod: params.paymentMethod,
        allocations: params.allocations
      },
      {
        tenantId,
        branchId: branchId || 'BRH-DEFAULT',
        idempotencyKey: transactionUuid
      }
    );

    if (!result.success) {
      throw new Error(result.error?.message || 'فشل معالجة سند الصرف');
    }

    return {
      success: true,
      payment: result.data!.document as Payment
    };
  }

  // =========================================================================
  // 5. CUSTOMER RECEIPT WORKFLOW (Delegated to VoucherWorkflow)
  // =========================================================================
  public static async processCustomerReceipt(
    params: WorkflowVoucherParams
  ): Promise<{ success: boolean; receipt: Receipt }> {
    const transactionUuid = params.transactionUuid || generateTransactionUuid('RECEIPT');

    const result = await WorkflowOrchestrator.execute(
      voucherWorkflow,
      {
        type: 'RECEIPT',
        partnerId: params.partnerId,
        amount: params.amount,
        notes: params.notes,
        date: params.date,
        paymentMethod: params.paymentMethod,
        allocations: params.allocations
      },
      { idempotencyKey: transactionUuid }
    );

    if (!result.success) {
      throw new Error(result.error?.message || 'فشل معالجة سند القبض');
    }

    return {
      success: true,
      receipt: result.data!.document as Receipt
    };
  }

  // =========================================================================
  // 6. STOCK TRANSFER WORKFLOW (Delegated to InventoryTransferWorkflow)
  // =========================================================================
  public static async processStockTransferCreate(
    params: WorkflowStockTransferCreateParams
  ): Promise<{ success: boolean; transferId: string }> {
    const transactionUuid = params.transactionUuid || generateTransactionUuid('INVENTORY');

    const result = await WorkflowOrchestrator.execute(
      inventoryTransferWorkflow,
      {
        sourceBranchId: params.sourceBranchId,
        targetBranchId: params.targetBranchId,
        notes: params.notes,
        items: params.items
      },
      { idempotencyKey: transactionUuid }
    );

    if (!result.success) {
      throw new Error(result.error?.message || 'فشل إنشاء طلب التحويل');
    }

    return {
      success: true,
      transferId: result.data!.transferId
    };
  }

  public static async processStockTransferStatusUpdate(
    params: WorkflowStockTransferStatusParams
  ): Promise<{ success: boolean }> {
    const { transferId, newStatus, updatedBy, receivedQuantities } = params;
    const rawTransfer = await db.db.branchTransfers.get(transferId);
    if (!rawTransfer) throw new Error("لم يتم العثور على طلب النقل");

    if (rawTransfer.status === newStatus) return { success: true };

    const branchId = rawTransfer.sourceBranchId || "BRH-MAIN-001";
    const lockKey = `transfer:${transferId}`;

    return await LockService.withLock(
      lockKey,
      { branchId, lockType: "BRANCH_TRANSFER", ownerId: updatedBy, ttl: 15000 },
      async () => {
        return await TransactionService.runSafe(transferId, async () => {
          const rawItems = await db.db.branchTransferItems.where("transferId").equals(transferId).toArray();
          const previousStatus = rawTransfer.status;
          const now = new Date().toISOString();

          if (newStatus === "APPROVED") {
            rawTransfer.approvedBy = updatedBy;
          } else if (newStatus === "IN_TRANSIT") {
            rawTransfer.shippedBy = updatedBy;
            rawTransfer.shippedAt = now;

            for (const item of rawItems) {
              const srcWarehouse = (rawTransfer as any).sourceWarehouseId || 
                (rawTransfer.sourceBranchId.startsWith('WH-') ? rawTransfer.sourceBranchId : `WH-${rawTransfer.sourceBranchId}`);

              await unifiedInventoryMutationEngine.executeMutation({
                productId: item.productId,
                warehouseId: srcWarehouse,
                delta: -Math.abs(item.qty),
                docType: 'TRANSFER',
                docId: transferId,
                movementType: 'TRANSFER_OUT',
                batchNumber: item.batchNumber,
                expiryDate: item.expiryDate,
                userId: updatedBy,
                tenantId: (rawTransfer as any).tenantId || 'TEN-DEV-001',
                branchId: rawTransfer.sourceBranchId,
                transactionUuid: `${transferId}-${item.productId}-OUT`,
                notes: `شحن تحويل مخزني من الفرع ${rawTransfer.sourceBranchId} إلى الفرع ${rawTransfer.targetBranchId}`
              });

              // branchInventory is now canonically handled by the mutation engine
            }
          } else if (newStatus === "RECEIVED") {
            rawTransfer.receivedBy = updatedBy;
            rawTransfer.receivedAt = now;

            for (const item of rawItems) {
              const recQty = receivedQuantities && receivedQuantities[item.id] !== undefined
                ? receivedQuantities[item.id]
                : item.qty;

              await db.db.branchTransferItems.update(item.id, { receivedQty: recQty });

              const targetWarehouse = (rawTransfer as any).targetWarehouseId || 
                (rawTransfer.targetBranchId.startsWith('WH-') ? rawTransfer.targetBranchId : `WH-${rawTransfer.targetBranchId}`);

              await unifiedInventoryMutationEngine.executeMutation({
                productId: item.productId,
                warehouseId: targetWarehouse,
                delta: Math.abs(recQty),
                docType: 'TRANSFER',
                docId: transferId,
                movementType: 'TRANSFER_IN',
                batchNumber: item.batchNumber,
                expiryDate: item.expiryDate,
                userId: updatedBy,
                tenantId: (rawTransfer as any).tenantId || 'TEN-DEV-001',
                branchId: rawTransfer.targetBranchId,
                transactionUuid: `${transferId}-${item.productId}-IN`,
                notes: `استلام تحويل مخزني بالفرع ${rawTransfer.targetBranchId} من الفرع ${rawTransfer.sourceBranchId}`
              });

              // branchInventory is now canonically handled by the mutation engine
            }
          } else if (newStatus === "CANCELLED") {
            if (previousStatus === "IN_TRANSIT") {
              for (const item of rawItems) {
                const srcWarehouse = (rawTransfer as any).sourceWarehouseId || 
                  (rawTransfer.sourceBranchId.startsWith('WH-') ? rawTransfer.sourceBranchId : `WH-${rawTransfer.sourceBranchId}`);

                await unifiedInventoryMutationEngine.executeMutation({
                  productId: item.productId,
                  warehouseId: srcWarehouse,
                  delta: Math.abs(item.qty),
                  docType: 'TRANSFER',
                  docId: transferId,
                  movementType: 'TRANSFER_IN',
                  batchNumber: item.batchNumber,
                  expiryDate: item.expiryDate,
                  userId: updatedBy,
                  tenantId: (rawTransfer as any).tenantId || 'TEN-DEV-001',
                  branchId: rawTransfer.sourceBranchId,
                  transactionUuid: `${transferId}-${item.productId}-CANCEL`,
                  notes: `إلغاء تحويل مخزني واستعادة الكمية للفرع ${rawTransfer.sourceBranchId}`
                });

                // branchInventory is now canonically handled by the mutation engine
              }
            }
          }

          rawTransfer.status = newStatus;
          rawTransfer.updatedAt = now;
          await db.db.branchTransfers.put(rawTransfer);

          await ProjectionEventBus.publish('STOCK_TRANSFER_STATUS_CHANGED', transferId, { newStatus, previousStatus });
          await AuditService.log({
            action: 'EDIT',
            module: 'INVENTORY',
            transactionUuid: transferId,
            after: { transferId, newStatus, updatedBy },
            recordId: transferId
          });

          return { success: true };
        }, transferId, STOCK_TRANSFER_WORKFLOW_TABLES);
      }
    );
  }

  // =========================================================================
  // UNPOST & DELETE UTILITIES
  // =========================================================================
  public static async unpostInvoice(invoiceId: string, type: 'SALE' | 'PURCHASE'): Promise<{ success: boolean }> {
    const user = authService.getCurrentUser();
    if (user?.Role !== 'Admin') {
      throw new Error("Only administrators can unpost invoices.");
    }

    await BackupService.createBackup(`Auto Backup before Unpost #${invoiceId}`, 'PRE_UNPOST', true);

    return await TransactionService.runSafe(invoiceId, async () => {
      try {
        await GlobalGuard.checkSystemState('إلغاء ترحيل');

        const invoice = type === 'SALE' 
          ? await InvoiceRepository.getSaleById(invoiceId)
          : await InvoiceRepository.getPurchaseById(invoiceId);

        if (!invoice) throw new Error("Invoice not found.");

        const status = (invoice as any).InvoiceStatus || (invoice as any).invoiceStatus;
        if (status !== 'POSTED') {
          throw new Error("Only POSTED invoices can be unposted.");
        }

        await AccountingRepository.deleteEntriesBySource(invoiceId);

        // 🚨 MIGRATE: Replace legacy destructive deletions with canonical compensating movements
        await unifiedInventoryMutationEngine.executeReversal({
          originalDocumentId: invoiceId,
          originalDocumentType: type === 'SALE' ? 'SALE' : 'PURCHASE',
          reason: `إلغاء ترحيل الفاتورة رقم ${invoiceId}`,
          userId: user?.id || 'admin',
          tenantId: user?.tenantId || 'TEN-DEV-001',
          transactionUuid: `UNPOST-${invoiceId}-${Date.now()}`
        });

        const total = (invoice as any).finalTotal || (invoice as any).totalAmount;
        const partnerId = type === 'SALE' ? (invoice as any).customerId : (invoice as any).partnerId;

        const ftId = db.generateId('FT');
        await FinancialTransactionRepository.record({
          id: ftId,
          Transaction_Type: 'Refund',
          Reference_ID: invoiceId,
          Reference_Table: type === 'SALE' ? 'Sales_Invoices' : 'Purchase_Invoices',
          Entity_Name: partnerId || 'عميل نقدي',
          Amount: total,
          Direction: type === 'SALE' ? 'Debit' : 'Credit',
          Transaction_Date: new Date().toISOString(),
          Notes: `[UNPOST REVERSAL] Invoice #${invoiceId}`
        });

        if (partnerId && partnerId !== 'عميل نقدي' && partnerId !== 'مورد نقدي') {
          if (type === 'SALE') {
            await db.updateCustomerBalance(partnerId, -total);
          } else {
            await db.updateSupplierBalance(partnerId, -total);
          }
          await SupplierRepository.postToLedger({
            id: db.generateId('PL'),
            partnerId,
            date: new Date().toISOString(),
            description: `عكس قيد فاتورة #${invoiceId}`,
            debit: type === 'SALE' ? 0 : total,
            credit: type === 'SALE' ? total : 0,
            referenceId: invoiceId
          });
        }

        if (type === 'SALE') {
          await db.db.sales.update(invoiceId, { InvoiceStatus: 'DRAFT_EDIT', lastModified: new Date().toISOString() });
        } else {
          await db.db.purchases.update(invoiceId, { invoiceStatus: 'DRAFT_EDIT', lastModified: new Date().toISOString() });
        }

        await AuditService.log({
          action: 'EDIT',
          module: type,
          transactionUuid: invoiceId,
          recordId: invoiceId,
          after: { invoiceId, type, unpostedBy: user?.User_Email }
        });

        await ProjectionEventBus.publish('INVOICE_UNPOSTED', invoiceId, { type });
        return { success: true };
      } catch (err: any) {
        FaultService.log({
          type: 'UNPOST_FATAL',
          module: 'UNIFIED_WORKFLOW_ORCHESTRATOR',
          message: `Failed to unpost invoice ${invoiceId}: ${err.message || String(err)}`,
          payload: { invoiceId, type },
          stack: err.stack
        });
        throw err;
      }
    }, invoiceId, UNPOST_WORKFLOW_TABLES);
  }

  public static async deleteInvoice(invoiceId: string, type: 'SALE' | 'PURCHASE'): Promise<{ success: boolean }> {
    const invoice = type === 'SALE' 
      ? await InvoiceRepository.getSaleById(invoiceId)
      : await InvoiceRepository.getPurchaseById(invoiceId);

    if (!invoice) throw new Error("Invoice not found.");

    const invoiceDate = (invoice as any).date || new Date().toISOString();
    await GlobalGuard.checkSystemState('حذف فاتورة', invoiceDate);

    const hasDeps = await InvoiceRepository.checkHasDependencies(invoiceId, type);
    if (hasDeps) {
      throw new Error("لا يمكن حذف الفاتورة لوجود مستندات مرتبطة بها. يرجى حذف الارتباطات أولاً.");
    }

    await BackupService.createBackup(`Auto Backup before Delete #${invoiceId}`, 'PRE_DELETE', true);

    return await TransactionService.runSafe(invoiceId, async () => {
      try {
        const status = (invoice as any).InvoiceStatus || (invoice as any).invoiceStatus;
        if (status === 'POSTED') {
          await this.unpostInvoice(invoiceId, type);
        }

        if (type === 'SALE') {
          await db.db.sales.update(invoiceId, { InvoiceStatus: 'VOID', isDeleted: true, lastModified: new Date().toISOString() });
        } else {
          await db.db.purchases.update(invoiceId, { invoiceStatus: 'VOID', isDeleted: true, lastModified: new Date().toISOString() });
        }

        await AuditService.log({
          action: 'DELETE',
          module: type,
          transactionUuid: invoiceId,
          recordId: invoiceId,
          after: { invoiceId, type, deletedBy: authService.getCurrentUser()?.User_Email }
        });

        await ProjectionEventBus.publish('INVOICE_DELETED', invoiceId, { type });
        return { success: true };
      } catch (err: any) {
        FaultService.log({
          type: 'DELETE_FATAL',
          module: 'UNIFIED_WORKFLOW_ORCHESTRATOR',
          message: `Failed to delete invoice ${invoiceId}: ${err.message || String(err)}`,
          payload: { invoiceId, type },
          stack: err.stack
        });
        throw err;
      }
    }, invoiceId, UNPOST_WORKFLOW_TABLES);
  }

  // Helper methods
  public static createJournalLine(entryId: string, accountId: string, debit: number, credit: number): JournalLine {
    const id = db.generateId('JL');
    return {
      id,
      lineId: id,
      entryId,
      accountId,
      accountName: '',
      debit,
      credit,
      type: debit > 0 ? 'DEBIT' : 'CREDIT',
      amount: debit > 0 ? debit : credit
    };
  }
}
