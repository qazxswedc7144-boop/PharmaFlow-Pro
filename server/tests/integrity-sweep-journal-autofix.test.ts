import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  entries: [] as Array<{ id: string; lines: Array<{ debit: number; credit: number }> }>,
  lines: [] as Array<{ id: string; entryId: string; debit: number; credit: number }>,
  accountBalances: {} as Record<string, number>,
  getJournalEntries: vi.fn(),
  deleteJournalEntry: vi.fn(),
  deleteJournalLines: vi.fn(),
  updateAccount: vi.fn(),
}));

vi.mock('@/core/db', () => ({
  db: {
    getJournalEntries: mocks.getJournalEntries,
    journalEntries: { delete: mocks.deleteJournalEntry },
    journalLines: { delete: mocks.deleteJournalLines },
    accounts: { update: mocks.updateAccount },
  },
  getCurrentUserSession: vi.fn(() => ({ tenantId: 'tenant-integrity-test' })),
}));

vi.mock('@/services/system/LoadTestService', () => ({
  LoadTestService: { logMetric: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@features/inventory/services/UnifiedInventoryMutationEngine', () => ({
  unifiedInventoryMutationEngine: { executeAdjustment: vi.fn() },
}));

vi.mock('@/services/audit/AnomalyScoringEngine', () => ({
  AnomalyScoringEngine: { calculateCurrentRiskScore: vi.fn() },
}));

vi.mock('@/constants', () => ({ IS_PREVIEW: false }));

import { IntegritySweepService } from '@/services/integrity/IntegritySweepService';

describe('IntegritySweepService journal auto-fix safety', () => {
  const validateJournal = (autoFix: boolean) =>
    (IntegritySweepService as any).validateJournal(autoFix) as Promise<boolean>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.entries = [{
      id: 'journal-imbalanced-1',
      lines: [
        { debit: 125, credit: 0 },
        { debit: 0, credit: 100 },
      ],
    }];
    mocks.lines = [
      { id: 'line-debit-1', entryId: 'journal-imbalanced-1', debit: 125, credit: 0 },
      { id: 'line-credit-1', entryId: 'journal-imbalanced-1', debit: 0, credit: 100 },
    ];
    mocks.accountBalances = { cash: 125, payable: -100 };

    mocks.getJournalEntries.mockImplementation(async () =>
      mocks.entries.map(entry => ({ ...entry, lines: entry.lines.map(line => ({ ...line })) }))
    );
    mocks.deleteJournalEntry.mockImplementation(async (entryId: string) => {
      mocks.entries = mocks.entries.filter(entry => entry.id !== entryId);
    });
    mocks.deleteJournalLines.mockImplementation(async (entryId: string) => {
      mocks.lines = mocks.lines.filter(line => line.entryId !== entryId);
    });
    mocks.updateAccount.mockImplementation(async (accountId: string, changes: { balance: number }) => {
      mocks.accountBalances[accountId] = changes.balance;
    });
  });

  it('preserves an imbalanced journal, its lines, and account balances when auto-fix is enabled', async () => {
    const entryBefore = structuredClone(mocks.entries);
    const linesBefore = structuredClone(mocks.lines);
    const balancesBefore = structuredClone(mocks.accountBalances);

    await expect(validateJournal(true)).resolves.toBe(false);

    expect(mocks.entries).toEqual(entryBefore);
    expect(mocks.lines).toEqual(linesBefore);
    expect(mocks.accountBalances).toEqual(balancesBefore);
    expect(mocks.deleteJournalEntry).not.toHaveBeenCalled();
    expect(mocks.deleteJournalLines).not.toHaveBeenCalled();
    expect(mocks.updateAccount).not.toHaveBeenCalled();
  });

  it('reports an imbalanced journal as unhealthy when auto-fix is disabled', async () => {
    await expect(validateJournal(false)).resolves.toBe(false);
    expect(mocks.entries).toHaveLength(1);
    expect(mocks.lines).toHaveLength(2);
    expect(mocks.deleteJournalEntry).not.toHaveBeenCalled();
  });

  it('continues to accept balanced journal entries', async () => {
    mocks.entries = [{
      id: 'journal-balanced-1',
      lines: [
        { debit: 75, credit: 0 },
        { debit: 0, credit: 75 },
      ],
    }];

    await expect(validateJournal(true)).resolves.toBe(true);
    expect(mocks.deleteJournalEntry).not.toHaveBeenCalled();
  });
});
