import { afterEach, describe, expect, it, vi } from 'vitest';

const { validateOperation } = vi.hoisted(() => ({
  validateOperation: vi.fn(),
}));

vi.mock('@/services/transactions/PeriodLockEngine', () => ({
  PeriodLockEngine: { validateOperation },
}));

import { periodService } from './periodService';

describe('Integrity PeriodService', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an empty or invalid invoice date before consulting the lock engine', async () => {
    await expect(periodService.validatePeriod('')).rejects.toThrow('تاريخ الفترة المحاسبية غير صالح.');
    await expect(periodService.validatePeriod('not-a-date')).rejects.toThrow('تاريخ الفترة المحاسبية غير صالح.');
    expect(validateOperation).not.toHaveBeenCalled();
  });

  it('delegates a valid invoice date to the canonical PeriodLockEngine', async () => {
    validateOperation.mockResolvedValueOnce(true);

    await expect(periodService.validatePeriod('2026-11-22T10:30:00.000Z')).resolves.toBeUndefined();

    expect(validateOperation).toHaveBeenCalledOnce();
    expect(validateOperation).toHaveBeenCalledWith(
      '2026-11-22T10:30:00.000Z',
      'عملية محاسبية',
    );
  });

  it('propagates a closed-period rejection without converting it into success', async () => {
    const lockedPeriodError = new Error('Period locked');
    validateOperation.mockRejectedValueOnce(lockedPeriodError);

    await expect(periodService.validatePeriod('2026-01-15T00:00:00.000Z')).rejects.toBe(lockedPeriodError);
  });
});
