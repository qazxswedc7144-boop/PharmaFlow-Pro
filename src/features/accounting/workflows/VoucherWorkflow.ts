import { BusinessWorkflow, WorkflowContext } from '@/core/workflow';
import { db } from '@/core/db';
import { Payment, Receipt, Voucher } from '@/types';
import { PurchaseRepository } from '@/database/repositories/PurchaseRepository';
import { SalesRepository } from '@/database/repositories/SalesRepository';
import { FinancialTransactionRepository } from '@/database/repositories/FinancialTransactionRepository';
import { AccountingEngine as accountingEngine } from '@features/accounting/services/AccountingEngine';
import { ProjectionEventBus } from '@/services/system/ProjectionEventBus';

export interface VoucherWorkflowInput {
  type: 'RECEIPT' | 'PAYMENT';
  partnerId: string;
  amount: number;
  notes?: string;
  date?: string;
  paymentMethod?: 'CASH' | 'TRANSFER';
  allocations?: Record<string, number | { amount: number; note?: string }>;
}

export interface VoucherWorkflowResult {
  id: string;
  voucher: Voucher;
  document: Receipt | Payment;
}

export class VoucherWorkflow implements BusinessWorkflow<VoucherWorkflowInput, VoucherWorkflowResult> {
  public id = 'accounting.voucher.process';
  public name = 'معالجة سند قبض / صرف';
  public operationType = 'VOUCHER';
  public requiredPermissions = ['accounting.voucher.create', 'vouchers.create'];
  public tables = [
    'vouchers', 'invoices', 'suppliers', 'customers', 'financialTransactions',
    'journalEntries', 'journalLines', 'accounts', 'auditLogs',
    'idempotencyKeys', 'projectionEvents'
  ];

  public async validateInput(input: VoucherWorkflowInput): Promise<void> {
    if (typeof input.amount !== 'number' || isNaN(input.amount) || input.amount <= 0) {
      throw new Error('مبلغ السند يجب أن يكون أكبر من الصفر');
    }
    if (!input.partnerId || input.partnerId.trim() === '') {
      throw new Error('يرجى تحديد الشريك (عميل أو مورد)');
    }

    // Validate allocations structure and total bounds
    if (input.allocations && Object.keys(input.allocations).length > 0) {
      let totalAllocated = 0;
      for (const invoiceId in input.allocations) {
        const item = input.allocations[invoiceId];
        const allocAmount = typeof item === 'number' ? item : item?.amount || 0;
        if (typeof allocAmount !== 'number' || isNaN(allocAmount) || allocAmount <= 0) {
          throw new Error(`مبلغ التخصيص للفاتورة [${invoiceId}] يجب أن يكون رقماً موجباً أكبر من الصفر.`);
        }
        totalAllocated += allocAmount;
      }

      if (totalAllocated > input.amount + 0.001) {
        throw new Error(`OVER_ALLOCATION: إجمالي مبالغ التخصيص (${totalAllocated}) يتجاوز مبلغ سند الصرف (${input.amount}).`);
      }
    }
  }

