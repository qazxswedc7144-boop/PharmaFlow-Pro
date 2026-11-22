import { afterEach, describe, expect, it, vi } from 'vitest';

const { toArray } = vi.hoisted(() => ({
  toArray: vi.fn(),
}));
const { handleError } = vi.hoisted(() => ({
  handleError: vi.fn(),
}));

vi.mock('@/core/db', () => ({
  db: { accountingPeriods: { toArray } },
  getCurrentUserSession: vi.fn(() => ({ tenantId: 'tenant-test' })),
}));

vi.mock('@/core/errors', () => ({
  PeriodLockedError: class PeriodLockedError extends Error {},
  ErrorManager: { handleError },
}));

import { PeriodLockEngine } from './PeriodLockEngine';

describe('PeriodLockEngine period lookup', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('detects a locked period containing the requested date', async () => {
    toArray.mockResolvedValueOnce([{
      id: 'period-2026-01',
      Start_Date: '2026-01-01T00:00:00.000Z',
      End_Date: '2026-01-31T23:59:59.999Z',
      Is_Locked: true,
    }]);

    await expect(PeriodLockEngine.isPeriodLocked('2026-01-15T12:00:00.000Z')).resolves.toBe(true);
  });

  it('does not block dates in an open or unconfigured period', async () => {
    toArray.mockResolvedValueOnce([{
      id: 'period-2026-01',
      Start_Date: '2026-01-01T00:00:00.000Z',
      End_Date: '2026-01-31T23:59:59.999Z',
      Is_Locked: false,
    }]);
    await expect(PeriodLockEngine.isPeriodLocked('2026-01-15T12:00:00.000Z')).resolves.toBe(false);

    toArray.mockResolvedValueOnce([]);
    await expect(PeriodLockEngine.isPeriodLocked('2026-01-15T12:00:00.000Z')).resolves.toBe(false);
  });

  it('fails closed and propagates a normalized error when period storage is unavailable', async () => {
    const storageError = new Error('IndexedDB unavailable');
    const normalizedError = new Error('Accounting period status could not be verified.');
    toArray.mockRejectedValueOnce(storageError);
    handleError.mockReturnValueOnce(normalizedError);

    await expect(PeriodLockEngine.isPeriodLocked('2026-01-15T12:00:00.000Z')).rejects.toBe(normalizedError);
    expect(handleError).toHaveBeenCalledWith(storageError, {
      module: 'ACCOUNTING',
      action: 'CHECK_PERIOD_LOCK',
      showToast: false,
    });
  });
});
