import Decimal from 'decimal.js-light';
import { BusinessWorkflow, SyncContract, WorkflowContext } from '@/core/workflow';
import { db } from '@/core/db';
import { AuditService } from '@/services/system/AuditService';
import { ProjectionEventBus } from '@/services/system/ProjectionEventBus';
import { AccountingRepository } from '@/database/repositories/AccountingRepository';
import { FinancialTransactionRepository } from '@/database/repositories/FinancialTransactionRepository';
import { DistributedSyncEngine } from '@features/sync/sync.engine';

const MONETARY_TOLERANCE = '0.001';

function extractFinitePositiveAmount(ft: any): number | null {
  if (!ft || typeof ft !== 'object') return null;
  const raw = ft.Amount !== undefined
    ? ft.Amount
    : (ft.amount !== undefined ? ft.amount : ft.Paid_Amount);
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return raw;
}

function extractFinitePositivePaidAmount(ft: any): number | null {
  if (!ft || typeof ft !== 'object') return null;
  const raw = ft.Paid_Amount;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return raw;
}

function amountsMatch(a: number, b: number): boolean {
  return new Decimal(a).minus(b).abs().lessThanOrEqualTo(MONETARY_TOLERANCE);
}

export interface VoucherCancellationInput {
  id: string;
  type: 'RECEIPT' | 'PAYMENT';
  partnerId: string;
  amount: number;
  reason?: string;
}

export interface VoucherCancellationResult {
  success: boolean;
  id: string;
  type: 'RECEIPT' | 'PAYMENT';
  partnerId: string;
  amount: number;
  reason?: string;
}

export class VoucherCancellationWorkflow implements BusinessWorkflow<VoucherCancellationInput, VoucherCancellationResult> {
  public id = 'accounting.voucher.cancel';
  public name = 'إلغاء وحذف سند قبض / صرف';
  public operationType = 'VOUCHER_CANCEL';
  public syncContract: SyncContract = {
    entityType: 'VOUCHER',
    operation: 'CANCEL',
    buildPayload: (result, ctx) => {
      const cancellation = result as VoucherCancellationResult;
      return {
        id: cancellation.id,
        type: cancellation.type,
        partnerId: cancellation.partnerId,
        amount: cancellation.amount,
        reason: cancellation.reason || null,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId
      };
    }
  };
  public syncHandledInDomainTransaction = true;
  public requiredPermissions = ['vouchers.delete', 'vouchers.manage'];
  public tables = [
    'vouchers', 'receipts', 'payments', 'suppliers', 'customers',
    'journalEntries', 'journalLines', 'accounts', 'financialTransactions',
    'auditLogs', 'idempotencyKeys', 'projectionEvents', 'voucherInvoiceLinks',
    'invoices', 'syncQueue', 'outbox'
  ];

