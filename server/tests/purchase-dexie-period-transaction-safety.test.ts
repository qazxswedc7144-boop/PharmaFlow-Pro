import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { db } from '@/core/db';
import { UnifiedBusinessWorkflowOrchestrator } from '@/services/orchestration/UnifiedBusinessWorkflowOrchestrator';
import { UnifiedInventoryMutationEngine } from '@/features/inventory/services/UnifiedInventoryMutationEngine';
import { PeriodLockEngine } from '@/services/transactions/PeriodLockEngine';
import { AccountingPeriodSyncService } from '@/features/accounting/services/AccountingPeriodSyncService';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { useAuthStore } from '@/store/authStore';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';

describe('P0 Repair — Dexie TransactionInactiveError & Pre-Transaction Period Verification', () => {
  const tenantId = 'TENANT-P0-DEXIE-01';
  const branchId = 'BRH-P0-DEXIE-01';
  const supplierId = 'SUP-P0-DEXIE-01';
  const productId = 'PROD-P0-DEXIE-01';
  const warehouseId = 'WH-MAIN';

  let baseFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    vi.clearAllMocks();
    baseFetch = globalThis.fetch;
    AccountingPeriodSyncService.invalidate();
    (globalThis as any).__FAIL_AT_STAGE__ = undefined;
    IdempotencyRegistry.clearInMemory();

    const userObj = {
      id: 'usr-p0-dexie',
      user_id: 'usr-p0-dexie',
      User_Name: 'P0 Verification Auditor',
      User_Email: 'p0-auditor@pharmaflow.test',
      Role: 'SuperAdmin',
      User_Role: 'SuperAdmin',
      tenantId,
      tenant_id: tenantId,
      branchId,
      branch_id: branchId,
      permissions: ['ALL', 'purchases.create', 'purchases.edit', 'accounting.voucher.create', 'vouchers.create']
    };

    TokenProvider.setSession(userObj as any, 'mock-jwt-p0-dexie', 'mock-refresh-p0-dexie');
    useAuthStore.setState({
      user: userObj as any,
      token: 'mock-jwt-p0-dexie',
      tenantId,
      branchId,
      roles: ['SuperAdmin'],
      permissions: ['ALL', 'purchases.create', 'purchases.edit', 'accounting.voucher.create', 'vouchers.create'],
      isAuthenticated: true
    });

    if (!db.isOpen()) await db.open();

    await db.invoices.clear();
    await db.purchases.clear();
    await db.products.clear();
    await db.suppliers.clear();
    await db.warehouseStock.clear();
    await db.branchInventory.clear();
    await db.branches.clear();
    await db.inventoryTransactions.clear();
    await db.inventory_layers.clear();
    await db.fifo_consumption_log.clear();
    await db.financialTransactions.clear();
    await db.journalEntries.clear();
    await db.journalLines.clear();
    await db.accounts.clear();
    await db.idempotencyRecords.clear();
    await db.idempotencyKeys.clear();
    await db.voucherInvoiceLinks.clear();
    await db.vouchers.clear();
    await db.auditLogs.clear();
    await db.accountingPeriods.clear();

    await db.branches.bulkPut([
      { id: branchId, code: branchId, name: 'P0 Main Branch', tenantId, isActive: true },
      { id: warehouseId, code: warehouseId, name: 'Main Warehouse', tenantId, isActive: true }
    ] as any);

    await db.suppliers.put({
      id: supplierId,
      Supplier_Name: 'P0 Medical Supplies',
      balance: 0,
      tenantId,
      branchId,
      is_active: true
    } as any);

    await db.products.put({
      id: productId,
      name: 'Paracetamol 500mg',
      stock: 10,
      StockQuantity: 10,
      price: 25,
      costPrice: 12,
      tenantId,
      branchId,
      is_active: true
    } as any);

    await db.warehouseStock.put({
      id: `${warehouseId}-${productId}`,
      warehouseId,
      productId,
      quantity: 10,
      tenantId
    } as any);

    await db.accounts.bulkPut([
      { id: 'ACC-101', code: '1010', name: 'الصندوق الرئيسي', type: 'Asset', tenantId, branchId, balance: 100000 },
      { id: 'ACC-102', code: '1020', name: 'المخزون', type: 'Asset', tenantId, branchId, balance: 50000 },
      { id: 'ACC-104', code: '1040', name: 'البنك', type: 'Asset', tenantId, branchId, balance: 200000 },
      { id: 'ACC-201', code: '2010', name: 'الموردين - ذمم دائنة', type: 'Liability', tenantId, branchId, balance: 0 }
    ] as any);
  });

  afterEach(() => {
    (globalThis as any).__FAIL_AT_STAGE__ = undefined;
    globalThis.fetch = baseFetch;
    AccountingPeriodSyncService.invalidate();
  });

  it('1. Never executes fetch inside an active Dexie transaction during credit & cash purchases', async () => {
    const fetchSnapshots: Array<{ url: string; inDexieTx: boolean }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      fetchSnapshots.push({
        url,
        inDexieTx: Boolean((Dexie as any).currentTransaction)
      });
      return baseFetch(input, init);
    }) as any;

    const creditRes = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
      supplierId,
      items: [{ productId, quantity: 30, unitCost: 20, unitPrice: 20 } as any],
      total: 600,
      transactionUuid: 'TX-P0-CREDIT-01',
      notes: 'فاتورة مشتريات آجلة'
    });
    expect(creditRes.success).toBe(true);

    const cashRes = await UnifiedBusinessWorkflowOrchestrator.processPurchase(
      {
        supplierId,
        items: [{ productId, quantity: 15, unitCost: 20, unitPrice: 20 } as any],
        total: 300,
        transactionUuid: 'TX-P0-CASH-01',
        notes: 'فاتورة مشتريات نقدية'
      },
      { isCash: true }
    );
    expect(cashRes.success).toBe(true);

    const periodFetches = fetchSnapshots.filter((s) => s.url.includes('/api/accounting/periods'));
    expect(periodFetches.length).toBeGreaterThanOrEqual(2);
    expect(fetchSnapshots.every((s) => s.inDexieTx === false)).toBe(true);

    const creditInv = await db.invoices.get(creditRes.refId);
    expect(creditInv?.totalAmount).toBe(600);
    expect(creditInv?.finalTotal).toBe(600);
    expect(creditInv?.paidAmount).toBe(0);
    expect(creditInv?.remainingAmount).toBe(600);

    const cashInv = await db.invoices.get(cashRes.refId);
    expect(cashInv?.totalAmount).toBe(300);
    expect(cashInv?.finalTotal).toBe(300);
    expect(cashInv?.paidAmount).toBe(300);
    expect(cashInv?.remainingAmount).toBe(0);

    const product = await db.products.get(productId);
    expect(product?.stock).toBe(10 + 30 + 15);
    expect(product?.StockQuantity).toBe(10 + 30 + 15);

    const whStock = await db.warehouseStock.get(`${warehouseId}-${productId}`);
    expect(whStock?.quantity).toBe(10 + 30 + 15);

    const supplier = await db.suppliers.get(supplierId);
    expect(supplier?.balance).toBe(600);
  });

  it('2. Succeeds for a credit purchase followed by two partial supplier payments with exact balances', async () => {
    const fetchInTxFlags: boolean[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchInTxFlags.push(Boolean((Dexie as any).currentTransaction));
      return baseFetch(input, init);
    }) as any;

    const purchaseRes = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
      supplierId,
      items: [{ productId, quantity: 50, unitCost: 20, unitPrice: 20 } as any],
      total: 1000,
      transactionUuid: 'TX-P0-PARTIAL-PUR-01',
      notes: 'شراء آجل لدفعتين جزئيتين'
    });
    expect(purchaseRes.success).toBe(true);

    const pay1 = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
      partnerId: supplierId,
      amount: 400,
      paymentMethod: 'CASH',
      allocations: { [purchaseRes.refId]: 400 },
      transactionUuid: 'TX-P0-PARTIAL-PAY-01',
      notes: 'دفعة أولى'
    });
    expect(pay1.success).toBe(true);

    const pay2 = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
      partnerId: supplierId,
      amount: 350,
      paymentMethod: 'BANK',
      allocations: { [purchaseRes.refId]: 350 },
      transactionUuid: 'TX-P0-PARTIAL-PAY-02',
      notes: 'دفعة ثانية'
    });
    expect(pay2.success).toBe(true);

    expect(fetchInTxFlags.every((inTx) => inTx === false)).toBe(true);

    const invoice = await db.invoices.get(purchaseRes.refId);
    expect(invoice?.totalAmount).toBe(1000);
    expect(invoice?.paidAmount).toBe(750);
    expect(invoice?.remainingAmount).toBe(250);

    const supplier = await db.suppliers.get(supplierId);
    expect(supplier?.balance).toBe(250);

    const product = await db.products.get(productId);
    expect(product?.stock).toBe(60);
    const whStock = await db.warehouseStock.get(`${warehouseId}-${productId}`);
    expect(whStock?.quantity).toBe(60);
  });

  it('3. Rejects posting when the accounting period is locked without mutating local state', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/accounting/periods')) {
        expect((Dexie as any).currentTransaction).toBeFalsy();
        return new Response(
          JSON.stringify({
            success: true,
            periods: [
              {
                id: 'LOCKED-PERIOD-1',
                clientId: 'LOCKED-PERIOD-1',
                startDate: '2000-01-01T00:00:00.000Z',
                endDate: '2100-12-31T23:59:59.999Z',
                isLocked: true,
                lockedBy: 'admin@pharmaflow.test',
                lockedAt: '2026-01-01T00:00:00.000Z'
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return baseFetch(input, init);
    }) as any;

    await expect(
      UnifiedBusinessWorkflowOrchestrator.processPurchase({
        supplierId,
        items: [{ productId, quantity: 20, unitCost: 20, unitPrice: 20 } as any],
        total: 400,
        transactionUuid: 'TX-P0-LOCKED-01'
      })
    ).rejects.toThrow(/Period locked|مغلقة/i);

    expect(await db.invoices.count()).toBe(0);
    expect(await db.inventoryTransactions.count()).toBe(0);
    expect(await db.journalEntries.count()).toBe(0);
    expect((await db.products.get(productId))?.stock).toBe(10);
    expect((await db.warehouseStock.get(`${warehouseId}-${productId}`))?.quantity).toBe(10);
    expect((await db.suppliers.get(supplierId))?.balance).toBe(0);
  });

  it('4. Fails closed and refuses to bypass period lock when fetching period data fails', async () => {
    // Even if a stale open period exists locally in IndexedDB, network failure must fail closed.
    await db.accountingPeriods.put({
      id: 'STALE-OPEN-LOCAL',
      tenantId,
      Start_Date: '2000-01-01T00:00:00.000Z',
      End_Date: '2100-12-31T23:59:59.999Z',
      Is_Locked: false
    } as any);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/accounting/periods')) {
        expect((Dexie as any).currentTransaction).toBeFalsy();
        return new Response(JSON.stringify({ success: false, error: 'PERIOD_SERVICE_UNAVAILABLE' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return baseFetch(input, init);
    }) as any;

    await expect(
      UnifiedBusinessWorkflowOrchestrator.processPurchase({
        supplierId,
        items: [{ productId, quantity: 10, unitCost: 20, unitPrice: 20 } as any],
        total: 200,
        transactionUuid: 'TX-P0-FAILCLOSED-01'
      })
    ).rejects.toThrow();

    expect(await db.invoices.count()).toBe(0);
    expect(await db.inventoryTransactions.count()).toBe(0);
    expect(await db.journalEntries.count()).toBe(0);
    expect((await db.products.get(productId))?.stock).toBe(10);
    expect((await db.suppliers.get(supplierId))?.balance).toBe(0);
  });

  it('5. Rolls back completely on in-transaction failure with zero partial commits', async () => {
    (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_INVENTORY';

    await expect(
      UnifiedBusinessWorkflowOrchestrator.processPurchase({
        supplierId,
        items: [{ productId, quantity: 40, unitCost: 15, unitPrice: 15 } as any],
        total: 600,
        transactionUuid: 'TX-P0-ROLLBACK-01'
      })
    ).rejects.toThrow(/SIMULATED_INVENTORY_FAILURE/);

    expect(await db.invoices.count()).toBe(0);
    expect(await db.inventoryTransactions.count()).toBe(0);
    expect(await db.inventory_layers.count()).toBe(0);
    expect(await db.journalEntries.count()).toBe(0);
    expect(await db.journalLines.count()).toBe(0);
    expect((await db.products.get(productId))?.stock).toBe(10);
    expect((await db.warehouseStock.get(`${warehouseId}-${productId}`))?.quantity).toBe(10);
    expect((await db.suppliers.get(supplierId))?.balance).toBe(0);
  });

  it('6. Produces zero duplicate journal entries or inventory movements on retry with the same transactionUuid', async () => {
    const payload = {
      supplierId,
      items: [{ productId, quantity: 25, unitCost: 20, unitPrice: 20 } as any],
      total: 500,
      transactionUuid: 'TX-P0-IDEM-RETRY-01',
      notes: 'اختبار تكرار نفس المعرف'
    };

    const first = await UnifiedBusinessWorkflowOrchestrator.processPurchase(payload);
    const second = await UnifiedBusinessWorkflowOrchestrator.processPurchase(payload);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.refId).toBe(first.refId);

    expect(await db.invoices.count()).toBe(1);
    expect(await db.inventoryTransactions.count()).toBe(1);
    expect(await db.journalEntries.count()).toBe(1);
    expect((await db.products.get(productId))?.stock).toBe(35);
    expect((await db.warehouseStock.get(`${warehouseId}-${productId}`))?.quantity).toBe(35);
    expect((await db.suppliers.get(supplierId))?.balance).toBe(500);
  });

  it('7. Blocks forged/missing period snapshots and forbids network period calls inside an active Dexie transaction', async () => {
    const fetchSpy = vi.fn(baseFetch);
    globalThis.fetch = fetchSpy as any;

    await expect(
      db.safeTransaction('rw', ['accountingPeriods'], async () => {
        await PeriodLockEngine.isPeriodLocked(new Date().toISOString());
      })
    ).rejects.toThrow(/ACCOUNTING_PERIOD_NETWORK_IN_TRANSACTION_FORBIDDEN/);
    expect(fetchSpy).not.toHaveBeenCalled();

    await expect(
      db.safeTransaction('rw', ['accountingPeriods'], async () => {
        await AccountingPeriodSyncService.getPeriods({ forceRefresh: true });
      })
    ).rejects.toThrow(/ACCOUNTING_PERIOD_FETCH_IN_TRANSACTION_FORBIDDEN/);
    expect(fetchSpy).not.toHaveBeenCalled();

    const engine = UnifiedInventoryMutationEngine.getInstance();
    const forgedSnapshot = {
      tenantId,
      periodId: 'FORGED',
      periodStartMs: Date.parse('2000-01-01T00:00:00.000Z'),
      periodEndMs: Date.parse('2100-12-31T23:59:59.999Z'),
      checkedDateStr: new Date().toISOString(),
      isLocked: false,
      verifiedAt: Date.now()
    };

    await expect(
      db.safeTransaction(
        'rw',
        [
          'products', 'inventoryTransactions', 'warehouseStock', 'branchInventory',
          'branches', 'inventory_layers', 'fifo_consumption_log', 'medicineBatches',
          'stock_movements', 'accountingPeriods', 'settings', 'systemSettings'
        ],
        async (tx) => {
          await engine.executeReceivePurchase(
            {
              invoiceId: 'PUR-FORGED-01',
              warehouseId,
              supplierId,
              items: [{ productId, quantity: 5, unitCost: 10 }],
              transactionUuid: 'TX-FORGED-01',
              userId: 'usr-p0-dexie',
              tenantId,
              branchId,
              timestamp: new Date().toISOString(),
              periodVerification: forgedSnapshot
            },
            tx
          );
        }
      )
    ).rejects.toThrow(/ACCOUNTING_PERIOD_VERIFICATION_REQUIRED/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await db.products.get(productId))?.stock).toBe(10);
  });
});
