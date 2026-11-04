
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { FinancialHealthService } from '@/features/accounting/services/FinancialHealthService';
import { cashboxTransferWorkflow } from '@/features/accounting/workflows/CashboxTransferWorkflow';

// Mock TokenProvider to control sessions
vi.mock('@/services/auth/tokenProvider', () => ({
  TokenProvider: {
    getCurrentSession: vi.fn()
  }
}));

describe('PHARMAFLOW PRO — TENANT ISOLATION PHASE 2 — SECURITY VERIFICATION', () => {
  
  const TENANT_A = 'tenant-A';
  const TENANT_B = 'tenant-B';
  const BRANCH_A = 'branch-A';
  const BRANCH_B = 'branch-B';

  const setSession = (tenantId?: string, branchId?: string) => {
    (TokenProvider.getCurrentSession as any).mockReturnValue({
      tenantId,
      branchId,
      user: { id: 'user-1', tenantId, branchId }
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset database to ensure clean state for each test
    await db.delete();
    await db.open();
  });

  describe('1. Compatibility Wrappers Isolation', () => {
    it('db.getCashFlow returns only current tenant records', async () => {
      // Setup: Record for Tenant A
      setSession(TENANT_A);
      await (db as any).cashFlow.add({ 
        category: 'Rent', amount: 100, type: 'خرج', date: '2023-01-01',
        cashboxId: 'box-A', userId: 'user-1' 
      });
      
      // Setup: Record for Tenant B
      setSession(TENANT_B);
      await (db as any).cashFlow.add({ 
        category: 'Sales', amount: 200, type: 'دخل', date: '2023-01-01',
        cashboxId: 'box-B', userId: 'user-1'
      });

      // Verify for Tenant A
      setSession(TENANT_A);
      const flowA = await db.getCashFlow();
      expect(flowA).toHaveLength(1);
      expect(flowA[0].category).toBe('Rent');

      // Verify for Tenant B
      setSession(TENANT_B);
      const flowB = await db.getCashFlow();
      expect(flowB).toHaveLength(1);
      expect(flowB[0].category).toBe('Sales');
    });

    it('Fail-Closed: getAccounts returns empty if session is missing', async () => {
      setSession(TENANT_A);
      await (db as any).accounts.add({ code: '101', name: 'Cash', type: 'ASSET' });
      
      // Missing session
      (TokenProvider.getCurrentSession as any).mockReturnValue({ user: null });
      const accounts = await db.getAccounts();
      expect(accounts).toEqual([]);
    });

    it('Proxy wrappers (getProducts, getTransactions, etc.) enforce isolation', async () => {
      setSession(TENANT_A);
      await (db as any).products.add({ name: 'Panadol', stock: 10 });
      await (db as any).invoices.add({ invoiceNumber: 'INV-1', type: 'SALE', date: '2023-01-01', partnerId: 'C-1' });

      setSession(TENANT_B);
      const productsB = await db.getProducts();
      const transactionsB = await db.getTransactions();
      expect(productsB).toHaveLength(0);
      expect(transactionsB).toHaveLength(0);
    });
  });

  describe('2. Security Hooks Hardening', () => {
    it('Cannot pass forged tenantId during creation (Forced from Session)', async () => {
      setSession(TENANT_A);
      const id = await (db as any).customers.add({ name: 'Evil Corp', tenantId: TENANT_B });
      const record = await (db as any).customers.get(id);
      
      // Hook must have overridden TENANT_B with TENANT_A
      expect(record.tenantId).toBe(TENANT_A);
    });

    it('Cannot create records without active tenant session', async () => {
      (TokenProvider.getCurrentSession as any).mockReturnValue({ user: null });
      await expect((db as any).suppliers.add({ name: 'Supp' })).rejects.toThrow(/FAIL_CLOSED: Creation forbidden/);
    });

    it('Cannot update record belonging to another tenant', async () => {
      setSession(TENANT_A);
      const id = await (db as any).products.add({ name: 'Safe Prod' });
      
      // Switch to Tenant B and attempt to rename Tenant A's product
      setSession(TENANT_B);
      await expect((db as any).products.update(id, { name: 'Hacked' })).rejects.toThrow(/FAIL_CLOSED: Unauthorized data modification attempt/);
      
      // Verify Tenant A's record was NOT changed
      setSession(TENANT_A);
      const record = await (db as any).products.get(id);
      expect(record.name).toBe('Safe Prod');
    });

    it('Cannot modify tenantId via update()', async () => {
      setSession(TENANT_A);
      const id = await (db as any).journalEntries.add({ date: '2023-01-01' });
      
      await expect((db as any).journalEntries.update(id, { tenantId: TENANT_B })).rejects.toThrow(/tenantId modification is strictly forbidden/);
    });
  });

  describe('3. FinancialHealthService Isolation', () => {
    it('getActiveAlerts returns only current tenant alerts', async () => {
      setSession(TENANT_A);
      await (db as any).systemAlerts.add({ type: 'FINANCIAL', message: 'A-Danger', isRead: 0 });
      
      setSession(TENANT_B);
      await (db as any).systemAlerts.add({ type: 'FINANCIAL', message: 'B-Danger', isRead: 0 });

      const alertsB = await FinancialHealthService.getActiveAlerts();
      expect(alertsB).toHaveLength(1);
      expect(alertsB[0].message).toBe('B-Danger');
    });

    it('getLatestSnapshot returns only current tenant snapshot', async () => {
      setSession(TENANT_A);
      await (db as any).financialHealthSnapshots.add({ date: '2023-01-01', score: 100 });
      
      setSession(TENANT_B);
      const snapB = await FinancialHealthService.getLatestSnapshot();
      expect(snapB).toBeUndefined();
    });
  });

  describe('4. CashboxTransferWorkflow Isolation', () => {
    it('Cannot execute transfer with mismatched tenantId/branchId session', async () => {
      setSession(TENANT_A, BRANCH_A);
      
      const input = {
        sourceCashboxId: 'box-1',
        destinationCashboxId: 'box-2',
        amount: 50,
        date: '2023-01-01',
        tenantId: TENANT_B, // Spoofed
        branchId: BRANCH_A,
        transactionUuid: 'tx-1'
      };

      await expect(cashboxTransferWorkflow.execute(input)).rejects.toThrow(/خطأ أمني: سياق المؤسسة أو الفرع غير مطابق للجلسة النشطة/);
    });
  });

  describe('5. Users & Permissions Isolation', () => {
    it('Cannot modify userPermissions of another tenant (Verification in db hooks)', async () => {
      setSession(TENANT_A);
      const permId = 'perm-A';
      await (db as any).userPermissions.add({ id: permId, userId: 'user-A', permissions: {} });

      setSession(TENANT_B);
      // Attempt to update Tenant A's permissions
      await expect((db as any).userPermissions.update(permId, { permissions: { 'Admin': true } }))
        .rejects.toThrow(/FAIL_CLOSED: Unauthorized data modification attempt/);
    });
  });
});
