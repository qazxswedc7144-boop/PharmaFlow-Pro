import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountingEngine } from './AccountingEngine';
import { CurrencyService } from '@/services/localization/CurrencyService';
import 'fake-indexeddb/auto';
import { db } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';

describe('AccountingEngine local SALE tax split', () => {
  beforeEach(async () => {
    TokenProvider.setSession(
      { id: 'USER-UNIT-001', tenantId: 'TENANT-UNIT-001', role: 'admin' } as any,
      'unit-test-access-token',
      { tenantId: 'TENANT-UNIT-001', branchId: 'BRANCH-UNIT-001', roles: ['admin'] }
    );
    // Clear only the active tenant's accounts after establishing its session.
    // The DB guard intentionally rejects tenant-scoped mutations without a session.
    await db.accounts.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    TokenProvider.clearSession();
  });

  it('debits receivables for gross total and credits net revenue plus tax payable', async () => {
    const accounts: Record<string, string> = {
      CASH: 'ACC-101',
      RECEIVABLE: 'ACC-103',
      SALES_REVENUE: 'ACC-401',
      TAX_PAYABLE: 'ACC-202',
      COGS: 'ACC-501',
      INVENTORY: 'ACC-102'
    };

    vi.spyOn(AccountingEngine, 'getCoreAccount').mockImplementation(async (type: any) => accounts[type] || 'ACC-GENERIC');
    await db.accounts.put({ id: 'ACC-TAX-TENANT-UNIT-001', code: '2201', name: 'VAT Payable', type: 'LIABILITY', isActive: true, tenantId: 'TENANT-UNIT-001' } as any);
    vi.spyOn(CurrencyService, 'convertToBase').mockImplementation(async (amount: number) => ({
      baseAmount: amount,
      rate: 1
    }));

    const entry = await AccountingEngine.generateSalesEntry({
      id: 'SALE-LOCAL-TAX-001',
      SaleID: 'SALE-LOCAL-TAX-001',
      date: '2026-11-08T12:00:00.000Z',
      paymentStatus: 'Credit',
      currencyCode: 'USD',
      totalAmount: 115,
      revenueAmount: 100,
      taxAmount: 15,
      tenantId: 'TENANT-UNIT-001',
      branchId: 'BRANCH-UNIT-001',
      items: []
    } as any, []);

    const lineAmount = (accountId: string, side: 'debit' | 'credit') =>
      entry.lines.filter(line => line.accountId === accountId)
        .reduce((sum, line) => sum + line[side], 0);

    expect(lineAmount('ACC-103', 'debit')).toBe(115);
    expect(lineAmount('ACC-401', 'credit')).toBe(100);
    expect(lineAmount('ACC-TAX-TENANT-UNIT-001', 'credit')).toBe(15);
    expect(entry.lines.reduce((sum, line) => sum + line.debit, 0)).toBe(115);
    expect(entry.lines.reduce((sum, line) => sum + line.credit, 0)).toBe(115);
  });

  it('uses cash rather than receivables for a cash sale without changing the tax split', async () => {
    const accounts: Record<string, string> = {
      CASH: 'ACC-101',
      RECEIVABLE: 'ACC-103',
      SALES_REVENUE: 'ACC-401',
      TAX_PAYABLE: 'ACC-202',
      COGS: 'ACC-501',
      INVENTORY: 'ACC-102'
    };

    vi.spyOn(AccountingEngine, 'getCoreAccount').mockImplementation(async (type: any) => accounts[type] || 'ACC-GENERIC');
    await db.accounts.put({ id: 'ACC-TAX-CASH-TENANT-UNIT-001', code: '2201', name: 'VAT Payable', type: 'LIABILITY', isActive: true, tenantId: 'TENANT-UNIT-001' } as any);
    vi.spyOn(CurrencyService, 'convertToBase').mockImplementation(async (amount: number) => ({
      baseAmount: amount,
      rate: 1
    }));

    const entry = await AccountingEngine.generateSalesEntry({
      id: 'SALE-CASH-TAX-001',
      SaleID: 'SALE-CASH-TAX-001',
      date: '2026-11-08T12:00:00.000Z',
      paymentStatus: 'Cash',
      currencyCode: 'USD',
      totalAmount: 115,
      revenueAmount: 100,
      taxAmount: 15,
      tenantId: 'TENANT-UNIT-001',
      branchId: 'BRANCH-UNIT-001',
      items: []
    } as any, []);

    expect(entry.lines.find(line => line.accountId === 'ACC-101')?.debit).toBe(115);
    expect(entry.lines.some(line => line.accountId === 'ACC-103')).toBe(false);
    expect(entry.lines.find(line => line.accountId === 'ACC-401')?.credit).toBe(100);
    expect(entry.lines.find(line => line.accountId === 'ACC-TAX-CASH-TENANT-UNIT-001')?.credit).toBe(15);
  });
  it('fails closed when the tenant has no tax payable account, even if another tenant has one', async () => {
    const accounts: Record<string, string> = { CASH: 'ACC-101', RECEIVABLE: 'ACC-103', SALES_REVENUE: 'ACC-401', COGS: 'ACC-501', INVENTORY: 'ACC-102' };
    vi.spyOn(AccountingEngine, 'getCoreAccount').mockImplementation(async (type: any) => accounts[type] || 'ACC-GENERIC');
    await db.accounts.put({ id: 'ACC-TAX-OTHER-TENANT', code: '2201', name: 'VAT Payable', type: 'LIABILITY', isActive: true, tenantId: 'TENANT-OTHER' } as any);
    vi.spyOn(CurrencyService, 'convertToBase').mockImplementation(async (amount: number) => ({ baseAmount: amount, rate: 1 }));
    await expect(AccountingEngine.generateSalesEntry({ id: 'SALE-TAX-CROSS-TENANT-001', SaleID: 'SALE-TAX-CROSS-TENANT-001', date: '2026-11-08T12:00:00.000Z', paymentStatus: 'Credit', currencyCode: 'USD', totalAmount: 115, revenueAmount: 100, taxAmount: 15, tenantId: 'TENANT-UNIT-001', branchId: 'BRANCH-UNIT-001', items: [] } as any, [])).rejects.toThrow('No tenant-owned active tax payable liability account is configured.');
  });
});
