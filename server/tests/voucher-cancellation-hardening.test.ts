import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { voucherCancellationWorkflow } from '@/features/accounting/workflows/VoucherCancellationWorkflow';
import { AccountingRepository } from '@/database/repositories/AccountingRepository';
import { FinancialTransactionRepository } from '@/database/repositories/FinancialTransactionRepository';
import { AuditService } from '@/services/system/AuditService';
import { ProjectionEventBus } from '@/services/system/ProjectionEventBus';
import { TransactionBoundary } from '@/core/integrity/transactionBoundary';
import { WorkflowOrchestrator } from '@/core/workflow';
import { useAuthStore } from '@/store/authStore';
import { db } from '@/core/db';

vi.mock('@/features/accounting/services/AccountingPeriodSyncService', () => ({
  AccountingPeriodSyncService: {
    getPeriods: vi.fn().mockResolvedValue([{
      id: 'TEST-OPEN-PERIOD',
      Start_Date: '1900-01-01T00:00:00.000Z',
      End_Date: '2200-12-31T23:59:59.999Z',
      Is_Locked: false,
    }]),
    setLocked: vi.fn().mockResolvedValue(undefined),
  },
}));


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
  financialTransactions: any[];
  accounts: any[];
  auditLogs: any[];
  projectionEvents: any[];
  syncQueue: any[];
  outbox: any[];
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
    financialTransactions: sortById(await db.financialTransactions.toArray()),
    accounts: sortById(await db.accounts.toArray()),
    auditLogs: sortById(
      (await db.auditLogs.toArray()).filter((a: any) => a.module === 'VOUCHERS')
    ),
    projectionEvents: sortById(
      (await db.projectionEvents.toArray()).filter((e: any) => e.eventType === 'VOUCHER_CANCELLED')
    ),
    syncQueue: sortById(await db.syncQueue.toArray()),
    outbox: sortById(await db.outbox.toArray())
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

    const ftId = `FT-${id}`;
    await db.financialTransactions.put({
      id: ftId,
      Transaction_ID: ftId,
      Transaction_Type: 'Receipt',
      Reference_ID: id,
      Reference_Table: 'Vouchers',
      Entity_Type: 'Customer',
      Entity_Name: partnerId,
      Amount: amount,
      Paid_Amount: amount,
      Direction: 'Credit',
      Transaction_Date: '2026-01-15',
      Notes: `سند قبض #${id}`,
      tenantId,
      branchId,
      isDeleted: false
    } as any);

    return { id, partnerId, amount, invoiceId, journalId, ftId };
  };

  const seedCompletePaymentFixture = async (opts?: {
    id?: string;
    partnerId?: string;
    amount?: number;
    invoiceId?: string;
    journalId?: string;
  }) => {
    const id = opts?.id ?? 'PYMT-FULL-01';
    const partnerId = opts?.partnerId ?? 'SUPP-FULL-01';
    const amount = opts?.amount ?? 300;
    const invoiceId = opts?.invoiceId ?? 'PUR-FULL-01';
    const journalId = opts?.journalId ?? `JE-${id}`;

    await db.vouchers.put({
      id,
      type: 'PAYMENT',
      partnerId,
      amount,
      date: '2026-01-15',
      paymentMethod: 'CASH',
      tenantId,
      branchId
    } as any);

    await db.payments.put({
      id,
      type: 'PAYMENT',
      supplier_id: partnerId,
      partnerId,
      amount,
      date: '2026-01-15',
      tenantId,
      branchId
    } as any);

    if (partnerId !== 'مورد نقدي') {
      await db.suppliers.put({
        id: partnerId,
        name: 'مورد اختبار متكامل',
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
      { id: `${journalId}-L1`, entryId: journalId, accountId: 'ACC-201', debit: amount, credit: 0 },
      { id: `${journalId}-L2`, entryId: journalId, accountId: 'ACC-101', debit: 0, credit: amount }
    ];

    await db.journalEntries.put({
      id: journalId,
      sourceId: id,
      sourceType: 'PAYMENT',
      date: '2026-01-15',
      tenantId,
      branchId,
      lines: inlineLines
    } as any);

    for (const line of inlineLines) {
      await db.journalLines.put({
        ...line,
        entry_id: journalId,
        account_id: line.accountId,
        tenantId,
        branchId
      } as any);
    }

    const ftId = `FT-${id}`;
    await db.financialTransactions.put({
      id: ftId,
      Transaction_ID: ftId,
      Transaction_Type: 'Payment',
      Reference_ID: id,
      Reference_Table: 'Vouchers',
      Entity_Type: 'Supplier',
      Entity_Name: partnerId,
      Amount: amount,
      Paid_Amount: amount,
      Direction: 'Debit',
      Transaction_Date: '2026-01-15',
      Notes: `سند صرف #${id}`,
      tenantId,
      branchId,
      isDeleted: false
    } as any);

    return { id, partnerId, amount, invoiceId, journalId, ftId };
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
      token: 'test-access-token',
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
    await db.financialTransactions.clear();
    await db.accounts.clear();
    await db.voucherInvoiceLinks.clear();
    await db.auditLogs.clear();
    await db.projectionEvents.clear();
    await db.syncQueue.filter((row: any) => row.tenantId === tenantId && row.userId === 'usr-accountant').delete();
    await db.outbox.filter((row: any) => row.tenantId === tenantId && row.userId === 'usr-accountant').delete();
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

    const syncRows = await db.syncQueue.toArray();
    const outboxRows = await db.outbox.toArray();
    expect(syncRows).toHaveLength(1);
    expect(outboxRows).toHaveLength(1);
    expect(syncRows[0].entityType).toBe('VOUCHER');
    expect(syncRows[0].operationType).toBe('CANCEL');
    expect(syncRows[0].payload?.id).toBe(fixture.id);
    expect(outboxRows[0].entityType).toBe('VOUCHER');
    expect(outboxRows[0].operation).toBe('CANCEL');
    expect(outboxRows[0].payload?.id).toBe(fixture.id);
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
    await db.financialTransactions.put({
      id: 'FT-PAY-CASH-01',
      Transaction_ID: 'FT-PAY-CASH-01',
      Transaction_Type: 'Payment',
      Reference_ID: 'PAY-CASH-01',
      Reference_Table: 'Vouchers',
      Entity_Type: 'Supplier',
      Entity_Name: 'مورد نقدي',
      Amount: 200,
      Paid_Amount: 200,
      Direction: 'Debit',
      Transaction_Date: '2026-01-15',
      tenantId,
      branchId,
      isDeleted: false
    } as any);

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

  // =========================================================================
  // FINAL AUDIT ADDITIONS: FinancialTransaction, Journal, Type & Allocation Integrity
  // =========================================================================

  // 18. Financial transaction records after receipt cancellation
  it('18. Preserves historical FinancialTransaction and creates opposite-direction compensating reversal on receipt cancellation', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-FT-REV-01', amount: 400 });

    const beforeFts = await db.financialTransactions.where('Reference_ID').equals(fixture.id).toArray();
    expect(beforeFts).toHaveLength(1);
    expect(beforeFts[0]?.Direction).toBe('Credit');
    expect(beforeFts[0]?.isDeleted).toBe(false);

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });
    expect(res.success).toBe(true);

    const afterFts = await db.financialTransactions.where('Reference_ID').equals(fixture.id).toArray();
    expect(afterFts).toHaveLength(2);

    const originalFt = afterFts.find((f: any) => f.id === fixture.ftId);
    const reversalFt = afterFts.find((f: any) => f.isReversal === true);

    expect(originalFt).toBeDefined();
    expect(originalFt?.isDeleted).toBe(true);
    expect(originalFt?.reversedBy).toBe(reversalFt?.id);

    expect(reversalFt).toBeDefined();
    expect(reversalFt?.reversalOf).toBe(fixture.ftId);
    expect(reversalFt?.Direction).toBe('Debit');
    expect(reversalFt?.Amount).toBe(400);
    expect(reversalFt?.isDeleted).toBe(false);

    // Zero un-reversed active original FTs remain
    const activeOriginals = afterFts.filter((f: any) => !f.isDeleted && !f.isReversal && !f.reversedBy);
    expect(activeOriginals).toHaveLength(0);
  });

  // 19. Financial transaction records after payment cancellation
  it('19. Preserves historical FinancialTransaction and creates opposite-direction compensating reversal on payment cancellation', async () => {
    const fixture = await seedCompletePaymentFixture({ id: 'PYMT-FT-REV-01', amount: 300 });

    const beforeFts = await db.financialTransactions.where('Reference_ID').equals(fixture.id).toArray();
    expect(beforeFts).toHaveLength(1);
    expect(beforeFts[0]?.Direction).toBe('Debit');

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'PAYMENT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });
    expect(res.success).toBe(true);

    const afterFts = await db.financialTransactions.where('Reference_ID').equals(fixture.id).toArray();
    expect(afterFts).toHaveLength(2);

    const originalFt = afterFts.find((f: any) => f.id === fixture.ftId);
    const reversalFt = afterFts.find((f: any) => f.isReversal === true);

    expect(originalFt?.isDeleted).toBe(true);
    expect(originalFt?.reversedBy).toBe(reversalFt?.id);
    expect(reversalFt?.reversalOf).toBe(fixture.ftId);
    expect(reversalFt?.Direction).toBe('Credit');
    expect(reversalFt?.Amount).toBe(300);
    expect(reversalFt?.isDeleted).toBe(false);
    expect((await db.suppliers.get(fixture.partnerId))?.balance).toBe(1300);
    expect((await db.invoices.get(fixture.invoiceId))?.paidAmount).toBe(0);
    expect((await db.invoices.get(fixture.invoiceId))?.paymentStatus).toBe('UNPAID');
  });

  // 20. Multiple/duplicate financial transaction records (and missing FT)
  it('20. Rejects duplicate active financialTransactions and missing financialTransaction with full rollback', async () => {
    const fixtureDup = await seedCompleteReceiptFixture({
      id: 'RCPT-DUP-FT-01',
      invoiceId: 'INV-DUP-FT-01'
    });
    await db.financialTransactions.put({
      id: 'FT-DUPLICATE-EXTRA',
      Transaction_ID: 'FT-DUPLICATE-EXTRA',
      Transaction_Type: 'Receipt',
      Reference_ID: fixtureDup.id,
      Reference_Table: 'Vouchers',
      Entity_Type: 'Customer',
      Entity_Name: fixtureDup.partnerId,
      Amount: fixtureDup.amount,
      Paid_Amount: fixtureDup.amount,
      Direction: 'Credit',
      Transaction_Date: '2026-01-15',
      tenantId,
      branchId,
      isDeleted: false
    } as any);

    const beforeDup = await captureDbSnapshot();
    const resDup = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixtureDup.id,
      type: 'RECEIPT',
      partnerId: fixtureDup.partnerId,
      amount: fixtureDup.amount
    });
    expect(resDup.success).toBe(false);
    expect(resDup.error?.message).toMatch(/DUPLICATE_VOUCHER_FINANCIAL_TRANSACTIONS/i);
    expect(await captureDbSnapshot()).toEqual(beforeDup);

    // Also verify missing FT is rejected fail-closed
    await db.financialTransactions.where('Reference_ID').equals(fixtureDup.id).delete();
    const beforeMissing = await captureDbSnapshot();
    const resMissing = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixtureDup.id,
      type: 'RECEIPT',
      partnerId: fixtureDup.partnerId,
      amount: fixtureDup.amount
    });
    expect(resMissing.success).toBe(false);
    expect(resMissing.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_MISSING/i);
    expect(await captureDbSnapshot()).toEqual(beforeMissing);
  });

  // 21. Financial transaction reversal failure and full rollback
  it('21. Rolls back all affected tables when FinancialTransaction reversal fails mid-transaction', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-FT-FAIL-01', amount: 400 });
    const before = await captureDbSnapshot();

    const originalExecuteAtomic = TransactionBoundary.executeAtomic.bind(TransactionBoundary);
    vi.spyOn(TransactionBoundary, 'executeAtomic').mockImplementationOnce(async (tables, op) => {
      return originalExecuteAtomic(tables, async (tx: any) => {
        const originalTable = tx.table.bind(tx);
        const wrappedTx = Object.create(tx);
        wrappedTx.table = (name: string) => {
          const tbl = originalTable(name);
          if (name === 'financialTransactions') {
            return new Proxy(tbl, {
              get(target, prop, receiver) {
                if (prop === 'put') {
                  return async () => {
                    throw new Error('SIMULATED_FT_REVERSAL_WRITE_FAILURE');
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
    expect(res.error?.message).toMatch(/SIMULATED_FT_REVERSAL_WRITE_FAILURE/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 22. Missing journal entry
  it('22. Rejects cancellation with VOUCHER_JOURNAL_ENTRY_MISSING when no journal entry exists and preserves all state', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-NO-JE-01', amount: 400 });
    await db.journalEntries.where('sourceId').equals(fixture.id).delete();
    await db.journalLines.where('entryId').equals(fixture.journalId).delete();

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/VOUCHER_JOURNAL_ENTRY_MISSING/i);
    expect(await db.vouchers.get(fixture.id)).toBeDefined();
    expect(await db.receipts.get(fixture.id)).toBeDefined();
    expect((await db.customers.get(fixture.partnerId))?.balance).toBe(1000);
    expect((await db.invoices.get(fixture.invoiceId))?.paidAmount).toBe(400);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 23. Duplicate journal entries
  it('23. Rejects cancellation with DUPLICATE_VOUCHER_JOURNAL_ENTRIES when multiple journal entries share sourceId', async () => {
    const fixture = await seedCompleteReceiptFixture({ id: 'RCPT-DUP-JE-01', amount: 400 });
    const dupJeId = 'JE-DUPLICATE-SECOND';
    const dupLines = [
      { id: `${dupJeId}-L1`, entryId: dupJeId, accountId: 'ACC-101', debit: 400, credit: 0 },
      { id: `${dupJeId}-L2`, entryId: dupJeId, accountId: 'ACC-103', debit: 0, credit: 400 }
    ];
    await db.journalEntries.put({
      id: dupJeId,
      sourceId: fixture.id,
      sourceType: 'RECEIPT',
      date: '2026-01-15',
      tenantId,
      branchId,
      lines: dupLines
    } as any);
    await db.journalLines.bulkPut(
      dupLines.map((l) => ({ ...l, entry_id: dupJeId, account_id: l.accountId, tenantId, branchId })) as any
    );

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/DUPLICATE_VOUCHER_JOURNAL_ENTRIES/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 24. Missing and invalid persisted voucher type
  it('24. Rejects missing persisted voucher type and invalid persisted voucher type with full rollback', async () => {
    const fixtureMissing = await seedCompleteReceiptFixture({
      id: 'RCPT-MISSING-TYPE',
      invoiceId: 'INV-MISSING-TYPE'
    });
    await db.vouchers.update(fixtureMissing.id, { type: undefined, voucherType: undefined } as any);

    const beforeMissing = await captureDbSnapshot();
    const resMissing = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixtureMissing.id,
      type: 'RECEIPT',
      partnerId: fixtureMissing.partnerId,
      amount: fixtureMissing.amount
    });
    expect(resMissing.success).toBe(false);
    expect(resMissing.error?.message).toMatch(/VOUCHER_TYPE_MISSING/i);
    expect(await captureDbSnapshot()).toEqual(beforeMissing);

    // Invalid persisted voucher type (e.g. JOURNAL)
    await db.vouchers.update(fixtureMissing.id, { type: 'JOURNAL' } as any);
    const beforeInvalid = await captureDbSnapshot();
    const resInvalid = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixtureMissing.id,
      type: 'RECEIPT',
      partnerId: fixtureMissing.partnerId,
      amount: fixtureMissing.amount
    });
    expect(resInvalid.success).toBe(false);
    expect(resInvalid.error?.message).toMatch(/VOUCHER_TYPE_INVALID/i);
    expect(await captureDbSnapshot()).toEqual(beforeInvalid);
  });

  // 25. Conflicting persisted voucher type across vouchers, receipts, and payments
  it('25. Rejects conflicting persisted voucher type across vouchers and receipts/payments tables', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-CONFLICT-TYPE',
      invoiceId: 'INV-CONFLICT-TYPE'
    });
    // voucher says PAYMENT while receipts table holds RECEIPT
    await db.vouchers.update(fixture.id, { type: 'PAYMENT' } as any);

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/VOUCHER_TYPE_CONFLICT/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 26. Invalid invoice paidAmount (NaN, negative, missing)
  it('26. Rejects invalid invoice paidAmount (NaN, negative, undefined) with zero mutations', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-BAD-INV-PAID',
      invoiceId: 'INV-BAD-PAID'
    });

    for (const badPaid of [Number.NaN, -50, undefined]) {
      await db.invoices.update(fixture.invoiceId, { paidAmount: badPaid } as any);
      const before = await captureDbSnapshot();
      const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
        id: fixture.id,
        type: 'RECEIPT',
        partnerId: fixture.partnerId,
        amount: fixture.amount
      });
      expect(res.success).toBe(false);
      expect(res.error?.message).toMatch(/INVALID_INVOICE_PAID_AMOUNT/i);
      expect(await captureDbSnapshot()).toEqual(before);
    }
  });

  // 27. Invalid invoice total (NaN, 0, negative, missing)
  it('27. Rejects invalid invoice total (NaN, 0, negative, undefined) with zero mutations', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-BAD-INV-TOTAL',
      invoiceId: 'INV-BAD-TOTAL'
    });

    for (const badTotal of [Number.NaN, 0, -500, undefined]) {
      await db.invoices.update(fixture.invoiceId, {
        totalAmount: badTotal,
        finalTotal: badTotal
      } as any);
      const before = await captureDbSnapshot();
      const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
        id: fixture.id,
        type: 'RECEIPT',
        partnerId: fixture.partnerId,
        amount: fixture.amount
      });
      expect(res.success).toBe(false);
      expect(res.error?.message).toMatch(/INVALID_INVOICE_TOTAL/i);
      expect(await captureDbSnapshot()).toEqual(before);
    }
  });

  // 28. Allocation exceeding recorded invoice paidAmount
  it('28. Rejects allocation amount exceeding invoice recorded paidAmount with full rollback', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-EXCEED-PAID',
      amount: 400,
      invoiceId: 'INV-LOW-PAID'
    });
    // Invoice recorded paidAmount is only 250, while link claims 400
    await db.invoices.update(fixture.invoiceId, { paidAmount: 250 } as any);

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/ALLOCATION_EXCEEDS_PAID_AMOUNT/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 29. Total allocations exceeding voucher amount
  it('29. Rejects total linked allocations exceeding voucher saved amount with full rollback', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-OVER-ALLOC',
      amount: 400,
      invoiceId: 'INV-ALLOC-A'
    });
    await db.invoices.put({
      id: 'INV-ALLOC-B',
      totalAmount: 1000,
      finalTotal: 1000,
      paidAmount: 200,
      paymentStatus: 'PARTIAL',
      tenantId,
      branchId
    } as any);
    // Add second link so total allocations = 400 + 200 = 600 > voucher amount 400
    await db.voucherInvoiceLinks.put({
      id: 'LINK-OVER-EXTRA',
      voucherId: fixture.id,
      invoiceId: 'INV-ALLOC-B',
      Paid_Amount: 200,
      tenantId,
      branchId
    } as any);

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/ALLOCATION_TOTAL_EXCEEDS_VOUCHER/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 30. Partial allocation cancellation restores PAID -> PARTIAL status accurately
  it('30. Restores PAID invoice to PARTIAL with accurate remainingAmount when cancelling partial allocation voucher', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-PARTIAL-STATUS',
      amount: 400,
      invoiceId: 'INV-PAID-TO-PARTIAL'
    });
    // Invoice total 1000, previously paid 1000 (600 from earlier voucher + 400 from this voucher)
    await db.invoices.update(fixture.invoiceId, {
      paidAmount: 1000,
      remainingAmount: 0,
      remaining: 0,
      paymentStatus: 'PAID'
    } as any);

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(true);
    const updatedInv = await db.invoices.get(fixture.invoiceId);
    expect(updatedInv?.paidAmount).toBe(600);
    expect((updatedInv as any)?.remainingAmount).toBe(400);
    expect(updatedInv?.paymentStatus).toBe('PARTIAL');
  });

  // =========================================================================
  // TARGETED FIX REGRESSION TESTS: FT Tenant/Branch Isolation & Reversal Verification
  // =========================================================================

  // 31. Missing tenantId on linked FinancialTransaction
  it('31. Rejects cancellation when linked FinancialTransaction is missing tenantId and leaves all tables unchanged', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-FT-NO-TENANT',
      invoiceId: 'INV-FT-NO-TENANT'
    });
    await db.financialTransactions.update(fixture.ftId, { tenantId: undefined } as any);

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_TENANT_MISSING/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 32. Missing branchId on linked FinancialTransaction
  it('32. Rejects cancellation when linked FinancialTransaction is missing branchId and leaves all tables unchanged', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-FT-NO-BRANCH',
      invoiceId: 'INV-FT-NO-BRANCH'
    });
    await db.financialTransactions.update(fixture.ftId, { branchId: undefined } as any);

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_BRANCH_MISSING/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 33. Different tenantId on linked FinancialTransaction
  it('33. Rejects cancellation when linked FinancialTransaction belongs to a different tenantId and does not leak tenant IDs', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-FT-WRONG-TENANT',
      invoiceId: 'INV-FT-WRONG-TENANT'
    });
    // Use raw table put via Dexie transaction or direct update to simulate cross-tenant record
    await db.financialTransactions.delete(fixture.ftId);
    await db.financialTransactions.put({
      id: fixture.ftId,
      Transaction_ID: fixture.ftId,
      Transaction_Type: 'Receipt',
      Reference_ID: fixture.id,
      Reference_Table: 'Vouchers',
      Entity_Type: 'Customer',
      Entity_Name: fixture.partnerId,
      Amount: fixture.amount,
      Paid_Amount: fixture.amount,
      Direction: 'Credit',
      Transaction_Date: '2026-01-15',
      tenantId: 'TENANT-OTHER-SECRET-99',
      branchId,
      isDeleted: false
    } as any);

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/CROSS_TENANT_FINANCIAL_TRANSACTION_FORBIDDEN/i);
    expect(res.error?.message).not.toContain('TENANT-OTHER-SECRET-99');
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 34. Different branchId on linked FinancialTransaction
  it('34. Rejects cancellation when linked FinancialTransaction belongs to a different branchId and leaves all tables unchanged', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-FT-WRONG-BRANCH',
      invoiceId: 'INV-FT-WRONG-BRANCH'
    });
    await db.financialTransactions.update(fixture.ftId, { branchId: 'BRH-OTHER-SECRET-99' } as any);

    const before = await captureDbSnapshot();
    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/CROSS_BRANCH_FINANCIAL_TRANSACTION_FORBIDDEN/i);
    expect(res.error?.message).not.toContain('BRH-OTHER-SECRET-99');
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 35. Missing or invalid Reference_Table on linked FinancialTransaction
  it('35. Rejects missing and invalid Reference_Table on linked FinancialTransaction with full rollback', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-FT-BAD-REFTBL',
      invoiceId: 'INV-FT-BAD-REFTBL'
    });

    // Missing Reference_Table
    await db.financialTransactions.update(fixture.ftId, { Reference_Table: undefined } as any);
    const beforeMissing = await captureDbSnapshot();
    const resMissing = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });
    expect(resMissing.success).toBe(false);
    expect(resMissing.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_REFERENCE_TABLE_MISSING/i);
    expect(await captureDbSnapshot()).toEqual(beforeMissing);

    // Invalid Reference_Table (not 'Vouchers')
    await db.financialTransactions.update(fixture.ftId, { Reference_Table: 'Sales_Invoices' } as any);
    const beforeInvalid = await captureDbSnapshot();
    const resInvalid = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });
    expect(resInvalid.success).toBe(false);
    expect(resInvalid.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_REFERENCE_TABLE_INVALID/i);
    expect(await captureDbSnapshot()).toEqual(beforeInvalid);
  });

  // 36. Reversal lookup returning no scoped transaction (no-op prevented)
  it('36. Rejects no-op reversal when scoped FinancialTransaction lookup returns zero records and rolls back all tables', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-FT-NOOP',
      invoiceId: 'INV-FT-NOOP'
    });
    const before = await captureDbSnapshot();

    vi.spyOn(FinancialTransactionRepository, 'getByReference').mockResolvedValueOnce([]);

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/FINANCIAL_TRANSACTION_REVERSAL_NO_OP/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 37. Original transaction not marked as reversed (postcondition guard)
  it('37. Rejects cancellation and rolls back all tables if original FinancialTransaction is not marked isDeleted/reversedBy', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-FT-UNMARKED',
      invoiceId: 'INV-FT-UNMARKED'
    });
    const before = await captureDbSnapshot();

    // Simulate a buggy reversal implementation that claims reversedCount: 1 without updating original FT
    vi.spyOn(FinancialTransactionRepository, 'reverseTransactions').mockImplementationOnce(
      async (_refId, tx) => {
        const ftTbl = tx.table('financialTransactions');
        const revId = `FT-REV-${fixture.ftId}-UNMARKED`;
        await ftTbl.put({
          id: revId,
          Transaction_ID: revId,
          Transaction_Type: 'Receipt',
          Reference_ID: fixture.id,
          Reference_Table: 'Vouchers',
          Amount: fixture.amount,
          Direction: 'Debit',
          tenantId,
          branchId,
          isReversal: true,
          reversalOf: fixture.ftId,
          isDeleted: false
        });
        return { reversedCount: 1, reversalIds: [revId] };
      }
    );

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/FINANCIAL_TRANSACTION_REVERSAL_VERIFICATION_FAILED/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 38. Reversal record written with incorrect tenantId or branchId
  it('38. Rejects cancellation and rolls back all tables if compensating reversal has incorrect tenantId or branchId', async () => {
    const fixtureTenant = await seedCompleteReceiptFixture({
      id: 'RCPT-FT-REV-BAD-TENANT',
      invoiceId: 'INV-FT-REV-BAD-TENANT'
    });
    const beforeTenant = await captureDbSnapshot();

    vi.spyOn(FinancialTransactionRepository, 'reverseTransactions').mockImplementationOnce(
      async (_refId, tx) => {
        const ftTbl = tx.table('financialTransactions');
        const revId = `FT-REV-${fixtureTenant.ftId}-WRONG-TENANT`;
        await ftTbl.put({
          id: revId,
          Transaction_ID: revId,
          Transaction_Type: 'Receipt',
          Reference_ID: fixtureTenant.id,
          Reference_Table: 'Vouchers',
          Amount: fixtureTenant.amount,
          Direction: 'Debit',
          tenantId: 'TENANT-ROGUE',
          branchId,
          isReversal: true,
          reversalOf: fixtureTenant.ftId,
          isDeleted: false
        });
        await ftTbl.update(fixtureTenant.ftId, { isDeleted: true, reversedBy: revId });
        return { reversedCount: 1, reversalIds: [revId] };
      }
    );

    const resWrongTenant = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixtureTenant.id,
      type: 'RECEIPT',
      partnerId: fixtureTenant.partnerId,
      amount: fixtureTenant.amount
    });
    expect(resWrongTenant.success).toBe(false);
    expect(resWrongTenant.error?.message).toMatch(/FINANCIAL_TRANSACTION_REVERSAL_SCOPE_VIOLATION/i);
    expect(await captureDbSnapshot()).toEqual(beforeTenant);

    // Now test wrong branchId on reversal record
    const fixtureBranch = await seedCompleteReceiptFixture({
      id: 'RCPT-FT-REV-BAD-BRANCH',
      partnerId: 'CUST-REV-BAD-BR',
      invoiceId: 'INV-FT-REV-BAD-BRANCH'
    });
    const beforeBranch = await captureDbSnapshot();

    vi.spyOn(FinancialTransactionRepository, 'reverseTransactions').mockImplementationOnce(
      async (_refId, tx) => {
        const ftTbl = tx.table('financialTransactions');
        const revId = `FT-REV-${fixtureBranch.ftId}-WRONG-BRANCH`;
        await ftTbl.put({
          id: revId,
          Transaction_ID: revId,
          Transaction_Type: 'Receipt',
          Reference_ID: fixtureBranch.id,
          Reference_Table: 'Vouchers',
          Amount: fixtureBranch.amount,
          Direction: 'Debit',
          tenantId,
          branchId: 'BRH-ROGUE',
          isReversal: true,
          reversalOf: fixtureBranch.ftId,
          isDeleted: false
        });
        await ftTbl.update(fixtureBranch.ftId, { isDeleted: true, reversedBy: revId });
        return { reversedCount: 1, reversalIds: [revId] };
      }
    );

    const resWrongBranch = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixtureBranch.id,
      type: 'RECEIPT',
      partnerId: fixtureBranch.partnerId,
      amount: fixtureBranch.amount
    });
    expect(resWrongBranch.success).toBe(false);
    expect(resWrongBranch.error?.message).toMatch(/FINANCIAL_TRANSACTION_REVERSAL_SCOPE_VIOLATION/i);
    expect(await captureDbSnapshot()).toEqual(beforeBranch);
  });

  // 39. Successful cancellation creates exactly one valid scoped compensating reversal
  it('39. Successful cancellation creates exactly one valid compensating reversal within matching tenant and branch scope', async () => {
    const fixture = await seedCompletePaymentFixture({
      id: 'PYMT-FT-SCOPED-OK',
      amount: 325,
      invoiceId: 'PUR-FT-SCOPED-OK'
    });

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'PAYMENT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(true);

    const allFts = await db.financialTransactions.where('Reference_ID').equals(fixture.id).toArray();
    expect(allFts).toHaveLength(2);

    const originals = allFts.filter((f: any) => f.id === fixture.ftId);
    const reversals = allFts.filter((f: any) => f.isReversal === true);
    expect(originals).toHaveLength(1);
    expect(reversals).toHaveLength(1);

    const orig = originals[0]!;
    const rev = reversals[0]!;

    expect(orig.isDeleted).toBe(true);
    expect(orig.reversedBy).toBe(rev.id);

    expect(rev.isReversal).toBe(true);
    expect(rev.reversalOf).toBe(orig.id);
    expect(rev.isDeleted).toBe(false);
    expect(rev.Direction).toBe('Credit');
    expect(rev.Reference_Table).toBe('Vouchers');
    expect(rev.tenantId).toBe(tenantId);
    expect(rev.branchId).toBe(branchId);
    expect(rev.Amount).toBe(325);
  });

  // 40. Receipt with incorrect Transaction_Type
  it('40. Rejects receipt cancellation when FinancialTransaction has incorrect or missing Transaction_Type and rolls back all tables', async () => {
    const fixtureWrong = await seedCompleteReceiptFixture({
      id: 'RCPT-FT-WRONG-TX-TYPE',
      invoiceId: 'INV-FT-WRONG-TX-TYPE'
    });
    await db.financialTransactions.update(fixtureWrong.ftId, { Transaction_Type: 'Payment' as any });
    const beforeWrong = await captureDbSnapshot();

    const resWrong = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixtureWrong.id,
      type: 'RECEIPT',
      partnerId: fixtureWrong.partnerId,
      amount: fixtureWrong.amount
    });

    expect(resWrong.success).toBe(false);
    expect(resWrong.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_TYPE_MISMATCH/i);
    expect(await captureDbSnapshot()).toEqual(beforeWrong);

    const fixtureMissing = await seedCompleteReceiptFixture({
      id: 'RCPT-FT-MISSING-TX-TYPE',
      partnerId: 'CUST-MISSING-TX',
      invoiceId: 'INV-FT-MISSING-TX-TYPE'
    });
    await db.financialTransactions.update(fixtureMissing.ftId, { Transaction_Type: undefined as any });
    const beforeMissing = await captureDbSnapshot();

    const resMissing = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixtureMissing.id,
      type: 'RECEIPT',
      partnerId: fixtureMissing.partnerId,
      amount: fixtureMissing.amount
    });

    expect(resMissing.success).toBe(false);
    expect(resMissing.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_TYPE_MISMATCH/i);
    expect(await captureDbSnapshot()).toEqual(beforeMissing);
  });

  // 41. Payment with incorrect Transaction_Type
  it('41. Rejects payment cancellation when FinancialTransaction has incorrect or missing Transaction_Type and rolls back all tables', async () => {
    const fixtureWrong = await seedCompletePaymentFixture({
      id: 'PYMT-FT-WRONG-TX-TYPE',
      invoiceId: 'PUR-FT-WRONG-TX-TYPE'
    });
    await db.financialTransactions.update(fixtureWrong.ftId, { Transaction_Type: 'Receipt' as any });
    const beforeWrong = await captureDbSnapshot();

    const resWrong = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixtureWrong.id,
      type: 'PAYMENT',
      partnerId: fixtureWrong.partnerId,
      amount: fixtureWrong.amount
    });

    expect(resWrong.success).toBe(false);
    expect(resWrong.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_TYPE_MISMATCH/i);
    expect(await captureDbSnapshot()).toEqual(beforeWrong);

    const fixtureMissing = await seedCompletePaymentFixture({
      id: 'PYMT-FT-MISSING-TX-TYPE',
      partnerId: 'SUPP-MISSING-TX',
      invoiceId: 'PUR-FT-MISSING-TX-TYPE'
    });
    await db.financialTransactions.update(fixtureMissing.ftId, { Transaction_Type: '' as any });
    const beforeMissing = await captureDbSnapshot();

    const resMissing = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixtureMissing.id,
      type: 'PAYMENT',
      partnerId: fixtureMissing.partnerId,
      amount: fixtureMissing.amount
    });

    expect(resMissing.success).toBe(false);
    expect(resMissing.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_TYPE_MISMATCH/i);
    expect(await captureDbSnapshot()).toEqual(beforeMissing);
  });

  // 42. Incorrect Entity_Type on original FinancialTransaction
  it('42. Rejects cancellation when FinancialTransaction has incorrect Entity_Type for receipt or payment and rolls back all tables', async () => {
    const receiptFixture = await seedCompleteReceiptFixture({
      id: 'RCPT-FT-WRONG-ENT-TYPE',
      invoiceId: 'INV-FT-WRONG-ENT-TYPE'
    });
    await db.financialTransactions.update(receiptFixture.ftId, { Entity_Type: 'Supplier' as any });
    const beforeReceipt = await captureDbSnapshot();

    const resReceipt = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: receiptFixture.id,
      type: 'RECEIPT',
      partnerId: receiptFixture.partnerId,
      amount: receiptFixture.amount
    });

    expect(resReceipt.success).toBe(false);
    expect(resReceipt.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_ENTITY_TYPE_MISMATCH/i);
    expect(await captureDbSnapshot()).toEqual(beforeReceipt);

    const paymentFixture = await seedCompletePaymentFixture({
      id: 'PYMT-FT-WRONG-ENT-TYPE',
      invoiceId: 'PUR-FT-WRONG-ENT-TYPE'
    });
    await db.financialTransactions.update(paymentFixture.ftId, { Entity_Type: 'Customer' as any });
    const beforePayment = await captureDbSnapshot();

    const resPayment = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: paymentFixture.id,
      type: 'PAYMENT',
      partnerId: paymentFixture.partnerId,
      amount: paymentFixture.amount
    });

    expect(resPayment.success).toBe(false);
    expect(resPayment.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_ENTITY_TYPE_MISMATCH/i);
    expect(await captureDbSnapshot()).toEqual(beforePayment);
  });

  // 43. Incorrect Entity_Name on original FinancialTransaction
  it('43. Rejects cancellation when FinancialTransaction Entity_Name does not match persisted voucher partner and rolls back all tables', async () => {
    const receiptFixture = await seedCompleteReceiptFixture({
      id: 'RCPT-FT-WRONG-ENT-NAME',
      partnerId: 'CUST-AUTH-01',
      invoiceId: 'INV-FT-WRONG-ENT-NAME'
    });
    await db.financialTransactions.update(receiptFixture.ftId, { Entity_Name: 'CUST-IMPERSONATOR' });
    const beforeReceipt = await captureDbSnapshot();

    const resReceipt = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: receiptFixture.id,
      type: 'RECEIPT',
      partnerId: receiptFixture.partnerId,
      amount: receiptFixture.amount
    });

    expect(resReceipt.success).toBe(false);
    expect(resReceipt.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_ENTITY_NAME_MISMATCH/i);
    expect(await captureDbSnapshot()).toEqual(beforeReceipt);

    const paymentFixture = await seedCompletePaymentFixture({
      id: 'PYMT-FT-WRONG-ENT-NAME',
      partnerId: 'SUPP-AUTH-01',
      invoiceId: 'PUR-FT-WRONG-ENT-NAME'
    });
    await db.financialTransactions.update(paymentFixture.ftId, { Entity_Name: 'SUPP-OTHER-99' });
    const beforePayment = await captureDbSnapshot();

    const resPayment = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: paymentFixture.id,
      type: 'PAYMENT',
      partnerId: paymentFixture.partnerId,
      amount: paymentFixture.amount
    });

    expect(resPayment.success).toBe(false);
    expect(resPayment.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_ENTITY_NAME_MISMATCH/i);
    expect(await captureDbSnapshot()).toEqual(beforePayment);
  });

  // 44. Existing deterministic reversal with a different amount
  it('44. Rejects pre-existing reversal with mismatched Amount or Paid_Amount and rolls back all tables', async () => {
    const fixtureAmt = await seedCompleteReceiptFixture({
      id: 'RCPT-EXISTING-REV-BAD-AMT',
      amount: 400,
      invoiceId: 'INV-EXISTING-REV-BAD-AMT'
    });
    const idemKeyAmt = 'IDEM-EXISTING-REV-BAD-AMT';
    const existingRevIdAmt = `FT-REV-${fixtureAmt.ftId}-${idemKeyAmt}`;

    await db.financialTransactions.put({
      id: existingRevIdAmt,
      Transaction_ID: existingRevIdAmt,
      Transaction_Type: 'Receipt',
      Reference_ID: fixtureAmt.id,
      Reference_Table: 'Vouchers',
      Entity_Type: 'Customer',
      Entity_Name: fixtureAmt.partnerId,
      Amount: 150, // Tampered amount (original is 400)
      Paid_Amount: 150,
      Direction: 'Debit',
      Transaction_Date: '2026-01-16',
      tenantId,
      branchId,
      isReversal: true,
      reversalOf: fixtureAmt.ftId,
      isDeleted: false
    } as any);

    const beforeAmt = await captureDbSnapshot();

    const resAmt = await WorkflowOrchestrator.execute(
      voucherCancellationWorkflow,
      {
        id: fixtureAmt.id,
        type: 'RECEIPT',
        partnerId: fixtureAmt.partnerId,
        amount: fixtureAmt.amount
      },
      { idempotencyKey: idemKeyAmt }
    );

    expect(resAmt.success).toBe(false);
    expect(resAmt.error?.message).toMatch(/FINANCIAL_TRANSACTION_REVERSAL_INCONSISTENT/i);
    expect(await captureDbSnapshot()).toEqual(beforeAmt);

    // Also reject when Amount matches but Paid_Amount differs
    const fixturePaid = await seedCompletePaymentFixture({
      id: 'PYMT-EXISTING-REV-BAD-PAID',
      amount: 300,
      invoiceId: 'PUR-EXISTING-REV-BAD-PAID'
    });
    const idemKeyPaid = 'IDEM-EXISTING-REV-BAD-PAID';
    const existingRevIdPaid = `FT-REV-${fixturePaid.ftId}-${idemKeyPaid}`;

    await db.financialTransactions.put({
      id: existingRevIdPaid,
      Transaction_ID: existingRevIdPaid,
      Transaction_Type: 'Payment',
      Reference_ID: fixturePaid.id,
      Reference_Table: 'Vouchers',
      Entity_Type: 'Supplier',
      Entity_Name: fixturePaid.partnerId,
      Amount: 300,
      Paid_Amount: 290, // Tampered Paid_Amount
      Direction: 'Credit',
      Transaction_Date: '2026-01-16',
      tenantId,
      branchId,
      isReversal: true,
      reversalOf: fixturePaid.ftId,
      isDeleted: false
    } as any);

    const beforePaid = await captureDbSnapshot();

    const resPaid = await WorkflowOrchestrator.execute(
      voucherCancellationWorkflow,
      {
        id: fixturePaid.id,
        type: 'PAYMENT',
        partnerId: fixturePaid.partnerId,
        amount: fixturePaid.amount
      },
      { idempotencyKey: idemKeyPaid }
    );

    expect(resPaid.success).toBe(false);
    expect(resPaid.error?.message).toMatch(/FINANCIAL_TRANSACTION_REVERSAL_INCONSISTENT/i);
    expect(await captureDbSnapshot()).toEqual(beforePaid);
  });

  // 45. Existing deterministic reversal with incorrect Reference_Table (both repository-level and workflow-level rollback)
  it('45. Rejects pre-existing reversal with incorrect Reference_Table at both repository and workflow layers with full rollback', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-EXISTING-REV-BAD-REFTBL',
      amount: 400,
      invoiceId: 'INV-EXISTING-REV-BAD-REFTBL'
    });
    const idemKey = 'IDEM-EXISTING-REV-BAD-REFTBL';
    const existingRevId = `FT-REV-${fixture.ftId}-${idemKey}`;

    // Use a different Reference_ID so workflow Phase 1 does not short-circuit before hitting reverseTransactions reuse guard
    await db.financialTransactions.put({
      id: existingRevId,
      Transaction_ID: existingRevId,
      Transaction_Type: 'Receipt',
      Reference_ID: 'OTHER-DOC-REF',
      Reference_Table: 'Sales_Invoices',
      Entity_Type: 'Customer',
      Entity_Name: fixture.partnerId,
      Amount: fixture.amount,
      Paid_Amount: fixture.amount,
      Direction: 'Debit',
      Transaction_Date: '2026-01-16',
      tenantId,
      branchId,
      isReversal: true,
      reversalOf: fixture.ftId,
      isDeleted: false
    } as any);

    const beforeWorkflow = await captureDbSnapshot();

    const resWorkflow = await WorkflowOrchestrator.execute(
      voucherCancellationWorkflow,
      {
        id: fixture.id,
        type: 'RECEIPT',
        partnerId: fixture.partnerId,
        amount: fixture.amount
      },
      { idempotencyKey: idemKey }
    );

    expect(resWorkflow.success).toBe(false);
    expect(resWorkflow.error?.message).toMatch(/FINANCIAL_TRANSACTION_REVERSAL_INCONSISTENT/i);
    expect(await captureDbSnapshot()).toEqual(beforeWorkflow);

    // Direct repository test where Reference_ID matches but ONLY Reference_Table is wrong
    await db.financialTransactions.update(existingRevId, {
      Reference_ID: fixture.id,
      Reference_Table: 'Sales_Invoices'
    });
    const beforeRepo = await captureDbSnapshot();

    await expect(
      db.transaction('rw', [db.financialTransactions], async (tx) => {
        await FinancialTransactionRepository.reverseTransactions(
          fixture.id,
          tx,
          idemKey,
          tenantId,
          branchId,
          { requireActiveTransaction: true, referenceTable: 'Vouchers' }
        );
      })
    ).rejects.toThrow(/FINANCIAL_TRANSACTION_REVERSAL_INCONSISTENT/i);

    expect(await captureDbSnapshot()).toEqual(beforeRepo);
  });

  // 46. Existing deterministic reversal with mismatched transaction identity fields (Transaction_Type, Entity_Type, Entity_Name)
  it('46. Rejects pre-existing reversal with mismatched Transaction_Type, Entity_Type, or Entity_Name and rolls back all tables', async () => {
    const cases: Array<{
      label: string;
      voucherId: string;
      invoiceId: string;
      partnerId: string;
      overrides: Record<string, any>;
    }> = [
      {
        label: 'Transaction_Type',
        voucherId: 'RCPT-REV-BAD-TXTYPE',
        invoiceId: 'INV-REV-BAD-TXTYPE',
        partnerId: 'CUST-REV-ID-1',
        overrides: { Transaction_Type: 'Payment' }
      },
      {
        label: 'Entity_Type',
        voucherId: 'RCPT-REV-BAD-ENTTYPE',
        invoiceId: 'INV-REV-BAD-ENTTYPE',
        partnerId: 'CUST-REV-ID-2',
        overrides: { Entity_Type: 'Supplier' }
      },
      {
        label: 'Entity_Name',
        voucherId: 'RCPT-REV-BAD-ENTNAME',
        invoiceId: 'INV-REV-BAD-ENTNAME',
        partnerId: 'CUST-REV-ID-3',
        overrides: { Entity_Name: 'CUST-DIFFERENT' }
      }
    ];

    for (const c of cases) {
      const fixture = await seedCompleteReceiptFixture({
        id: c.voucherId,
        partnerId: c.partnerId,
        invoiceId: c.invoiceId
      });
      const idemKey = `IDEM-${c.voucherId}`;
      const existingRevId = `FT-REV-${fixture.ftId}-${idemKey}`;

      await db.financialTransactions.put({
        id: existingRevId,
        Transaction_ID: existingRevId,
        Transaction_Type: 'Receipt',
        Reference_ID: fixture.id,
        Reference_Table: 'Vouchers',
        Entity_Type: 'Customer',
        Entity_Name: fixture.partnerId,
        Amount: fixture.amount,
        Paid_Amount: fixture.amount,
        Direction: 'Debit',
        Transaction_Date: '2026-01-16',
        tenantId,
        branchId,
        isReversal: true,
        reversalOf: fixture.ftId,
        isDeleted: false,
        ...c.overrides
      } as any);

      const before = await captureDbSnapshot();

      const res = await WorkflowOrchestrator.execute(
        voucherCancellationWorkflow,
        {
          id: fixture.id,
          type: 'RECEIPT',
          partnerId: fixture.partnerId,
          amount: fixture.amount
        },
        { idempotencyKey: idemKey }
      );

      expect(res.success, `Expected failure for mismatched ${c.label}`).toBe(false);
      expect(res.error?.message).toMatch(/FINANCIAL_TRANSACTION_REVERSAL_INCONSISTENT/i);
      expect(await captureDbSnapshot()).toEqual(before);
    }
  });

  // 47. Postcondition verification rejects compensating reversal with wrong amount, Reference_Table, or identity fields
  it('47. Rejects cancellation and rolls back all tables if postcondition finds compensating reversal with wrong amount or identity', async () => {
    const postconditionCases: Array<{
      label: string;
      voucherId: string;
      invoiceId: string;
      partnerId: string;
      badFields: Record<string, any>;
    }> = [
      {
        label: 'wrong amount',
        voucherId: 'RCPT-POST-BAD-AMT',
        invoiceId: 'INV-POST-BAD-AMT',
        partnerId: 'CUST-POST-1',
        badFields: { Amount: 999, Paid_Amount: 999 }
      },
      {
        label: 'wrong Reference_Table',
        voucherId: 'RCPT-POST-BAD-REFTBL',
        invoiceId: 'INV-POST-BAD-REFTBL',
        partnerId: 'CUST-POST-2',
        badFields: { Reference_Table: 'Sales_Invoices' }
      },
      {
        label: 'wrong Transaction_Type',
        voucherId: 'RCPT-POST-BAD-TXTYPE',
        invoiceId: 'INV-POST-BAD-TXTYPE',
        partnerId: 'CUST-POST-3',
        badFields: { Transaction_Type: 'Payment' }
      },
      {
        label: 'wrong Entity_Type',
        voucherId: 'RCPT-POST-BAD-ENTTYPE',
        invoiceId: 'INV-POST-BAD-ENTTYPE',
        partnerId: 'CUST-POST-4',
        badFields: { Entity_Type: 'Supplier' }
      },
      {
        label: 'wrong Entity_Name',
        voucherId: 'RCPT-POST-BAD-ENTNAME',
        invoiceId: 'INV-POST-BAD-ENTNAME',
        partnerId: 'CUST-POST-5',
        badFields: { Entity_Name: 'CUST-WRONG' }
      }
    ];

    for (const pc of postconditionCases) {
      const fixture = await seedCompleteReceiptFixture({
        id: pc.voucherId,
        partnerId: pc.partnerId,
        invoiceId: pc.invoiceId
      });
      const before = await captureDbSnapshot();

      vi.spyOn(FinancialTransactionRepository, 'reverseTransactions').mockImplementationOnce(
        async (_refId, tx) => {
          const ftTbl = tx.table('financialTransactions');
          const revId = `FT-REV-${fixture.ftId}-POST`;
          await ftTbl.put({
            id: revId,
            Transaction_ID: revId,
            Transaction_Type: 'Receipt',
            Reference_ID: fixture.id,
            Reference_Table: 'Vouchers',
            Entity_Type: 'Customer',
            Entity_Name: fixture.partnerId,
            Amount: fixture.amount,
            Paid_Amount: fixture.amount,
            Direction: 'Debit',
            tenantId,
            branchId,
            isReversal: true,
            reversalOf: fixture.ftId,
            isDeleted: false,
            ...pc.badFields
          });
          await ftTbl.update(fixture.ftId, { isDeleted: true, reversedBy: revId });
          return { reversedCount: 1, reversalIds: [revId] };
        }
      );

      const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
        id: fixture.id,
        type: 'RECEIPT',
        partnerId: fixture.partnerId,
        amount: fixture.amount
      });

      expect(res.success, `Expected postcondition rejection for ${pc.label}`).toBe(false);
      expect(res.error?.message).toMatch(/FINANCIAL_TRANSACTION_REVERSAL_VERIFICATION_FAILED/i);
      expect(await captureDbSnapshot()).toEqual(before);
    }
  });

  // 48. Successful receipt and payment cancellations each create exactly one valid compensating reversal with full identity & amount integrity
  it('48. Successful receipt and payment cancellations each create exactly one valid compensating reversal with matching identity and amount', async () => {
    const receiptFixture = await seedCompleteReceiptFixture({
      id: 'RCPT-IDENTITY-OK',
      partnerId: 'CUST-IDENTITY-OK',
      amount: 425.5,
      invoiceId: 'INV-IDENTITY-OK'
    });

    const receiptRes = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: receiptFixture.id,
      type: 'RECEIPT',
      partnerId: receiptFixture.partnerId,
      amount: receiptFixture.amount
    });
    expect(receiptRes.success).toBe(true);

    const receiptFts = await db.financialTransactions.where('Reference_ID').equals(receiptFixture.id).toArray();
    expect(receiptFts).toHaveLength(2);
    const receiptOrig = receiptFts.find((f: any) => f.id === receiptFixture.ftId)!;
    const receiptRevs = receiptFts.filter((f: any) => f.isReversal === true);
    expect(receiptRevs).toHaveLength(1);
    const receiptRev = receiptRevs[0]!;

    expect(receiptOrig.isDeleted).toBe(true);
    expect(receiptOrig.reversedBy).toBe(receiptRev.id);
    expect(receiptRev.isReversal).toBe(true);
    expect(receiptRev.reversalOf).toBe(receiptOrig.id);
    expect(receiptRev.isDeleted).toBe(false);
    expect(receiptRev.Direction).toBe('Debit');
    expect(receiptRev.Amount).toBe(425.5);
    expect(receiptRev.Paid_Amount).toBe(425.5);
    expect(receiptRev.Reference_ID).toBe(receiptFixture.id);
    expect(receiptRev.Reference_Table).toBe('Vouchers');
    expect(receiptRev.Transaction_Type).toBe('Receipt');
    expect(receiptRev.Entity_Type).toBe('Customer');
    expect(receiptRev.Entity_Name).toBe(receiptFixture.partnerId);
    expect(receiptRev.tenantId).toBe(tenantId);
    expect(receiptRev.branchId).toBe(branchId);

    const paymentFixture = await seedCompletePaymentFixture({
      id: 'PYMT-IDENTITY-OK',
      partnerId: 'SUPP-IDENTITY-OK',
      amount: 310.75,
      invoiceId: 'PUR-IDENTITY-OK'
    });

    const paymentRes = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: paymentFixture.id,
      type: 'PAYMENT',
      partnerId: paymentFixture.partnerId,
      amount: paymentFixture.amount
    });
    expect(paymentRes.success).toBe(true);

    const paymentFts = await db.financialTransactions.where('Reference_ID').equals(paymentFixture.id).toArray();
    expect(paymentFts).toHaveLength(2);
    const paymentOrig = paymentFts.find((f: any) => f.id === paymentFixture.ftId)!;
    const paymentRevs = paymentFts.filter((f: any) => f.isReversal === true);
    expect(paymentRevs).toHaveLength(1);
    const paymentRev = paymentRevs[0]!;

    expect(paymentOrig.isDeleted).toBe(true);
    expect(paymentOrig.reversedBy).toBe(paymentRev.id);
    expect(paymentRev.isReversal).toBe(true);
    expect(paymentRev.reversalOf).toBe(paymentOrig.id);
    expect(paymentRev.isDeleted).toBe(false);
    expect(paymentRev.Direction).toBe('Credit');
    expect(paymentRev.Amount).toBe(310.75);
    expect(paymentRev.Paid_Amount).toBe(310.75);
    expect(paymentRev.Reference_ID).toBe(paymentFixture.id);
    expect(paymentRev.Reference_Table).toBe('Vouchers');
    expect(paymentRev.Transaction_Type).toBe('Payment');
    expect(paymentRev.Entity_Type).toBe('Supplier');
    expect(paymentRev.Entity_Name).toBe(paymentFixture.partnerId);
    expect(paymentRev.tenantId).toBe(tenantId);
    expect(paymentRev.branchId).toBe(branchId);
  });

  // 49. Reject receipt cancellation when original FinancialTransaction has missing Paid_Amount
  it('49. Rejects receipt cancellation when original FinancialTransaction has missing Paid_Amount and rolls back all tables', async () => {
    const fixture = await seedCompleteReceiptFixture({
      id: 'RCPT-MISSING-PAID-AMT',
      partnerId: 'CUST-MISSING-PAID',
      amount: 400,
      invoiceId: 'INV-MISSING-PAID-AMT'
    });
    const existingFt = await db.financialTransactions.get(fixture.ftId);
    const ftWithoutPaidAmount = { ...(existingFt as any) };
    delete ftWithoutPaidAmount.Paid_Amount;
    await db.financialTransactions.put(ftWithoutPaidAmount);

    const before = await captureDbSnapshot();

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'RECEIPT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_AMOUNT_MISMATCH/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 50. Reject payment cancellation when original FinancialTransaction has missing Paid_Amount
  it('50. Rejects payment cancellation when original FinancialTransaction has missing Paid_Amount and rolls back all tables', async () => {
    const fixture = await seedCompletePaymentFixture({
      id: 'PYMT-MISSING-PAID-AMT',
      partnerId: 'SUPP-MISSING-PAID',
      amount: 300,
      invoiceId: 'PUR-MISSING-PAID-AMT'
    });
    const existingFt = await db.financialTransactions.get(fixture.ftId);
    const ftWithoutPaidAmount = { ...(existingFt as any) };
    delete ftWithoutPaidAmount.Paid_Amount;
    await db.financialTransactions.put(ftWithoutPaidAmount);

    const before = await captureDbSnapshot();

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixture.id,
      type: 'PAYMENT',
      partnerId: fixture.partnerId,
      amount: fixture.amount
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_AMOUNT_MISMATCH/i);
    expect(await captureDbSnapshot()).toEqual(before);
  });

  // 51. Reject cancellation when compensating reversal has missing Paid_Amount (both reuse and postcondition paths)
  it('51. Rejects cancellation when compensating reversal has missing Paid_Amount and rolls back all tables', async () => {
    // 51a. Postcondition check rejects compensating reversal without Paid_Amount
    const fixturePost = await seedCompleteReceiptFixture({
      id: 'RCPT-REV-MISSING-PAID-POST',
      partnerId: 'CUST-REV-MISSING-PAID-1',
      amount: 400,
      invoiceId: 'INV-REV-MISSING-PAID-POST'
    });
    const beforePost = await captureDbSnapshot();

    vi.spyOn(FinancialTransactionRepository, 'reverseTransactions').mockImplementationOnce(
      async (_refId, tx) => {
        const ftTbl = tx.table('financialTransactions');
        const revId = `FT-REV-${fixturePost.ftId}-NO-PAID`;
        await ftTbl.put({
          id: revId,
          Transaction_ID: revId,
          Transaction_Type: 'Receipt',
          Reference_ID: fixturePost.id,
          Reference_Table: 'Vouchers',
          Entity_Type: 'Customer',
          Entity_Name: fixturePost.partnerId,
          Amount: fixturePost.amount,
          // Paid_Amount intentionally omitted
          Direction: 'Debit',
          tenantId,
          branchId,
          isReversal: true,
          reversalOf: fixturePost.ftId,
          isDeleted: false
        });
        await ftTbl.update(fixturePost.ftId, { isDeleted: true, reversedBy: revId });
        return { reversedCount: 1, reversalIds: [revId] };
      }
    );

    const resPost = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: fixturePost.id,
      type: 'RECEIPT',
      partnerId: fixturePost.partnerId,
      amount: fixturePost.amount
    });

    expect(resPost.success).toBe(false);
    expect(resPost.error?.message).toMatch(/FINANCIAL_TRANSACTION_REVERSAL_VERIFICATION_FAILED/i);
    expect(await captureDbSnapshot()).toEqual(beforePost);

    // 51b. Existing deterministic reversal without Paid_Amount is rejected before reuse
    const fixtureReuse = await seedCompletePaymentFixture({
      id: 'PYMT-REV-MISSING-PAID-REUSE',
      partnerId: 'SUPP-REV-MISSING-PAID-2',
      amount: 300,
      invoiceId: 'PUR-REV-MISSING-PAID-REUSE'
    });
    const idemKey = 'IDEM-REV-MISSING-PAID-REUSE';
    const existingRevId = `FT-REV-${fixtureReuse.ftId}-${idemKey}`;

    await db.financialTransactions.put({
      id: existingRevId,
      Transaction_ID: existingRevId,
      Transaction_Type: 'Payment',
      Reference_ID: fixtureReuse.id,
      Reference_Table: 'Vouchers',
      Entity_Type: 'Supplier',
      Entity_Name: fixtureReuse.partnerId,
      Amount: fixtureReuse.amount,
      // Paid_Amount intentionally omitted
      Direction: 'Credit',
      Transaction_Date: '2026-01-16',
      tenantId,
      branchId,
      isReversal: true,
      reversalOf: fixtureReuse.ftId,
      isDeleted: false
    } as any);

    const beforeReuse = await captureDbSnapshot();

    const resReuse = await WorkflowOrchestrator.execute(
      voucherCancellationWorkflow,
      {
        id: fixtureReuse.id,
        type: 'PAYMENT',
        partnerId: fixtureReuse.partnerId,
        amount: fixtureReuse.amount
      },
      { idempotencyKey: idemKey }
    );

    expect(resReuse.success).toBe(false);
    expect(resReuse.error?.message).toMatch(/FINANCIAL_TRANSACTION_REVERSAL_INCONSISTENT/i);
    expect(await captureDbSnapshot()).toEqual(beforeReuse);
  });

  // 52. Reject invalid non-finite, non-numeric, zero, or negative Paid_Amount values on original and reversal FTs
  it('52. Rejects invalid Paid_Amount values (null, string, NaN, Infinity, 0, negative) on original and compensating reversal with full rollback', async () => {
    const invalidValues: Array<{ label: string; value: any }> = [
      { label: 'null', value: null },
      { label: 'string', value: '400' },
      { label: 'NaN', value: Number.NaN },
      { label: 'Infinity', value: Number.POSITIVE_INFINITY },
      { label: 'negative Infinity', value: Number.NEGATIVE_INFINITY },
      { label: 'zero', value: 0 },
      { label: 'negative', value: -400 }
    ];

    // 52a. Invalid Paid_Amount on original active FinancialTransaction
    for (let i = 0; i < invalidValues.length; i++) {
      const entry = invalidValues[i]!;
      const fixture = await seedCompleteReceiptFixture({
        id: `RCPT-INVALID-PAID-ORIG-${i}`,
        partnerId: `CUST-INV-ORIG-${i}`,
        amount: 400,
        invoiceId: `INV-INVALID-PAID-ORIG-${i}`
      });
      await db.financialTransactions.update(fixture.ftId, { Paid_Amount: entry.value } as any);
      const before = await captureDbSnapshot();

      const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
        id: fixture.id,
        type: 'RECEIPT',
        partnerId: fixture.partnerId,
        amount: fixture.amount
      });

      expect(res.success, `Expected rejection for original Paid_Amount=${entry.label}`).toBe(false);
      expect(res.error?.message).toMatch(/VOUCHER_FINANCIAL_TRANSACTION_AMOUNT_MISMATCH/i);
      expect(await captureDbSnapshot()).toEqual(before);
    }

    // 52b. Invalid Paid_Amount on compensating reversal (postcondition guard)
    for (let i = 0; i < invalidValues.length; i++) {
      const entry = invalidValues[i]!;
      const fixture = await seedCompletePaymentFixture({
        id: `PYMT-INVALID-PAID-REV-${i}`,
        partnerId: `SUPP-INV-REV-${i}`,
        amount: 300,
        invoiceId: `PUR-INVALID-PAID-REV-${i}`
      });
      const before = await captureDbSnapshot();

      vi.spyOn(FinancialTransactionRepository, 'reverseTransactions').mockImplementationOnce(
        async (_refId, tx) => {
          const ftTbl = tx.table('financialTransactions');
          const revId = `FT-REV-${fixture.ftId}-INV-${i}`;
          await ftTbl.put({
            id: revId,
            Transaction_ID: revId,
            Transaction_Type: 'Payment',
            Reference_ID: fixture.id,
            Reference_Table: 'Vouchers',
            Entity_Type: 'Supplier',
            Entity_Name: fixture.partnerId,
            Amount: fixture.amount,
            Paid_Amount: entry.value,
            Direction: 'Credit',
            tenantId,
            branchId,
            isReversal: true,
            reversalOf: fixture.ftId,
            isDeleted: false
          });
          await ftTbl.update(fixture.ftId, { isDeleted: true, reversedBy: revId });
          return { reversedCount: 1, reversalIds: [revId] };
        }
      );

      const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
        id: fixture.id,
        type: 'PAYMENT',
        partnerId: fixture.partnerId,
        amount: fixture.amount
      });

      expect(res.success, `Expected postcondition rejection for reversal Paid_Amount=${entry.label}`).toBe(false);
      expect(res.error?.message).toMatch(/FINANCIAL_TRANSACTION_REVERSAL_VERIFICATION_FAILED/i);
      expect(await captureDbSnapshot()).toEqual(before);
    }
  });

  // 53. Preserve successful receipt and payment cancellation with valid matching Paid_Amount values
  it('53. Succeeds for receipt and payment cancellation when both original and reversal have valid matching Paid_Amount within Decimal tolerance', async () => {
    const receiptFixture = await seedCompleteReceiptFixture({
      id: 'RCPT-PAID-AMOUNT-OK',
      partnerId: 'CUST-PAID-OK',
      amount: 199.99,
      invoiceId: 'INV-PAID-AMOUNT-OK'
    });

    const receiptRes = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: receiptFixture.id,
      type: 'RECEIPT',
      partnerId: receiptFixture.partnerId,
      amount: receiptFixture.amount
    });
    expect(receiptRes.success).toBe(true);

    const receiptFts = await db.financialTransactions.where('Reference_ID').equals(receiptFixture.id).toArray();
    const receiptOrig = receiptFts.find((f: any) => f.id === receiptFixture.ftId)!;
    const receiptRev = receiptFts.find((f: any) => f.isReversal === true)!;
    expect(receiptOrig.isDeleted).toBe(true);
    expect(receiptOrig.Paid_Amount).toBe(199.99);
    expect(receiptRev.Paid_Amount).toBe(199.99);
    expect(receiptRev.Amount).toBe(199.99);
    expect(receiptRev.Direction).toBe('Debit');

    const paymentFixture = await seedCompletePaymentFixture({
      id: 'PYMT-PAID-AMOUNT-OK',
      partnerId: 'SUPP-PAID-OK',
      amount: 249.45,
      invoiceId: 'PUR-PAID-AMOUNT-OK'
    });

    const paymentRes = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: paymentFixture.id,
      type: 'PAYMENT',
      partnerId: paymentFixture.partnerId,
      amount: paymentFixture.amount
    });
    expect(paymentRes.success).toBe(true);

    const paymentFts = await db.financialTransactions.where('Reference_ID').equals(paymentFixture.id).toArray();
    const paymentOrig = paymentFts.find((f: any) => f.id === paymentFixture.ftId)!;
    const paymentRev = paymentFts.find((f: any) => f.isReversal === true)!;
    expect(paymentOrig.isDeleted).toBe(true);
    expect(paymentOrig.Paid_Amount).toBe(249.45);
    expect(paymentRev.Paid_Amount).toBe(249.45);
    expect(paymentRev.Amount).toBe(249.45);
    expect(paymentRev.Direction).toBe('Credit');
  });
});
