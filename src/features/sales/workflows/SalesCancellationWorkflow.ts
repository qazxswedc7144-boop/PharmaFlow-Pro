import { BusinessWorkflow, SyncContract, WorkflowContext } from '@/core/workflow';
import { db } from '@/core/db';
import { UnifiedInventoryMutationEngine } from '@features/inventory/services/UnifiedInventoryMutationEngine';
import { DistributedSyncEngine } from '@/features/sync/sync.engine';
import { AuditService } from '@/services/system/AuditService';
import { ProjectionEventBus } from '@/services/system/ProjectionEventBus';
import { FinancialTransactionRepository } from '@/database/repositories/FinancialTransactionRepository';
import { AccountingEngine } from '@features/accounting/services/AccountingEngine';
import type { VerifiedPeriodSnapshot } from '@/services/transactions/PeriodLockEngine';

export interface SalesCancellationInput {
  invoiceId: string;
  reason?: string;
}

export interface SalesCancellationResult {
  success: boolean;
  invoiceId: string;
}

async function loadCancellationItems(invoice: any, invoiceId: string, tx: any): Promise<any[]> {
  if (Array.isArray(invoice.items) && invoice.items.length > 0) {
    return invoice.items;
  }

  const invoiceItemsTable = tx.table('invoiceItems');
  const documentKeys = [
    invoiceId,
    invoice.invoice_number,
    invoice.invoiceNumber
  ].filter((value, index, values): value is string =>
    typeof value === 'string' && value.length > 0 && values.indexOf(value) === index
  );
  const foreignKeys = ['parent_id', 'parentId', 'invoice_id', 'invoiceId'];

  for (const documentKey of documentKeys) {
    for (const foreignKey of foreignKeys) {
      const rows = await invoiceItemsTable.where(foreignKey).equals(documentKey).toArray();
      if (rows.length > 0) return rows;
    }
  }

  return [];
}

