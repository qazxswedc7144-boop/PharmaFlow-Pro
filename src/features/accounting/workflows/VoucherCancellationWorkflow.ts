import { BusinessWorkflow, SyncContract, WorkflowContext } from '@/core/workflow';
import { db } from '@/core/db';
import { AuditService } from '@/services/system/AuditService';
import { ProjectionEventBus } from '@/services/system/ProjectionEventBus';
import { AccountingRepository } from '@/database/repositories/AccountingRepository';

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
}

export class VoucherCancellationWorkflow implements BusinessWorkflow<VoucherCancellationInput, VoucherCancellationResult> {
  public id = 'accounting.voucher.cancel';
  public name = 'إلغاء وحذف سند قبض / صرف';
  public operationType = 'VOUCHER_CANCEL';
  /** Documentation-only sync metadata; not consumed by the execution pipeline in V-30A. */
  public syncContract: SyncContract = {
    entityType: 'VOUCHER',
    operation: 'CANCEL',
    buildPayload: (result) => result as Record<string, unknown>
  };
  public requiredPermissions = ['vouchers.delete', 'vouchers.manage'];
  public tables = [
    'vouchers', 'receipts', 'payments', 'suppliers', 'customers',
    'journalEntries', 'journalLines', 'accounts', 'financialTransactions',
    'auditLogs', 'idempotencyKeys', 'projectionEvents', 'voucherInvoiceLinks',
    'invoices'
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
    const customersTbl = tx.table('customers');
    const suppliersTbl = tx.table('suppliers');

    // Double cancellation prevention & authoritative record inspection inside active transaction
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

    const persistedRecords: Array<{ source: string; record: any }> = [];
    if (voucher) persistedRecords.push({ source: 'vouchers', record: voucher });
    if (receipt) persistedRecords.push({ source: 'receipts', record: receipt });
    if (payment) persistedRecords.push({ source: 'payments', record: payment });

    // Validate persisted type, authoritative amount, and partner across every persisted record
    const persistedAmounts: number[] = [];
    for (const { source, record } of persistedRecords) {
      const rawType = record.type ?? record.voucherType;
      if (rawType !== undefined && rawType !== null && String(rawType).trim() !== '') {
        const normalizedType = String(rawType).trim().toUpperCase();
        if (normalizedType !== input.type) {
          throw new Error(
            `VOUCHER_TYPE_MISMATCH: Persisted ${source} type (${normalizedType}) does not match requested type (${input.type}).`
          );
        }
      }

      const rawAmount = record.amount;
      if (typeof rawAmount !== 'number' || !Number.isFinite(rawAmount) || rawAmount <= 0) {
        throw new Error(
          `VOUCHER_AMOUNT_MISSING_OR_INVALID: Persisted ${source} record [${voucherId}] has missing or invalid amount (${String(rawAmount)}).`
        );
      }
      persistedAmounts.push(rawAmount);

      const rawPartner =
        input.type === 'RECEIPT'
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
    }

    const authoritativeAmount = persistedAmounts[0];
    if (authoritativeAmount === undefined) {
      throw new Error(
        `VOUCHER_AMOUNT_MISSING_OR_INVALID: Persisted voucher [${voucherId}] has no authoritative amount.`
      );
    }
    for (let i = 1; i < persistedAmounts.length; i++) {
      const candidateAmount = persistedAmounts[i];
      if (candidateAmount === undefined || Math.abs(candidateAmount - authoritativeAmount) > 0.001) {
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

    const now = new Date().toISOString();

    if (input.type === 'RECEIPT') {
      if (receipt) {
        await receiptsTbl.delete(voucherId);
      }
      if (inputPartnerId !== 'عميل نقدي') {
        const customer = await customersTbl.get(inputPartnerId);
        if (!customer) {
          throw new Error(`CUSTOMER_NOT_FOUND: Customer ${inputPartnerId} for receipt cancellation does not exist.`);
        }
        const currentBalance = Number(customer.balance ?? 0);
        if (!Number.isFinite(currentBalance)) {
          throw new Error(`INVALID_PARTNER_BALANCE: Customer ${inputPartnerId} has a non-finite balance.`);
        }
        await customersTbl.update(inputPartnerId, {
          balance: Math.round((currentBalance + authoritativeAmount) * 100) / 100,
          updatedAt: now
        });
      }
    } else {
      if (payment) {
        await paymentsTbl.delete(voucherId);
      }
      if (inputPartnerId !== 'مورد نقدي') {
        const supplier = await suppliersTbl.get(inputPartnerId);
        if (!supplier) {
          throw new Error(`SUPPLIER_NOT_FOUND: Supplier ${inputPartnerId} for payment cancellation does not exist.`);
        }
        const currentBalance = Number(supplier.balance ?? 0);
        if (!Number.isFinite(currentBalance)) {
          throw new Error(`INVALID_PARTNER_BALANCE: Supplier ${inputPartnerId} has a non-finite balance.`);
        }
        await suppliersTbl.update(inputPartnerId, {
          balance: Math.round((currentBalance + authoritativeAmount) * 100) / 100,
          updatedAt: now
        });
      }
    }

    // Revert invoice allocations linked to this voucher (NO error swallowing!)
    const links = await linksTbl.where('voucherId').equals(voucherId).toArray();
    for (const link of links) {
      const inv = await invoicesTbl.get(link.invoiceId);
      if (!inv) {
        throw new Error(`INVOICE_NOT_FOUND: Invoice ${link.invoiceId} linked to voucher ${voucherId} could not be found for cancellation.`);
      }
      const rawPaidAmount = link.Paid_Amount ?? link.paid_amount;
      if (typeof rawPaidAmount !== 'number' || !Number.isFinite(rawPaidAmount) || rawPaidAmount < 0) {
        throw new Error(`INVALID_ALLOCATION_AMOUNT: Allocation link ${link.id} for voucher ${voucherId} has invalid paid amount (${String(rawPaidAmount)}).`);
      }
      const newPaid = Math.max(0, Math.round(((Number(inv.paidAmount) || 0) - rawPaidAmount) * 100) / 100);
      const total = Number(inv.totalAmount ?? inv.finalTotal ?? 0);
      await invoicesTbl.update(link.invoiceId, {
        paidAmount: newPaid,
        paymentStatus: newPaid <= 0.001 ? 'UNPAID' : (newPaid < total - 0.001 ? 'PARTIAL' : 'PAID'),
        updatedAt: now
      });
      await linksTbl.delete(link.id);
    }

    // Reverse journal entries and lines atomically via AccountingRepository.deleteEntry
    const entries = await jeTbl.where('sourceId').equals(voucherId).toArray();
    for (const entry of entries) {
      await AccountingRepository.deleteEntry(entry.id, tx);
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
        type: input.type,
        partnerId: inputPartnerId,
        amount: authoritativeAmount
      },
      after: {
        cancelled: true,
        id: voucherId,
        type: input.type,
        partnerId: inputPartnerId,
        amount: authoritativeAmount,
        reason: input.reason
      }
    }, tx);

    await ProjectionEventBus.publish('VOUCHER_CANCELLED', voucherId, {
      type: input.type,
      partnerId: inputPartnerId,
      amount: authoritativeAmount,
      correlationId: ctx.correlationId
    }, tx);

    return {
      success: true,
      id: voucherId
    };
  }
}

export const voucherCancellationWorkflow = new VoucherCancellationWorkflow();
