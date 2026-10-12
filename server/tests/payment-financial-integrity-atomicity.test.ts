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
    // Clear Dexie tables (including auditLogs for atomicity verification)
    await db.vouchers.clear();
    await db.journalEntries.clear();
    await db.journalLines.clear();
    await db.financialTransactions.clear();
    await db.invoices.clear();
    await db.suppliers.clear();
    await db.voucherInvoiceLinks.clear();
    await db.idempotencyRecords.clear();
    await db.auditLogs.clear();

    // CRITICAL: Ensure failure stage is reset before each test
    (globalThis as any).__FAIL_AT_STAGE__ = undefined;

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

  // =========================================================================
  // VALIDATION TESTS (No mutations)
  // =========================================================================

  it('1. amount <= 0 or invalid must fail validation and produce zero side effects', async () => {
    await expect(
      UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: supplierId,
        amount: 0
      })
    ).rejects.toThrow(/مبلغ السداد يجب أن يكون رقماً موجباً أكبر من الصفر|مبلغ السند يجب أن يكون أكبر من الصفر/i);

    await expect(
      UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: supplierId,
        amount: -150
      })
    ).rejects.toThrow(/مبلغ السداد يجب أن يكون رقماً موجباً أكبر من الصفر|مبلغ السند يجب أن يكون أكبر من الصفر/i);

    await expect(
      UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: supplierId,
        amount: NaN
      })
    ).rejects.toThrow(/مبلغ السداد يجب أن يكون رقماً موجباً أكبر من الصفر|مبلغ السند يجب أن يكون أكبر من الصفر/i);

    expect((await db.vouchers.toArray()).length).toBe(0);
    expect((await db.financialTransactions.toArray()).length).toBe(0);
    expect((await db.journalEntries.toArray()).length).toBe(0);
  });

  it('2. Over-allocation exceeding remaining invoice balance is strictly rejected', async () => {
    await expect(
      UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: supplierId,
        amount: 850,
        allocations: { 'PUR-001': 850 }
      })
    ).rejects.toThrow(/OVER_ALLOCATION/i);

    expect((await db.invoices.get('PUR-001'))?.paidAmount).toBe(200);
    expect((await db.suppliers.get(supplierId))?.balance).toBe(1500);
    expect((await db.vouchers.toArray()).length).toBe(0);
  });

  it('3. Allocation to an already fully paid invoice is strictly rejected', async () => {
    await expect(
      UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: supplierId,
        amount: 100,
        allocations: { 'PUR-002': 100 }
      })
    ).rejects.toThrow(/INVOICE_ALREADY_PAID/i);

    expect((await db.invoices.get('PUR-002'))?.paidAmount).toBe(500);
    expect((await db.invoices.get('PUR-002'))?.paymentStatus).toBe('PAID');
  });

  // =========================================================================
  // SUCCESS PATH TESTS
  // =========================================================================

  it('4 & 5. Successful payment correctly updates Supplier Balance and Invoice Paid Amount', async () => {
    const paymentAmount = 350;
    const result = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
      partnerId: supplierId,
      amount: paymentAmount,
      allocations: { 'PUR-001': paymentAmount },
      notes: 'Partial invoice settlement'
    });

    expect(result.success).toBe(true);
    expect(result.payment.id).toBeDefined();
    expect((await db.suppliers.get(supplierId))?.balance).toBe(1150);
    expect((await db.invoices.get('PUR-001'))?.paidAmount).toBe(550);
    expect((await db.invoices.get('PUR-001'))?.paymentStatus).toBe('PARTIAL');
  });

  it('6, 7, 8. Produces exactly ONE FinancialTransaction, ONE JournalEntry, and Balanced Lines', async () => {
    const paymentAmount = 400;
    const result = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
      partnerId: supplierId,
      amount: paymentAmount,
      notes: 'Authoritative financial records check'
    });

    expect(result.success).toBe(true);
    const voucherId = result.payment.id;

    const transactions = await db.financialTransactions.toArray();
    expect(transactions.length).toBe(1);
    expect(transactions[0].Reference_ID).toBe(voucherId);
    expect(transactions[0].Amount).toBe(paymentAmount);
    expect(transactions[0].tenantId).toBe(tenantId);

    const journalEntries = await db.journalEntries.toArray();
    expect(journalEntries.length).toBe(1);
    expect(journalEntries[0].referenceId).toBe(voucherId);

    const lines = await db.journalLines.where('entryId').equals(journalEntries[0].id).toArray();
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const totalDebit = lines.reduce((acc, l) => acc + (Number(l.debit) || 0), 0);
    const totalCredit = lines.reduce((acc, l) => acc + (Number(l.credit) || 0), 0);
    expect(Math.round(totalDebit * 100) / 100).toBe(paymentAmount);
    expect(Math.round(totalCredit * 100) / 100).toBe(paymentAmount);
  });

  // =========================================================================
  // ATOMICITY TESTS — 6 Real Failure Stages (Post-Mutation Rollback)
  // =========================================================================

  /**
   * Helper: verifies complete rollback after a mid-transaction failure.
   * Confirms ALL relevant tables returned to their pre-transaction state.
   */
  async function assertFullRollback() {
    // 1. Voucher must not exist
    expect((await db.vouchers.toArray()).length).toBe(0);

    // 2. Invoice PUR-001 must be UNCHANGED (paidAmount still 200)
    expect((await db.invoices.get('PUR-001'))?.paidAmount).toBe(200);

    // 3. Supplier balance must be UNCHANGED (still 1500)
    expect((await db.suppliers.get(supplierId))?.balance).toBe(1500);

    // 4. VoucherInvoiceLink must be rolled back
    expect((await db.voucherInvoiceLinks.toArray()).length).toBe(0);

    // 5. FinancialTransaction must not exist
    expect((await db.financialTransactions.toArray()).length).toBe(0);

    // 6. JournalEntry must not exist
    expect((await db.journalEntries.toArray()).length).toBe(0);

    // 7. JournalLine must not exist
    expect((await db.journalLines.toArray()).length).toBe(0);

    // 8. AuditLog must be rolled back (since addAuditLog now uses tx)
    expect((await db.auditLogs.toArray()).length).toBe(0);
  }

  it('9a. Atomicity: Failure AFTER_VOUCHER rolls back entire payment', async () => {
    (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_VOUCHER';
    try {
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: supplierId,
          amount: 200,
          allocations: { 'PUR-001': 200 }
        })
      ).rejects.toThrow(/SIMULATED_VOUCHER_FAILURE/i);

      await assertFullRollback();
    } finally {
      (globalThis as any).__FAIL_AT_STAGE__ = undefined;
    }
  });

  it('9b. Atomicity: Failure AFTER_ALLOCATION rolls back entire payment', async () => {
    (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_ALLOCATION';
    try {
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: supplierId,
          amount: 200,
          allocations: { 'PUR-001': 200 }
        })
      ).rejects.toThrow(/SIMULATED_ALLOCATION_FAILURE/i);

      await assertFullRollback();
    } finally {
      (globalThis as any).__FAIL_AT_STAGE__ = undefined;
    }
  });

  it('9c. Atomicity: Failure AFTER_LINK rolls back entire payment', async () => {
    (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_LINK';
    try {
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: supplierId,
          amount: 200,
          allocations: { 'PUR-001': 200 }
        })
      ).rejects.toThrow(/SIMULATED_LINK_FAILURE/i);

      await assertFullRollback();
    } finally {
      (globalThis as any).__FAIL_AT_STAGE__ = undefined;
    }
  });

  it('9d. Atomicity: Failure AFTER_BALANCE_UPDATE rolls back entire payment', async () => {
    (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_BALANCE_UPDATE';
    try {
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: supplierId,
          amount: 200,
          allocations: { 'PUR-001': 200 }
        })
      ).rejects.toThrow(/SIMULATED_BALANCE_UPDATE_FAILURE/i);

      await assertFullRollback();
    } finally {
      (globalThis as any).__FAIL_AT_STAGE__ = undefined;
    }
  });

  it('9e. Atomicity: Failure AFTER_FT rolls back entire payment', async () => {
    (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_FT';
    try {
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: supplierId,
          amount: 200,
          allocations: { 'PUR-001': 200 }
        })
      ).rejects.toThrow(/SIMULATED_FT_FAILURE/i);

      await assertFullRollback();
    } finally {
      (globalThis as any).__FAIL_AT_STAGE__ = undefined;
    }
  });

  it('9f. Atomicity: Failure AFTER_JOURNAL rolls back entire payment', async () => {
    (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_JOURNAL';
    try {
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: supplierId,
          amount: 200,
          allocations: { 'PUR-001': 200 }
        })
      ).rejects.toThrow(/SIMULATED_JOURNAL_POSTING_FAILURE/i);

      await assertFullRollback();
    } finally {
      (globalThis as any).__FAIL_AT_STAGE__ = undefined;
    }
  });

  // =========================================================================
  // IDEMPOTENCY / RETRY TESTS
  // =========================================================================

  it('10. Retrying an already committed payment yields identical result with zero extra financial side-effects', async () => {
    const idempotencyKey = 'PAYMENT-IDEMP-RETRY-001';
    const amount = 250;

    const firstRun = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
      partnerId: supplierId,
      amount,
      allocations: { 'PUR-001': amount },
      idempotencyKey
    });

    expect(firstRun.success).toBe(true);
    const voucherId = firstRun.payment.id;

    expect((await db.suppliers.get(supplierId))?.balance).toBe(1250);
    expect((await db.invoices.get('PUR-001'))?.paidAmount).toBe(450);
    expect((await db.vouchers.toArray()).length).toBe(1);
    expect((await db.financialTransactions.toArray()).length).toBe(1);
    expect((await db.journalEntries.toArray()).length).toBe(1);

    const secondRun = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
      partnerId: supplierId,
      amount,
      allocations: { 'PUR-001': amount },
      idempotencyKey
    });

    expect(secondRun.success).toBe(true);
    expect(secondRun.payment.id).toBe(voucherId);
    expect((await db.suppliers.get(supplierId))?.balance).toBe(1250);
    expect((await db.invoices.get('PUR-001'))?.paidAmount).toBe(450);
    expect((await db.vouchers.toArray()).length).toBe(1);
    expect((await db.financialTransactions.toArray()).length).toBe(1);
    expect((await db.journalEntries.toArray()).length).toBe(1);
  });
});
