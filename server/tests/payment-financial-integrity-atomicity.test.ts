import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/core/db';
import { UnifiedBusinessWorkflowOrchestrator } from '../../src/services/orchestration/UnifiedBusinessWorkflowOrchestrator';
import { PurchaseRepository } from '../../src/database/repositories/PurchaseRepository';
import { AccountingRepository } from '../../src/database/repositories/AccountingRepository';
import { FinancialTransactionRepository } from '../../src/database/repositories/FinancialTransactionRepository';
import { useAuthStore } from '@/store/authStore';
import { IdempotencyRegistry } from '../../src/core/workflow/idempotency';
import { voucherWorkflow } from '../../src/features/accounting/workflows/VoucherWorkflow';

describe('Supplier Payment - Financial Integrity & Atomicity Verification Suite', () => {
  const tenantId = 'TENANT-FIN-01';
  const branchId = 'BRH-FIN-01';
  const supplierId = 'SUP-FIN-001';

  beforeEach(async () => {
    // Clear Dexie tables
    await db.db.vouchers.clear();
    await db.db.journalEntries.clear();
    await db.db.journalLines.clear();
    await db.db.financialTransactions.clear();
    await db.db.invoices.clear();
    await db.db.suppliers.clear();
    await db.db.voucherInvoiceLinks.clear();
    await db.db.idempotencyRecords.clear();

    // Setup active authenticated user with required permissions
    useAuthStore.setState({
      user: {
        id: 'usr-fin-tester',
        tenantId,
        branchId,
        role: 'accountant',
        roles: ['accountant'],
        permissions: ['accounting.voucher.create', 'vouchers.create', 'vouchers.manage']
      } as any,
      tenantId,
      branchId,
      roles: ['accountant'],
      permissions: ['accounting.voucher.create', 'vouchers.create', 'vouchers.manage'],
      isAuthenticated: true
    });

    // Seed Supplier with initial balance of 1500
    await db.suppliers.put({
      id: supplierId,
      tenantId,
      branchId,
      Supplier_Name: 'Al-Amal Pharmaceuticals',
      balance: 1500
    } as any);

    // Seed Purchases for this supplier
    await db.invoices.bulkPut([
      {
        id: 'PUR-001',
        tenantId,
        branchId,
        partnerId: supplierId,
        totalAmount: 1000,
        paidAmount: 200,
        paymentStatus: 'PARTIAL',
        type: 'PURCHASE'
      } as any,
      {
        id: 'PUR-002',
        tenantId,
        branchId,
        partnerId: supplierId,
        totalAmount: 500,
        paidAmount: 500,
        paymentStatus: 'PAID',
        type: 'PURCHASE'
      } as any
    ]);
  });

  // -------------------------------------------------------------------------
  // 1. Validation: amount > 0
  // -------------------------------------------------------------------------
  it('1. amount <= 0 or invalid must fail validation and produce zero side effects', async () => {
    // Test 0
    await expect(
      UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: supplierId,
        amount: 0
      })
    ).rejects.toThrow(/مبلغ السداد يجب أن يكون رقماً موجباً أكبر من الصفر|مبلغ السند يجب أن يكون أكبر من الصفر/i);

    // Test negative
    await expect(
      UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: supplierId,
        amount: -150
      })
    ).rejects.toThrow(/مبلغ السداد يجب أن يكون رقماً موجباً أكبر من الصفر|مبلغ السند يجب أن يكون أكبر من الصفر/i);

    // Test NaN
    await expect(
      UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: supplierId,
        amount: NaN
      })
    ).rejects.toThrow(/مبلغ السداد يجب أن يكون رقماً موجباً أكبر من الصفر|مبلغ السند يجب أن يكون أكبر من الصفر/i);

    // Verify zero mutations
    const vouchers = await db.db.vouchers.toArray();
    expect(vouchers.length).toBe(0);
    const transactions = await db.db.financialTransactions.toArray();
    expect(transactions.length).toBe(0);
    const journals = await db.db.journalEntries.toArray();
    expect(journals.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 2. Over-allocation prevention
  // -------------------------------------------------------------------------
  it('2. Over-allocation exceeding remaining invoice balance is strictly rejected', async () => {
    // PUR-001 total: 1000, paid: 200 -> remaining: 800
    // Attempt to allocate 850
    await expect(
      UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: supplierId,
        amount: 850,
        allocations: {
          'PUR-001': 850
        }
      })
    ).rejects.toThrow(/OVER_ALLOCATION/i);

    // Verify invoice remains untouched
    const invoice = await db.invoices.get('PUR-001');
    expect(invoice?.paidAmount).toBe(200);

    // Verify supplier balance remains 1500
    const sup = await db.suppliers.get(supplierId);
    expect(sup?.balance).toBe(1500);

    // Zero vouchers/financial records created
    expect((await db.db.vouchers.toArray()).length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. Duplicate allocation / already paid invoice
  // -------------------------------------------------------------------------
  it('3. Allocation to an already fully paid invoice is strictly rejected', async () => {
    // PUR-002 total: 500, paid: 500 -> remaining: 0 (PAID)
    await expect(
      UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: supplierId,
        amount: 100,
        allocations: {
          'PUR-002': 100
        }
      })
    ).rejects.toThrow(/INVOICE_ALREADY_PAID/i);

    // Verify invoice status remains untouched
    const invoice = await db.invoices.get('PUR-002');
    expect(invoice?.paidAmount).toBe(500);
    expect(invoice?.paymentStatus).toBe('PAID');
  });

  // -------------------------------------------------------------------------
  // 4 & 5. Supplier Balance & Invoice Paid Amount correctness
  // -------------------------------------------------------------------------
  it('4 & 5. Successful payment correctly updates Supplier Balance and Invoice Paid Amount', async () => {
    // Initial: Supplier balance 1500, PUR-001 paid: 200 (remaining 800)
    const paymentAmount = 350;
    const result = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
      partnerId: supplierId,
      amount: paymentAmount,
      allocations: {
        'PUR-001': paymentAmount
      },
      notes: 'Partial invoice settlement'
    });

    expect(result.success).toBe(true);
    expect(result.payment.id).toBeDefined();

    // Supplier balance should be reduced from 1500 to 1150
    const supplier = await db.suppliers.get(supplierId);
    expect(supplier?.balance).toBe(1150);

    // Invoice PUR-001 paidAmount should be updated from 200 to 550
    const invoice = await db.invoices.get('PUR-001');
    expect(invoice?.paidAmount).toBe(550);
    expect(invoice?.paymentStatus).toBe('PARTIAL');
  });

  // -------------------------------------------------------------------------
  // 6, 7 & 8. Exactly ONE FinancialTransaction, ONE JournalEntry, and Balanced Lines (Debit = Credit)
  // -------------------------------------------------------------------------
  it('6, 7, 8. Produces exactly ONE FinancialTransaction, ONE JournalEntry, and Total Debit == Total Credit', async () => {
    const paymentAmount = 400;
    const result = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
      partnerId: supplierId,
      amount: paymentAmount,
      notes: 'Authoritative financial records check'
    });

    expect(result.success).toBe(true);
    const voucherId = result.payment.id;

    // Exactly 1 FinancialTransaction
    const transactions = await db.db.financialTransactions.toArray();
    expect(transactions.length).toBe(1);
    const trx = transactions[0];
    expect(trx.Reference_ID).toBe(voucherId);
    expect(trx.Amount).toBe(paymentAmount);
    expect(trx.tenantId).toBe(tenantId);
    expect(trx.branchId).toBe(branchId);

    // Exactly 1 JournalEntry
    const journalEntries = await db.db.journalEntries.toArray();
    expect(journalEntries.length).toBe(1);
    const entry = journalEntries[0];
    expect(entry.referenceId).toBe(voucherId);
    expect(entry.tenantId).toBe(tenantId);
    expect(entry.branchId).toBe(branchId);

    // Journal Lines must be balanced: Total Debit == Total Credit
    const lines = await db.db.journalLines.where('entryId').equals(entry.id).toArray();
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const totalDebit = lines.reduce((acc, l) => acc + (Number(l.debit) || 0), 0);
    const totalCredit = lines.reduce((acc, l) => acc + (Number(l.credit) || 0), 0);

    expect(Math.round(totalDebit * 100) / 100).toBe(paymentAmount);
    expect(Math.round(totalCredit * 100) / 100).toBe(paymentAmount);
    expect(totalDebit).toBeCloseTo(totalCredit, 2);
  });

  // -------------------------------------------------------------------------
  // 9. Failure during critical steps rolls back cleanly (No Partial Financial State)
  // -------------------------------------------------------------------------
  it('9. Partial failure during domain execution guarantees full rollback (Atomicity)', async () => {
    // We simulate a mid-stream failure in domain execution
    // e.g., PurchaseRepository.updatePaidAmount throws if an invoice is not found
    const invalidInvoiceId = 'NON-EXISTENT-INV';

    await expect(
      UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: supplierId,
        amount: 300,
        allocations: {
          'PUR-001': 100,
          [invalidInvoiceId]: 200
        }
      })
    ).rejects.toThrow();

    // Verify zero partial financial state:
    // 1. Voucher was NOT created or was rolled back
    const vouchers = await db.db.vouchers.toArray();
    expect(vouchers.length).toBe(0);

    // 2. PUR-001 was NOT partially updated
    const pur001 = await db.invoices.get('PUR-001');
    expect(pur001?.paidAmount).toBe(200);

    // 3. Supplier balance was NOT updated
    const supplier = await db.suppliers.get(supplierId);
    expect(supplier?.balance).toBe(1500);

    // 4. Zero FinancialTransaction
    const transactions = await db.db.financialTransactions.toArray();
    expect(transactions.length).toBe(0);

    // 5. Zero JournalEntry
    const journalEntries = await db.db.journalEntries.toArray();
    expect(journalEntries.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 10. Retry produces zero additional financial impact
  // -------------------------------------------------------------------------
  it('10. Retrying an already committed payment yields identical result with zero extra financial side-effects', async () => {
    const idempotencyKey = 'PAYMENT-IDEMP-RETRY-001';
    const amount = 250;

    // First execution
    const firstRun = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
      partnerId: supplierId,
      amount,
      allocations: {
        'PUR-001': amount
      },
      idempotencyKey
    });

    expect(firstRun.success).toBe(true);
    const voucherId = firstRun.payment.id;

    // Verify first run side-effects
    expect((await db.suppliers.get(supplierId))?.balance).toBe(1250);
    expect((await db.invoices.get('PUR-001'))?.paidAmount).toBe(450);
    expect((await db.db.vouchers.toArray()).length).toBe(1);
    expect((await db.db.financialTransactions.toArray()).length).toBe(1);
    expect((await db.db.journalEntries.toArray()).length).toBe(1);

    // Second execution (Retry with same idempotencyKey)
    const secondRun = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
      partnerId: supplierId,
      amount,
      allocations: {
        'PUR-001': amount
      },
      idempotencyKey
    });

    expect(secondRun.success).toBe(true);
    expect(secondRun.payment.id).toBe(voucherId);

    // ZERO additional financial side effects:
    // Supplier balance must STILL be 1250 (NOT 1000)
    expect((await db.suppliers.get(supplierId))?.balance).toBe(1250);

    // Invoice paidAmount must STILL be 450 (NOT 700)
    expect((await db.invoices.get('PUR-001'))?.paidAmount).toBe(450);

    // Total vouchers must STILL be 1 (NOT 2)
    expect((await db.db.vouchers.toArray()).length).toBe(1);

    // Total financial transactions must STILL be 1 (NOT 2)
    expect((await db.db.financialTransactions.toArray()).length).toBe(1);

    // Total journal entries must STILL be 1 (NOT 2)
    expect((await db.db.journalEntries.toArray()).length).toBe(1);
  });
});
