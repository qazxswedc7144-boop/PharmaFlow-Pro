import 'fake-indexeddb/auto';

import { vi, beforeEach, describe, expect, it } from 'vitest';

const { getCurrentSession } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(() => ({
    isAuthenticated: true,
    token: 'manual-journal-test-token',
    tenantId: 'TENANT-MANUAL-JOURNAL',
    branchId: 'BRANCH-MANUAL-JOURNAL',
    user: {
      id: 'USER-MANUAL-JOURNAL',
      tenantId: 'TENANT-MANUAL-JOURNAL'
    }
  }))
}));

vi.mock('@/services/auth/tokenProvider', () => ({
  TokenProvider: { getCurrentSession }
}));

import { db } from '@/core/db';
import { TransactionBoundary } from '@/core/integrity/transactionBoundary';
import { AccountingRepository } from '@/database/repositories/AccountingRepository';
import { JournalPostingWorkflow } from '@/features/accounting/workflows/JournalPostingWorkflow';
import { useAuthStore } from '@/store/authStore';

const TENANT_ID = 'TENANT-MANUAL-JOURNAL';
const BRANCH_ID = 'BRANCH-MANUAL-JOURNAL';

const context = () => ({
  workflowId: 'WF-MANUAL-JOURNAL-001',
  correlationId: 'CORR-MANUAL-JOURNAL-001',
  idempotencyKey: 'IDEM-MANUAL-JOURNAL-001',
  tenantId: TENANT_ID,
  branchId: BRANCH_ID,
  userId: 'USER-MANUAL-JOURNAL',
  deviceId: 'TEST-DEVICE',
  operationType: 'JOURNAL_POSTING',
  startedAt: '2026-11-24T00:00:00.000Z'
});

describe('Manual journal persistence and reversal integrity', () => {
  const workflow = new JournalPostingWorkflow();

  beforeEach(async () => {
    await db.open();
    useAuthStore.setState({
      user: {
        id: 'USER-MANUAL-JOURNAL',
        tenantId: TENANT_ID,
        branchId: BRANCH_ID,
        role: 'accountant',
        roles: ['accountant'],
        permissions: ['accounting.journal.create', 'accounting.post']
      } as any,
      tenantId: TENANT_ID,
      branchId: BRANCH_ID,
      token: 'manual-journal-test-token',
      roles: ['accountant'],
      permissions: ['accounting.journal.create', 'accounting.post'],
      isAuthenticated: true
    });

    await db.journalEntries.where('tenantId').equals(TENANT_ID).delete();
    await db.journalLines.where('tenantId').equals(TENANT_ID).delete();
    await db.accounts.where('tenantId').equals(TENANT_ID).delete();

    await db.accounts.bulkPut([
      {
        id: 'ACC-MJ-CASH',
        code: '101',
        name: 'Cash',
        type: 'Asset',
        balanceType: 'Debit',
        balance: 1000,
        tenantId: TENANT_ID,
        branchId: BRANCH_ID
      },
      {
        id: 'ACC-MJ-REVENUE',
        code: '401',
        name: 'Revenue',
        type: 'Revenue',
        balanceType: 'Credit',
        balance: 2000,
        tenantId: TENANT_ID,
        branchId: BRANCH_ID
      }
    ] as any);
  });

  it('requires the active transaction and persists entry, lines, and account balances atomically through posting and reversal', async () => {
    const input = {
      date: '2026-11-24',
      description: 'Manual journal persistence regression',
      reference: 'MANUAL-JOURNAL-REF-001',
      lines: [
        { accountId: 'ACC-MJ-CASH', accountCode: '101', accountName: 'Cash', debit: 125, credit: 0 },
        { accountId: 'ACC-MJ-REVENUE', accountCode: '401', accountName: 'Revenue', debit: 0, credit: 125 }
      ]
    };

    await expect(
      workflow.executeDomainSteps(input, context() as any)
    ).rejects.toThrow(/ACTIVE_TRANSACTION_REQUIRED/i);

    const posted = await TransactionBoundary.executeAtomic(
      workflow.tables!,
      (tx) => workflow.executeDomainSteps(input, context() as any, tx)
    );

    const savedEntry = await db.journalEntries.get(posted.journalId);
    const savedLines = await db.journalLines.where('entryId').equals(posted.journalId).toArray();

    expect(savedEntry).toBeDefined();
    expect(savedEntry?.lines).toHaveLength(2);
    expect(savedLines).toHaveLength(2);
    expect(savedLines.map(line => line.entryId)).toEqual([posted.journalId, posted.journalId]);
    expect(savedLines.map(line => (line as any).entry_id)).toEqual([posted.journalId, posted.journalId]);
    expect(savedLines.every(line => line.tenantId === TENANT_ID && line.branchId === BRANCH_ID)).toBe(true);

    const totalDebit = savedLines.reduce((sum, line) => sum + line.debit, 0);
    const totalCredit = savedLines.reduce((sum, line) => sum + line.credit, 0);
    expect(totalDebit).toBe(125);
    expect(totalCredit).toBe(125);
    expect((await db.accounts.get('ACC-MJ-CASH'))?.balance).toBe(1125);
    expect((await db.accounts.get('ACC-MJ-REVENUE'))?.balance).toBe(1875);

    await TransactionBoundary.executeAtomic(
      ['journalEntries', 'journalLines', 'accounts'],
      (tx) => AccountingRepository.deleteEntry(posted.journalId, tx)
    );

    expect(await db.journalEntries.get(posted.journalId)).toBeUndefined();
    expect(await db.journalLines.where('entryId').equals(posted.journalId).count()).toBe(0);
    expect((await db.accounts.get('ACC-MJ-CASH'))?.balance).toBe(1000);
    expect((await db.accounts.get('ACC-MJ-REVENUE'))?.balance).toBe(2000);
  });
});
