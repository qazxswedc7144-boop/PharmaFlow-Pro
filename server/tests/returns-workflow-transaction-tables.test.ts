import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { db } from '@/core/db';
import { WorkflowExecutionPipeline } from '@/core/workflow/workflowExecution';
import { WorkflowContextFactory } from '@/core/workflow/workflowContext';
import { salesReturnWorkflow } from '@/features/returns/workflows/SalesReturnWorkflow';
import { purchaseReturnWorkflow } from '@/features/returns/workflows/PurchaseReturnWorkflow';
import { UnifiedBusinessWorkflowOrchestrator } from '@/services/orchestration/UnifiedBusinessWorkflowOrchestrator';
import { AccountingPeriodSyncService } from '@/features/accounting/services/AccountingPeriodSyncService';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { useAuthStore } from '@/store/authStore';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';

describe('Returns Workflows — WorkflowExecutionPipeline Dexie Transaction Tables Coverage', () => {
  const tenantId = 'TENANT-RETURNS-TX-01';
  const branchId = 'BRH-RETURNS-TX-01';
  const warehouseId = 'WH-MAIN';
  const customerId = 'CUST-RETURNS-01';
  const supplierId = 'SUP-RETURNS-01';
  const productId = 'PROD-RETURNS-01';

  let baseFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    vi.clearAllMocks();
    baseFetch = globalThis.fetch;
    AccountingPeriodSyncService.invalidate();
    (globalThis as any).__FAIL_AT_STAGE__ = undefined;
    IdempotencyRegistry.clearInMemory();

    const userObj = {
      id: 'usr-returns-tx',
      user_id: 'usr-returns-tx',
      User_Name: 'Returns Pipeline Auditor',
      User_Email: 'returns-auditor@pharmaflow.test',
      Role: 'SuperAdmin',
      User_Role: 'SuperAdmin',
      tenantId,
      tenant_id: tenantId,
      branchId,
      branch_id: branchId,
      permissions: [
        'ALL',
        'sales.return',
        'sales.edit',
        'purchases.return',
        'purchases.create',
        'purchases.edit'
      ]
    };

    TokenProvider.setSession(userObj as any, 'mock-jwt-returns', 'mock-refresh-returns');
    useAuthStore.setState({
      user: userObj as any,
      token: 'mock-jwt-returns',
      tenantId,
      branchId,
      roles: ['SuperAdmin'],
      permissions: userObj.permissions,
      isAuthenticated: true
    });

    if (!db.isOpen()) await db.open();

    await db.invoices.clear();
    await db.sales.clear();
    await db.purchases.clear();
    await db.products.clear();
    await db.customers.clear();
    await db.suppliers.clear();
    await db.warehouseStock.clear();
    await db.branchInventory.clear();
    await db.branches.clear();
    await db.medicineBatches.clear();
    await db.inventoryTransactions.clear();
    await db.inventory_layers.clear();
    await db.fifo_consumption_log.clear();
    await db.financialTransactions.clear();
    await db.journalEntries.clear();
    await db.journalLines.clear();
    await db.accounts.clear();
    await db.auditLogs.clear();
    await db.idempotencyKeys.clear();
    await db.idempotency_records.clear();
    await db.projectionEvents.clear();
    await db.syncQueue.clear();
    await db.outbox.clear();

    await db.branches.bulkPut([
      { id: branchId, code: branchId, name: 'Returns Main Branch', tenantId, isActive: true },
      { id: warehouseId, code: warehouseId, name: 'Main Warehouse', tenantId, isActive: true }
    ] as any);

    await db.customers.put({
      id: customerId,
      Customer_Name: 'Returns Test Customer',
      balance: 500,
      tenantId,
      branchId,
      is_active: true
    } as any);

    await db.suppliers.put({
      id: supplierId,
      Supplier_Name: 'Returns Test Supplier',
      balance: 0,
      tenantId,
      branchId,
      is_active: true
    } as any);

    await db.products.put({
      id: productId,
      name: 'Amoxicillin 500mg',
      stock: 0,
      StockQuantity: 0,
      price: 25,
      costPrice: 12,
      CostPrice: 12,
      tenantId,
      branchId,
      is_active: true
    } as any);

    await db.accounts.bulkPut([
      { id: 'ACC-101', code: '1010', name: 'الصندوق', type: 'Asset', tenantId, branchId, balance: 100000 },
      { id: 'ACC-102', code: '1020', name: 'المخزون', type: 'Asset', tenantId, branchId, balance: 50000 },
      { id: 'ACC-103', code: '1030', name: 'العملاء', type: 'Asset', tenantId, branchId, balance: 500 },
      { id: 'ACC-201', code: '2010', name: 'الموردين', type: 'Liability', tenantId, branchId, balance: 0 },
      { id: 'ACC-401', code: '4010', name: 'المبيعات', type: 'Revenue', tenantId, branchId, balance: 0 },
      { id: 'ACC-501', code: '5010', name: 'تكلفة المبيعات', type: 'Expense', tenantId, branchId, balance: 0 }
    ] as any);
  });

  afterEach(() => {
    (globalThis as any).__FAIL_AT_STAGE__ = undefined;
    globalThis.fetch = baseFetch;
    AccountingPeriodSyncService.invalidate();
  });

  it('1. Executes SalesReturnWorkflow end-to-end via WorkflowExecutionPipeline without Dexie NotFoundError', async () => {
    const fetchSnapshots: Array<{ url: string; inDexieTx: boolean }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      fetchSnapshots.push({ url, inDexieTx: Boolean((Dexie as any).currentTransaction) });
      return baseFetch(input, init);
    }) as any;

    const ctx = WorkflowContextFactory.create('SALES_RETURN', {
      tenantId,
      branchId,
      idempotencyKey: 'TX-SALES-RETURN-PIPE-01'
    });

    const result = await WorkflowExecutionPipeline.run(
      salesReturnWorkflow,
      {
        customerId,
        items: [
          {
            productId,
            product_id: productId,
            quantity: 4,
            qty: 4,
            unitPrice: 25,
            price: 25,
            batchNumber: 'BATCH-SR-01',
            expiryDate: '2029-12-31'
          } as any
        ],
        total: 100,
        isCash: false,
        notes: 'مرتجع مبيعات عبر Pipeline'
      },
      ctx
    );

    expect(result.success).toBe(true);
    expect(result.data?.refId).toBeTruthy();

    // Verify all network calls happened outside any active Dexie transaction
    expect(fetchSnapshots.some((s) => s.url.includes('/api/accounting/periods'))).toBe(true);
    expect(fetchSnapshots.every((s) => s.inDexieTx === false)).toBe(true);

    const refId = result.data!.refId;
    const savedInvoice = await db.invoices.get(refId);
    expect(savedInvoice?.isReturn).toBe(true);
    expect(savedInvoice?.totalAmount).toBe(100);

    const savedSaleMirror = await db.sales.get(refId);
    expect(savedSaleMirror?.id).toBe(refId);

    const product = await db.products.get(productId);
    expect(product?.stock).toBe(4);
    expect(product?.StockQuantity).toBe(4);

    const whRecords = await db.warehouseStock.where('productId').equals(productId).toArray();
    expect(whRecords.length).toBe(1);
    expect(whRecords[0]?.quantity).toBe(4);

    const brInv = await db.branchInventory.where('[branchId+productId]').equals([branchId, productId]).first();
    expect(brInv?.stockQuantity).toBe(4);

    const batches = await db.medicineBatches.where('productId').equals(productId).toArray();
    expect(batches.length).toBe(1);
    expect(batches[0]?.quantity).toBe(4);

    const layers = await db.inventory_layers.filter((l: any) => l.product_id === productId).toArray();
    expect(layers.length).toBe(1);
    expect(layers[0]?.quantity_remaining).toBe(4);

    const customer = await db.customers.get(customerId);
    expect(customer?.balance).toBe(400);

    const fts = await db.financialTransactions.where('Reference_ID').equals(refId).toArray();
    expect(fts.length).toBe(1);

    const journals = await db.journalEntries.where('sourceId').equals(refId).toArray();
    expect(journals.length).toBe(1);
    expect(await db.journalLines.where('entryId').equals(journals[0]!.id).count()).toBeGreaterThanOrEqual(2);

    const projEvents = await db.projectionEvents.filter((e: any) => e.aggregateId === refId).toArray();
    expect(projEvents.length).toBe(1);
  });

  it('2. Executes PurchaseReturnWorkflow end-to-end via WorkflowExecutionPipeline without Dexie NotFoundError', async () => {
    // First receive real stock via purchase so FIFO layers, warehouseStock, branchInventory, and batches exist.
    const purchaseRes = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
      supplierId,
      items: [
        {
          productId,
          quantity: 10,
          unitCost: 15,
          unitPrice: 15,
          batchNumber: 'BATCH-PR-01',
          expiryDate: '2029-12-31'
        } as any
      ],
      total: 150,
      transactionUuid: 'TX-PURCHASE-BASE-FOR-RETURN-01',
      notes: 'شراء أساسي قبل المرتجع'
    });
    expect(purchaseRes.success).toBe(true);

    const fetchSnapshots: Array<{ url: string; inDexieTx: boolean }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      fetchSnapshots.push({ url, inDexieTx: Boolean((Dexie as any).currentTransaction) });
      return baseFetch(input, init);
    }) as any;

    const ctx = WorkflowContextFactory.create('PURCHASE_RETURN', {
      tenantId,
      branchId,
      idempotencyKey: 'TX-PURCHASE-RETURN-PIPE-01'
    });

    const result = await WorkflowExecutionPipeline.run(
      purchaseReturnWorkflow,
      {
        originalPurchaseId: purchaseRes.refId,
        supplierId,
        items: [
          {
            productId,
            product_id: productId,
            quantity: 3,
            qty: 3,
            unitCost: 15,
            unitPrice: 15,
            price: 15,
            batchNumber: 'BATCH-PR-01'
          } as any
        ],
        total: 45,
        isCash: false,
        notes: 'مرتجع مشتريات عبر Pipeline'
      },
      ctx
    );

    expect(result.success).toBe(true);
    expect(result.data?.refId).toBeTruthy();

    // Verify all network calls happened outside any active Dexie transaction
    expect(fetchSnapshots.some((s) => s.url.includes('/api/accounting/periods'))).toBe(true);
    expect(fetchSnapshots.every((s) => s.inDexieTx === false)).toBe(true);

    const refId = result.data!.refId;
    const savedInvoice = await db.invoices.get(refId);
    expect(savedInvoice?.isReturn).toBe(true);
    expect(savedInvoice?.totalAmount).toBe(45);

    const savedPurchaseMirror = await db.purchases.get(refId);
    expect(savedPurchaseMirror?.id).toBe(refId);

    const product = await db.products.get(productId);
    expect(product?.stock).toBe(7);
    expect(product?.StockQuantity).toBe(7);

    const whRecords = await db.warehouseStock.where('productId').equals(productId).toArray();
    expect(whRecords.length).toBe(1);
    expect(whRecords[0]?.quantity).toBe(7);

    const brInv = await db.branchInventory.where('[branchId+productId]').equals([branchId, productId]).first();
    expect(brInv?.stockQuantity).toBe(7);

    const batches = await db.medicineBatches.where('productId').equals(productId).toArray();
    expect(batches.length).toBe(1);
    expect(batches[0]?.quantity).toBe(7);

    const layers = await db.inventory_layers.filter((l: any) => l.product_id === productId).toArray();
    expect(layers.length).toBe(1);
    expect(layers[0]?.quantity_remaining).toBe(7);

    const fifoLogs = await db.fifo_consumption_log.filter((l: any) => l.sale_id === refId).toArray();
    expect(fifoLogs.length).toBe(1);
    expect(fifoLogs[0]?.quantity_consumed).toBe(3);

    const supplier = await db.suppliers.get(supplierId);
    expect(supplier?.balance).toBe(105);

    const fts = await db.financialTransactions.where('Reference_ID').equals(refId).toArray();
    expect(fts.length).toBe(1);

    const journals = await db.journalEntries.where('sourceId').equals(refId).toArray();
    expect(journals.length).toBe(1);
    expect(await db.journalLines.where('entryId').equals(journals[0]!.id).count()).toBe(2);

    const projEvents = await db.projectionEvents.filter((e: any) => e.aggregateId === refId).toArray();
    expect(projEvents.length).toBe(1);
  });

  it('3. Rejects both SalesReturnWorkflow and PurchaseReturnWorkflow when the accounting period is locked', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/accounting/periods')) {
        expect((Dexie as any).currentTransaction).toBeFalsy();
        return new Response(
          JSON.stringify({
            success: true,
            periods: [
              {
                id: 'LOCKED-RET-PERIOD',
                clientId: 'LOCKED-RET-PERIOD',
                startDate: '2000-01-01T00:00:00.000Z',
                endDate: '2100-12-31T23:59:59.999Z',
                isLocked: true
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return baseFetch(input, init);
    }) as any;

    const salesCtx = WorkflowContextFactory.create('SALES_RETURN', {
      tenantId,
      branchId,
      idempotencyKey: 'TX-LOCKED-SR-01'
    });

    const salesRes = await WorkflowExecutionPipeline.run(
      salesReturnWorkflow,
      {
        customerId,
        items: [{ productId, quantity: 2, unitPrice: 25 } as any],
        total: 50
      },
      salesCtx
    );
    expect(salesRes.success).toBe(false);
    expect(salesRes.error?.message).toMatch(/Period locked|مغلقة/i);

    const purchaseCtx = WorkflowContextFactory.create('PURCHASE_RETURN', {
      tenantId,
      branchId,
      idempotencyKey: 'TX-LOCKED-PR-01'
    });

    const purchaseRes = await WorkflowExecutionPipeline.run(
      purchaseReturnWorkflow,
      {
        supplierId,
        items: [{ productId, quantity: 2, unitPrice: 15 } as any],
        total: 30
      },
      purchaseCtx
    );
    expect(purchaseRes.success).toBe(false);
    expect(purchaseRes.error?.message).toMatch(/Period locked|مغلقة/i);

    expect(await db.invoices.count()).toBe(0);
    expect(await db.sales.count()).toBe(0);
    expect(await db.purchases.count()).toBe(0);
    expect(await db.inventoryTransactions.count()).toBe(0);
    expect(await db.journalEntries.count()).toBe(0);
  });
});
