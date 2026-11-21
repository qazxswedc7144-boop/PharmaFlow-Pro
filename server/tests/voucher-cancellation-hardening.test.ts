import { describe, it, expect, beforeEach } from 'vitest';
import { voucherCancellationWorkflow } from '@/features/accounting/workflows/VoucherCancellationWorkflow';
import { WorkflowOrchestrator } from '@/core/workflow';
import { useAuthStore } from '@/store/authStore';
import { db } from '@/core/db';

describe('Voucher Cancellation Hardening & Financial Integrity Suite', () => {
  const tenantId = 'TENANT-VOUCHER-HARDEN-01';
  const branchId = 'BRH-VOUCHER-MAIN-01';

  beforeEach(async () => {
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

    // Setup Chart of Accounts
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

  it('1. Rejects cancellation when customer does not exist', async () => {
    await db.receipts.put({
      id: 'RCPT-001',
      amount: 500,
      partnerId: 'CUST-NONEXISTENT',
      tenantId,
      branchId
    } as any);

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: 'RCPT-001',
      type: 'RECEIPT',
      partnerId: 'CUST-NONEXISTENT',
      amount: 500
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/CUSTOMER_NOT_FOUND/i);
  });

  it('2. Rejects cancellation when amount mismatches saved record', async () => {
    await db.receipts.put({
      id: 'RCPT-002',
      amount: 1000,
      partnerId: 'CUST-01',
      tenantId,
      branchId
    } as any);

    await db.customers.put({
      id: 'CUST-01',
      name: 'عميل اختبار',
      balance: 2000,
      tenantId,
      branchId
    } as any);

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: 'RCPT-002',
      type: 'RECEIPT',
      partnerId: 'CUST-01',
      amount: 500 // Mismatch
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/VOUCHER_AMOUNT_MISMATCH/i);
  });

  it('3. Rejects cancellation when journal line references non-existent account', async () => {
    await db.receipts.put({
      id: 'RCPT-003',
      amount: 300,
      partnerId: 'CUST-02',
      tenantId,
      branchId
    } as any);

    await db.customers.put({
      id: 'CUST-02',
      name: 'عميل 2',
      balance: 1500,
      tenantId,
      branchId
    } as any);

    await db.journalEntries.put({
      id: 'JE-BAD-ACCT',
      sourceId: 'RCPT-003',
      tenantId,
      branchId,
      lines: [
        { accountId: 'ACC-NONEXISTENT', debit: 300, credit: 0 },
        { accountId: 'ACC-101', debit: 0, credit: 300 }
      ]
    } as any);

    const res = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: 'RCPT-003',
      type: 'RECEIPT',
      partnerId: 'CUST-02',
      amount: 300
    });

    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/ACCOUNT_NOT_FOUND/i);

    // Verify customer balance was NOT modified due to rollback
    const cust = await db.customers.get('CUST-02');
    expect(cust?.balance).toBe(1500);
  });

  it('4. Rejects double cancellation', async () => {
    await db.receipts.put({
      id: 'RCPT-004',
      amount: 400,
      partnerId: 'CUST-03',
      tenantId,
      branchId
    } as any);

    await db.customers.put({
      id: 'CUST-03',
      name: 'عميل 3',
      balance: 1000,
      tenantId,
      branchId
    } as any);

    // First cancel succeeds
    const res1 = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: 'RCPT-004',
      type: 'RECEIPT',
      partnerId: 'CUST-03',
      amount: 400
    });
    expect(res1.success).toBe(true);

    // Second cancel fails (already cancelled)
    const res2 = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: 'RCPT-004',
      type: 'RECEIPT',
      partnerId: 'CUST-03',
      amount: 400
    });
    expect(res2.success).toBe(false);
    expect(res2.error?.message).toMatch(/غير موجود/i);
  });
});
