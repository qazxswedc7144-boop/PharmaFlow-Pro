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
    await db.vouchers.clear();
    await db.invoices.clear();
    await db.suppliers.clear();
    await db.customers.clear();
    await db.financialTransactions.clear();
    await db.journalEntries.clear();
    await db.journalLines.clear();
    await db.accounts.clear();
    await db.idempotencyKeys.clear();
    await db.voucherInvoiceLinks.clear();
    await db.auditLogs.clear();

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
      const ftList = await db.financialTransactions.where('Reference_ID').equals(result.payment.id).toArray();
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
      const links = await db.voucherInvoiceLinks.where('voucherId').equals(result.payment.id).toArray();
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

    it('POSITIVE: exact verification of user example (Balance 1500, Invoice paid 200, Payment 350, Allocation 350 -> Balance 1150, Invoice paid 550)', async () => {
      await db.suppliers.put({
        id: 'SUP-EX-01',
        Supplier_Name: 'Exact Example Supplier',
        balance: 1500,
        tenantId
      } as any);

      await db.invoices.put({
        id: 'INV-EX-01',
        tenantId,
        partnerId: 'SUP-EX-01',
        totalAmount: 1000,
        paidAmount: 200,
        paymentStatus: 'PARTIAL',
        type: 'PURCHASE'
      } as any);

      const result = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: 'SUP-EX-01',
        amount: 350,
        allocations: {
          'INV-EX-01': 350
        }
      });

      expect(result.success).toBe(true);

      const supp = await db.suppliers.get('SUP-EX-01');
      expect(supp?.balance).toBe(1150);

      const inv = await db.invoices.get('INV-EX-01');
      expect(inv?.paidAmount).toBe(550);
    });

    it('NEGATIVE: zero mutation to Supplier Balance and Invoice Paid Amount if allocation or payment fails', async () => {
      await db.suppliers.put({
        id: 'SUP-FAIL-MUTATE-01',
        Supplier_Name: 'Mutation Test Supplier',
        balance: 1500,
        tenantId
      } as any);

      await db.invoices.put({
        id: 'INV-FAIL-MUTATE-01',
        tenantId,
        partnerId: 'SUP-FAIL-MUTATE-01',
        totalAmount: 1000,
        paidAmount: 200,
        paymentStatus: 'PARTIAL',
        type: 'PURCHASE'
      } as any);

      // Attempt over-allocation (fails validation)
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: 'SUP-FAIL-MUTATE-01',
          amount: 900,
          allocations: {
            'INV-FAIL-MUTATE-01': 900 // Exceeds remaining 800
          }
        })
      ).rejects.toThrow();

      // Verify ZERO mutation
      const supp = await db.suppliers.get('SUP-FAIL-MUTATE-01');
      expect(supp?.balance).toBe(1500);

      const inv = await db.invoices.get('INV-FAIL-MUTATE-01');
      expect(inv?.paidAmount).toBe(200);
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

      const ftCountFirst = (await db.financialTransactions.toArray()).length;
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

      const ftCountSecond = (await db.financialTransactions.toArray()).length;
      const jeCountSecond = (await db.journalEntries.toArray()).length;
      expect(ftCountSecond).toBe(1); // EXACTLY 1, not duplicated!
      expect(jeCountSecond).toBe(1); // EXACTLY 1, not duplicated!
    });

    it('NEGATIVE: rejects request when same idempotencyKey is used with a different payload', async () => {
      const idempotencyKey = 'IDEMP-RETRY-CONFLICT-TEST-01';

      // 1st Execution
      await db.suppliers.put({
        id: 'SUP-CONFLICT-01',
        Supplier_Name: 'Conflict Supplier',
        balance: 2000,
        tenantId
      } as any);

      await db.invoices.put({
        id: 'INV-CONFLICT-01',
        tenantId,
        partnerId: 'SUP-CONFLICT-01',
        totalAmount: 1000,
        paidAmount: 0,
        type: 'PURCHASE'
      } as any);

      const firstRes = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: 'SUP-CONFLICT-01',
        amount: 300,
        idempotencyKey,
        allocations: { 'INV-CONFLICT-01': 300 }
      });
      expect(firstRes.success).toBe(true);

      // 2nd Execution with SAME key but DIFFERENT payload (amount: 600 instead of 300)
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: 'SUP-CONFLICT-01',
          amount: 600,
          idempotencyKey,
          allocations: { 'INV-CONFLICT-01': 600 }
        })
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // 6. Failure Recovery & Atomicity Across All 6 Critical Stages
  // =========================================================================
  describe('6. Failure Recovery & Atomicity Across Critical Steps (6 Stages)', () => {
    const assertFullRollback = async (supplierId: string, initialBalance: number, invoiceId?: string, initialPaid = 0) => {
      await new Promise(r => setTimeout(r, 15));
      expect((await db.vouchers.toArray()).length).toBe(0);
      expect((await db.suppliers.get(supplierId))?.balance).toBe(initialBalance);
      if (invoiceId) {
        expect((await db.invoices.get(invoiceId))?.paidAmount).toBe(initialPaid);
      }
      expect((await db.voucherInvoiceLinks.toArray()).length).toBe(0);
      expect((await db.financialTransactions.toArray()).length).toBe(0);
      expect((await db.journalEntries.toArray()).length).toBe(0);
      expect((await db.journalLines.toArray()).length).toBe(0);
      const businessAuditLogs = (await db.auditLogs.toArray()).filter((l: any) => l.target_type !== 'DISTRIBUTED_LOCK');
      expect(businessAuditLogs.length).toBe(0);
    };

    it('Stage 1: AFTER_VOUCHER failure rolls back voucher and all records', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_VOUCHER';
      try {
        const supId = 'SUP-FAIL-VOUCHER';
        await db.suppliers.put({ id: supId, Supplier_Name: 'Fail Voucher', balance: 1000, tenantId } as any);
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
            partnerId: supId,
            amount: 200
          })
        ).rejects.toThrow(/SIMULATED_VOUCHER_FAILURE/i);
        await assertFullRollback(supId, 1000);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
    });

    it('Stage 2: AFTER_ALLOCATION failure rolls back allocations and all records', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_ALLOCATION';
      try {
        const supId = 'SUP-FAIL-ALLOC';
        const invId = 'INV-FAIL-ALLOC';
        await db.suppliers.put({ id: supId, Supplier_Name: 'Fail Alloc', balance: 1000, tenantId } as any);
        await db.invoices.put({ id: invId, tenantId, partnerId: supId, totalAmount: 500, paidAmount: 0, type: 'PURCHASE' } as any);
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
            partnerId: supId,
            amount: 200,
            allocations: { [invId]: 200 }
          })
        ).rejects.toThrow(/SIMULATED_ALLOCATION_FAILURE/i);
        await assertFullRollback(supId, 1000, invId, 0);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
    });

    it('Stage 3: AFTER_LINK failure rolls back voucher, link, and all records', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_LINK';
      try {
        const supId = 'SUP-FAIL-LINK';
        const invId = 'INV-FAIL-LINK';
        await db.suppliers.put({ id: supId, Supplier_Name: 'Fail Link', balance: 1000, tenantId } as any);
        await db.invoices.put({ id: invId, tenantId, partnerId: supId, totalAmount: 500, paidAmount: 0, type: 'PURCHASE' } as any);
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
            partnerId: supId,
            amount: 200,
            allocations: { [invId]: 200 }
          })
        ).rejects.toThrow(/SIMULATED_LINK_FAILURE/i);
        await assertFullRollback(supId, 1000, invId, 0);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
    });

    it('Stage 4: AFTER_BALANCE_UPDATE failure rolls back balance update and all records', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_BALANCE_UPDATE';
      try {
        const supId = 'SUP-FAIL-BAL';
        await db.suppliers.put({ id: supId, Supplier_Name: 'Fail Balance', balance: 1000, tenantId } as any);
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
            partnerId: supId,
            amount: 200
          })
        ).rejects.toThrow(/SIMULATED_BALANCE_UPDATE_FAILURE/i);
        await assertFullRollback(supId, 1000);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
    });

    it('Stage 5: AFTER_FT failure rolls back financial transaction and all records', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_FT';
      try {
        const supId = 'SUP-FAIL-FT';
        await db.suppliers.put({ id: supId, Supplier_Name: 'Fail FT', balance: 1000, tenantId } as any);
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
            partnerId: supId,
            amount: 250
          })
        ).rejects.toThrow(/SIMULATED_FT_FAILURE/i);
        await assertFullRollback(supId, 1000);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
    });

    it('Stage 6: AFTER_JOURNAL failure rolls back journal entry and all records', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_JOURNAL';
      try {
        const supId = 'SUP-FAIL-JE';
        await db.suppliers.put({ id: supId, Supplier_Name: 'Fail JE', balance: 1000, tenantId } as any);
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
            partnerId: supId,
            amount: 250
          })
        ).rejects.toThrow(/SIMULATED_JOURNAL_POSTING_FAILURE/i);
        await assertFullRollback(supId, 1000);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
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
