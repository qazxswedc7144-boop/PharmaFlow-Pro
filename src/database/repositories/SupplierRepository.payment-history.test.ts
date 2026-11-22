import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/core/db';
import { useAuthStore } from '@/store/authStore';
import { SupplierRepository } from './SupplierRepository';

describe('SupplierRepository.getInvoicePaymentHistory', () => {
  const tenantId = 'TENANT-PUR-005';
  const branchId = 'BRANCH-PUR-005';

  beforeEach(async () => {
    useAuthStore.setState({
      user: {
        id: 'USER-PUR-005',
        tenantId,
        branchId,
        role: 'accountant',
        roles: ['accountant'],
        permissions: []
      } as any,
      tenantId,
      branchId,
      roles: ['accountant'],
      permissions: [],
      isAuthenticated: true
    });

    await db.vouchers.clear();
    await db.voucherInvoiceLinks.clear();
  });

  afterEach(async () => {
    await db.voucherInvoiceLinks.clear();
    await db.vouchers.clear();
  });

  it('reads invoice links from voucherInvoiceLinks and displays the allocated amount', async () => {
    await db.vouchers.put({
      id: 'VOUCHER-001',
      voucherId: 'VOUCHER-001',
      voucherNumber: 'PAY-2026-001',
      type: 'PAYMENT',
      date: '2026-11-20T10:00:00.000Z',
      amount: 900,
      tenantId,
      branchId
    } as any);
    await db.voucherInvoiceLinks.put({
      id: 'LINK-001',
      linkId: 'LINK-001',
      voucherId: 'VOUCHER-001',
      invoiceId: 'PUR-INV-001',
      Paid_Amount: 250,
      tenantId,
      branchId
    } as any);

    await expect(SupplierRepository.getInvoicePaymentHistory('PUR-INV-001')).resolves.toEqual([
      {
        id: 'VOUCHER-001',
        voucherId: 'PAY-2026-001',
        date: '2026-11-20T10:00:00.000Z',
        amount: 250
      }
    ]);
  });

  it('returns each voucher allocation separately when one invoice has multiple payments', async () => {
    await db.vouchers.bulkPut([
      { id: 'VOUCHER-002', voucherId: 'VOUCHER-002', date: '2026-11-19', amount: 700, tenantId, branchId },
      { id: 'VOUCHER-003', voucherId: 'VOUCHER-003', date: '2026-11-21', amount: 500, tenantId, branchId }
    ] as any);
    await db.voucherInvoiceLinks.bulkPut([
      { id: 'LINK-002', linkId: 'LINK-002', voucherId: 'VOUCHER-002', invoiceId: 'PUR-INV-002', Paid_Amount: 300, tenantId, branchId },
      { id: 'LINK-003', linkId: 'LINK-003', voucherId: 'VOUCHER-003', invoiceId: 'PUR-INV-002', Paid_Amount: 200, tenantId, branchId }
    ] as any);

    const history = await SupplierRepository.getInvoicePaymentHistory('PUR-INV-002');

    expect(history).toHaveLength(2);
    expect(history.map((item) => item.amount).sort((a, b) => a - b)).toEqual([200, 300]);
    expect(history.map((item) => item.voucherId).sort()).toEqual(['VOUCHER-002', 'VOUCHER-003']);
  });

  it('returns an empty history when no invoice links exist', async () => {
    await expect(SupplierRepository.getInvoicePaymentHistory('PUR-INV-MISSING')).resolves.toEqual([]);
  });

  it('ignores orphaned links whose voucher record is missing', async () => {
    await db.voucherInvoiceLinks.put({
      id: 'LINK-ORPHAN',
      linkId: 'LINK-ORPHAN',
      voucherId: 'VOUCHER-MISSING',
      invoiceId: 'PUR-INV-ORPHAN',
      Paid_Amount: 125,
      tenantId,
      branchId
    } as any);

    await expect(SupplierRepository.getInvoicePaymentHistory('PUR-INV-ORPHAN')).resolves.toEqual([]);
  });
});
