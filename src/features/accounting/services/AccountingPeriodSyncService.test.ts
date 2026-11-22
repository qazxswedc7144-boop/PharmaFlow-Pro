import { afterEach, describe, expect, it, vi } from 'vitest';

const { get, post, patch, getAccountingPeriods, whereToArray, bulkDelete, bulkPut, transaction } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  getAccountingPeriods: vi.fn(),
  whereToArray: vi.fn(),
  bulkDelete: vi.fn(),
  bulkPut: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@/core/db', () => ({
  db: {
    accountingPeriods: {
      where: vi.fn(() => ({ equals: vi.fn(() => ({ toArray: whereToArray })) })),
      bulkDelete,
      bulkPut,
    },
    getAccountingPeriods,
    transaction,
    generateId: vi.fn(() => 'PER-NEW'),
  },
  getCurrentUserSession: vi.fn(() => ({ tenantId: 'tenant-a' })),
}));

vi.mock('@/shared/network/transport/unifiedTransport', () => ({
  unifiedTransport: { get, post, patch },
}));

import { AccountingPeriodSyncService } from './AccountingPeriodSyncService';

const SERVER_PERIOD = {
  id: 'PER-SERVER-ID',
  clientId: 'DEFAULT-PERIOD',
  startDate: '2026-01-01T00:00:00.000Z',
  endDate: '2026-12-31T23:59:59.999Z',
  isLocked: false,
  lockedBy: null,
  lockedAt: null,
};

describe('AccountingPeriodSyncService', () => {
  afterEach(() => {
    AccountingPeriodSyncService.invalidate();
    vi.clearAllMocks();
  });

  it('hydrates the tenant cache from PostgreSQL and removes stale tenant-local rows', async () => {
    get.mockResolvedValueOnce({ success: true, periods: [SERVER_PERIOD] });
    whereToArray.mockResolvedValueOnce([{ id: 'STALE', tenantId: 'tenant-a' }]);
    transaction.mockImplementationOnce(async (_mode: unknown, _table: unknown, callback: () => Promise<unknown>) => callback());

    const periods = await AccountingPeriodSyncService.getPeriods();

    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({
      id: 'DEFAULT-PERIOD',
      tenantId: 'tenant-a',
      Start_Date: SERVER_PERIOD.startDate,
      End_Date: SERVER_PERIOD.endDate,
      Is_Locked: false,
    });
    expect(bulkDelete).toHaveBeenCalledWith(['STALE']);
    expect(bulkPut).toHaveBeenCalledWith([expect.objectContaining({ id: 'DEFAULT-PERIOD', tenantId: 'tenant-a' })]);
  });

  it('bootstraps tenant-owned legacy periods once when the server has no periods', async () => {
    get.mockResolvedValueOnce({ success: true, periods: [] });
    getAccountingPeriods.mockResolvedValueOnce([{
      id: 'DEFAULT-PERIOD',
      tenantId: 'tenant-a',
      Start_Date: '2026-01-01T00:00:00.000Z',
      End_Date: '2026-12-31T23:59:59.999Z',
      Is_Locked: true,
    }]);
    post.mockResolvedValueOnce({ success: true });
    get.mockResolvedValueOnce({ success: true, periods: [{ ...SERVER_PERIOD, isLocked: true }] });
    whereToArray.mockResolvedValueOnce([]);
    transaction.mockImplementationOnce(async (_mode: unknown, _table: unknown, callback: () => Promise<unknown>) => callback());

    const periods = await AccountingPeriodSyncService.getPeriods();

    expect(post).toHaveBeenCalledWith('/api/accounting/periods/bootstrap', {
      periods: [{
        clientId: 'DEFAULT-PERIOD',
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-12-31T23:59:59.999Z',
        isLocked: true,
      }],
    }, expect.objectContaining({ profile: 'FINANCIAL', retries: 0 }));
    expect(periods[0].Is_Locked).toBe(true);
  });

  it('fails closed if neither PostgreSQL nor tenant-owned local periods are configured', async () => {
    get.mockResolvedValueOnce({ success: true, periods: [] });
    getAccountingPeriods.mockResolvedValueOnce([]);

    await expect(AccountingPeriodSyncService.getPeriods())
      .rejects.toThrow(/ACCOUNTING_PERIOD_NOT_CONFIGURED/);
    expect(post).not.toHaveBeenCalled();
  });

  it('does not authorize a local open period when the server is unreachable', async () => {
    get.mockRejectedValueOnce(new Error('Network offline'));
    getAccountingPeriods.mockResolvedValueOnce([{
      id: 'DEFAULT-PERIOD',
      tenantId: 'tenant-a',
      Start_Date: '2026-01-01T00:00:00.000Z',
      End_Date: '2026-12-31T23:59:59.999Z',
      Is_Locked: false,
    }]);

    await expect(AccountingPeriodSyncService.getPeriods()).rejects.toThrow('Network offline');
    expect(post).not.toHaveBeenCalled();
  });
});