  public async validateInput(input: VoucherCancellationInput): Promise<void> {
    if (!input || typeof input !== 'object') {
      throw new Error('INVALID_VOUCHER_INPUT: بيانات إلغاء السند غير صالحة');
    }
    if (typeof input.id !== 'string' || input.id.trim().length === 0) {
      throw new Error('معرف السند مطلوب للإلغاء');
    }
    if (input.type !== 'RECEIPT' && input.type !== 'PAYMENT') {
      throw new Error('VOUCHER_TYPE_INVALID: نوع السند يجب أن يكون RECEIPT أو PAYMENT');
    }
    if (typeof input.partnerId !== 'string' || input.partnerId.trim().length === 0) {
      throw new Error('معرف الشريك مطلوب للإلغاء');
    }
    if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0) {
      throw new Error('INVALID_VOUCHER_AMOUNT: مبلغ السند يجب أن يكون أكبر من الصفر');
    }
  }

  public async validateBusinessRules(input: VoucherCancellationInput): Promise<void> {
    const voucherId = input.id.trim();
    const [voucher, receipt, payment] = await Promise.all([
      db.vouchers.get(voucherId),
      db.receipts.get(voucherId),
      db.payments.get(voucherId)
    ]);

    if (!voucher && !receipt && !payment) {
      throw new Error(`السند رقم [${voucherId}] غير موجود أو تم إلغاؤه سابقاً`);
    }
  }

  public async executeDomainSteps(
    input: VoucherCancellationInput,
    ctx: WorkflowContext,
    tx?: any
  ): Promise<VoucherCancellationResult> {
    if (!tx || typeof tx.table !== 'function') {
      throw new Error('VOUCHER_CANCELLATION_REJECTED: ACTIVE_TRANSACTION_REQUIRED');
    }

    const voucherId = input.id.trim();
    const inputPartnerId = input.partnerId.trim();

    const receiptsTbl = tx.table('receipts');
    const paymentsTbl = tx.table('payments');
    const vouchersTbl = tx.table('vouchers');
    const linksTbl = tx.table('voucherInvoiceLinks');
    const invoicesTbl = tx.table('invoices');
    const jeTbl = tx.table('journalEntries');
    const ftTbl = tx.table('financialTransactions');
    const customersTbl = tx.table('customers');
    const suppliersTbl = tx.table('suppliers');

    // =========================================================================
    // PHASE 1: STRICT READ-ONLY VALIDATION (NO IRREVERSIBLE MUTATIONS YET)
    // =========================================================================

    // 1. Double cancellation prevention & authoritative record inspection inside active transaction
    const voucher = await vouchersTbl.get(voucherId);
    const receipt = await receiptsTbl.get(voucherId);
    const payment = await paymentsTbl.get(voucherId);

    if (!voucher && !receipt && !payment) {
      throw new Error(`السند رقم [${voucherId}] غير موجود أو تم إلغاؤه مسبقاً (Double Cancellation Prevented)`);
    }

    if (receipt && payment) {
      throw new Error(`VOUCHER_TYPE_CONFLICT: Voucher [${voucherId}] exists in both receipts and payments tables.`);
    }
    if (input.type === 'RECEIPT' && payment) {
      throw new Error(`VOUCHER_TYPE_MISMATCH: Voucher [${voucherId}] is stored as PAYMENT and cannot be cancelled as RECEIPT.`);
    }
    if (input.type === 'PAYMENT' && receipt) {
      throw new Error(`VOUCHER_TYPE_MISMATCH: Voucher [${voucherId}] is stored as RECEIPT and cannot be cancelled as PAYMENT.`);
    }

    const persistedRecords: Array<{ source: 'vouchers' | 'receipts' | 'payments'; record: any }> = [];
    if (voucher) persistedRecords.push({ source: 'vouchers', record: voucher });
    if (receipt) persistedRecords.push({ source: 'receipts', record: receipt });
    if (payment) persistedRecords.push({ source: 'payments', record: payment });

    // 2. Validate mandatory persisted type, authoritative amount, and partner across every persisted record
    const persistedTypes: Array<'RECEIPT' | 'PAYMENT'> = [];
    const persistedAmounts: number[] = [];
    const persistedPartners: string[] = [];
    for (const { source, record } of persistedRecords) {
      const rawType = record.type ?? record.voucherType;
      if (typeof rawType !== 'string' || rawType.trim().length === 0) {
        throw new Error(
          `VOUCHER_TYPE_MISSING: Persisted ${source} record [${voucherId}] is missing required voucher type.`
        );
      }
      const normalizedType = rawType.trim().toUpperCase();
      if (normalizedType !== 'RECEIPT' && normalizedType !== 'PAYMENT') {
        throw new Error(
          `VOUCHER_TYPE_INVALID: Persisted ${source} record [${voucherId}] has invalid voucher type (${normalizedType}).`
        );
      }
      if (source === 'receipts' && normalizedType !== 'RECEIPT') {
        throw new Error(
          `VOUCHER_TYPE_CONFLICT: Record [${voucherId}] in receipts table has conflicting persisted type (${normalizedType}).`
        );
      }
      if (source === 'payments' && normalizedType !== 'PAYMENT') {
        throw new Error(
          `VOUCHER_TYPE_CONFLICT: Record [${voucherId}] in payments table has conflicting persisted type (${normalizedType}).`
        );
      }
      persistedTypes.push(normalizedType);

      const rawAmount = record.amount;
      if (typeof rawAmount !== 'number' || !Number.isFinite(rawAmount) || rawAmount <= 0) {
        throw new Error(
          `VOUCHER_AMOUNT_MISSING_OR_INVALID: Persisted ${source} record [${voucherId}] has missing or invalid amount (${String(rawAmount)}).`
        );
      }
      persistedAmounts.push(rawAmount);

      const rawPartner =
        normalizedType === 'RECEIPT'
          ? (record.partnerId ?? record.customer_id ?? record.customerId ?? record.partner_id)
          : (record.partnerId ?? record.supplier_id ?? record.supplierId ?? record.partner_id);
      const persistedPartnerId = typeof rawPartner === 'string' ? rawPartner.trim() : '';
      if (!persistedPartnerId) {
        throw new Error(
          `VOUCHER_PARTNER_MISSING: Persisted ${source} record [${voucherId}] is missing partner identifier.`
        );
      }
      if (persistedPartnerId !== inputPartnerId) {
        throw new Error(
          `VOUCHER_PARTNER_MISMATCH: Persisted ${source} partner (${persistedPartnerId}) does not match requested partner (${inputPartnerId}).`
        );
      }
      persistedPartners.push(persistedPartnerId);
    }

    const authoritativeType = persistedTypes[0];
    if (authoritativeType === undefined) {
      throw new Error(
        `VOUCHER_TYPE_MISSING: Persisted voucher [${voucherId}] has no authoritative type.`
      );
    }
    for (let i = 1; i < persistedTypes.length; i++) {
      if (persistedTypes[i] !== authoritativeType) {
        throw new Error(
          `VOUCHER_TYPE_CONFLICT: Persisted records for voucher [${voucherId}] have conflicting types (${authoritativeType} vs ${String(persistedTypes[i])}).`
        );
      }
    }
    if (authoritativeType !== input.type) {
      throw new Error(
        `VOUCHER_TYPE_MISMATCH: Persisted voucher type (${authoritativeType}) does not match requested type (${input.type}).`
      );
    }

    const authoritativePartnerId = persistedPartners[0];
    if (authoritativePartnerId === undefined) {
      throw new Error(
        `VOUCHER_PARTNER_MISSING: Persisted voucher [${voucherId}] has no authoritative partner identifier.`
      );
    }
    for (let i = 1; i < persistedPartners.length; i++) {
      if (persistedPartners[i] !== authoritativePartnerId) {
        throw new Error(
          `VOUCHER_PARTNER_MISMATCH: Persisted records for voucher [${voucherId}] have conflicting partners (${authoritativePartnerId} vs ${String(persistedPartners[i])}).`
        );
      }
    }

    const authoritativeAmount = persistedAmounts[0];
    if (authoritativeAmount === undefined) {
      throw new Error(
        `VOUCHER_AMOUNT_MISSING_OR_INVALID: Persisted voucher [${voucherId}] has no authoritative amount.`
      );
    }
    for (let i = 1; i < persistedAmounts.length; i++) {
      const candidateAmount = persistedAmounts[i];
      if (candidateAmount === undefined || !amountsMatch(candidateAmount, authoritativeAmount)) {
        throw new Error(
          `VOUCHER_AMOUNT_INCONSISTENT: Persisted records for voucher [${voucherId}] have conflicting amounts (${authoritativeAmount} vs ${String(candidateAmount)}).`
        );
      }
    }

    if (Math.abs(authoritativeAmount - input.amount) > 0.01) {
      throw new Error(
        `VOUCHER_AMOUNT_MISMATCH: Cancellation amount (${input.amount}) does not match saved record amount (${authoritativeAmount}).`
      );
    }

    // 3. Validate partner existence & balance (preserve cash customer / cash supplier behavior)
    let partnerNextBalance: number | null = null;
    if (authoritativeType === 'RECEIPT') {
      if (authoritativePartnerId !== 'عميل نقدي') {
        const customer = await customersTbl.get(authoritativePartnerId);
        if (!customer) {
          throw new Error(`CUSTOMER_NOT_FOUND: Customer ${authoritativePartnerId} for receipt cancellation does not exist.`);
        }
        const currentBalance = customer.balance ?? 0;
        if (typeof currentBalance !== 'number' || !Number.isFinite(currentBalance)) {
          throw new Error(`INVALID_PARTNER_BALANCE: Customer ${authoritativePartnerId} has a non-finite balance.`);
        }
        partnerNextBalance = Math.round((currentBalance + authoritativeAmount) * 100) / 100;
      }
    } else {
      if (authoritativePartnerId !== 'مورد نقدي') {
        const supplier = await suppliersTbl.get(authoritativePartnerId);
        if (!supplier) {
          throw new Error(`SUPPLIER_NOT_FOUND: Supplier ${authoritativePartnerId} for payment cancellation does not exist.`);
        }
        const currentBalance = supplier.balance ?? 0;
        if (typeof currentBalance !== 'number' || !Number.isFinite(currentBalance)) {
          throw new Error(`INVALID_PARTNER_BALANCE: Supplier ${authoritativePartnerId} has a non-finite balance.`);
        }
        partnerNextBalance = Math.round((currentBalance + authoritativeAmount) * 100) / 100;
      }
    }

    // 4. Validate invoice allocations and target invoices completely before mutating anything
    const links = await linksTbl.where('voucherId').equals(voucherId).toArray();
    const allocationByInvoice = new Map<string, number>();
    let totalAllocated = 0;

    for (const link of links) {
      const rawPaidAmount = link.Paid_Amount ?? link.paid_amount;
      if (typeof rawPaidAmount !== 'number' || !Number.isFinite(rawPaidAmount) || rawPaidAmount <= 0) {
        throw new Error(
          `INVALID_ALLOCATION_AMOUNT: Allocation link ${link.id} for voucher ${voucherId} has invalid paid amount (${String(rawPaidAmount)}).`
        );
      }
      totalAllocated = Math.round((totalAllocated + rawPaidAmount) * 100) / 100;
      const prevForInvoice = allocationByInvoice.get(link.invoiceId) ?? 0;
      allocationByInvoice.set(link.invoiceId, Math.round((prevForInvoice + rawPaidAmount) * 100) / 100);
    }

    // Per VoucherWorkflow creation rules, total allocations must never exceed voucher amount (tolerance 0.001)
    if (totalAllocated > authoritativeAmount + 0.001) {
      throw new Error(
        `ALLOCATION_TOTAL_EXCEEDS_VOUCHER: Total linked allocations (${totalAllocated}) exceed voucher amount (${authoritativeAmount}) for voucher [${voucherId}].`
      );
    }

    const invoiceRestorations: Array<{
      invoiceId: string;
      newPaid: number;
      newRemaining: number;
      paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID';
    }> = [];

    for (const [invoiceId, allocatedForInvoice] of allocationByInvoice.entries()) {
      const inv = await invoicesTbl.get(invoiceId);
      if (!inv) {
        throw new Error(
          `INVOICE_NOT_FOUND: Invoice ${invoiceId} linked to voucher ${voucherId} could not be found for cancellation.`
        );
      }

      const rawCurrentPaid = inv.paidAmount;
      if (typeof rawCurrentPaid !== 'number' || !Number.isFinite(rawCurrentPaid) || rawCurrentPaid < 0) {
        throw new Error(
          `INVALID_INVOICE_PAID_AMOUNT: Invoice [${invoiceId}] has missing, negative, or non-finite paidAmount (${String(rawCurrentPaid)}).`
        );
      }

      const rawInvoiceTotal = inv.totalAmount !== undefined ? inv.totalAmount : inv.finalTotal;
      if (typeof rawInvoiceTotal !== 'number' || !Number.isFinite(rawInvoiceTotal) || rawInvoiceTotal <= 0) {
        throw new Error(
          `INVALID_INVOICE_TOTAL: Invoice [${invoiceId}] has missing, non-positive, or non-finite total (${String(rawInvoiceTotal)}).`
        );
      }

      if (rawCurrentPaid > rawInvoiceTotal + 0.001) {
        throw new Error(
          `INVALID_INVOICE_BALANCE: Invoice [${invoiceId}] recorded paidAmount (${rawCurrentPaid}) exceeds invoice total (${rawInvoiceTotal}).`
        );
      }

      if (allocatedForInvoice > rawCurrentPaid + 0.001) {
        throw new Error(
          `ALLOCATION_EXCEEDS_PAID_AMOUNT: Allocation (${allocatedForInvoice}) exceeds invoice [${invoiceId}] recorded paidAmount (${rawCurrentPaid}).`
        );
      }

      const computedPaid = Math.round((rawCurrentPaid - allocatedForInvoice) * 100) / 100;
      const newPaid = computedPaid <= 0.001 ? 0 : computedPaid;
      const newRemaining = Math.max(0, Math.round((rawInvoiceTotal - newPaid) * 100) / 100);
      const paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' =
        newPaid <= 0.001 ? 'UNPAID' : (newPaid < rawInvoiceTotal - 0.001 ? 'PARTIAL' : 'PAID');

      invoiceRestorations.push({
        invoiceId,
        newPaid,
        newRemaining,
        paymentStatus
      });
    }

    // 5. Validate mandatory single JournalEntry for the voucher
    const entries = await jeTbl.where('sourceId').equals(voucherId).toArray();
    if (entries.length === 0) {
      throw new Error(
        `VOUCHER_JOURNAL_ENTRY_MISSING: No journal entry found for voucher [${voucherId}].`
      );
    }
    if (entries.length > 1) {
      throw new Error(
        `DUPLICATE_VOUCHER_JOURNAL_ENTRIES: Voucher [${voucherId}] has ${entries.length} journal entries; expected exactly 1.`
      );
    }
    const journalEntry = entries[0];
    if (!journalEntry) {
      throw new Error(
        `VOUCHER_JOURNAL_ENTRY_MISSING: No journal entry found for voucher [${voucherId}].`
      );
    }

    // 6. Validate mandatory single active FinancialTransaction with strict tenant/branch & Reference_Table scope
    const expectedTenantId = typeof ctx.tenantId === 'string' ? ctx.tenantId.trim() : '';
    const expectedBranchId = typeof ctx.branchId === 'string' ? ctx.branchId.trim() : '';
    if (!expectedTenantId) {
      throw new Error(
        'VOUCHER_CANCELLATION_SCOPE_MISSING: Trusted tenant context is required for voucher cancellation.'
      );
    }
    if (!expectedBranchId) {
      throw new Error(
        'VOUCHER_CANCELLATION_SCOPE_MISSING: Trusted branch context is required for voucher cancellation.'
      );
    }

    const allFtsForVoucher = await ftTbl.where('Reference_ID').equals(voucherId).toArray();
    for (const ft of allFtsForVoucher) {
      const rawRefTable = typeof ft.Reference_Table === 'string' ? ft.Reference_Table.trim() : '';
      if (!rawRefTable) {
        throw new Error(
          'VOUCHER_FINANCIAL_TRANSACTION_REFERENCE_TABLE_MISSING: Financial transaction is missing required Reference_Table.'
        );
      }
      if (rawRefTable !== 'Vouchers') {
        throw new Error(
          'VOUCHER_FINANCIAL_TRANSACTION_REFERENCE_TABLE_INVALID: Financial transaction Reference_Table does not match voucher contract.'
        );
      }

      const ftTenantId = typeof ft.tenantId === 'string' ? ft.tenantId.trim() : '';
      if (!ftTenantId) {
        throw new Error(
          'VOUCHER_FINANCIAL_TRANSACTION_TENANT_MISSING: Financial transaction is missing required tenantId.'
        );
      }
      if (ftTenantId !== expectedTenantId) {
        throw new Error(
          'CROSS_TENANT_FINANCIAL_TRANSACTION_FORBIDDEN: Financial transaction belongs to a different tenant scope.'
        );
      }

      const ftBranchId = typeof ft.branchId === 'string' ? ft.branchId.trim() : '';
      if (!ftBranchId) {
        throw new Error(
          'VOUCHER_FINANCIAL_TRANSACTION_BRANCH_MISSING: Financial transaction is missing required branchId.'
        );
      }
      if (ftBranchId !== expectedBranchId) {
        throw new Error(
          'CROSS_BRANCH_FINANCIAL_TRANSACTION_FORBIDDEN: Financial transaction belongs to a different branch scope.'
        );
      }
    }

    const activeFts = allFtsForVoucher.filter(
      (ft: any) => !ft.isDeleted && !ft.isReversal && !ft.reversedBy
    );
    const hasReversalOrReversed = allFtsForVoucher.some(
      (ft: any) => Boolean(ft.isReversal || ft.reversedBy)
    );

    if (activeFts.length === 0) {
      if (hasReversalOrReversed) {
        throw new Error(
          `VOUCHER_FINANCIAL_TRANSACTION_ALREADY_REVERSED: Financial transaction for voucher [${voucherId}] was already reversed.`
        );
      }
      throw new Error(
        `VOUCHER_FINANCIAL_TRANSACTION_MISSING: No active financial transaction found for voucher [${voucherId}].`
      );
    }
    if (activeFts.length > 1) {
      throw new Error(
        `DUPLICATE_VOUCHER_FINANCIAL_TRANSACTIONS: Voucher [${voucherId}] has ${activeFts.length} active financial transaction records; expected exactly 1.`
      );
    }

    const activeFt = activeFts[0];
    if (activeFt.Reference_ID !== voucherId) {
      throw new Error(
        `VOUCHER_FINANCIAL_TRANSACTION_REFERENCE_MISMATCH: Financial transaction [${activeFt.id}] Reference_ID (${String(activeFt.Reference_ID)}) does not match voucher [${voucherId}].`
      );
    }

    const rawFtAmount = extractFinitePositiveAmount(activeFt);
    const activeFtPaidAmount = extractFinitePositivePaidAmount(activeFt);
    if (
      rawFtAmount === null ||
      !amountsMatch(rawFtAmount, authoritativeAmount) ||
      activeFtPaidAmount === null ||
      !amountsMatch(activeFtPaidAmount, authoritativeAmount)
    ) {
      throw new Error(
        `VOUCHER_FINANCIAL_TRANSACTION_AMOUNT_MISMATCH: Financial transaction [${activeFt.id}] amount (${String(rawFtAmount)}) or Paid_Amount (${String(activeFt.Paid_Amount)}) is missing, invalid, or does not match voucher amount (${authoritativeAmount}).`
      );
    }

    const expectedTransactionType = authoritativeType === 'RECEIPT' ? 'Receipt' : 'Payment';
    if (activeFt.Transaction_Type !== expectedTransactionType) {
      throw new Error(
        `VOUCHER_FINANCIAL_TRANSACTION_TYPE_MISMATCH: Financial transaction [${activeFt.id}] Transaction_Type (${String(activeFt.Transaction_Type)}) does not match expected type (${expectedTransactionType}) for ${authoritativeType}.`
      );
    }

    const expectedEntityType = authoritativeType === 'RECEIPT' ? 'Customer' : 'Supplier';
    if (activeFt.Entity_Type !== expectedEntityType) {
      throw new Error(
        `VOUCHER_FINANCIAL_TRANSACTION_ENTITY_TYPE_MISMATCH: Financial transaction [${activeFt.id}] Entity_Type (${String(activeFt.Entity_Type)}) does not match expected entity type (${expectedEntityType}) for ${authoritativeType}.`
      );
    }

    const actualEntityName = typeof activeFt.Entity_Name === 'string' ? activeFt.Entity_Name.trim() : '';
    if (!actualEntityName || actualEntityName !== authoritativePartnerId) {
      throw new Error(
        `VOUCHER_FINANCIAL_TRANSACTION_ENTITY_NAME_MISMATCH: Financial transaction [${activeFt.id}] Entity_Name (${String(activeFt.Entity_Name)}) does not match persisted voucher partner (${authoritativePartnerId}).`
      );
    }

    const expectedFtDirection = authoritativeType === 'RECEIPT' ? 'Credit' : 'Debit';
    if (activeFt.Direction !== expectedFtDirection) {
      throw new Error(
        `VOUCHER_FINANCIAL_TRANSACTION_DIRECTION_MISMATCH: Financial transaction [${activeFt.id}] direction (${String(activeFt.Direction)}) does not match expected direction (${expectedFtDirection}) for ${authoritativeType}.`
      );
    }

    // =========================================================================
    // PHASE 2: ATOMIC MUTATIONS INSIDE THE ACTIVE TRANSACTION
    // =========================================================================
    const now = new Date().toISOString();

    if (authoritativeType === 'RECEIPT') {
      if (receipt) {
        await receiptsTbl.delete(voucherId);
      }
      if (partnerNextBalance !== null) {
        await customersTbl.update(authoritativePartnerId, {
          balance: partnerNextBalance,
          updatedAt: now
        });
      }
    } else {
      if (payment) {
        await paymentsTbl.delete(voucherId);
      }
      if (partnerNextBalance !== null) {
        await suppliersTbl.update(authoritativePartnerId, {
          balance: partnerNextBalance,
          updatedAt: now
        });
      }
    }

    // Apply pre-validated invoice allocation restorations and delete links
    for (const restoration of invoiceRestorations) {
      await invoicesTbl.update(restoration.invoiceId, {
        paidAmount: restoration.newPaid,
        remainingAmount: restoration.newRemaining,
        remaining: restoration.newRemaining,
        paymentStatus: restoration.paymentStatus,
        updatedAt: now
      });
    }
    for (const link of links) {
      await linksTbl.delete(link.id);
    }

    // Reverse journal entry and lines atomically via AccountingRepository.deleteEntry
    await AccountingRepository.deleteEntry(journalEntry.id, tx);

    // Non-destructive compensating reversal of the voucher's FinancialTransaction (preserves historical record)
    const reversalOutcome = await FinancialTransactionRepository.reverseTransactions(
      voucherId,
      tx,
      ctx.idempotencyKey,
      expectedTenantId,
      expectedBranchId,
      { requireActiveTransaction: true, referenceTable: 'Vouchers' }
    );

    // Postcondition verification inside the same active transaction: no-op or mis-scoped reversals must fail closed
    if (!reversalOutcome || reversalOutcome.reversedCount !== 1) {
      throw new Error(
        'FINANCIAL_TRANSACTION_REVERSAL_VERIFICATION_FAILED: Expected exactly one financial transaction to be reversed.'
      );
    }

    const updatedOriginalFt = await ftTbl.get(activeFt.id);
    if (!updatedOriginalFt || updatedOriginalFt.isDeleted !== true) {
      throw new Error(
        'FINANCIAL_TRANSACTION_REVERSAL_VERIFICATION_FAILED: Original financial transaction was not marked as deleted/reversed.'
      );
    }

    const reversedById =
      typeof updatedOriginalFt.reversedBy === 'string' ? updatedOriginalFt.reversedBy.trim() : '';
    if (!reversedById) {
      throw new Error(
        'FINANCIAL_TRANSACTION_REVERSAL_VERIFICATION_FAILED: Original financial transaction is missing reversedBy reference.'
      );
    }

    const reversalRecord = await ftTbl.get(reversedById);
    const expectedReversalDirection = expectedFtDirection === 'Debit' ? 'Credit' : 'Debit';
    if (!reversalRecord) {
      throw new Error(
        'FINANCIAL_TRANSACTION_REVERSAL_VERIFICATION_FAILED: Compensating reversal record referenced by reversedBy does not exist.'
      );
    }
    if (
      reversalRecord.tenantId !== expectedTenantId ||
      reversalRecord.branchId !== expectedBranchId
    ) {
      throw new Error(
        'FINANCIAL_TRANSACTION_REVERSAL_SCOPE_VIOLATION: Compensating reversal record does not match expected tenant and branch scope.'
      );
    }
    const reversalAmount = extractFinitePositiveAmount(reversalRecord);
    const reversalPaidAmount = extractFinitePositivePaidAmount(reversalRecord);
    const reversalPaidAmountValid =
      reversalPaidAmount !== null &&
      amountsMatch(reversalPaidAmount, activeFtPaidAmount) &&
      amountsMatch(reversalPaidAmount, authoritativeAmount);
    const reversalEntityName =
      typeof reversalRecord.Entity_Name === 'string' ? reversalRecord.Entity_Name.trim() : '';

    if (
      reversalRecord.isReversal !== true ||
      reversalRecord.reversalOf !== activeFt.id ||
      reversalRecord.isDeleted === true ||
      reversalRecord.Direction !== expectedReversalDirection ||
      reversalAmount === null ||
      !amountsMatch(reversalAmount, rawFtAmount) ||
      !amountsMatch(reversalAmount, authoritativeAmount) ||
      !reversalPaidAmountValid ||
      reversalRecord.Reference_ID !== voucherId ||
      reversalRecord.Reference_Table !== 'Vouchers' ||
      reversalRecord.Transaction_Type !== expectedTransactionType ||
      reversalRecord.Entity_Type !== expectedEntityType ||
      reversalEntityName !== authoritativePartnerId
    ) {
      throw new Error(
        'FINANCIAL_TRANSACTION_REVERSAL_VERIFICATION_FAILED: Compensating reversal record failed integrity, amount, reference, or identity postconditions.'
      );
    }

    // Delete voucher record if exists
    if (voucher) {
      await vouchersTbl.delete(voucherId);
    }

    // Transaction-scoped audit and projection writes (no silent swallowing: any failure aborts tx)
    await AuditService.log({
      action: 'DELETE',
      module: 'VOUCHERS',
      transactionUuid: ctx.workflowId,
      recordId: voucherId,
      before: {
        id: voucherId,
        type: authoritativeType,
        partnerId: authoritativePartnerId,
        amount: authoritativeAmount
      },
      after: {
        cancelled: true,
        id: voucherId,
        type: authoritativeType,
        partnerId: authoritativePartnerId,
        amount: authoritativeAmount,
        reason: input.reason
      }
    }, tx);

    await ProjectionEventBus.publish('VOUCHER_CANCELLED', voucherId, {
      type: authoritativeType,
      partnerId: authoritativePartnerId,
      amount: authoritativeAmount,
      correlationId: ctx.correlationId
    }, tx);

    const result: VoucherCancellationResult = {
      success: true,
      id: voucherId,
      type: authoritativeType,
      partnerId: authoritativePartnerId,
      amount: authoritativeAmount,
      reason: input.reason
    };
    await this.enqueueSync(result, ctx, tx);
    return result;
  }

  private async enqueueSync(
    result: VoucherCancellationResult,
    ctx: WorkflowContext,
    tx?: any
  ): Promise<void> {
    if (!tx || typeof tx.table !== 'function') {
      throw new Error('VOUCHER_CANCEL_SYNC_TRANSACTION_REQUIRED: Cancellation sync must be persisted inside the domain transaction.');
    }
    if (!ctx.idempotencyKey || !ctx.tenantId || !ctx.branchId) {
      throw new Error('VOUCHER_CANCEL_SYNC_SCOPE_REQUIRED: Tenant, branch and idempotency context are mandatory.');
    }

    const payload = {
      ...this.syncContract.buildPayload(result, ctx),
      id: result.id,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId
    };
    const enqueueResult = await DistributedSyncEngine.getInstance().enqueueWithinTransaction(
      this.syncContract.operation,
      payload,
      this.syncContract.entityType,
      ctx.idempotencyKey,
      { tenantId: ctx.tenantId, branchId: ctx.branchId }
    );
    if (!enqueueResult?.mutationId || enqueueResult.idempotencyKey !== ctx.idempotencyKey) {
      throw new Error('VOUCHER_CANCEL_SYNC_ENQUEUE_FAILED: Cancellation was not paired with a durable sync mutation.');
    }

    const syncQueueTable = tx.table('syncQueue');
    const outboxTable = tx.table('outbox');
    if (!syncQueueTable || !outboxTable) {
      throw new Error('VOUCHER_CANCEL_SYNC_STORES_UNAVAILABLE: syncQueue and outbox must be part of the cancellation transaction.');
    }
    const [queueRow, outboxRow] = await Promise.all([
      syncQueueTable.where('idempotencyKey').equals(ctx.idempotencyKey).first(),
      outboxTable.where('idempotencyKey').equals(ctx.idempotencyKey).first()
    ]);
    if (
      !queueRow ||
      !outboxRow ||
      queueRow.entityType !== this.syncContract.entityType ||
      queueRow.operationType !== this.syncContract.operation ||
      queueRow.payload?.id !== result.id ||
      queueRow.tenantId !== ctx.tenantId ||
      queueRow.branchId !== ctx.branchId ||
      outboxRow.entityType !== this.syncContract.entityType ||
      outboxRow.operation !== this.syncContract.operation ||
      outboxRow.payload?.id !== result.id ||
      outboxRow.tenantId !== ctx.tenantId ||
      outboxRow.branchId !== ctx.branchId
    ) {
      throw new Error('VOUCHER_CANCEL_SYNC_DURABILITY_FAILED: Tenant-bound cancellation queue and outbox records must exist before commit.');
    }
  }
}

export const voucherCancellationWorkflow = new VoucherCancellationWorkflow();