  public async validateBusinessRules(input: VoucherWorkflowInput, ctx: WorkflowContext): Promise<void> {
    if (!ctx.tenantId || ctx.tenantId === 'default' || ctx.tenantId === 'default-tenant') {
      throw new Error('FAIL_CLOSED: يتطلب تنفيذ السند المالي وجود سياق مؤسسة موثوق (Trusted Tenant Context Required).');
    }

    const isPayment = input.type === 'PAYMENT';

    if (isPayment) {
      // 1. Verify Supplier existence and tenant isolation
      if (input.partnerId && input.partnerId !== 'مورد نقدي') {
        const supplier = await db.suppliers.get(input.partnerId);
        if (!supplier) {
          throw new Error(`SUPPLIER_NOT_FOUND: لم يتم العثور على المورد المحدد [${input.partnerId}].`);
        }
        if (supplier.tenantId && supplier.tenantId !== ctx.tenantId) {
          throw new Error(`CROSS_TENANT_SUPPLIER_FORBIDDEN: المورد [${input.partnerId}] تابع لمؤسسة أخرى.`);
        }
      }

      // 2. Verify Allocated Invoices: existence, tenant isolation, supplier ownership, and no over-allocation
      if (input.allocations && Object.keys(input.allocations).length > 0) {
        for (const invoiceId in input.allocations) {
          const inv = await db.invoices.get(invoiceId);
          if (!inv) {
            throw new Error(`INVOICE_NOT_FOUND: فاتورة المشتريات [${invoiceId}] غير موجودة.`);
          }

          // Verify tenant ownership of the invoice
          if (inv.tenantId && inv.tenantId !== ctx.tenantId) {
            throw new Error(`CROSS_TENANT_INVOICE_FORBIDDEN: الفاتورة [${invoiceId}] تابعة لمؤسسة أخرى.`);
          }

          // Verify partner ownership
          const invPartner = inv.partnerId || (inv as any).supplier_id || (inv as any).partner_id;
          if (invPartner && invPartner !== input.partnerId) {
            throw new Error(`SUPPLIER_INVOICE_MISMATCH: الفاتورة [${invoiceId}] لا تنتمي إلى المورد المحدد [${input.partnerId}].`);
          }

          // Prevent over-allocation on individual invoice
          const item = input.allocations[invoiceId];
          const allocAmount = typeof item === 'number' ? item : item?.amount || 0;
          const invoiceTotal = Number(inv.totalAmount ?? inv.finalTotal ?? 0);
          const alreadyPaid = Number(inv.paidAmount ?? 0);
          const remainingOwed = Math.max(0, invoiceTotal - alreadyPaid);

          if (allocAmount > remainingOwed + 0.001) {
            throw new Error(`OVER_ALLOCATION: المبلغ المخصص للفاتورة [${invoiceId}] (${allocAmount}) يتجاوز المبلغ المتبقي المستحق (${remainingOwed}).`);
          }
        }
      }
    } else {
      // Receipt business rules
      if (input.partnerId && input.partnerId !== 'عميل نقدي') {
        const customer = await db.customers.get(input.partnerId);
        if (!customer) {
          throw new Error(`CUSTOMER_NOT_FOUND: لم يتم العثور على العميل المحدد [${input.partnerId}].`);
        }
        if (customer.tenantId && customer.tenantId !== ctx.tenantId) {
          throw new Error(`CROSS_TENANT_CUSTOMER_FORBIDDEN: العميل [${input.partnerId}] تابع لمؤسسة أخرى.`);
        }
      }

      if (input.allocations && Object.keys(input.allocations).length > 0) {
        for (const saleId in input.allocations) {
          const inv = await db.invoices.get(saleId);
          if (!inv) {
            throw new Error(`INVOICE_NOT_FOUND: فاتورة المبيعات [${saleId}] غير موجودة.`);
          }
          if (inv.tenantId && inv.tenantId !== ctx.tenantId) {
            throw new Error(`CROSS_TENANT_INVOICE_FORBIDDEN: الفاتورة [${saleId}] تابعة لمؤسسة أخرى.`);
          }
          const invPartner = inv.partnerId || (inv as any).customer_id || (inv as any).partner_id;
          if (invPartner && invPartner !== input.partnerId) {
            throw new Error(`CUSTOMER_INVOICE_MISMATCH: الفاتورة [${saleId}] لا تنتمي إلى العميل المحدد [${input.partnerId}].`);
          }

          const item = input.allocations[saleId];
          const allocAmount = typeof item === 'number' ? item : item?.amount || 0;
          const invoiceTotal = Number(inv.totalAmount ?? inv.finalTotal ?? 0);
          const alreadyPaid = Number(inv.paidAmount ?? 0);
          const remainingOwed = Math.max(0, invoiceTotal - alreadyPaid);

          if (allocAmount > remainingOwed + 0.001) {
            throw new Error(`OVER_ALLOCATION: المبلغ المخصص للفاتورة [${saleId}] (${allocAmount}) يتجاوز المبلغ المتبقي المستحق (${remainingOwed}).`);
          }
        }
      }
    }
  }

