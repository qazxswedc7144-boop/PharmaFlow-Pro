
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
    return await db.journalEntries.orderBy('date').reverse().limit(MAX_ACCOUNTING_SLICE).toArray();
  },

  addEntry: async (entry: AccountingEntry) => {
    // Audit log integration
    const totalDebit = entry.lines.reduce((sum, l) => sum + (l.debit || 0), 0);
    const totalCredit = entry.lines.reduce((sum, l) => sum + (l.credit || 0), 0);
    
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new Error(`قيد غير متزن: إجمالي المدين (${totalDebit}) لا يساوي إجمالي الدائن (${totalCredit}) للفاتورة #${entry.sourceId}`);
    }

    await db.safeTransaction('rw', ['journalEntries', 'accounts', 'journalLines'], async () => {
      const entryId = entry.id || generateTransactionUuid('JE');
      
      let tenantId = (entry as any).tenantId;
      let branchId = (entry as any).branchId;

      if (!tenantId || tenantId === 'default' || tenantId === 'default-tenant' || tenantId === 'tenant-default' || tenantId === 'main') {
        const authState = useAuthStore.getState();
        const user = authState.user;
        tenantId = (user as any)?.tenantId || (user as any)?.tenant_id || authState.tenantId || null;
      }

      if (!branchId || branchId === 'main' || branchId === 'default' || branchId === 'default-branch' || branchId === 'BRH-DEFAULT') {
        const authState = useAuthStore.getState();
        const user = authState.user;
        branchId = (user as any)?.branchId || (user as any)?.branch_id || authState.branchId || null;
      }

      if (!tenantId || tenantId === 'default' || tenantId === 'default-tenant' || tenantId === 'tenant-default' || tenantId === 'main') {
        throw new Error('FAIL_CLOSED: قيد اليومية يتطلب سياق مؤسسة موثوق (Trusted Tenant Context Required).');
      }
      if (!branchId || branchId === 'main' || branchId === 'default' || branchId === 'default-branch' || branchId === 'BRH-DEFAULT') {
        throw new Error('FAIL_CLOSED: قيد اليومية يتطلب فرع موثوق للمؤسسة (Trusted Branch Context Required).');
      }

      await db.journalEntries.add({
        ...entry,
        id: entryId,
        createdAt: (entry as any).createdAt || entry.created_at || new Date().toISOString(),
        created_at: entry.created_at || (entry as any).createdAt || new Date().toISOString(),
        tenantId,
        branchId,
        status: entry.status || 'Posted'
      });
      
      // Update account balances
      for (const line of entry.lines) {
        const lineAccId = line.accountId || line.account_id || 'ACC-GENERIC';
        const lineEntryId = line.entryId || line.entry_id || entryId;
        const amount = (line.debit || 0) - (line.credit || 0);
        if (lineAccId) {
          const account = await db.accounts.get(lineAccId);
          if (account) {
            await db.accounts.update(lineAccId, {
              balance: (account.balance || 0) + amount,
              updatedAt: new Date().toISOString()
            });
          }
        }

        // Also save journal lines separately if needed for indexing
        await db.journalLines.add({
          ...line,
          id: line.id || line.lineId || generateTransactionUuid('JL'),
          entryId: lineEntryId,
          entry_id: lineEntryId,
          accountId: lineAccId,
          account_id: lineAccId,
          tenantId,
          branchId
        });
      }
    });
  },

  // Alias for addEntry to support legacy code
  addJournalEntry: async (entry: AccountingEntry) => {
    return await AccountingRepository.addEntry(entry);
  },

  deleteEntry: async (entryId: string) => {
    await db.safeTransaction('rw', ['journalEntries', 'accounts', 'journalLines'], async () => {
      const entry = await db.journalEntries.get(entryId);
      if (entry) {
        // Reverse balances before deleting
        for (const line of (entry.lines || [])) {
          const amount = (line.credit || 0) - (line.debit || 0);
          const account = await db.accounts.get(line.accountId);
          if (account) {
            await db.accounts.update(line.accountId, {
              balance: (account.balance || 0) + amount,
              updatedAt: new Date().toISOString()
            });
          }
        }
        await db.journalEntries.delete(entryId);
        // Also delete lines
        await db.journalLines.where('entryId').equals(entryId).delete();
      }
    });
  },

  deleteEntriesBySource: async (sourceId: string) => {
    const entries = await db.journalEntries.where('sourceId').equals(sourceId).toArray();
    if (entries) {
      for (const entry of entries) {
        await AccountingRepository.deleteEntry(entry.id);
      }
    }
  },

  getAccountBalance: async (accountName: string): Promise<number> => {
    const account = await db.accounts.where('name').equals(accountName).first();
    return account ? account.balance || 0 : 0;
  },

  isDateLocked: async (date: string): Promise<boolean> => {
    const period = await db.accountingPeriods
      .where('Start_Date').belowOrEqual(date)
      .and(p => p.End_Date >= date && p.Is_Locked)
      .first();
    return !!period;
  },

  getTransactions: async (): Promise<Transaction[]> => {
    const invoices = await db.getTransactions();
    return invoices.map(inv => ({
      id: inv.id,
      date: inv.date,
      amount: inv.finalTotal,
      type: inv.type === 'SALE' ? 'sale' : 'purchase',
      customer: inv.partnerName,
      lastModified: inv.lastModified
    }));
  },

  getCashFlow: async (): Promise<CashFlow[]> => {
    return await db.getCashFlow();
  }
};
