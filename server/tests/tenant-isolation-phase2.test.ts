import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { FinancialHealthService } from '@/features/accounting/services/FinancialHealthService';
import { cashboxTransferWorkflow } from '@/features/accounting/workflows/CashboxTransferWorkflow';

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

  describe('3. Financial health isolation', () => {
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
      expect(await db.financialHealthSnapshots.toArray()).toHaveLength(0);
    });

    it('clearOldAlerts deletes only alerts belonging to the active tenant', async () => {
      setSession(TENANT_A);
      await db.systemAlerts.add({ id: 'alert-A', type: 'STOCK', message: 'Medicine A', isRead: false } as any);
      await db.systemAlerts.add({ id: 'financial-A', type: 'FINANCIAL', message: 'Financial A', isRead: false } as any);

      setSession(TENANT_B);
      await db.systemAlerts.add({ id: 'alert-B', type: 'STOCK', message: 'Medicine B', isRead: false } as any);

      setSession(TENANT_A);
      await db.clearOldAlerts();

      const remaining = await db.systemAlerts.toArray();
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
