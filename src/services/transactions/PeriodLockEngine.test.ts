import { afterEach, describe, expect, it, vi } from 'vitest';

const { getPeriods, setLocked, handleError } = vi.hoisted(() => ({
  getPeriods: vi.fn(),
  setLocked: vi.fn(),
  handleError: vi.fn((error: unknown) => error),
}));

vi.mock('@/core/db', () => ({
  db: { accountingPeriods: { count: vi.fn(), add: vi.fn() } },
  getCurrentUserSession: vi.fn(() => ({ tenantId: 'tenant-test' })),
}));

vi.mock('@/features/accounting/services/AccountingPeriodSyncService', () => ({
  AccountingPeriodSyncService: { getPeriods, setLocked },
}));

vi.mock('@/core/errors', () => ({
  PeriodLockedError: class PeriodLockedError extends Error {},
  ErrorManager: { handleError },
}));

import { PeriodLockEngine } from './PeriodLockEngine';

const JANUARY_PERIOD = {
  id: 'period-2026-01',
  Start_Date: '2026-01-01T00:00:00.000Z',
  End_Date: '2026-01-31T23:59:59.999Z',
  Is_Locked: true,
};

describe('PeriodLockEngine authoritative period lookup', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('detects a locked period containing the requested date', async () => {
    getPeriods.mockResolvedValueOnce([JANUARY_PERIOD]);

    await expect(PeriodLockEngine.isPeriodLocked('2026-01-15T12:00:00.000Z')).resolves.toBe(true);
  });

  it('allows a date covered by exactly one open period', async () => {
    getPeriods.mockResolvedValueOnce([{ ...JANUARY_PERIOD, Is_Locked: false }]);

    await expect(PeriodLockEngine.isPeriodLocked('2026-01-15T12:00:00.000Z')).resolves.toBe(false);
  });

  it('fails closed when no configured period covers the operation date', async () => {
    getPeriods.mockResolvedValueOnce([]);

    await expect(PeriodLockEngine.isPeriodLocked('2026-02-15T12:00:00.000Z'))
      .rejects.toThrow(/ACCOUNTING_PERIOD_NOT_CONFIGURED/);
  });

  it('fails closed when overlapping periods make the lock state ambiguous', async () => {
    getPeriods.mockResolvedValueOnce([
      JANUARY_PERIOD,
      { ...JANUARY_PERIOD, id: 'period-overlap', Is_Locked: false },
    ]);

    await expect(PeriodLockEngine.isPeriodLocked('2026-01-15T12:00:00.000Z'))
      .rejects.toThrow(/ACCOUNTING_PERIOD_AMBIGUOUS/);
  });

  it('rejects invalid dates before asking the server', async () => {
    await expect(PeriodLockEngine.isPeriodLocked('not-a-date'))
      .rejects.toThrow(/ACCOUNTING_PERIOD_DATE_INVALID/);
    expect(getPeriods).not.toHaveBeenCalled();
  });

  it('fails closed and propagates a normalized error when the authoritative API is unavailable', async () => {
    const networkError = new Error('Network offline');
    const normalizedError = new Error('Accounting period status could not be verified.');
    getPeriods.mockRejectedValueOnce(networkError);
    handleError.mockReturnValueOnce(normalizedError);

    await expect(PeriodLockEngine.isPeriodLocked('2026-01-15T12:00:00.000Z')).rejects.toBe(normalizedError);
    expect(handleError).toHaveBeenCalledWith(networkError, {
      module: 'ACCOUNTING',
      action: 'CHECK_PERIOD_LOCK',
      showToast: false,
    });
  });

  it('routes period locking through the authoritative service', async () => {
    setLocked.mockResolvedValueOnce(undefined);

    await expect(PeriodLockEngine.lockPeriod('period-2026-01')).resolves.toBeUndefined();
    expect(setLocked).toHaveBeenCalledWith('period-2026-01', true);
  });
});
