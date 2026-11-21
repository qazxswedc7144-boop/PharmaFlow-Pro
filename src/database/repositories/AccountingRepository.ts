import Decimal from 'decimal.js-light';
import { db } from '@/core/db';
import { Account, AccountingEntry, CashFlow, Transaction } from '@/types';
import { useAuthStore } from '@/store/authStore';
import { generateTransactionUuid } from '@/utils/uuid';

const MAX_ACCOUNTING_SLICE = 200;

export const AccountingRepository = {
  // --- دليل الحسابات ---
  getAccounts: async (): Promise<Account[]> => {
    return await db.accounts.toArray();
  },

  getAccountById: async (id: string): Promise<Account | undefined> => {
    return await db.accounts.get(id);
  },

  saveAccount: async (account: Account) => {
    await db.accounts.put(account);
  },

  deleteAccount: async (id: string) => {
    await db.accounts.delete(id);
  },

  // --- القيود اليومية ---
  getAllJournalEntries: async (): Promise<AccountingEntry[]> => {
    return await db.journalEntries.toArray();
  },

  getEntries: async (): Promise<AccountingEntry[]> => {
    return await db.journalEntries.toArray();
  },

  getRecentJournalEntries: async (): Promise<AccountingEntry[]> => {
    return await db.journalEntries
      .orderBy('date')
      .reverse()
      .limit(MAX_ACCOUNTING_SLICE)
      .toArray();
  },

  addEntry: async (entry: AccountingEntry, tx?: any, assertWriteContext?: () => void) => {
    const totalDebit = entry.lines.reduce(
      (sum, l) => sum + (l.debit || 0),
      0
    );

    const totalCredit = entry.lines.reduce(
      (sum, l) => sum + (l.credit || 0),
      0
    );

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new Error(
        `قيد غير متزن: إجمالي المدين (${totalDebit}) لا يساوي إجمالي الدائن (${totalCredit}) للفاتورة #${entry.sourceId}`
      );
    }

    const performWrite = async (t: any) => {
      assertWriteContext?.();
      if (!t || typeof t.table !== 'function') {
        throw new Error(
          'ACCOUNTING_WRITE_REJECTED: ACTIVE_TRANSACTION_REQUIRED'
        );
      }

      const entryId =
        entry.id || generateTransactionUuid('JE');

      let tenantId = (entry as any).tenantId;
      let branchId = (entry as any).branchId;

      if (
        !tenantId ||
        tenantId === 'default' ||
        tenantId === 'default-tenant' ||
        tenantId === 'tenant-default' ||
        tenantId === 'main'
      ) {
        const authState = useAuthStore.getState();
        const user = authState.user;

        tenantId =
          (user as any)?.tenantId ||
          (user as any)?.tenant_id ||
          authState.tenantId ||
          null;
      }

      if (
        !branchId ||
        branchId === 'main' ||
        branchId === 'default' ||
        branchId === 'default-branch' ||
        branchId === 'BRH-DEFAULT'
      ) {
        const authState = useAuthStore.getState();
        const user = authState.user;

        branchId =
          (user as any)?.branchId ||
          (user as any)?.branch_id ||
          authState.branchId ||
          null;
      }

      if (
        !tenantId ||
        tenantId === 'default' ||
        tenantId === 'default-tenant' ||
        tenantId === 'tenant-default' ||
        tenantId === 'main'
      ) {
        throw new Error(
          'FAIL_CLOSED: قيد اليومية يتطلب سياق مؤسسة موثوق (Trusted Tenant Context Required).'
        );
      }

      if (
        !branchId ||
        branchId === 'main' ||
        branchId === 'default' ||
        branchId === 'default-branch' ||
        branchId === 'BRH-DEFAULT'
      ) {
        throw new Error(
          'FAIL_CLOSED: قيد اليومية يتطلب فرع موثوق للمؤسسة (Trusted Branch Context Required).'
        );
      }

      /*
       * IMPORTANT:
       * t is the real Dexie Transaction supplied by safeTransaction().
       * Never fall back to global db tables here.
       */
      const jeTbl = t.table('journalEntries');
      const accTbl = t.table('accounts');
      const jlTbl = t.table('journalLines');

      const now = new Date().toISOString();

      /*
       * Transaction-scoped idempotency.
       *
       * If the same journal entry was already committed,
       * do not apply account balances or journal lines again.
       */
      const existingEntry = await jeTbl.get(entryId);
      assertWriteContext?.();

      if (existingEntry) {
        const sameScope =
          (existingEntry as any).tenantId === tenantId &&
          (existingEntry as any).branchId === branchId &&
          (existingEntry as any).sourceId === entry.sourceId &&
          (existingEntry as any).sourceType === entry.sourceType;

        if (!sameScope) {
          throw new Error(
            `ACCOUNTING_IDEMPOTENCY_CONFLICT: Journal entry ${entryId} already exists in a different scope or source.`
          );
        }

        return;
      }

      assertWriteContext?.();
      await jeTbl.put({
        ...entry,
        id: entryId,
        createdAt:
          (entry as any).createdAt ||
          entry.created_at ||
          now,
        created_at:
          entry.created_at ||
          (entry as any).createdAt ||
          now,
        tenantId,
        branchId,
        status: entry.status || 'Posted'
      });

      /*
       * Update account balances and persist journal lines
       * inside the SAME Dexie transaction.
       */
      for (const line of entry.lines) {
        const lineAccId =
          line.accountId ||
          line.account_id ||
          'ACC-GENERIC';

        const lineEntryId =
          line.entryId ||
          line.entry_id ||
          entryId;

        const amount =
          (line.debit || 0) -
          (line.credit || 0);

        const account = await accTbl.get(lineAccId);

        if (account) {
          assertWriteContext?.();
          await accTbl.update(lineAccId, {
            balance:
              (account.balance || 0) +
              amount,
            updatedAt: now
          });
        }

        assertWriteContext?.();
        await jlTbl.add({
          ...line,
          id:
            line.id ||
            line.lineId ||
            generateTransactionUuid('JL'),
          entryId: lineEntryId,
          entry_id: lineEntryId,
          accountId: lineAccId,
          account_id: lineAccId,
          tenantId,
          branchId
        });
      }
    };

    if (tx) {
      await performWrite(tx);
    } else {
      await db.safeTransaction(
        'rw',
        [
          'journalEntries',
          'accounts',
          'journalLines'
        ],
        performWrite
      );
    }
  },
    // Alias for addEntry to support legacy code
  addJournalEntry: async (entry: AccountingEntry) => {
    return await AccountingRepository.addEntry(entry);
  },

  deleteEntry: async (entryId: string, tx?: any) => {
    const performDelete = async (t: any) => {
      if (!t || typeof t.table !== 'function') {
        throw new Error(
          'ACCOUNTING_WRITE_REJECTED: ACTIVE_TRANSACTION_REQUIRED'
        );
      }

      const jeTbl = t.table('journalEntries');
      const accTbl = t.table('accounts');
      const jlTbl = t.table('journalLines');

      const entry = await jeTbl.get(entryId);
      if (!entry) {
        throw new Error(`JOURNAL_ENTRY_NOT_FOUND: Entry ${entryId} does not exist or was already deleted.`);
      }

      const savedLines = await jlTbl.where('entryId').equals(entryId).toArray();
      const inlineLines = Array.isArray(entry.lines) ? entry.lines : [];

      if (savedLines.length === 0 && inlineLines.length === 0) {
        throw new Error(`JOURNAL_LINES_MISSING: Entry ${entryId} has no journal lines in journalLines table or entry.lines.`);
      }
      if (savedLines.length === 0) {
        throw new Error(`PERSISTED_JOURNAL_LINES_MISSING: Entry ${entryId} has inline entry.lines but no persisted rows in journalLines table.`);
      }
      if (inlineLines.length === 0) {
        throw new Error(`INLINE_JOURNAL_LINES_MISSING: Entry ${entryId} has persisted journalLines rows but is missing inline entry.lines.`);
      }
      if (savedLines.length !== inlineLines.length) {
        throw new Error(`JOURNAL_LINE_COUNT_MISMATCH: Saved lines count (${savedLines.length}) does not match entry.lines count (${inlineLines.length}).`);
      }
      if (savedLines.length < 2) {
        throw new Error(`INVALID_JOURNAL_LINE_COUNT: Entry ${entryId} must contain at least 2 journal lines.`);
      }

      const parseLineAmount = (raw: unknown, fieldName: string): Decimal => {
        if (raw === undefined || raw === null) {
          return new Decimal(0);
        }
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
          throw new Error(`INVALID_JOURNAL_AMOUNTS: ${fieldName} (${String(raw)}) in entry ${entryId} contains an invalid numeric value.`);
        }
        return new Decimal(raw);
      };

      const normalizeLine = (line: any) => {
        const rawAccId = line?.accountId ?? line?.account_id;
        const accountId = typeof rawAccId === 'string' ? rawAccId.trim() : '';
        if (!accountId || accountId === 'ACC-GENERIC') {
          throw new Error(`INVALID_ACCOUNT_ID: Journal line for entry ${entryId} has missing or generic account ID.`);
        }

        const debit = parseLineAmount(line?.debit, 'Debit');
        const credit = parseLineAmount(line?.credit, 'Credit');

        if ((debit.greaterThan(0) && credit.greaterThan(0)) || (debit.equals(0) && credit.equals(0))) {
          throw new Error(`INVALID_JOURNAL_AMOUNTS: Journal line for entry ${entryId} must have either positive debit or positive credit.`);
        }

        return {
          accountId,
          debit,
          credit,
          signature: `${accountId}|${debit.toFixed(4)}|${credit.toFixed(4)}`
        };
      };

      const normalizedSaved = savedLines.map(normalizeLine);
      const normalizedInline = inlineLines.map(normalizeLine);

      // Order-independent comparison of persisted journalLines against inline entry.lines
      const savedSignatures = normalizedSaved.map((l) => l.signature).sort();
      const inlineSignatures = normalizedInline.map((l) => l.signature).sort();

      for (let i = 0; i < savedSignatures.length; i++) {
        if (savedSignatures[i] !== inlineSignatures[i]) {
          throw new Error(`JOURNAL_LINE_DATA_MISMATCH: Persisted journalLines do not match inline entry.lines for entry ${entryId}.`);
        }
      }

      // Verify journal entry balance before mutating any account
      let totalDebit = new Decimal(0);
      let totalCredit = new Decimal(0);
      const accountDeltas = new Map<string, Decimal>();

      for (const line of normalizedSaved) {
        totalDebit = totalDebit.plus(line.debit);
        totalCredit = totalCredit.plus(line.credit);

        const reversalDelta = line.credit.minus(line.debit);
        const existingDelta = accountDeltas.get(line.accountId) ?? new Decimal(0);
        accountDeltas.set(line.accountId, existingDelta.plus(reversalDelta));
      }

      if (totalDebit.lessThanOrEqualTo(0) || totalDebit.minus(totalCredit).abs().greaterThan('0.01')) {
        throw new Error(
          `UNBALANCED_JOURNAL_ENTRY: Entry ${entryId} is unbalanced (debit=${totalDebit.toFixed(2)}, credit=${totalCredit.toFixed(2)}).`
        );
      }

      // Validate all referenced accounts before mutating any balance
      const accountsToUpdate: Array<{ accountId: string; nextBalance: number }> = [];
      for (const [accountId, delta] of accountDeltas.entries()) {
        const account = await accTbl.get(accountId);
        if (!account) {
          throw new Error(`ACCOUNT_NOT_FOUND: Account ${accountId} referenced in journal entry ${entryId} does not exist.`);
        }
        if (account.tenantId && entry.tenantId && account.tenantId !== entry.tenantId) {
          throw new Error(`CROSS_TENANT_ACCOUNT_FORBIDDEN: Account ${accountId} does not belong to entry tenant ${entry.tenantId}.`);
        }
        const currentBalance = account.balance ?? 0;
        if (typeof currentBalance !== 'number' || !Number.isFinite(currentBalance)) {
          throw new Error(`INVALID_ACCOUNT_BALANCE: Account ${accountId} has a non-finite balance.`);
        }
        const nextBalance = new Decimal(currentBalance).plus(delta).toNumber();
        if (!Number.isFinite(nextBalance)) {
          throw new Error(`INVALID_REVERSAL_AMOUNT: Computed reversal balance for account ${accountId} is not finite.`);
        }
        accountsToUpdate.push({ accountId, nextBalance });
      }

      const now = new Date().toISOString();
      for (const { accountId, nextBalance } of accountsToUpdate) {
        await accTbl.update(accountId, {
          balance: nextBalance,
          updatedAt: now
        });
      }

      await jeTbl.delete(entryId);
      await jlTbl.where('entryId').equals(entryId).delete();
    };

    if (tx !== undefined) {
      await performDelete(tx);
    } else {
      await db.safeTransaction(
        'rw',
        [
          'journalEntries',
          'accounts',
          'journalLines'
        ],
        performDelete
      );
    }
  },

  deleteEntriesBySource: async (
    sourceId: string
  ) => {
    const entries =
      await db.journalEntries
        .where('sourceId')
        .equals(sourceId)
        .toArray();

    if (entries) {
      for (const entry of entries) {
        await AccountingRepository.deleteEntry(
          entry.id
        );
      }
    }
  },

  getAccountBalance: async (
    accountName: string
  ): Promise<number> => {
    const account =
      await db.accounts
        .where('name')
        .equals(accountName)
        .first();

    return account
      ? account.balance || 0
      : 0;
  },

  isDateLocked: async (
    date: string
  ): Promise<boolean> => {
    const period =
      await db.accountingPeriods
        .where('Start_Date')
        .belowOrEqual(date)
        .and(
          p =>
            p.End_Date >= date &&
            p.Is_Locked
        )
        .first();

    return !!period;
  },

  getTransactions: async (): Promise<Transaction[]> => {
    const invoices =
      await db.getTransactions();

    return invoices.map(inv => ({
      id: inv.id,
      date: inv.date,
      amount: inv.finalTotal,
      type:
        inv.type === 'SALE'
          ? 'sale'
          : 'purchase',
      customer: inv.partnerName,
      lastModified: inv.lastModified
    }));
  },

  getCashFlow: async (): Promise<CashFlow[]> => {
    return await db.getCashFlow();
  }
};
