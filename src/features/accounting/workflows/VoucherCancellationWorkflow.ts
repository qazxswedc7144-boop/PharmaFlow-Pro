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
    if (!input.id) {
      throw new Error('معرف السند مطلوب للإلغاء');
    }
    if (!input.partnerId) {
      throw new Error('معرف الشريك مطلوب للإلغاء');
    }
    if (input.amount <= 0) {
      throw new Error('مبلغ السند يجب أن يكون أكبر من الصفر');
    }
  }

  public async validateBusinessRules(input: VoucherCancellationInput): Promise<void> {
    const voucher = await db.vouchers.get(input.id);
    if (!voucher) {
      // Also check fallback if needed
      const existsInReceipts = input.type === 'RECEIPT' ? await db.receipts.get(input.id) : null;
      const existsInPayments = input.type === 'PAYMENT' ? await db.payments.get(input.id) : null;
      if (!existsInReceipts && !existsInPayments) {
        throw new Error(`السند رقم [${input.id}] غير موجود أو تم إلغاؤه سابقاً`);
      }
    }
  }

  public async executeDomainSteps(
    input: VoucherCancellationInput,
    ctx: WorkflowContext,
    tx?: any
  ): Promise<VoucherCancellationResult> {
    const receiptsTbl = tx ? tx.table('receipts') : db.receipts;
    const paymentsTbl = tx ? tx.table('payments') : db.payments;
    const vouchersTbl = tx ? tx.table('vouchers') : db.vouchers;
    const linksTbl = tx ? tx.table('voucherInvoiceLinks') : db.voucherInvoiceLinks;
    const invoicesTbl = tx ? tx.table('invoices') : db.invoices;
    const jeTbl = tx ? tx.table('journalEntries') : db.journalEntries;
    const customersTbl = tx ? tx.table('customers') : db.customers;
    const suppliersTbl = tx ? tx.table('suppliers') : db.suppliers;

    // Double cancellation prevention & record inspection
    const voucher = await vouchersTbl.get(input.id);
    const receipt = input.type === 'RECEIPT' ? await receiptsTbl.get(input.id) : null;
    const payment = input.type === 'PAYMENT' ? await paymentsTbl.get(input.id) : null;

    if (!voucher && !receipt && !payment) {
      throw new Error(`السند رقم [${input.id}] غير موجود أو تم إلغاؤه مسبقاً (Double Cancellation Prevented)`);
    }

    const savedRecord = receipt || payment || voucher;
    const savedAmount = Number(savedRecord?.amount ?? savedRecord?.finalTotal ?? savedRecord?.totalAmount ?? input.amount);
    if (!Number.isFinite(savedAmount) || Math.abs(savedAmount - input.amount) > 0.01) {
      throw new Error(`VOUCHER_AMOUNT_MISMATCH: Cancellation amount (${input.amount}) does not match saved record amount (${savedAmount}).`);
    }

    if (input.type === 'RECEIPT') {
      if (receipt) {
        await receiptsTbl.delete(input.id);
      }
      if (input.partnerId && input.partnerId !== 'عميل نقدي') {
        const customer = await customersTbl.get(input.partnerId);
        if (!customer) {
          throw new Error(`CUSTOMER_NOT_FOUND: Customer ${input.partnerId} for receipt cancellation does not exist.`);
        }
        await customersTbl.update(input.partnerId, {
          balance: (customer.balance || 0) + input.amount,
          updatedAt: new Date().toISOString()
        });
      }
    } else {
      if (payment) {
        await paymentsTbl.delete(input.id);
      }
      if (input.partnerId && input.partnerId !== 'مورد نقدي') {
        const supplier = await suppliersTbl.get(input.partnerId);
        if (!supplier) {
          throw new Error(`SUPPLIER_NOT_FOUND: Supplier ${input.partnerId} for payment cancellation does not exist.`);
        }
        await suppliersTbl.update(input.partnerId, {
          balance: (supplier.balance || 0) + input.amount,
          updatedAt: new Date().toISOString()
        });
      }
    }

    // Revert invoice allocations linked to this voucher (NO error swallowing!)
    const links = await linksTbl.where('voucherId').equals(input.id).toArray();
    for (const link of links) {
      const inv = await invoicesTbl.get(link.invoiceId);
      if (!inv) {
        throw new Error(`INVOICE_NOT_FOUND: Invoice ${link.invoiceId} linked to voucher ${input.id} could not be found for cancellation.`);
      }
      const paidAmount = Number(link.Paid_Amount ?? link.paid_amount ?? 0);
      const newPaid = Math.max(0, Math.round(((inv.paidAmount || 0) - paidAmount) * 100) / 100);
      const total = Number(inv.totalAmount ?? inv.finalTotal ?? 0);
      await invoicesTbl.update(link.invoiceId, {
        paidAmount: newPaid,
        paymentStatus: newPaid <= 0.001 ? 'UNPAID' : (newPaid < total - 0.001 ? 'PARTIAL' : 'PAID'),
        updatedAt: new Date().toISOString()
      });
      await linksTbl.delete(link.id);
    }

    // Reverse journal entries and lines atomically via AccountingRepository.deleteEntry
    const entries = await jeTbl.where('sourceId').equals(input.id).toArray();
    for (const entry of entries) {
      await AccountingRepository.deleteEntry(entry.id, tx);
    }

    // Delete voucher record if exists
    if (voucher) {
      await vouchersTbl.delete(input.id);
    }

    try {
      await (AuditService.log as any)({
        action: 'DELETE',
        module: 'VOUCHERS',
        transactionUuid: ctx.workflowId,
        recordId: input.id,
        details: `تم إلغاء السند [${input.id}] بقيمة ${input.amount}`
      });
    } catch (auditErr) {
      console.warn('[VoucherCancellation] Audit log failed:', auditErr);
    }

    try {
      await ProjectionEventBus.publish('VOUCHER_CANCELLED', input.id, {
        type: input.type,
        partnerId: input.partnerId,
        amount: input.amount,
        correlationId: ctx.correlationId
      });
    } catch (eventErr) {
      console.warn('[VoucherCancellation] Projection event publish failed:', eventErr);
    }

    return {
      success: true,
      id: input.id
    };
  }
}

export const voucherCancellationWorkflow = new VoucherCancellationWorkflow();
