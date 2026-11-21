import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { voucherCancellationWorkflow } from '@/features/accounting/workflows/VoucherCancellationWorkflow';
import { AccountingRepository } from '@/database/repositories/AccountingRepository';
import { AuditService } from '@/services/system/AuditService';
import { ProjectionEventBus } from '@/services/system/ProjectionEventBus';
import { TransactionBoundary } from '@/core/integrity/transactionBoundary';
import { WorkflowOrchestrator } from '@/core/workflow';
import { useAuthStore } from '@/store/authStore';
import { db } from '@/core/db';

interface FullDbSnapshot {
  vouchers: any[];
  receipts: any[];
  payments: any[];
  customers: any[];
  suppliers: any[];
  invoices: any[];
  voucherInvoiceLinks: any[];
  journalEntries: any[];
  journalLines: any[];
  accounts: any[];
  auditLogs: any[];
  projectionEvents: any[];
}

async function captureDbSnapshot(): Promise<FullDbSnapshot> {
  const sortById = (rows: any[]) =>
    [...rows].sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));

  return {
    vouchers: sortById(await db.vouchers.toArray()),
    receipts: sortById(await db.receipts.toArray()),
    payments: sortById(await db.payments.toArray()),
    customers: sortById(await db.customers.toArray()),
    suppliers: sortById(await db.suppliers.toArray()),
    invoices: sortById(await db.invoices.toArray()),
    voucherInvoiceLinks: sortById(await db.voucherInvoiceLinks.toArray()),
    journalEntries: sortById(await db.journalEntries.toArray()),
    journalLines: sortById(await db.journalLines.toArray()),
    accounts: sortById(await db.accounts.toArray()),
    auditLogs: sortById(
      (await db.auditLogs.toArray()).filter((a: any) => a.module === 'VOUCHERS')
    ),
    projectionEvents: sortById(
      (await db.projectionEvents.toArray()).filter((e: any) => e.eventType === 'VOUCHER_CANCELLED')
    )
  };
}

