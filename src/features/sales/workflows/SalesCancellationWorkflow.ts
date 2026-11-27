import { BusinessWorkflow, SyncContract, WorkflowContext } from '@/core/workflow';
import { db } from '@/core/db';
import { UnifiedInventoryMutationEngine } from '@features/inventory/services/UnifiedInventoryMutationEngine';
import { DistributedSyncEngine } from '@/features/sync/sync.engine';
import { AuditService } from '@/services/system/AuditService';
import { ProjectionEventBus } from '@/services/system/ProjectionEventBus';
import type { VerifiedPeriodSnapshot } from '@/services/transactions/PeriodLockEngine';

export interface SalesCancellationInput {
  invoiceId: string;
  reason?: string;
}

export interface SalesCancellationResult {
  success: boolean;
  invoiceId: string;
}

export class SalesCancellationWorkflow implements BusinessWorkflow<SalesCancellationInput, SalesCancellationResult> {
  public id = 'sales.invoice.cancel';
  public name = 'إلغاء الفاتورة بالكامل';
  public operationType = 'INVOICE_CANCEL';
  /** Queue and Outbox are persisted inside the cancellation transaction. */
  public syncContract: SyncContract = {
    entityType: 'INVOICE',
    operation: 'CANCEL',
    buildPayload: (result) => result as Record<string, unknown>
  };
  public requiredPermissions = ['sales.cancel', 'invoices.manage'];
  public syncHandledInDomainTransaction = true;
  public tables = [
    'invoices', 'invoiceItems', 'sales', 'purchases',
    'products', 'inventoryTransactions', 'warehouseStock', 'branchInventory',
    'inventory_layers', 'fifo_consumption_log', 'medicineBatches', 'stock_movements',
    'branches', 'accountingPeriods', 'settings', 'systemSettings',
    'journalEntries', 'journalLines', 'accounts', 'auditLogs',
    'idempotencyKeys', 'projectionEvents', 'syncQueue', 'outbox'
  ];

  public async validateInput(input: SalesCancellationInput): Promise<void> {
    if (!input.invoiceId) {
      throw new Error('معرف الفاتورة مطلوب للإلغاء');
    }
  }

  public async validateBusinessRules(input: SalesCancellationInput): Promise<void> {
    const invoice = (await db.invoices.get(input.invoiceId)) || (await db.sales.get(input.invoiceId)) || (await db.purchases.get(input.invoiceId));
    if (!invoice) {
      throw new Error(`الفاتورة رقم [${input.invoiceId}] غير موجودة بالنظام`);
    }
    const docStatus = (invoice as any).documentStatus || (invoice as any).status || (invoice as any).InvoiceStatus;
    if (docStatus === 'CANCELLED') {
      throw new Error('الفاتورة ملغاة بالفعل مسبقاً');
    }
  }

  public getPeriodCheckDates(_input: SalesCancellationInput, ctx: WorkflowContext): string[] {
    return [ctx.startedAt];
  }

  public async executeDomainSteps(
    input: SalesCancellationInput,
    ctx: WorkflowContext,
    tx?: any
  ): Promise<SalesCancellationResult> {
    if (!tx || typeof tx.table !== 'function') {
      throw new Error('TRANSACTION_REQUIRED: Sales cancellation must run inside WorkflowExecutionPipeline transaction.');
    }

    const invoicesTable = tx.table('invoices');
    const salesTable = tx.table('sales');
    const purchasesTable = tx.table('purchases');
    const invoice = (await invoicesTable.get(input.invoiceId)) ||
      (await salesTable.get(input.invoiceId)) ||
      (await purchasesTable.get(input.invoiceId));
    if (!invoice) throw new Error('Invoice not found');

    const invoiceType = String((invoice as any).type || 'SALE').toUpperCase();
    if (invoiceType !== 'SALE' && invoiceType !== 'PURCHASE') {
      throw new Error(`UNSUPPORTED_CANCELLATION_DOCUMENT_TYPE: ${invoiceType}`);
    }
    const currentStatus = String((invoice as any).documentStatus || (invoice as any).status || (invoice as any).InvoiceStatus || '').toUpperCase();
    if (currentStatus === 'CANCELLED') {
      throw new Error('INVOICE_ALREADY_CANCELLED: الفاتورة ملغاة بالفعل مسبقاً');
    }

    const verifiedPeriods = (ctx.metadata?.verifiedAccountingPeriods || {}) as Record<string, VerifiedPeriodSnapshot | undefined>;
    const periodVerification = verifiedPeriods[ctx.startedAt];
    if (!periodVerification) {
      throw new Error('ACCOUNTING_PERIOD_VERIFICATION_REQUIRED: Cancellation requires a verified period snapshot.');
    }

    // Reverse the original canonical ledger movements with compensating entries.
    // This is idempotent per original movement and preserves FIFO/batch projections.
    const reversalResults = await UnifiedInventoryMutationEngine.getInstance().executeReversal({
      originalDocumentId: input.invoiceId,
      originalDocumentType: invoiceType,
      reason: input.reason || 'إلغاء من قبل المستخدم',
      transactionUuid: ctx.idempotencyKey,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      timestamp: ctx.startedAt,
      periodVerification
    }, tx);

    if (reversalResults.some((result) => !result.success)) {
      throw new Error('INVENTORY_REVERSAL_FAILED: One or more original stock movements could not be reversed.');
    }

    const updatedInvoice = {
      ...invoice,
      documentStatus: 'CANCELLED',
      status: 'CANCELLED',
      updatedAt: new Date().toISOString()
    };
    await invoicesTable.put(updatedInvoice as any);

    await (AuditService.log as any)({
      action: 'DELETE',
      module: 'SALES',
      transactionUuid: ctx.workflowId,
      recordId: input.invoiceId,
      details: `تم إلغاء الفاتورة [${input.invoiceId}] - السبب: ${input.reason || 'إلغاء من قبل المستخدم'}`
    });

    await ProjectionEventBus.publish('INVOICE_CANCELLED', input.invoiceId, {
      type: invoiceType,
      total: (invoice as any).total || 0,
      correlationId: ctx.correlationId
    });

    const syncPayload = {
      id: input.invoiceId,
      invoiceId: input.invoiceId,
      type: invoiceType,
      documentStatus: 'CANCELLED',
      status: 'CANCELLED',
      reason: input.reason || 'إلغاء من قبل المستخدم',
      workflowId: ctx.workflowId,
      correlationId: ctx.correlationId
    };
    const enqueueResult = await DistributedSyncEngine.getInstance().enqueueWithinTransaction(
      this.operationType,
      syncPayload,
      'INVOICE',
      ctx.idempotencyKey,
      { tenantId: ctx.tenantId, branchId: ctx.branchId }
    );
    if (!enqueueResult?.mutationId || enqueueResult.idempotencyKey !== ctx.idempotencyKey) {
      throw new Error('SYNC_ENQUEUE_FAILED: Cancellation Queue/Outbox acknowledgement is incomplete.');
    }

    return { success: true, invoiceId: input.invoiceId };
  }
}

export const salesCancellationWorkflow = new SalesCancellationWorkflow();
