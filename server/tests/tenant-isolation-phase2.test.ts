import Dexie from 'dexie';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db, PharmaFlowDB } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { FinancialHealthService } from '@/features/accounting/services/FinancialHealthService';
import { cashboxTransferWorkflow } from '@/features/accounting/workflows/CashboxTransferWorkflow';
import { hashLocalPassword, verifyLocalPassword } from '@features/auth/services/localPasswordService';

vi.mock('@/services/auth/tokenProvider', () => ({
  TokenProvider: {
    getCurrentSession: vi.fn()
  }
}));

describe('PHARMAFLOW PRO — TENANT ISOLATION PHASE 2 — SECURITY VERIFICATION', () => {
  const TENANT_A = 'tenant-A';
  const TENANT_B = 'tenant-B';
  const BRANCH_A = 'branch-A';

  const setSession = (tenantId?: string, branchId = BRANCH_A) => {
    (TokenProvider.getCurrentSession as any).mockReturnValue({
      tenantId,
      branchId: tenantId ? branchId : undefined,
      user: tenantId ? { id: 'user-1', tenantId, branchId } : null
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.delete();
    await db.open();
  });

  describe('1. Compatibility wrappers', () => {
    it('getCashFlow returns only current tenant records', async () => {
      setSession(TENANT_A);
      await db.cashFlow.add({ category: 'Rent', amount: 100, type: 'خرج', date: '2023-01-01' } as any);

      setSession(TENANT_B);
      await db.cashFlow.add({ category: 'Sales', amount: 200, type: 'دخل', date: '2023-01-01' } as any);

      setSession(TENANT_A);
      const flowA = await db.getCashFlow();
      expect(flowA).toHaveLength(1);
      expect(flowA[0].category).toBe('Rent');

      setSession(TENANT_B);
      const flowB = await db.getCashFlow();
      expect(flowB).toHaveLength(1);
      expect(flowB[0].category).toBe('Sales');
    });

    it('fail-closes tenant-scoped reads when the session is missing', async () => {
      setSession(TENANT_A);
      await db.accounts.add({ id: 'account-A', code: '101', name: 'Cash', type: 'ASSET' } as any);

      setSession(undefined);
      expect(await db.getAccounts()).toEqual([]);
      expect(await db.getCashFlow()).toEqual([]);
      expect(await db.getProducts()).toEqual([]);
      expect(await db.getTransactions()).toEqual([]);
    });

    it('getProducts and getTransactions exclude another tenant', async () => {
      setSession(TENANT_A);
      await db.products.add({ id: 'product-A', name: 'Panadol', stock: 10 } as any);
      await db.invoices.add({
        id: 'invoice-A', invoiceNumber: 'INV-A', type: 'SALE', date: '2023-01-01', partnerId: 'C-A'
      } as any);

      setSession(TENANT_B);
      expect(await db.getProducts()).toEqual([]);
      expect(await db.getTransactions()).toEqual([]);
    });
  });

  describe('2. Dexie security hooks', () => {
    it('overwrites a forged tenantId on create with the active session tenant', async () => {
      setSession(TENANT_A);
      await db.customers.add({ id: 'customer-A', name: 'Customer', tenantId: TENANT_B } as any);
      const record = await db.customers.get('customer-A');
      expect(record?.tenantId).toBe(TENANT_A);
    });

    it('blocks creation without an active tenant session', async () => {
      setSession(undefined);
      await expect(db.suppliers.add({ id: 'supplier-X', name: 'Supplier' } as any))
        .rejects.toThrow(/FAIL_CLOSED: Creation forbidden/);
    });

    it('blocks updates to another tenant record', async () => {
      setSession(TENANT_A);
      await db.products.add({ id: 'product-A', name: 'Safe Product' } as any);

      setSession(TENANT_B);
      await expect(db.products.update('product-A', { name: 'Hacked' }))
        .rejects.toThrow(/FAIL_CLOSED: Unauthorized data modification attempt/);

      setSession(TENANT_A);
      expect((await db.products.get('product-A'))?.name).toBe('Safe Product');
    });

    it('blocks tenantId changes through update()', async () => {
      setSession(TENANT_A);
      await db.journalEntries.add({ id: 'journal-A', date: '2023-01-01' } as any);

      await expect(db.journalEntries.update('journal-A', { tenantId: TENANT_B } as any))
        .rejects.toThrow(/tenantId modification is strictly forbidden/);
    });

    it('blocks deletion of another tenant record', async () => {
      setSession(TENANT_A);
      await db.products.add({ id: 'product-A', name: 'Protected' } as any);

      setSession(TENANT_B);
      await expect(db.products.delete('product-A'))
        .rejects.toThrow(/FAIL_CLOSED: Unauthorized data deletion attempt/);

      setSession(TENANT_A);
      expect(await db.products.get('product-A')).toBeDefined();
    });
  });

  describe('3. Bulk and direct table operation isolation', () => {
    it('blocks direct get and cross-tenant bulk writes/deletes while clear stays tenant-scoped', async () => {
      setSession(TENANT_A);
      await db.products.add({ id: 'product-bulk-A', name: 'A Product' } as any);

      setSession(TENANT_B);
      await db.products.add({ id: 'product-bulk-B', name: 'Shared Product Name' } as any);
      setSession(TENANT_A);
      await db.products.add({ id: 'product-bulk-query-A', name: 'Shared Product Name' } as any);
      expect((await db.products.where('name').equals('Shared Product Name').toArray()).map(p => p.id))
        .toEqual(['product-bulk-query-A']);
      expect(await db.products.where('name').equals('Shared Product Name').count()).toBe(1);
      expect((await db.products.where('name').equals('Shared Product Name').first())?.id).toBe('product-bulk-query-A');

      setSession(TENANT_B);
      await expect(db.products.get('product-bulk-A'))
        .rejects.toThrow(/FAIL_CLOSED: Unauthorized direct read/);
      await expect(db.products.bulkGet(['product-bulk-A']))
        .rejects.toThrow(/FAIL_CLOSED: Unauthorized bulk read/);
      await expect(db.products.bulkPut([
        { id: 'product-bulk-A', name: 'Overwritten', tenantId: TENANT_B }
      ] as any))
        .rejects.toThrow(/FAIL_CLOSED: Unauthorized bulk upsert target/);
      await expect(db.products.bulkDelete(['product-bulk-A']))
        .rejects.toThrow(/FAIL_CLOSED: Unauthorized bulk delete target/);

      await db.products.clear();
      setSession(TENANT_A);
      expect((await db.products.where('tenantId').equals(TENANT_A).toArray()).map(p => p.id))
        .toEqual(['product-bulk-A']);
      setSession(TENANT_B);
      expect((await db.products.where('tenantId').equals(TENANT_B).toArray())).toHaveLength(0);
    });

    it('stamps newly bulk-added and bulk-upserted records and rejects bulk writes without a tenant', async () => {
      setSession(TENANT_A);
      await db.users.bulkAdd([{ id: 'bulk-user-A', username: 'bulk-a' }] as any);
      await db.users.bulkPut([{ id: 'bulk-user-B', username: 'bulk-b' }] as any);
      expect((await db.users.where('id').equals('bulk-user-A').first())?.tenantId).toBe(TENANT_A);
      expect((await db.users.where('id').equals('bulk-user-B').first())?.tenantId).toBe(TENANT_A);

      setSession(undefined);
      await expect(db.users.bulkAdd([{ id: 'bulk-user-no-session', username: 'x' }] as any))
        .rejects.toThrow(/FAIL_CLOSED/);
      await expect(db.users.bulkPut([{ id: 'bulk-user-no-session-2', username: 'x' }] as any))
        .rejects.toThrow(/FAIL_CLOSED/);
    });
  });

  describe('4. Local password hashing', () => {
    it('hashes new local passwords with salted PBKDF2 and verifies them', async () => {
      const hash = await hashLocalPassword('StrongLocalPassword!2026');
      expect(hash).toMatch(/^pbkdf2-sha256\$600000\$/);
      expect((await verifyLocalPassword('StrongLocalPassword!2026', hash)).valid).toBe(true);
      expect((await verifyLocalPassword('WrongPassword', hash)).valid).toBe(false);
    });

    it('accepts a legacy local plaintext password only for one-time upgrade', async () => {
      expect(await verifyLocalPassword('LegacyPass123', null, 'LegacyPass123')).toEqual({
        valid: true,
        needsUpgrade: true
      });
      expect((await verifyLocalPassword('WrongPass', null, 'LegacyPass123')).valid).toBe(false);
    });
  });

  describe('5. Version 36 to 38 orphan-safe migration', () => {
    it('preserves legacy users and cashboxes without assigning an unverified tenantId', async () => {
      const legacyName = `pharmaflow-phase2-v36-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const legacyDb = new Dexie(legacyName);
      legacyDb.version(36).stores({
        users: '&id, username, role, status, branch, createdAt, cashboxId',
        cashboxes: '&id, name, accountId, branchId, isActive, openingBalance, openingBalanceJournalId',
        cashFlow: '&id, transaction_id, date, type, cashboxId, userId, tenantId',
        financialHealthSnapshots: '&id, date, tenantId',
        systemAlerts: '&id, type, timestamp, isRead, tenantId',
        accountingPeriods: '&id, Start_Date, End_Date, Is_Locked, start_date, end_date, is_locked, tenantId',
        vouchers: '&id, voucher_id, type, partner_id, partnerId, date, status, tenantId, branchId'
      });

      try {
        await legacyDb.open();
        await legacyDb.table('users').add({ id: 'legacy-user-36', username: 'legacy-user', role: 'CASHIER' });
        await legacyDb.table('cashboxes').add({ id: 'legacy-cashbox-36', name: 'Legacy Cashbox', isActive: true });
        legacyDb.close();

        const upgradedDb = new PharmaFlowDB(legacyName);
        try {
          await upgradedDb.open();
          const nativeDb = (upgradedDb as any).backendDB();
          const readLegacyStore = (storeName: string) => new Promise<any[]>((resolve, reject) => {
            const transaction = nativeDb.transaction(storeName, 'readonly');
            const request = transaction.objectStore(storeName).getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
          });
          const migratedUsers = await readLegacyStore('users');
          const migratedCashboxes = await readLegacyStore('cashboxes');
          expect(migratedUsers).toHaveLength(1);
          expect(migratedUsers[0].id).toBe('legacy-user-36');
          expect(migratedUsers[0].tenantId).toBeUndefined();
          expect(migratedCashboxes).toHaveLength(1);
          expect(migratedCashboxes[0].id).toBe('legacy-cashbox-36');
          expect(migratedCashboxes[0].tenantId).toBeUndefined();
          expect(await upgradedDb.getOrphanedTenantRecordCount()).toBeGreaterThanOrEqual(2);
        } finally {
          upgradedDb.close();
        }
      } finally {
        legacyDb.close();
        await Dexie.delete(legacyName);
      }
    });
  });

  describe('6. Financial health isolation', () => {
    it('stamps alerts with tenantId and returns only active tenant alerts', async () => {
      setSession(TENANT_A);
      await db.systemAlerts.add({
        id: 'alert-A', type: 'FINANCIAL', severity: 'HIGH',
        message: 'A-Danger', timestamp: '2026-11-04T00:00:00.000Z', isRead: false
      } as any);

      setSession(TENANT_B);
      await db.systemAlerts.add({
        id: 'alert-B', type: 'FINANCIAL', severity: 'HIGH',
        message: 'B-Danger', timestamp: '2026-11-04T00:00:00.000Z', isRead: false
      } as any);

      const alertsB = await FinancialHealthService.getActiveAlerts();
      expect(alertsB).toHaveLength(1);
      expect(alertsB[0].message).toBe('B-Danger');
      expect(alertsB[0].tenantId).toBe(TENANT_B);

      setSession(TENANT_A);
      const alertsA = await FinancialHealthService.getActiveAlerts();
      expect(alertsA).toHaveLength(1);
      expect(alertsA[0].message).toBe('A-Danger');
    });

    it('stamps snapshots with tenantId and returns only the active tenant snapshot', async () => {
      setSession(TENANT_A);
      await db.financialHealthSnapshots.add({ id: 'snapshot-A', date: '2026-11-03', score: 80 } as any);

      setSession(TENANT_B);
      await db.financialHealthSnapshots.add({ id: 'snapshot-B', date: '2026-11-04', score: 90 } as any);
      const snapshotB = await FinancialHealthService.getLatestSnapshot();
      expect(snapshotB?.id).toBe('snapshot-B');
      expect(snapshotB?.tenantId).toBe(TENANT_B);

      setSession(TENANT_A);
      const snapshotA = await FinancialHealthService.getLatestSnapshot();
      expect(snapshotA?.id).toBe('snapshot-A');
      expect(snapshotA?.tenantId).toBe(TENANT_A);
    });

    it('does not create a financial snapshot without an active tenant', async () => {
      setSession(undefined);
      await expect(FinancialHealthService.refreshHealthMonitor())
        .rejects.toThrow(/FAIL_CLOSED/);
      expect(await db.financialHealthSnapshots.toCollection().toArray()).toHaveLength(0);
    });

    it('clearOldAlerts deletes only alerts belonging to the active tenant', async () => {
      setSession(TENANT_A);
      await db.systemAlerts.add({ id: 'alert-A', type: 'STOCK', message: 'Medicine A', isRead: false } as any);
      await db.systemAlerts.add({ id: 'financial-A', type: 'FINANCIAL', message: 'Financial A', isRead: false } as any);

      setSession(TENANT_B);
      await db.systemAlerts.add({ id: 'alert-B', type: 'STOCK', message: 'Medicine B', isRead: false } as any);

      setSession(TENANT_A);
      await db.clearOldAlerts();

      const remaining = await db.systemAlerts.toCollection().toArray();
      expect(remaining.map((alert: any) => alert.id).sort()).toEqual(['alert-B', 'financial-A']);
      expect(remaining.find((alert: any) => alert.id === 'alert-B')?.tenantId).toBe(TENANT_B);
      expect(remaining.find((alert: any) => alert.id === 'financial-A')?.tenantId).toBe(TENANT_A);
    });
  });

  describe('4. Cashbox transfer isolation', () => {
    it('rejects tenant or branch context spoofing before any accounting write', async () => {
      setSession(TENANT_A, BRANCH_A);
      const input = {
        sourceCashboxId: 'box-1',
        destinationCashboxId: 'box-2',
        amount: 50,
        date: '2023-01-01',
        tenantId: TENANT_B,
        branchId: BRANCH_A,
        transactionUuid: 'tx-1'
      };

      await expect(cashboxTransferWorkflow.execute(input))
        .rejects.toThrow(/خطأ أمني: سياق المؤسسة أو الفرع غير مطابق للجلسة النشطة/);
      expect(await db.journalEntries.count()).toBe(0);
    });
  });

  describe('5. User permissions isolation', () => {
    it('blocks updates to permissions owned by another tenant', async () => {
      setSession(TENANT_A);
      await db.userPermissions.add({
        id: 'permission-A', userId: 'user-A', permissions: {}
      } as any);

      setSession(TENANT_B);
      await expect(db.userPermissions.update('permission-A', { permissions: { Admin: true } } as any))
        .rejects.toThrow(/FAIL_CLOSED: Unauthorized data modification attempt/);
    });

    it('supports tenant-scoped permission lookup through the compound index', async () => {
      setSession(TENANT_A);
      await db.userPermissions.add({
        id: 'permission-A', userId: 'same-user-id', permissions: { Sales: true }
      } as any);

      setSession(TENANT_B);
      await db.userPermissions.add({
        id: 'permission-B', userId: 'same-user-id', permissions: { Accounting: true }
      } as any);

      const permissionsB = await db.userPermissions
        .where('[tenantId+userId]').equals([TENANT_B, 'same-user-id']).first();
      expect(permissionsB?.id).toBe('permission-B');
      expect(permissionsB?.permissions).toEqual({ Accounting: true });
    });
  });
});
