import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountingEngine } from './AccountingEngine';
import { CurrencyService } from '@/services/localization/CurrencyService';

describe('AccountingEngine local SALE tax split', () => {
  afterEach(() => vi.restoreAllMocks());

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
    expect(lineAmount('ACC-202', 'credit')).toBe(15);
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

    vi.spyOn(AccountingEngine, 'getCoreAccount').mockImplementation(async (type: any) => accounts[type]);
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
    expect(entry.lines.find(line => line.accountId === 'ACC-202')?.credit).toBe(15);
  });
});