  public async executeDomainSteps(
    input: VoucherWorkflowInput,
    ctx: WorkflowContext
  ): Promise<VoucherWorkflowResult> {
    const isPayment = input.type === 'PAYMENT';
    const prefix = isPayment ? 'PYMT' : 'RCPT';
    const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const id = `${prefix}-${Date.now()}-${randomSuffix}`;
    const date = input.date || ctx.startedAt;

    const voucherRecord: Voucher = {
      id,
      voucherId: id,
      type: input.type,
      amount: input.amount,
      partnerId: input.partnerId,
      notes: input.notes,
      date,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      Created_At: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      syncStatus: 'NEW'
    };

    // 1. Persist Voucher
    await db.db.vouchers.put(voucherRecord);

    if (isPayment) {
      // 2. Process Purchase allocations with over-allocation prevention
      if (input.allocations) {
        for (const invoiceId in input.allocations) {
          const item = input.allocations[invoiceId];
          const allocAmount = typeof item === 'number' ? item : item?.amount || 0;
          if (allocAmount > 0) {
            await PurchaseRepository.updatePaidAmount(invoiceId, allocAmount);
          }
        }
      }

      // 3. Update Supplier Balance
      if (input.partnerId && input.partnerId !== 'مورد نقدي') {
        await db.updateSupplierBalance(input.partnerId, -input.amount);
      }

      // 4. Record single authoritative Financial Transaction
      await FinancialTransactionRepository.record({
        id: db.generateId('FT'),
        Transaction_Type: 'Payment',
        Reference_ID: id,
        Reference_Table: 'Vouchers',
        Entity_Type: 'Supplier',
        Entity_Name: input.partnerId,
        Amount: input.amount,
        Direction: 'Debit',
        Transaction_Date: date,
        Notes: input.notes || `سند صرف للمورد #${id}`,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId
      } as any);

      // 5. Generate single authoritative balanced double-entry Journal Entry
      const entry = await accountingEngine.generateVoucherEntry({
        type: 'PAYMENT',
        amount: input.amount,
        partnerId: input.partnerId,
        date,
        refId: id,
        notes: input.notes,
        paymentMethod: input.paymentMethod,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId
      });
      await db.addJournalEntry(entry);

      // 6. Publish Projection Event within transaction
      await ProjectionEventBus.publish('SUPPLIER_PAYMENT_PROCESSED', id, {
        supplierId: input.partnerId,
        amount: input.amount,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        correlationId: ctx.correlationId
      });

      const doc: Payment = {
        id,
        date,
        supplier_id: input.partnerId,
        amount: input.amount,
        notes: input.notes,
        paymentMethod: input.paymentMethod || 'CASH',
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        created_at: new Date().toISOString(),
        lastModified: new Date().toISOString()
      };

      return { id, voucher: voucherRecord, document: doc };

    } else {
      // Receipt execution
      if (input.allocations) {
        for (const saleId in input.allocations) {
          const item = input.allocations[saleId];
          const allocAmount = typeof item === 'number' ? item : item?.amount || 0;
          if (allocAmount > 0) {
            await SalesRepository.updatePaidAmount(saleId, allocAmount);
          }
        }
      }

      if (input.partnerId && input.partnerId !== 'عميل نقدي') {
        await db.updateCustomerBalance(input.partnerId, -input.amount);
      }

      await FinancialTransactionRepository.record({
        id: db.generateId('FT'),
        Transaction_Type: 'Receipt',
        Reference_ID: id,
        Reference_Table: 'Vouchers',
        Entity_Type: 'Customer',
        Entity_Name: input.partnerId,
        Amount: input.amount,
        Direction: 'Credit',
        Transaction_Date: date,
        Notes: input.notes || `سند قبض من العميل #${id}`,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId
      } as any);

      const entry = await accountingEngine.generateVoucherEntry({
        type: 'RECEIPT',
        amount: input.amount,
        partnerId: input.partnerId,
        date,
        refId: id,
        notes: input.notes,
        paymentMethod: input.paymentMethod,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId
      });
      await db.addJournalEntry(entry);

      await ProjectionEventBus.publish('CUSTOMER_RECEIPT_PROCESSED', id, {
        customerId: input.partnerId,
        amount: input.amount,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        correlationId: ctx.correlationId
      });

      const doc: Receipt = {
        id,
        date,
        customer_id: input.partnerId,
        amount: input.amount,
        notes: input.notes,
        paymentMethod: input.paymentMethod || 'CASH',
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        created_at: new Date().toISOString(),
        lastModified: new Date().toISOString()
      };

      return { id, voucher: voucherRecord, document: doc };
    }
  }
}

export const voucherWorkflow = new VoucherWorkflow();