describe('Voucher Cancellation Hardening & Financial Integrity Suite', () => {
  const tenantId = 'TENANT-VOUCHER-HARDEN-01';
  const branchId = 'BRH-VOUCHER-MAIN-01';

  const seedCompleteReceiptFixture = async (opts?: {
    id?: string;
    partnerId?: string;
    amount?: number;
    invoiceId?: string;
    journalId?: string;
    reverseJournalLineOrder?: boolean;
  }) => {
    const id = opts?.id ?? 'RCPT-FULL-01';
    const partnerId = opts?.partnerId ?? 'CUST-FULL-01';
    const amount = opts?.amount ?? 400;
    const invoiceId = opts?.invoiceId ?? 'INV-FULL-01';
    const journalId = opts?.journalId ?? `JE-${id}`;

    await db.vouchers.put({
      id,
      type: 'RECEIPT',
      partnerId,
      amount,
      date: '2026-01-15',
      paymentMethod: 'CASH',
      tenantId,
      branchId
    } as any);

    await db.receipts.put({
      id,
      type: 'RECEIPT',
      customer_id: partnerId,
      partnerId,
      amount,
      date: '2026-01-15',
      tenantId,
      branchId
    } as any);

    if (partnerId !== 'عميل نقدي') {
      await db.customers.put({
        id: partnerId,
        name: 'عميل اختبار متكامل',
        balance: 1000,
        tenantId,
        branchId
      } as any);
    }

    await db.invoices.put({
      id: invoiceId,
      totalAmount: 1000,
      finalTotal: 1000,
      paidAmount: amount,
      paymentStatus: 'PARTIAL',
      tenantId,
      branchId
    } as any);

    await db.voucherInvoiceLinks.put({
      id: `LINK-${id}`,
      voucherId: id,
      invoiceId,
      Paid_Amount: amount,
      tenantId,
      branchId
    } as any);

    const inlineLines = [
      { id: `${journalId}-L1`, entryId: journalId, accountId: 'ACC-101', debit: amount, credit: 0 },
      { id: `${journalId}-L2`, entryId: journalId, accountId: 'ACC-103', debit: 0, credit: amount }
    ];

    await db.journalEntries.put({
      id: journalId,
      sourceId: id,
      sourceType: 'RECEIPT',
      date: '2026-01-15',
      tenantId,
      branchId,
      lines: inlineLines
    } as any);

    const persistedLines = opts?.reverseJournalLineOrder
      ? [...inlineLines].reverse()
      : inlineLines;

    for (const line of persistedLines) {
      await db.journalLines.put({
        ...line,
        entry_id: journalId,
        account_id: line.accountId,
        tenantId,
        branchId
      } as any);
    }

    return { id, partnerId, amount, invoiceId, journalId };
  };

  beforeEach(async () => {
    vi.restoreAllMocks();

    useAuthStore.setState({
      user: {
        id: 'usr-accountant',
        tenantId,
        branchId,
        role: 'accountant',
        roles: ['accountant'],
        permissions: ['vouchers.manage', 'vouchers.delete']
      } as any,
      tenantId,
      branchId,
      roles: ['accountant'],
      permissions: ['vouchers.manage', 'vouchers.delete'],
      isAuthenticated: true
    });

    await db.vouchers.clear();
    await db.receipts.clear();
    await db.payments.clear();
    await db.suppliers.clear();
    await db.customers.clear();
    await db.invoices.clear();
    await db.journalEntries.clear();
    await db.journalLines.clear();
    await db.accounts.clear();
    await db.voucherInvoiceLinks.clear();
    await db.auditLogs.clear();
    await db.projectionEvents.clear();
    await db.idempotencyKeys.clear();

    await db.accounts.put({
      id: 'ACC-101',
      code: '101',
      name: 'الصندوق',
      type: 'Asset',
      balanceType: 'Debit',
      balance: 10000,
      tenantId,
      branchId
    } as any);

    await db.accounts.put({
      id: 'ACC-103',
      code: '103',
      name: 'العملاء',
      type: 'Asset',
      balanceType: 'Debit',
      balance: 5000,
      tenantId,
      branchId
    } as any);

    await db.accounts.put({
      id: 'ACC-201',
      code: '201',
      name: 'الموردين',
      type: 'Liability',
      balanceType: 'Credit',
      balance: 3000,
      tenantId,
      branchId
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Missing persisted journal lines
  it('1. Rejects cancellation when persisted journalLines are missing despite inline entry.lines', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-NO-PERSISTED-JL' });
    await db.journalLines.where('entryId').equals(fixture.journalId).delete();

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/PERSISTED_JOURNAL_LINES_MISSING/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 2. Missing inline journal lines
  it('2. Rejects cancellation when inline entry.lines are missing despite persisted journalLines', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-NO-INLINE-JL' });
    await db.journalEntries.update(fixture.journalId, { lines: [] } as any);

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/INLINE_JOURNAL_LINES_MISSING/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 3. Mismatched journal line account IDs & order-independent valid comparison
  it('3a. Rejects cancellation when persisted journalLines account IDs mismatch inline entry.lines', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-ACC-MISMATCH' });
    await db.journalLines.update(`${fixture.journalId}-L2`, {
      accountId: 'ACC-201',
      account_id: 'ACC-201'
    } as any);

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/JOURNAL_LINE_DATA_MISMATCH/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  it('3b. Accepts valid journal lines returned in a different order than inline entry.lines', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-REORDERED-JL',
      amount: 250,
      reverseJournalLineOrder: true
    });

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(true);
    expect(await db.vouchers.get(fixture.id)).toBeUndefined();
    expect(await db.receipts.get(fixture.id)).toBeUndefined();
    expect(await db.journalEntries.get(fixture.journalId)).toBeUndefined();
    expect(await db.journalLines.where('entryId').equals(fixture.journalId).count()).toBe(0);
    expect((await db.accounts.get('ACC-101'))?.balance).toBe(9750);
    expect((await db.accounts.get('ACC-103'))?.balance).toBe(5250);
    expect((await db.customers.get(fixture.partnerId))?.balance).toBe(1250);
    expect((await db.invoices.get(fixture.invoiceId))?.paidAmount).toBe(0);
    expect((await db.invoices.get(fixture.invoiceId))?.paymentStatus).toBe('UNPAID');
    expect(await db.voucherInvoiceLinks.where('voucherId').equals(fixture.id).count()).toBe(0);
    const voucherAudits = (await db.auditLogs.toArray()).filter((a: any) => a.module === 'VOUCHERS');
    const voucherEvents = (await db.projectionEvents.toArray()).filter((e: any) => e.eventType === 'VOUCHER_CANCELLED');
    expect(voucherAudits).toHaveLength(1);
    expect(voucherEvents).toHaveLength(1);
  });

  // 4. Mismatched debit/credit amounts & invalid/generic account IDs
  it('4a. Rejects cancellation when persisted journalLines debit/credit amounts mismatch inline lines', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-AMT-MISMATCH-JL' });
    await db.journalLines.update(`${fixture.journalId}-L1`, { debit: 390 } as any);

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/JOURNAL_LINE_DATA_MISMATCH/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  it('4b. Rejects journal lines with NaN amounts or ACC-GENERIC fallback account', async () => {
    const fixtureNaN = await seedCompleteReceiptFixture({ id: 'RCPT-NAN-JL', invoiceId: 'INV-NAN-JL' });
    await db.journalEntries.update(fixtureNaN.journalId, {
      lines: [
        { id: `${fixtureNaN.journalId}-L1`, entryId: fixtureNaN.journalId, accountId: 'ACC-101', debit: Number.NaN, credit: 0 },
        { id: `${fixtureNaN.journalId}-L2`, entryId: fixtureNaN.journalId, accountId: 'ACC-103', debit: 0, credit: 400 }
      ]
    } as any);
    await db.journalLines.update(`${fixtureNaN.journalId}-L1`, { debit: Number.NaN } as any);

    const beforeNaN = await captureDbSnapshot();
    const resNaN = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixtureNaN.id,
      type: 'RECEIPT',
      partnerId: fixtureNaN.partnerId,
      amount: fixtureNaN.amount
    });

    expect(resNaN.success).toBe(false);
    expect(resNaN.error?.message).toMatch(/INVALID_JOURNAL_AMOUNTS/i);
    expect(await captureDbSnapshot()).toEqual(beforeNaN);

    const fixtureGeneric = await seedCompleteReceiptFixture({
      id: 'RCPT-GENERIC-ACC',
      partnerId: 'CUST-GEN-01',
      invoiceId: 'INV-GEN-01'
    });
    await db.journalEntries.update(fixtureGeneric.journalId, {
      lines: [
        { id: `${fixtureGeneric.journalId}-L1`, entryId: fixtureGeneric.journalId, accountId: 'ACC-GENERIC', debit: 400, credit: 0 },
        { id: `${fixtureGeneric.journalId}-L2`, entryId: fixtureGeneric.journalId, accountId: 'ACC-103', debit: 0, credit: 400 }
      ]
    } as any);
    await db.journalLines.update(`${fixtureGeneric.journalId}-L1`, {
      accountId: 'ACC-GENERIC',
      account_id: 'ACC-GENERIC'
    } as any);

    const beforeGeneric = await captureDbSnapshot();
    const resGeneric = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixtureGeneric.id,
      type: 'RECEIPT',
      partnerId: fixtureGeneric.partnerId,
      amount: fixtureGeneric.amount
    });

    expect(resGeneric.success).toBe(false);
    expect(resGeneric.error?.message).toMatch(/INVALID_ACCOUNT_ID/i);
    expect(await captureDbSnapshot()).toEqual(beforeGeneric);
  });

  // 5. Unbalanced journal entry
  it('5. Rejects cancellation when linked journal entry is unbalanced', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-UNBALANCED' });
    const unbalancedLines = [
      { id: `${fixture.journalId}-L1`, entryId: fixture.journalId, accountId: 'ACC-101', debit: 400, credit: 0 },
      { id: `${fixture.journalId}-L2`, entryId: fixture.journalId, accountId: 'ACC-103', debit: 0, credit: 350 }
    ];
    await db.journalEntries.update(fixture.journalId, { lines: unbalancedLines } as any);
    await db.journalLines.update(`${fixture.journalId}-L2`, { credit: 350 } as any);

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/UNBALANCED_JOURNAL_ENTRY/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 6. Missing account
  it('6. Rejects cancellation when journal line references a missing account and rolls back all tables', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-MISSING-ACC' });
    const badLines = [
      { id: `${fixture.journalId}-L1`, entryId: fixture.journalId, accountId: 'ACC-101', debit: 400, credit: 0 },
      { id: `${fixture.journalId}-L2`, entryId: fixture.journalId, accountId: 'ACC-NONEXISTENT', debit: 0, credit: 400 }
    ];
    await db.journalEntries.update(fixture.journalId, { lines: badLines } as any);
    await db.journalLines.update(`${fixture.journalId}-L2`, {
      accountId: 'ACC-NONEXISTENT',
      account_id: 'ACC-NONEXISTENT'
    } as any);

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/ACCOUNT_NOT_FOUND/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 7. Missing or inconsistent persisted voucher amount (never fall back to input.amount)
  it('7. Rejects cancellation when persisted voucher amount is missing or inconsistent across tables', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-NO-AMOUNT' });
    await db.vouchers.update(fixture.id, { amount: undefined } as any);
    await db.receipts.update(fixture.id, { amount: undefined } as any);

    const beforeMissing = await captureDbSnapshot();
    const resMissing = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: 400
    });

    expect(resMissing.success).toBe(false);
    expect(resMissing.error?.message).toMatch(/VOUCHER_AMOUNT_MISSING_OR_INVALID/i);
    expect(await captureDbSnapshot()).toEqual(beforeMissing);

    // Restore voucher amount to 400, corrupt receipt amount to 450
    await db.vouchers.update(fixture.id, { amount: 400 } as any);
    await db.receipts.update(fixture.id, { amount: 450 } as any);

    const beforeConflict = await captureDbSnapshot();
    const resConflict = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: 400
    });

    expect(resConflict.success).toBe(false);
    expect(resConflict.error?.message).toMatch(/VOUCHER_AMOUNT_INCONSISTENT/i);
    expect(await captureDbSnapshot()).toEqual(beforeConflict);
  });

  // 8. NaN, Infinity, 0, and negative input amounts
  it('8. Rejects NaN, Infinity, -Infinity, 0, and negative input amounts with zero DB mutations', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-BAD-INPUT-AMT' });
    const before = await captureDbSnapshot();

    for (const invalidAmount of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -100]) {
      const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
        id: fixture.id,
        type: 'RECEIPT',
        partnerId: fixture.partnerId,
        amount: invalidAmount
      });

      expect(res.success).toBe(false);
      expect(res.error?.message).toMatch(/INVALID_VOUCHER_AMOUNT/i);
    }

    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 9. Voucher type mismatch & partner mismatch
  it('9. Rejects voucher type mismatch and partner mismatch with full rollback', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-TYPE-PARTNER' });
    const before = await captureDbSnapshot();

    const resTypeMismatch = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'PAYMENT', // Stored as RECEIPT
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });
    expect(resTypeMismatch.success).toBe(false);
    expect(resTypeMismatch.error?.message).toMatch(/VOUCHER_TYPE_MISMATCH/i);

    const resPartnerMismatch = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: 'CUST-OTHER-99',
      amount: fixture.amount
    });
    expect(resPartnerMismatch.success).toBe(false);
    expect(resPartnerMismatch.error?.message).toMatch(/VOUCHER_PARTNER_MISMATCH/i);

    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 10. Missing customer, missing supplier, and valid cash customer/supplier preservation
  it('10a. Rejects cancellation when customer or supplier is missing', async () => {
    const receiptFixture = await seedCompleteReceiptFixture({
      id: 'RCPT-NO-CUST',
      partnerId: 'CUST-MISSING'
    });
    await db.customers.delete('CUST-MISSING');

    const beforeReceipt = await captureDbSnapshot();
    const resReceipt = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: receiptFixture.id,
      type: 'RECEIPT',
      partnerId: 'CUST-MISSING',
      amount: receiptFixture.amount
    });
    expect(resReceipt.success).toBe(false);
    expect(resReceipt.error?.message).toMatch(/CUSTOMER_NOT_FOUND/i);
    expect(await captureDbSnapshot()).toEqual(beforeReceipt);

    await db.vouchers.put({
      id: 'PAY-NO-SUPP',
      type: 'PAYMENT',
      partnerId: 'SUPP-MISSING',
      amount: 300,
      tenantId,
      branchId
    } as any);
    await db.payments.put({
      id: 'PAY-NO-SUPP',
      type: 'PAYMENT',
      supplier_id: 'SUPP-MISSING',
      partnerId: 'SUPP-MISSING',
      amount: 300,
      tenantId,
      branchId
    } as any);

    const beforePayment = await captureDbSnapshot();
    const resPayment = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: 'PAY-NO-SUPP',
      type: 'PAYMENT',
      partnerId: 'SUPP-MISSING',
      amount: 300
    });
    expect(resPayment.success).toBe(false);
    expect(resPayment.error?.message).toMatch(/SUPPLIER_NOT_FOUND/i);
    expect(await captureDbSnapshot()).toEqual(beforePayment);
  });

  it('10b. Preserves cash customer (عميل نقدي) and cash supplier (مورد نقدي) cancellation without partner table rows', async () => {
    const cashReceipt = await seedCompleteReceiptFixture({
      id: 'RCPT-CASH-01',
      partnerId: 'عميل نقدي',
      amount: 150,
      invoiceId: 'INV-CASH-01'
    });

    const resCashReceipt = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: cashReceipt.id,
      type: 'RECEIPT',
      partnerId: 'عميل نقدي',
      amount: 150
    });
    expect(resCashReceipt.success).toBe(true);
    expect(await db.vouchers.get(cashReceipt.id)).toBeUndefined();
    expect((await db.accounts.get('ACC-101'))?.balance).toBe(9850);

    await db.vouchers.put({
      id: 'PAY-CASH-01',
      type: 'PAYMENT',
      partnerId: 'مورد نقدي',
      amount: 200,
      tenantId,
      branchId
    } as any);
    await db.journalEntries.put({
      id: 'JE-PAY-CASH-01',
      sourceId: 'PAY-CASH-01',
      tenantId,
      branchId,
      lines: [
        { id: 'JE-PAY-CASH-L1', entryId: 'JE-PAY-CASH-01', accountId: 'ACC-201', debit: 200, credit: 0 },
        { id: 'JE-PAY-CASH-L2', entryId: 'JE-PAY-CASH-01', accountId: 'ACC-101', debit: 0, credit: 200 }
      ]
    } as any);
    await db.journalLines.bulkPut([
      { id: 'JE-PAY-CASH-L1', entryId: 'JE-PAY-CASH-01', accountId: 'ACC-201', debit: 200, credit: 0, tenantId, branchId },
      { id: 'JE-PAY-CASH-L2', entryId: 'JE-PAY-CASH-01', accountId: 'ACC-101', debit: 0, credit: 200, tenantId, branchId }
    ] as any);

    const resCashPayment = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: 'PAY-CASH-01',
      type: 'PAYMENT',
      partnerId: 'مورد نقدي',
      amount: 200
    });
    expect(resCashPayment.success).toBe(true);
    expect(await db.vouchers.get('PAY-CASH-01')).toBeUndefined();
    expect((await db.accounts.get('ACC-101'))?.balance).toBe(10050);
    expect((await db.accounts.get('ACC-201'))?.balance).toBe(2800);
  });

  // 11. Invoice allocation restoration failure
  it('11. Rolls back all mutations when linked invoice is missing during allocation restoration', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-MISSING-INV' });
    await db.invoices.delete(fixture.invoiceId);

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/INVOICE_NOT_FOUND/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 12 & 13. Journal deletion failure & complete rollback across all affected tables
  it('12. Rolls back every affected table when journal deletion fails mid-transaction', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-JE-DEL-FAIL' });
    const before = await captureDbSnapshot();

    vi.spyOn(AccountingRepository, 'deleteEntry').mockRejectedValueOnce(
      new Error('SIMULATED_JOURNAL_DELETE_FAILURE')
    );

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/SIMULATED_JOURNAL_DELETE_FAILURE/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  it('12b. Rolls back account balances, journal entry, invoice, customer, and voucher when journalLines delete fails mid-deleteEntry', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-JL-DEL-MIDFAIL' });
    const before = await captureDbSnapshot();

    const originalExecuteAtomic = TransactionBoundary.executeAtomic.bind(TransactionBoundary);
    vi.spyOn(TransactionBoundary, 'executeAtomic').mockImplementationOnce(async (tables, op) => {
      return originalExecuteAtomic(tables, async (tx: any) => {
        const originalTable = tx.table.bind(tx);
        const wrappedTx = Object.create(tx);
        wrappedTx.table = (name: string) => {
          const tbl = originalTable(name);
          if (name === 'journalLines') {
            return new Proxy(tbl, {
              get(target, prop, receiver) {
                if (prop === 'where') {
                  return (...args: any[]) => {
                    const col = target.where(...args);
                    return new Proxy(col, {
                      get(cTarget, cProp, cReceiver) {
                        if (cProp === 'equals') {
                          return (...eqArgs: any[]) => {
                            const eqCol = cTarget.equals(...eqArgs);
                            return new Proxy(eqCol, {
                              get(eTarget, eProp, eReceiver) {
                                if (eProp === 'delete') {
                                  return async () => {
                                    throw new Error('SIMULATED_JOURNAL_LINES_DELETE_ABORT');
                                  };
                                }
                                const val = Reflect.get(eTarget, eProp, eReceiver);
                                return typeof val === 'function' ? val.bind(eTarget) : val;
                              }
                            });
                          };
                        }
                        const val = Reflect.get(cTarget, cProp, cReceiver);
                        return typeof val === 'function' ? val.bind(cTarget) : val;
                      }
                    });
                  };
                }
                const val = Reflect.get(target, prop, receiver);
                return typeof val === 'function' ? val.bind(target) : val;
              }
            });
          }
          return tbl;
        };
        return await op(wrappedTx);
      });
    });

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/SIMULATED_JOURNAL_LINES_DELETE_ABORT/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 14. Duplicate sequential cancellation
  it('14. Rejects duplicate sequential cancellation without duplicating reversals', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-SEQ-DUP', amount: 400 });

    const res1 = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });
    expect(res1.success).toBe(true);

    const afterFirst = await captureDbSnapshot();

    const res2 = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });
    expect(res2.success).toBe(false);
    expect(res2.error?.message).toMatch(/غير موجود/i);

    expect(await captureDbSnapshot()).toEqual(afterFirst);
  });

  // 15. Concurrent cancellation attempts
  it('15. Prevents duplicate reversal on concurrent cancellation attempts for the same voucher', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-CONCURRENT-01', amount: 350 });

    const [resA, resB] = await Promise.all([
      WorkflowOrchestrator.execute(
        voucherCancellationWorkflow,
        {
          id: fixture.id,
          type: 'RECEIPT',
          partnerId: fixture.partnerId,
          amount: fixture.amount
        },
        { idempotencyKey: 'CONC-CANCEL-KEY-A' }
      ),
      WorkflowOrchestrator.execute(
        voucherCancellationWorkflow,
        {
          id: fixture.id,
          type: 'RECEIPT',
          partnerId: fixture.partnerId,
          amount: fixture.amount
        },
        { idempotencyKey: 'CONC-CANCEL-KEY-B' }
      )
    ]);

    const successes = [resA, resB].filter((r) => r.success);
    const failures = [resA, resB].filter((r) => !r.success);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].error?.message).toMatch(/غير موجود|Double Cancellation/i);

    // Balances and invoice allocations restored strictly ONCE
    expect((await db.customers.get(fixture.partnerId))?.balance).toBe(1350);
    expect((await db.accounts.get('ACC-101'))?.balance).toBe(9650);
    expect((await db.accounts.get('ACC-103'))?.balance).toBe(5350);
    expect((await db.invoices.get(fixture.invoiceId))?.paidAmount).toBe(0);
    expect(await db.voucherInvoiceLinks.where('voucherId').equals(fixture.id).count()).toBe(0);
    expect(await db.journalEntries.where('sourceId').equals(fixture.id).count()).toBe(0);
    expect(await db.journalLines.where('entryId').equals(fixture.journalId).count()).toBe(0);
    const voucherAudits = (await db.auditLogs.toArray()).filter((a: any) => a.module === 'VOUCHERS');
    const voucherEvents = (await db.projectionEvents.toArray()).filter((e: any) => e.eventType === 'VOUCHER_CANCELLED');
    expect(voucherAudits).toHaveLength(1);
    expect(voucherEvents).toHaveLength(1);
  });

  // 16. Audit and projection failure behavior
  it('16a. Rolls back all financial changes when AuditService.log fails', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-AUDIT-FAIL' });
    const before = await captureDbSnapshot();

    vi.spyOn(AuditService, 'log').mockRejectedValueOnce(new Error('SIMULATED_AUDIT_FAILURE'));

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/SIMULATED_AUDIT_FAILURE/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  it('16b. Rolls back all financial changes and audit log when ProjectionEventBus.publish fails', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-PROJ-FAIL' });
    const before = await captureDbSnapshot();

    const originalPublish = ProjectionEventBus.publish.bind(ProjectionEventBus);
    vi.spyOn(ProjectionEventBus, 'publish').mockImplementation(
      async (eventType, aggregateId, payload, tx) => {
        if (eventType === 'VOUCHER_CANCELLED') {
          throw new Error('SIMULATED_PROJECTION_FAILURE');
        }
        return originalPublish(eventType, aggregateId, payload, tx);
      }
    );

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/SIMULATED_PROJECTION_FAILURE/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  it('16c. Real AuditService.log and ProjectionEventBus.publish propagate tx write errors and trigger full rollback', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-REAL-PROJ-TX-FAIL' });
    const before = await captureDbSnapshot();

    const originalExecuteAtomic = TransactionBoundary.executeAtomic.bind(TransactionBoundary);
    vi.spyOn(TransactionBoundary, 'executeAtomic').mockImplementationOnce(async (tables, op) => {
      return originalExecuteAtomic(tables, async (tx: any) => {
        const originalTable = tx.table.bind(tx);
        const wrappedTx = Object.create(tx);
        wrappedTx.table = (name: string) => {
          const tbl = originalTable(name);
          if (name === 'projectionEvents') {
            return new Proxy(tbl, {
              get(target, prop, receiver) {
                if (prop === 'add') {
                  return async () => {
                    throw new Error('SIMULATED_REAL_PROJECTION_TABLE_WRITE_ERROR');
                  };
                }
                const val = Reflect.get(target, prop, receiver);
                return typeof val === 'function' ? val.bind(target) : val;
              }
            });
          }
          return tbl;
        };
        return await op(wrappedTx);
      });
    });

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/SIMULATED_REAL_PROJECTION_TABLE_WRITE_ERROR/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 17. Database transaction failure & fail-closed blocked-DB empty transaction guard
  it('17a. Fails closed with zero mutations when database transaction throws', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-TX-FAIL' });
    const before = await captureDbSnapshot();

    vi.spyOn(TransactionBoundary, 'executeAtomic').mockRejectedValueOnce(
      new Error('SIMULATED_DB_TX_ABORT')
    );

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/SIMULATED_DB_TX_ABORT/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  it('17b. Fails closed when transaction boundary passes an invalid/blocked empty tx object', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-BLOCKED-TX' });
    const before = await captureDbSnapshot();

    vi.spyOn(TransactionBoundary, 'executeAtomic').mockImplementationOnce(async (_tables, op) => {
      return await op({} as any);
    });

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/ACTIVE_TRANSACTION_REQUIRED/i);
    expect(await captureDbSnapshot()).toEqual(before);

    // Direct AccountingRepository.deleteEntry also fails closed on invalid tx object
    await expect(AccountingRepository.deleteEntry(fixture.journalId, {} as any)).rejects.toThrow(
      /ACTIVE_TRANSACTION_REQUIRED/i
    );
    expect(await captureDbSnapshot()).toEqual(before);
  });
});
