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
  // Dexie schema indexes only parent_id on invoiceItems; query only that
  // indexed key instead of probing undeclared legacy indexes at runtime.
  for (const documentKey of documentKeys) {
    const rows = await invoiceItemsTable.where('parent_id').equals(documentKey).toArray();
    if (rows.length > 0) return rows;
  }

  return [];
}

async function reconcileCancellationProcessing(
  input: SalesCancellationInput,
  ctx: WorkflowContext
): Promise<
  | { status: 'COMMITTED'; result: SalesCancellationResult }
  | { status: 'NOT_COMMITTED' }
  | { status: 'UNKNOWN'; reason?: string }
> {
  const invoiceId = input.invoiceId;
  const [unifiedInvoice, legacySale, legacyPurchase] = await Promise.all([
    db.invoices.get(invoiceId),
    db.sales.get(invoiceId),
    db.purchases.get(invoiceId)
  ]);
  const invoice = unifiedInvoice || legacySale || legacyPurchase;
  const invoiceType = String(
    invoice?.type || invoice?.documentType || (legacyPurchase && !legacySale ? 'PURCHASE' : 'SALE')
  ).toUpperCase();

  const [queueRows, outboxRows, movementRows, journalRows, financialRows, voucherLinks] = await Promise.all([
    db.syncQueue.where('idempotencyKey').equals(ctx.idempotencyKey).toArray(),
    db.outbox.where('idempotencyKey').equals(ctx.idempotencyKey).toArray(),
    db.inventoryTransactions.where('source_doc_id').equals(invoiceId).toArray(),
    db.journalEntries.where('sourceId').equals(invoiceId).toArray(),
    db.financialTransactions.where('Reference_ID').equals(invoiceId).toArray(),
    db.voucherInvoiceLinks.where('invoiceId').equals(invoiceId).toArray()
  ]);

  const tenantMovements = movementRows.filter((row: any) =>
    (row.tenantId || row.tenant_id) === ctx.tenantId &&
    (row.branchId || row.branch_id) === ctx.branchId
  );
  const tenantJournalRows = journalRows.filter((row: any) =>
    row.tenantId === ctx.tenantId && row.branchId === ctx.branchId
  );
  const expectedReferenceTable = invoiceType === 'PURCHASE'
    ? 'Purchase_Invoices'
    : 'Sales_Invoices';
  const tenantFinancialRows = financialRows.filter((row: any) =>
    (row.tenantId || row.tenant_id) === ctx.tenantId &&
    (row.branchId || row.branch_id) === ctx.branchId &&
    row.Reference_Table === expectedReferenceTable
  );

  const reversalMovements = tenantMovements.filter((row: any) =>
    String(row.TransactionType || row.transactionType || '').toUpperCase() === 'REVERSAL' &&
    String(row.idempotencyKey || '').includes(ctx.idempotencyKey)
  );
  const reversalJournalRows = tenantJournalRows.filter((row: any) =>
    row.sourceType === 'AUTO_REVERSAL' && String(row.id || '').includes(ctx.idempotencyKey)
  );
  const reversalFinancialRows = tenantFinancialRows.filter((row: any) =>
    row.isReversal === true && String(row.id || '').includes(ctx.idempotencyKey)
  );
  const scopedQueueRows = queueRows.filter((row: any) =>
    (row.tenantId || row.tenant_id) === ctx.tenantId &&
    (row.branchId || row.branch_id) === ctx.branchId
  );
  const scopedOutboxRows = outboxRows.filter((row: any) =>
    (row.tenantId || row.tenant_id) === ctx.tenantId &&
    (row.branchId || row.branch_id) === ctx.branchId
  );

  const hasAnyCommittedEffect =
    scopedQueueRows.length > 0 ||
    scopedOutboxRows.length > 0 ||
    reversalMovements.length > 0 ||
    reversalJournalRows.length > 0 ||
    reversalFinancialRows.length > 0;

  if (!invoice) {
    return hasAnyCommittedEffect
      ? { status: 'UNKNOWN', reason: 'Durable side effects exist but the invoice record is missing.' }
      : { status: 'NOT_COMMITTED' };
  }

  const currentStatus = String(
    invoice.documentStatus || invoice.status || invoice.InvoiceStatus || ''
  ).toUpperCase();

  if (currentStatus !== 'CANCELLED') {
    return hasAnyCommittedEffect
      ? { status: 'UNKNOWN', reason: 'Some cancellation effects exist while the invoice is not marked CANCELLED.' }
      : { status: 'NOT_COMMITTED' };
  }

  const metadata = (invoice as any).cancellationMetadata;
  if (!metadata || metadata.idempotencyKey !== ctx.idempotencyKey) {
    return { status: 'UNKNOWN', reason: 'Cancelled invoice does not carry the matching cancellation idempotency metadata.' };
  }

  const activeVoucherLinks = voucherLinks.filter((link: any) =>
    link.isDeleted !== true &&
    link.is_deleted !== true &&
    !['CANCELLED', 'VOID', 'REVERSED'].includes(
      String(link.status || link.Status || '').toUpperCase()
    )
  );
  if (activeVoucherLinks.length > 0) {
    return { status: 'UNKNOWN', reason: 'Active voucher allocations still reference the cancelled invoice.' };
  }

  if (
    scopedQueueRows.length !== 1 ||
    scopedOutboxRows.length !== 1 ||
    scopedQueueRows[0].operationType !== 'INVOICE_CANCEL' ||
    scopedOutboxRows[0].operation !== 'INVOICE_CANCEL' ||
    scopedQueueRows[0].entityType !== 'INVOICE' ||
    scopedOutboxRows[0].entityType !== 'INVOICE' ||
    scopedQueueRows[0].mutationId !== scopedOutboxRows[0].mutationId ||
    scopedQueueRows[0].payload?.id !== invoiceId ||
    scopedOutboxRows[0].payload?.id !== invoiceId
  ) {
    return { status: 'UNKNOWN', reason: 'Cancellation Queue/Outbox pair is missing, duplicated, or inconsistent.' };
  }

  const legacyRecord = invoiceType === 'PURCHASE'
    ? await db.purchases.get(invoiceId)
    : await db.sales.get(invoiceId);
  if (legacyRecord) {
    const legacyStatus = String(
      legacyRecord.documentStatus || legacyRecord.status ||
      legacyRecord.InvoiceStatus || legacyRecord.invoiceStatus || ''
    ).toUpperCase();
    if (legacyStatus !== 'CANCELLED') {
      return { status: 'UNKNOWN', reason: 'Legacy sales/purchases read model is not marked CANCELLED.' };
    }
  }

  const originalMovements = tenantMovements.filter((row: any) =>
    String(row.TransactionType || row.transactionType || '').toUpperCase() !== 'REVERSAL'
  );
  for (const original of originalMovements) {
    const reversal = reversalMovements.find((row: any) =>
      row.reversedMovementId === original.id &&
      row.productId === original.productId
    );
    if (!reversal) {
      return { status: 'UNKNOWN', reason: `Original stock movement ${original.id} has no matching reversal.` };
    }
  }

  const items = Array.isArray((invoice as any).items)
    ? (invoice as any).items
    : await db.invoiceItems.where('parent_id').equals(invoiceId).toArray();
  const hasStockTrackedItems = items.some((item: any) => {
    const quantity = Number(item.quantity ?? item.qty ?? 0);
    return Boolean(item.productId || item.product_id) &&
      item.trackStock !== false &&
      item.isService !== true &&
      (item.type || item.itemType) !== 'SERVICE' &&
      Number.isFinite(quantity) &&
      quantity > 0;
  });
  if (
    (metadata.previousStatus === 'POSTED' || metadata.previousStatus === 'LOCKED') &&
    hasStockTrackedItems &&
    originalMovements.length === 0
  ) {
    return { status: 'UNKNOWN', reason: 'Posted stock-tracked invoice has no original movements to reconcile.' };
  }

  if (metadata.previousStatus === 'POSTED' || metadata.previousStatus === 'LOCKED') {
    const originalJournalEntries = tenantJournalRows.filter((row: any) => row.sourceType !== 'AUTO_REVERSAL');
    if (originalJournalEntries.length === 0) {
      return { status: 'UNKNOWN', reason: 'Posted invoice has no original journal entries.' };
    }
    for (const original of originalJournalEntries) {
      const reversalId = original.reversedBy;
      const reversal = reversalId ? await db.journalEntries.get(reversalId) : null;
      if (
        !reversal ||
        reversal.sourceType !== 'AUTO_REVERSAL' ||
        reversal.reversalOf !== original.id ||
        reversal.sourceId !== invoiceId ||
        !String(reversal.id || '').includes(ctx.idempotencyKey) ||
        reversal.tenantId !== ctx.tenantId ||
        reversal.branchId !== ctx.branchId
      ) {
        return { status: 'UNKNOWN', reason: `Journal entry ${original.id} is not fully reversed.` };
      }
    }

    const originalFinancialRows = tenantFinancialRows.filter((row: any) => row.isReversal !== true);
    if (originalFinancialRows.length === 0) {
      return { status: 'UNKNOWN', reason: 'Posted invoice has no original financial transaction rows.' };
    }
    for (const original of originalFinancialRows) {
      const reversalId = original.reversedBy;
      const reversal = reversalId ? await db.financialTransactions.get(reversalId) : null;
      if (
        !original.isDeleted ||
        !reversal ||
        reversal.isReversal !== true ||
        reversal.Reference_ID !== invoiceId ||
        reversal.Reference_Table !== expectedReferenceTable ||
        !String(reversal.id || '').includes(ctx.idempotencyKey) ||
        (reversal.tenantId || reversal.tenant_id) !== ctx.tenantId ||
        (reversal.branchId || reversal.branch_id) !== ctx.branchId
      ) {
        return { status: 'UNKNOWN', reason: `Financial transaction ${original.id} is not fully reversed by this cancellation.` };
      }
    }
  } else {
    const activeJournalEntries = tenantJournalRows.filter((row: any) =>
      row.sourceType !== 'AUTO_REVERSAL' && !row.reversedBy
    );
    const activeFinancialRows = tenantFinancialRows.filter((row: any) =>
      row.isReversal !== true && row.isDeleted !== true && !row.reversedBy
    );
    if (activeJournalEntries.length > 0 || activeFinancialRows.length > 0) {
      return {
        status: 'UNKNOWN',
        reason: 'A non-posted invoice still has active journal or financial transaction records.'
      };
    }
  }

  return {
    status: 'COMMITTED',
    result: { success: true, invoiceId }
  };
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
    'customers', 'suppliers', 'financialTransactions', 'voucherInvoiceLinks',
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

  public async reconcileProcessing(
    input: SalesCancellationInput,
    ctx: WorkflowContext
  ) {
    return reconcileCancellationProcessing(input, ctx);
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
    const [unifiedInvoice, legacySaleRecord, legacyPurchaseRecord] = await Promise.all([
      invoicesTable.get(input.invoiceId),
      salesTable.get(input.invoiceId),
      purchasesTable.get(input.invoiceId)
    ]);
    const invoice = unifiedInvoice || legacySaleRecord || legacyPurchaseRecord;
    if (!invoice) throw new Error('Invoice not found');

    const inferredInvoiceType = legacyPurchaseRecord && !legacySaleRecord ? 'PURCHASE' : 'SALE';
    const invoiceType = String(
      (invoice as any).type || (invoice as any).documentType || inferredInvoiceType
    ).toUpperCase();
    if (invoiceType !== 'SALE' && invoiceType !== 'PURCHASE') {
      throw new Error(`UNSUPPORTED_CANCELLATION_DOCUMENT_TYPE: ${invoiceType}`);
    }
    const currentStatus = String((invoice as any).documentStatus || (invoice as any).status || (invoice as any).InvoiceStatus || '').toUpperCase();
    if (currentStatus === 'CANCELLED') {
      throw new Error('INVOICE_ALREADY_CANCELLED: الفاتورة ملغاة بالفعل مسبقاً');
    }

    // A posted invoice with active voucher allocations cannot be cancelled
    // while those vouchers still point to it. Reverse/cancel the allocations
    // first; otherwise the voucher ledger would remain attached to a cancelled
    // document while its invoice-side balance is reversed.
    const voucherLinks = await tx.table('voucherInvoiceLinks')
      .where('invoiceId')
      .equals(input.invoiceId)
      .toArray();
    const activeVoucherLinks = voucherLinks.filter((link: any) =>
      link.isDeleted !== true &&
      link.is_deleted !== true &&
      !['CANCELLED', 'VOID', 'REVERSED'].includes(
        String(link.status || link.Status || '').toUpperCase()
      )
    );
    if (activeVoucherLinks.length > 0) {
      throw new Error(
        `INVOICE_HAS_ACTIVE_VOUCHER_ALLOCATIONS: Cancel or unallocate ${activeVoucherLinks.length} linked voucher allocation(s) before cancelling this invoice.`
      );
    }

    if (currentStatus !== 'POSTED' && currentStatus !== 'LOCKED') {
      const referenceTable = invoiceType === 'SALE' ? 'Sales_Invoices' : 'Purchase_Invoices';
      const [existingJournalEntries, existingFinancialRows] = await Promise.all([
        tx.table('journalEntries').where('sourceId').equals(input.invoiceId)
          .and((entry: any) => entry.tenantId === ctx.tenantId && entry.branchId === ctx.branchId)
          .toArray(),
        tx.table('financialTransactions').where('Reference_ID').equals(input.invoiceId)
          .and((entry: any) =>
            (entry.tenantId || entry.tenant_id) === ctx.tenantId &&
            (entry.branchId || entry.branch_id) === ctx.branchId &&
            entry.Reference_Table === referenceTable
          )
          .toArray()
      ]);
      const activeJournalEntries = existingJournalEntries.filter((entry: any) =>
        entry.sourceType !== 'AUTO_REVERSAL' && !entry.reversedBy
      );
      const activeFinancialRows = existingFinancialRows.filter((entry: any) =>
        entry.isReversal !== true && entry.isDeleted !== true && !entry.reversedBy
      );
      if (activeJournalEntries.length > 0 || activeFinancialRows.length > 0) {
        throw new Error(
          'UNPOSTED_INVOICE_HAS_FINANCIAL_EFFECTS: Financial ledger entries exist for a non-posted invoice; reconcile its posting state before cancellation.'
        );
      }
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
      lastModified: cancelledAt,
      cancellationMetadata: {
        previousStatus: currentStatus,
        idempotencyKey: ctx.idempotencyKey,
        originalDocumentType,
        cancelledAt
      }
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