async function reversePostedFinancialEffects(
  invoice: any,
  invoiceType: 'SALE' | 'PURCHASE',
  invoiceId: string,
  ctx: WorkflowContext,
  tx: any
): Promise<void> {
  const journalEntriesTable = tx.table('journalEntries');
  const originalJournalEntries = await journalEntriesTable
    .where('sourceId')
    .equals(invoiceId)
    .and((entry: any) =>
      entry.tenantId === ctx.tenantId &&
      entry.branchId === ctx.branchId
    )
    .toArray();
  const activeJournalEntries = originalJournalEntries.filter((entry: any) =>
    entry.sourceType !== 'AUTO_REVERSAL' && !entry.reversedBy
  );

  if (activeJournalEntries.length === 0) {
    throw new Error(
      'ACCOUNTING_REVERSAL_SOURCE_MISSING: A posted invoice cannot be cancelled without an active tenant/branch-scoped journal entry.'
    );
  }

  const rawTotal = (invoice as any).finalTotal ??
    (invoice as any).totalAmount ??
    (invoice as any).total;
  const total = Number(rawTotal);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(
      'CANCELLATION_FINANCIAL_AMOUNT_INVALID: A posted invoice with a missing, zero, or invalid total requires financial review before cancellation.'
    );
  }

  const referenceTable = invoiceType === 'SALE' ? 'Sales_Invoices' : 'Purchase_Invoices';
  const financialReversal = await FinancialTransactionRepository.reverseTransactions(
    invoiceId,
    tx,
    ctx.idempotencyKey,
    ctx.tenantId,
    ctx.branchId,
    { requireActiveTransaction: true, referenceTable }
  );

  if (!financialReversal || financialReversal.reversedCount === 0 ||
      financialReversal.reversalIds.length !== financialReversal.reversedCount) {
    throw new Error(
      'FINANCIAL_TRANSACTION_REVERSAL_NO_OP: Posted invoice cancellation requires verified financial reversal records.'
    );
  }

  const financialTransactionsTable = tx.table('financialTransactions');
  const financialReversals = await Promise.all(
    financialReversal.reversalIds.map((reversalId: string) => financialTransactionsTable.get(reversalId))
  );
  if (financialReversals.some((reversal: any) => !reversal || reversal.isReversal !== true)) {
    throw new Error(
      'FINANCIAL_TRANSACTION_REVERSAL_VERIFY_FAILED: One or more financial reversal records could not be read back.'
    );
  }

  const expectedEntityType = invoiceType === 'SALE' ? 'Customer' : 'Supplier';
  const entityNames = new Set(
    financialReversals.map((reversal: any) => String(reversal.Entity_Name || '').trim())
  );
  if (financialReversals.some((reversal: any) => reversal.Entity_Type !== expectedEntityType) ||
      entityNames.size !== 1 || entityNames.has('')) {
    throw new Error(
      'FINANCIAL_TRANSACTION_PARTNER_MISMATCH: Financial reversal partner identity is inconsistent with the invoice type.'
    );
  }

  const reversalTimestamp = ctx.startedAt || new Date().toISOString();
  await AccountingEngine.postInvoice(
    {
      ...invoice,
      type: invoiceType,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      isReversal: true,
      transactionUuid: ctx.idempotencyKey,
      date: reversalTimestamp
    } as any,
    undefined,
    tx
  );

  const isReturn = (invoice as any).isReturn === true;
  const balanceDelta = isReturn ? total : -total;
  const financialPartnerId = [...entityNames][0];

  if (invoiceType === 'SALE' && financialPartnerId !== 'عميل نقدي') {
    const customer = await tx.table('customers').get(financialPartnerId);
    if (!customer) {
      throw new Error(`CANCELLATION_CUSTOMER_NOT_FOUND: Customer ${financialPartnerId} is missing; balance reversal is unsafe.`);
    }
    const customerTenant = customer.tenantId || customer.tenant_id;
    if (customerTenant && customerTenant !== ctx.tenantId) {
      throw new Error('CROSS_TENANT_CUSTOMER_FORBIDDEN: Cancellation cannot change another tenant customer balance.');
    }
    await db.updateCustomerBalance(financialPartnerId, balanceDelta, tx);
  }

  if (invoiceType === 'PURCHASE' && financialPartnerId !== 'مورد نقدي') {
    const paymentStatus = String(
      (invoice as any).paymentStatus ??
      (invoice as any).payment_status ??
      ''
    ).trim().toUpperCase();
    if (paymentStatus !== 'CASH' && (invoice as any).isCash !== true) {
      const supplier = await tx.table('suppliers').get(financialPartnerId);
      if (!supplier) {
        throw new Error(`CANCELLATION_SUPPLIER_NOT_FOUND: Supplier ${financialPartnerId} is missing; balance reversal is unsafe.`);
      }
      const supplierTenant = supplier.tenantId || supplier.tenant_id;
      if (supplierTenant && supplierTenant !== ctx.tenantId) {
        throw new Error('CROSS_TENANT_SUPPLIER_FORBIDDEN: Cancellation cannot change another tenant supplier balance.');
      }
      await db.updateSupplierBalance(financialPartnerId, balanceDelta, tx);
    }
  }
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
    'customers', 'suppliers', 'financialTransactions',
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

    // A posted invoice has financial effects as well as stock effects. Reverse
    // its journal, financial transaction and partner balance inside this same
    // Dexie transaction before changing the document status.
    if (currentStatus === 'POSTED' || currentStatus === 'LOCKED') {
      await reversePostedFinancialEffects(invoice, invoiceType as 'SALE' | 'PURCHASE', input.invoiceId, ctx, tx);
    }

    // Reverse the original canonical ledger movements with compensating entries.
    // This is idempotent per original movement and preserves FIFO/batch projections.
    const isReturnDocument = (invoice as any).isReturn === true;
    const originalDocumentType = isReturnDocument ? `${invoiceType}_RETURN` : invoiceType;
    const reversalResults = await UnifiedInventoryMutationEngine.getInstance().executeReversal({
      originalDocumentId: input.invoiceId,
      originalDocumentType,
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

    // A POSTED/LOCKED document with stock-tracked lines must prove that every
    // expected quantity was reversed. An empty or partial result must never be
    // treated as a successful cancellation merely because the engine returned.
    if (currentStatus === 'POSTED' || currentStatus === 'LOCKED') {
      const invoiceItems = await loadCancellationItems(invoice, input.invoiceId, tx);
      const expectedQuantities = new Map<string, number>();

      for (const item of invoiceItems) {
        const productId = item.productId || item.product_id;
        if (!productId) continue;

        const isService = item.isService === true;
        const trackStock = item.trackStock === false;
        const itemType = item.type || item.itemType;
        if (isService || trackStock || itemType === 'SERVICE') continue;

        const quantity = Number(item.quantity ?? item.qty ?? 0);
        if (!Number.isFinite(quantity) || quantity <= 0) continue;

        expectedQuantities.set(
          String(productId),
          (expectedQuantities.get(String(productId)) || 0) + quantity
        );
      }

      const actualReversedQuantities = new Map<string, number>();
      for (const result of reversalResults) {
        const productId = String(result.productId || '');
        const delta = Number(result.delta);
        if (!productId || !Number.isFinite(delta)) {
          throw new Error('INVENTORY_REVERSAL_INCOMPLETE: Reversal result is missing a valid product or quantity.');
        }
        actualReversedQuantities.set(
          productId,
          (actualReversedQuantities.get(productId) || 0) + delta
        );
      }

      const expectedSign = (invoiceType === 'SALE' ? 1 : -1) * (isReturnDocument ? -1 : 1);
      for (const [productId, expectedQuantity] of expectedQuantities) {
        const actualQuantity = actualReversedQuantities.get(productId) || 0;
        const expectedDelta = expectedSign * expectedQuantity;
        if (Math.abs(actualQuantity - expectedDelta) > 0.000001) {
          throw new Error(
            `INVENTORY_REVERSAL_INCOMPLETE: Expected reversal ${expectedDelta} for product ${productId}, received ${actualQuantity}.`
          );
        }
      }
    }

    const cancelledAt = new Date().toISOString();
    const updatedInvoice = {
      ...invoice,
      documentStatus: 'CANCELLED',
      document_status: 'CANCELLED',
      InvoiceStatus: 'CANCELLED',
      invoiceStatus: 'CANCELLED',
      status: 'CANCELLED',
      updatedAt: cancelledAt,
      lastModified: cancelledAt
    };
    await invoicesTable.put(updatedInvoice as any);

    // Keep legacy read models in sync: InvoiceRepository archive queries the
    // sales/purchases tables, not only the unified invoices table.
    if (invoiceType === 'SALE') {
      const legacySale = await salesTable.get(input.invoiceId);
      if (legacySale) {
        await salesTable.update(input.invoiceId, {
          InvoiceStatus: 'CANCELLED',
          invoiceStatus: 'CANCELLED',
          documentStatus: 'CANCELLED',
          document_status: 'CANCELLED',
          status: 'CANCELLED',
          lastModified: cancelledAt
        });
      }
    } else {
      const legacyPurchase = await purchasesTable.get(input.invoiceId);
      if (legacyPurchase) {
        await purchasesTable.update(input.invoiceId, {
          invoiceStatus: 'CANCELLED',
          InvoiceStatus: 'CANCELLED',
          documentStatus: 'CANCELLED',
          document_status: 'CANCELLED',
          status: 'CANCELLED',
          lastModified: cancelledAt
        });
      }
    }

    await (AuditService.log as any)({
      action: 'DELETE',
      module: 'SALES',
      transactionUuid: ctx.workflowId,
      recordId: input.invoiceId,
      details: `تم إلغاء الفاتورة [${input.invoiceId}] - السبب: ${input.reason || 'إلغاء من قبل المستخدم'}`
    }, tx);

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
