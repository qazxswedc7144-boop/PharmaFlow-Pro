import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportEngine } from './reportEngine';
import { reportCache } from '@features/reports/services/reportCacheService';

describe('ReportEngine background refresh', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('defers report cache refresh to a later event-loop turn', async () => {
    vi.useFakeTimers();
    const purge = vi.spyOn(reportCache, 'purge');
    reportEngine.scheduleRefresh();

    expect(purge).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(purge).toHaveBeenCalledTimes(1);
  });
});

import { toTrialBalanceColumns } from '../../../server/routes/accounting.routes.js';

describe('Legacy trial balance debit/credit sign convention', () => {
  it('shows posted supplier liability and sales revenue credit balances in the credit column', () => {
    // Posted invoice journal lines; stored account balances use debit - credit.
    const purchaseLines = [{ debit: 0, credit: 120 }];
    const saleLines = [{ debit: 0, credit: 85 }];

    const supplierBalance = purchaseLines.reduce((balance, line) => balance + line.debit - line.credit, 0);
    const revenueBalance = saleLines.reduce((balance, line) => balance + line.debit - line.credit, 0);

    expect(supplierBalance).toBe(-120);
    expect(revenueBalance).toBe(-85);
    expect(toTrialBalanceColumns(supplierBalance)).toEqual({ debit: 0, credit: 120 });
    expect(toTrialBalanceColumns(revenueBalance)).toEqual({ debit: 0, credit: 85 });
  });

  it('keeps debit balances in the debit column regardless of account type', () => {
    expect(toTrialBalanceColumns(40)).toEqual({ debit: 40, credit: 0 });
    expect(toTrialBalanceColumns(0)).toEqual({ debit: 0, credit: 0 });
  });
});
