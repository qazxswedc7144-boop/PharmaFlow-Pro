import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnifiedBusinessWorkflowOrchestrator } from '@/services/orchestration/UnifiedBusinessWorkflowOrchestrator';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';
import { voucherWorkflow } from '@/features/accounting/workflows/VoucherWorkflow';
import { voucherCancellationWorkflow } from '@/features/accounting/workflows/VoucherCancellationWorkflow';
import { WorkflowOrchestrator } from '@/core/workflow';
import { useAuthStore } from '@/store/authStore';
import { db } from '@/core/db';
import { PurchaseRepository } from '@/database/repositories/PurchaseRepository';
import { FinancialTransactionRepository } from '@/database/repositories/FinancialTransactionRepository';
import { AccountingRepository } from '@/database/repositories/AccountingRepository';

describe('Supplier Payment: Financial Integrity & Atomicity Verification Suite', () => {
  const tenantId = 'TENANT-FIN-PROD-01';
  const branchId = 'BRH-FIN-MAIN-01';

  beforeEach(async () => {
    vi.clearAllMocks();
    IdempotencyRegistry.clearInMemory();

    // Clean tables
    await db.db.vouchers.clear();
    await db.db.invoices.clear();
    await db.db.suppliers.clear();
    await db.db.customers.clear();
    await db.db.financialTransactions.clear();
    await db.db.journalEntries.clear();
    await db.db.journalLines.clear();
    await db.db.accounts.clear();
    await db.db.idempotencyKeys.clear();
    await db.db.voucherInvoiceLinks.clear();

    // Ensure core chart of accounts exist for the tenant
    await db.accounts.put({
      id: 'ACC-CASH-01',
      code: '1010',
      name: 'الصندوق الرئيسي',
      type: 'Asset',
      balanceType: 'Debit',
      balance: 100000,
      debit: 100000,
      credit: 0,
      isSystem: true,
      isActive: true,
      tenantId,
      branchId
    } as any);

    await db.accounts.put({
      id: 'ACC-AP-01',
      code: '2010',
      name: 'الموردين - ذمم دائنة',
      type: 'Liability',
      balanceType: 'Credit',
      balance: 50000,
      debit: 0,
      credit: 50000,
      isSystem: true,
      isActive: true,
      tenantId,
      branchId
    } as any);

    // Setup authenticated trusted user
    useAuthStore.setState({
      user: {
        id: 'usr-accountant',
        tenantId,
        branchId,
        role: 'accountant',
        roles: ['accountant'],
        permissions: ['accounting.voucher.create', 'vouchers.create', 'vouchers.manage', 'vouchers.delete']
      } as any,
      tenantId,
      branchId,
      roles: ['accountant'],
      permissions: ['accounting.voucher.create', 'vouchers.create', 'vouchers.manage', 'vouchers.delete'],
      isAuthenticated: true
    });
  });

  // =========================================================================
  // 1. Amount > 0 Enforcement
  // =========================================================================
  describe('1. Amount > 0 Strict Financial Rule', () => {
    it('NEGATIVE: rejects payment when amount is 0', async () => {
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: 'SUP-001',
          amount: 0
        })
      ).rejects.toThrow(/مبلغ.*أكبر من الصفر/i);
    });

    it('NEGATIVE: rejects payment when amount is negative', async () => {
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: 'SUP-001',
          amount: -150
        })
      ).rejects.toThrow(/مبلغ.*أكبر من الصفر/i);
    });

    it('NEGATIVE: rejects payment when amount is NaN or non-finite', async () => {
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: 'SUP-001',
          amount: NaN
        })
      ).rejects.toThrow(/مبلغ.*أكبر من الصفر/i);

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: 'SUP-001',
          amount: Infinity
        })
      ).rejects.toThrow(/مبلغ.*أكبر من الصفر/i);
    });
  });

  // =========================================================================
  // 2. Over-Allocation Prevention
  // =========================================================================
  describe('2. Over-Allocation Prevention', () => {
    it('NEGATIVE: rejects when total allocations exceed payment amount', async () => {
      await db.suppliers.put({
        id: 'SUP-ALLOC-01',
        Supplier_Name: 'Test Supplier',
        balance: 2000,
        tenantId
      } as any);

      await db.invoices.put({
        id: 'INV-001',
        tenantId,
        partnerId: 'SUP-ALLOC-01',
        totalAmount: 1000,
        paidAmount: 0,
        type: 'PURCHASE'
      } as any);

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: 'SUP-ALLOC-01',
          amount: 500,
          allocations: {
            'INV-001': 700 // Exceeds payment amount of 500!
          }
        })
      ).rejects.toThrow(/OVER_ALLOCATION.*يتجاوز مبلغ سند الصرف/i);
    });

    it('NEGATIVE: rejects when allocated amount exceeds remaining invoice balance', async () => {
      await db.suppliers.put({
        id: 'SUP-ALLOC-02',
        Supplier_Name: 'Test Supplier',
        balance: 2000,
        tenantId
      } as any);

      // Invoice total 1000, already paid 800 -> remaining is 200
      await db.invoices.put({
        id: 'INV-002',
        tenantId,
        partnerId: 'SUP-ALLOC-02',
        totalAmount: 1000,
        paidAmount: 800,
        type: 'PURCHASE'
      } as any);

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: 'SUP-ALLOC-02',
          amount: 300,
          allocations: {
            'INV-002': 250 // Exceeds remaining owed of 200!
          }
        })
      ).rejects.toThrow(/OVER_ALLOCATION.*المبلغ المتبقي المستحق/i);
    });
  });

  // =========================================================================
  // 3. No Duplicate Allocation to Settled Invoices
  // =========================================================================
  describe('3. Duplicate Allocation Prevention', () => {
    it('NEGATIVE: rejects allocation to an invoice that is already fully paid', async () => {
      await db.suppliers.put({
        id: 'SUP-ALLOC-03',
        Supplier_Name: 'Test Supplier',
        balance: 1000,
        tenantId
      } as any);

      // Fully settled invoice: total 500, paid 500
      await db.invoices.put({
        id: 'INV-SETTLED-01',
        tenantId,
        partnerId: 'SUP-ALLOC-03',
        totalAmount: 500,
        paidAmount: 500,
        paymentStatus: 'PAID',
        type: 'PURCHASE'
      } as any);

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: 'SUP-ALLOC-03',
          amount: 200,
          allocations: {
            'INV-SETTLED-01': 100
          }
        })
      ).rejects.toThrow(/INVOICE_ALREADY_PAID/i);
    });
  });

  // =========================================================================
  // 4. Supplier Balance & Invoice Paid Amount Correctness
  // =========================================================================
  describe('4. Financial Balances & Double-Entry Integrity', () => {
    it('POSITIVE: accurately updates supplier balance, invoice paid amount, and records exact single FT and JE', async () => {
      await db.suppliers.put({
        id: 'SUP-BALANCE-01',
        Supplier_Name: 'Med Supply Corp',
        balance: 1500,
        tenantId
      } as any);

      await db.invoices.put({
        id: 'INV-BAL-01',
        tenantId,
        partnerId: 'SUP-BALANCE-01',
        totalAmount: 1000,
        paidAmount: 200,
        paymentStatus: 'PARTIAL',
        type: 'PURCHASE'
      } as any);

      const payAmount = 400;
      const opKey = 'KEY-FIN-PERFECT-01';

      const result = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: 'SUP-BALANCE-01',
        amount: payAmount,
        idempotencyKey: opKey,
        allocations: {
          'INV-BAL-01': payAmount
        }
      });

      expect(result.success).toBe(true);
      expect(result.payment.amount).toBe(payAmount);

      // 1. Supplier Balance check: 1500 - 400 = 1100
      const supp = await db.suppliers.get('SUP-BALANCE-01');
      expect(supp?.balance).toBe(1100);

      // 2. Invoice Paid Amount check: 200 + 400 = 600
      const inv = await db.invoices.get('INV-BAL-01');
      expect(inv?.paidAmount).toBe(600);
      expect(inv?.paymentStatus).toBe('PARTIAL');

      // 3. Exactly ONE Financial Transaction created
      const ftList = await db.db.financialTransactions.where('Reference_ID').equals(result.payment.id).toArray();
      expect(ftList.length).toBe(1);
      expect(ftList[0].Amount).toBe(payAmount);
      expect(ftList[0].Transaction_Type).toBe('Payment');
      expect(ftList[0].Direction).toBe('Debit');
      expect(ftList[0].tenantId).toBe(tenantId);
      expect(ftList[0].branchId).toBe(branchId);

      // 4. Exactly ONE Journal Entry created
      const jeList = await db.journalEntries.where('referenceId').equals(result.payment.id).toArray();
      expect(jeList.length).toBe(1);
      expect(jeList[0].TotalAmount).toBe(payAmount);
      expect(jeList[0].tenantId).toBe(tenantId);
      expect(jeList[0].branchId).toBe(branchId);

      // 5. Total Debit = Total Credit in Journal Lines
      const lines = await db.journalLines.where('entryId').equals(jeList[0].id).toArray();
      expect(lines.length).toBe(2);

      const totalDebit = lines.reduce((sum, l) => sum + (l.debit || 0), 0);
      const totalCredit = lines.reduce((sum, l) => sum + (l.credit || 0), 0);
      expect(totalDebit).toBe(payAmount);
      expect(totalCredit).toBe(payAmount);
      expect(totalDebit).toBe(totalCredit);

      // 6. Voucher Invoice Link record created
      const links = await db.db.voucherInvoiceLinks.where('voucherId').equals(result.payment.id).toArray();
      expect(links.length).toBe(1);
      expect(links[0].Paid_Amount).toBe(payAmount);
      expect(links[0].invoiceId).toBe('INV-BAL-01');
    });

    it('POSITIVE: full payment marks invoice as PAID and paidAmount never exceeds totalAmount', async () => {
      await db.suppliers.put({
        id: 'SUP-FULL-01',
        Supplier_Name: 'Full Meds Ltd',
        balance: 600,
        tenantId
      } as any);

      await db.invoices.put({
        id: 'INV-FULL-01',
        tenantId,
        partnerId: 'SUP-FULL-01',
        totalAmount: 600,
        paidAmount: 0,
        paymentStatus: 'UNPAID',
        type: 'PURCHASE'
      } as any);

      const result = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: 'SUP-FULL-01',
        amount: 600,
        allocations: {
          'INV-FULL-01': 600
        }
      });

      expect(result.success).toBe(true);

      const inv = await db.invoices.get('INV-FULL-01');
      expect(inv?.paidAmount).toBe(600);
      expect(inv?.paymentStatus).toBe('PAID');

      const supp = await db.suppliers.get('SUP-FULL-01');
      expect(supp?.balance).toBe(0);
    });
  });

  // =========================================================================
  // 5. Idempotent Retry Produces NO Extra Financial Effects
  // =========================================================================
  describe('5. Retry Idempotency & Zero Financial Side-Effects', () => {
    it('Duplicate execution with same key returns cached result without doubling balances, FTs, or JEs', async () => {
      await db.suppliers.put({
        id: 'SUP-RETRY-01',
        Supplier_Name: 'Retry Supplier',
        balance: 2000,
        tenantId
      } as any);

      await db.invoices.put({
        id: 'INV-RETRY-01',
        tenantId,
        partnerId: 'SUP-RETRY-01',
        totalAmount: 1000,
        paidAmount: 0,
        type: 'PURCHASE'
      } as any);

      const idempotencyKey = 'IDEMP-RETRY-FINANCIAL-TEST-01';

      // 1st Execution
      const firstRes = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: 'SUP-RETRY-01',
        amount: 500,
        idempotencyKey,
        allocations: {
          'INV-RETRY-01': 500
        }
      });

      expect(firstRes.success).toBe(true);

      const suppAfterFirst = await db.suppliers.get('SUP-RETRY-01');
      expect(suppAfterFirst?.balance).toBe(1500);

      const invAfterFirst = await db.invoices.get('INV-RETRY-01');
      expect(invAfterFirst?.paidAmount).toBe(500);

      const ftCountFirst = (await db.db.financialTransactions.toArray()).length;
      const jeCountFirst = (await db.journalEntries.toArray()).length;
      expect(ftCountFirst).toBe(1);
      expect(jeCountFirst).toBe(1);

      // 2nd Execution with EXACT SAME key (Simulating client retry)
      const secondRes = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: 'SUP-RETRY-01',
        amount: 500,
        idempotencyKey,
        allocations: {
          'INV-RETRY-01': 500
        }
      });

      expect(secondRes.success).toBe(true);
      expect(secondRes.payment.id).toBe(firstRes.payment.id);

      // Verify ZERO additional financial side-effects
      const suppAfterSecond = await db.suppliers.get('SUP-RETRY-01');
      expect(suppAfterSecond?.balance).toBe(1500); // NOT 1000!

      const invAfterSecond = await db.invoices.get('INV-RETRY-01');
      expect(invAfterSecond?.paidAmount).toBe(500); // NOT 1000!

      const ftCountSecond = (await db.db.financialTransactions.toArray()).length;
      const jeCountSecond = (await db.journalEntries.toArray()).length;
      expect(ftCountSecond).toBe(1); // EXACTLY 1, not duplicated!
      expect(jeCountSecond).toBe(1); // EXACTLY 1, not duplicated!
    });
  });

  // =========================================================================
  // 6. Failure Recovery & Atomicity Across All Critical Stages
  // =========================================================================
  describe('6. Failure Recovery & Atomicity Across Critical Steps', () => {
    it('Failure during allocation leaves zero partial records and rolls back', async () => {
      await db.suppliers.put({
        id: 'SUP-FAIL-01',
        Supplier_Name: 'Fail Test Supplier',
        balance: 1000,
        tenantId
      } as any);

      // Force failure during allocation by pointing to a non-existent invoice
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: 'SUP-FAIL-01',
          amount: 300,
          allocations: {
            'INV-NON-EXISTENT-99': 300
          }
        })
      ).rejects.toThrow(/INVOICE_NOT_FOUND/i);

      // Verify NO vouchers created
      const vouchers = await db.db.vouchers.toArray();
      expect(vouchers.length).toBe(0);

      // Verify supplier balance untouched
      const supp = await db.suppliers.get('SUP-FAIL-01');
      expect(supp?.balance).toBe(1000);

      // Verify NO financial transactions or journal entries
      const fts = await db.db.financialTransactions.toArray();
      expect(fts.length).toBe(0);
      const jes = await db.journalEntries.toArray();
      expect(jes.length).toBe(0);
    });

    it('Failure during FinancialTransaction throws and rolls back', async () => {
      await db.suppliers.put({
        id: 'SUP-FAIL-02',
        Supplier_Name: 'Fail FT Supplier',
        balance: 1000,
        tenantId
      } as any);

      // Mock FinancialTransactionRepository.record to fail
      const recordSpy = vi.spyOn(FinancialTransactionRepository, 'record').mockRejectedValueOnce(
        new Error('SIMULATED_FINANCIAL_TRANSACTION_FAILURE')
      );

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: 'SUP-FAIL-02',
          amount: 250
        })
      ).rejects.toThrow(/SIMULATED_FINANCIAL_TRANSACTION_FAILURE/i);

      // Dexie atomic boundary rolls back all preceding writes
      const vouchers = await db.db.vouchers.toArray();
      expect(vouchers.length).toBe(0);

      const supp = await db.suppliers.get('SUP-FAIL-02');
      expect(supp?.balance).toBe(1000);

      const fts = await db.db.financialTransactions.toArray();
      expect(fts.length).toBe(0);
      const jes = await db.journalEntries.toArray();
      expect(jes.length).toBe(0);

      recordSpy.mockRestore();
    });

    it('Failure during JournalEntry generation/posting throws and rolls back', async () => {
      await db.suppliers.put({
        id: 'SUP-FAIL-03',
        Supplier_Name: 'Fail JE Supplier',
        balance: 1000,
        tenantId
      } as any);

      // Mock AccountingRepository.addEntry to fail
      const addEntrySpy = vi.spyOn(AccountingRepository, 'addEntry').mockRejectedValueOnce(
        new Error('SIMULATED_JOURNAL_POSTING_FAILURE')
      );

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: 'SUP-FAIL-03',
          amount: 250
        })
      ).rejects.toThrow(/SIMULATED_JOURNAL_POSTING_FAILURE/i);

      // Dexie atomic boundary rolls back all preceding writes
      const vouchers = await db.db.vouchers.toArray();
      expect(vouchers.length).toBe(0);

      const supp = await db.suppliers.get('SUP-FAIL-03');
      expect(supp?.balance).toBe(1000);

      const fts = await db.db.financialTransactions.toArray();
      expect(fts.length).toBe(0);
      const jes = await db.journalEntries.toArray();
      expect(jes.length).toBe(0);

      addEntrySpy.mockRestore();
    });
  });

  // =========================================================================
  // 7. Voucher Cancellation Financial Balance Reversal
  // =========================================================================
  describe('7. Voucher Cancellation Financial Reversal', () => {
    it('Cancelling a payment accurately restores supplier balance and restores invoice unpaid status', async () => {
      await db.suppliers.put({
        id: 'SUP-CANCEL-01',
        Supplier_Name: 'Cancel Test Supplier',
        balance: 1000,
        tenantId
      } as any);

      await db.invoices.put({
        id: 'INV-CANCEL-01',
        tenantId,
        partnerId: 'SUP-CANCEL-01',
        totalAmount: 500,
        paidAmount: 0,
        type: 'PURCHASE'
      } as any);

      // Execute payment of 500
      const paymentRes = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: 'SUP-CANCEL-01',
        amount: 500,
        allocations: {
          'INV-CANCEL-01': 500
        }
      });

      expect(paymentRes.success).toBe(true);
      expect((await db.suppliers.get('SUP-CANCEL-01'))?.balance).toBe(500);
      expect((await db.invoices.get('INV-CANCEL-01'))?.paidAmount).toBe(500);

      // Cancel the voucher
      const cancelRes = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
        id: paymentRes.payment.id,
        type: 'PAYMENT',
        partnerId: 'SUP-CANCEL-01',
        amount: 500,
        reason: 'Client requested cancellation'
      });

      expect(cancelRes.success).toBe(true);

      // Supplier balance restored to original 1000!
      const restoredSupp = await db.suppliers.get('SUP-CANCEL-01');
      expect(restoredSupp?.balance).toBe(1000);

      // Invoice paid amount restored to 0 and status UNPAID!
      const restoredInv = await db.invoices.get('INV-CANCEL-01');
      expect(restoredInv?.paidAmount).toBe(0);
      expect(restoredInv?.paymentStatus).toBe('UNPAID');
    });
  });
});
