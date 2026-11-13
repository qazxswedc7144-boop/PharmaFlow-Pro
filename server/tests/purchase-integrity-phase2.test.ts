import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '@/core/db';
import { UnifiedBusinessWorkflowOrchestrator } from '@/services/orchestration/UnifiedBusinessWorkflowOrchestrator';
import { useAuthStore } from '@/store/authStore';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';

describe('Purchase Phase 2 Integrity Verification', () => {
  const tenantId = 'TENANT-P2-01';
  const branchId = 'BRH-P2-MAIN';
  const supplierAId = 'SUP-A';
  const supplierBId = 'SUP-B';
  const productAId = 'PROD-A';
  const warehouseId = 'WH-MAIN';

  beforeEach(async () => {
    vi.clearAllMocks();
    // This suite exercises the local Dexie workflow with an already trusted branch.
    vi.stubGlobal('navigator', { onLine: false, userAgent: 'Vitest Purchase Test' });

    // 🚨 SECURITY SETUP: Must set session BEFORE clearing tables to satisfy Dexie guards
    const userObj = {
      id: 'usr-p2-tester',
      User_Email: 'tester@pharmaflow.test',
      Role: 'SuperAdmin',
      tenantId,
      branchId,
      permissions: ['ALL']
    };

    TokenProvider.setSession(userObj as any, 'mock-jwt', 'mock-refresh');
    useAuthStore.setState({
      user: userObj as any,
      tenantId,
      branchId,
      isAuthenticated: true
    });

    await db.invoices.clear();
    await db.purchases.clear();
    await db.products.clear();
    await db.suppliers.clear();
    await db.warehouseStock.clear();
    await db.branchInventory.clear();
    await db.inventoryTransactions.clear();
    await db.financialTransactions.clear();
    await db.journalEntries.clear();
    await db.journalLines.clear();
    await db.accounts.clear();
    await db.idempotencyKeys.clear();
    IdempotencyRegistry.clearInMemory();

    if (!db.isOpen()) await db.open();
    await db.branches.clear();

    await db.branches.put({
      id: branchId,
      code: branchId,
      name: 'Test Branch',
      tenantId: tenantId,
      isActive: true
    } as any);

    await db.branches.put({
      id: 'WH-MAIN',
      code: 'WH-MAIN',
      name: 'Main Warehouse',
      tenantId: tenantId,
      isActive: true
    } as any);

    // Verify registration to be sure
    const checkBranch = await db.branches.get(branchId);
    if (!checkBranch) {
      throw new Error(`Setup failed: Branch ${branchId} not found in DB after put`);
    }

    await db.suppliers.put({ id: supplierAId, Supplier_Name: 'Supplier A', balance: 0, tenantId, branchId, is_active: true } as any);
    await db.suppliers.put({ id: supplierBId, Supplier_Name: 'Supplier B', balance: 0, tenantId, branchId, is_active: true } as any);

    await db.products.put({
      id: productAId,
      name: 'Product A',
      stock: 100,
      price: 10,
      costPrice: 8,
      tenantId: tenantId, // Explicitly set
      is_active: true
    } as any);

    await db.warehouseStock.put({
      id: `${warehouseId}-${productAId}`,
      warehouseId,
      productId: productAId,
      quantity: 100,
      tenantId: tenantId // Explicitly set
    } as any);

    await db.accounts.bulkPut([
      { id: 'ACC-101', code: '101', name: 'Cash', type: 'Asset', tenantId, branchId, balance: 10000 },
      { id: 'ACC-102', code: '102', name: 'Inventory', type: 'Asset', tenantId, branchId, balance: 800 },
      { id: 'ACC-201', code: '201', name: 'Payables', type: 'Liability', tenantId, branchId, balance: 0 }
    ] as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('P0-1: Creates purchase with manual invoice number and ensures internal ID is different', async () => {
    // Sanity check
    const b = await db.branches.get(branchId);
    if (!b) throw new Error(`TEST SANITY FAILED: Branch ${branchId} not found in DB before test execution`);

    const manualInvNum = 'INV-2026-00125';
    const res = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
      supplierId: supplierAId,
      supplierInvoiceNumber: manualInvNum,
      items: [{ productId: productAId, quantity: 10, unitCost: 8, unitPrice: 8 } as any],
      total: 80
    });

    expect(res.success).toBe(true);
    const inv = await db.invoices.get(res.refId);
    expect(inv?.supplierInvoiceNumber).toBe(manualInvNum);
    expect(res.invoiceNumber).toBe(inv?.invoiceNumber);
    expect(inv?.invoiceNumber).toBeTruthy();
    expect(inv?.invoiceNumber).not.toBe(manualInvNum);
    expect(inv?.invoice_number).toBe(inv?.invoiceNumber);
    expect(inv?.id).not.toBe(inv?.invoiceNumber);
  });

  it('P0-2: Verifies supplier balance reversal and re-application during edit', async () => {
    // 1. Create original purchase (1000)
    const createRes = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
      supplierId: supplierAId,
      supplierInvoiceNumber: 'SUP-A-1000-001',
      items: [{ productId: productAId, quantity: 100, unitCost: 10, unitPrice: 10 } as any],
      total: 1000
    });
    
    expect((await db.suppliers.get(supplierAId))?.balance).toBe(1000);

    // 2. Edit total to 1200
    await UnifiedBusinessWorkflowOrchestrator.processPurchase({
      id: createRes.refId, // Pass same internal ID
      supplierId: supplierAId,
      items: [{ productId: productAId, quantity: 120, unitCost: 10, unitPrice: 10 } as any],
      total: 1200,
      isEdit: true
    });

    // Final balance should be 1200, not 2200
    const supp = await db.suppliers.get(supplierAId);
    expect(supp?.balance).toBe(1200);
  });

  it('P0-2: Handles supplier change during edit correctly', async () => {
    // 1. Create original purchase for Supplier A (1000)
    const createRes = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
      supplierId: supplierAId,
      supplierInvoiceNumber: 'SUP-A-1000-002',
      items: [{ productId: productAId, quantity: 100, unitCost: 10, unitPrice: 10 } as any],
      total: 1000
    });

    expect((await db.suppliers.get(supplierAId))?.balance).toBe(1000);
    expect((await db.suppliers.get(supplierBId))?.balance).toBe(0);

    // 2. Edit and change to Supplier B with total 500
    await UnifiedBusinessWorkflowOrchestrator.processPurchase({
      id: createRes.refId,
      supplierId: supplierBId,
      supplierInvoiceNumber: 'SUP-B-500-001',
      items: [{ productId: productAId, quantity: 50, unitCost: 10, unitPrice: 10 } as any],
      total: 500,
      isEdit: true
    });

    // Supplier A should be back to 0, Supplier B should have 500
    expect((await db.suppliers.get(supplierAId))?.balance).toBe(0);
    expect((await db.suppliers.get(supplierBId))?.balance).toBe(500);
  });

  it('P0/P1: Verifies manual product validation flow and atomicity', async () => {
    const manualProdId = 'manual-new-prod';
    const pendingProducts = [{
      id: manualProdId,
      ProductID: manualProdId,
      name: 'New Manual Product',
      price: 50,
      Is_Active: 1
    }];

    // This should pass validation because manualProdId is in pendingProducts
    const res = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
      supplierId: supplierAId,
      supplierInvoiceNumber: 'SUP-A-MANUAL-001',
      items: [{ productId: manualProdId, quantity: 5, unitCost: 30, unitPrice: 30 } as any],
      total: 150,
      pendingProducts
    });

    expect(res.success).toBe(true);
    
    // Product should be created in DB
    const prod = await db.products.get(manualProdId);
    expect(prod).toBeDefined();
    expect(prod?.name).toBe('New Manual Product');
    expect(prod?.tenantId).toBe(tenantId);
  });

  it('P0/P1: Matches pending manual product IDs after trimming and case normalization', async () => {
    const canonicalProductId = 'Manual-Product-Case';
    const result = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
      supplierId: supplierAId,
      supplierInvoiceNumber: 'SUP-A-MANUAL-002',
      items: [{
        productId: '  manual-product-case  ',
        quantity: 2,
        unitCost: 30,
        unitPrice: 30
      } as any],
      total: 60,
      pendingProducts: [{
        id: canonicalProductId,
        ProductID: canonicalProductId,
        name: 'Normalized Manual Product',
        Name: 'Normalized Manual Product',
        UnitPrice: 30,
        price: 30,
        Is_Active: 1
      }]
    });

    expect(result.success).toBe(true);
    const product = await db.products.get(canonicalProductId);
    expect(product).toBeDefined();
    expect(product?.name).toBe('Normalized Manual Product');
  });

  it('P1: Stable idempotency prevents duplicate mutations on retry', async () => {
    const fixedUuid = 'STABLE-TX-001';
    const payload = {
      transactionUuid: fixedUuid,
      supplierId: supplierAId,
      supplierInvoiceNumber: 'SUP-A-STABLE-001',
      items: [{ productId: productAId, quantity: 10, unitCost: 10, unitPrice: 10 } as any],
      total: 100
    };

    const res1 = await UnifiedBusinessWorkflowOrchestrator.processPurchase(payload);
    expect(res1.success).toBe(true);
    expect((await db.suppliers.get(supplierAId))?.balance).toBe(100);

    // Retry with same UUID
    const res2 = await UnifiedBusinessWorkflowOrchestrator.processPurchase(payload);
    expect(res2.success).toBe(true);
    expect(res2.refId).toBe(res1.refId);

    // Balance should still be 100
    expect((await db.suppliers.get(supplierAId))?.balance).toBe(100);
    expect((await db.invoices.toArray()).length).toBe(1);
  });

  it('P1: a purchases index write failure aborts the purchase transaction before inventory or accounting mutations', async () => {
    const purchaseTablePrototype = Object.getPrototypeOf(db.purchases as any);
    const originalPut = purchaseTablePrototype.put;
    const putSpy = vi.spyOn(purchaseTablePrototype, 'put').mockImplementation(function(this: any, ...args: any[]) {
      if (this.name === 'purchases') {
        throw new Error('SIMULATED_PURCHASES_INDEX_WRITE_FAILURE');
      }
      return originalPut.apply(this, args);
    });

    try {
      await expect(UnifiedBusinessWorkflowOrchestrator.processPurchase({
        supplierId: supplierAId,
        supplierInvoiceNumber: 'SUP-A-FAIL-001',
        items: [{ productId: productAId, quantity: 10, unitCost: 8, unitPrice: 8 } as any],
        total: 80
      })).rejects.toThrow('SIMULATED_PURCHASES_INDEX_WRITE_FAILURE');

      expect(await db.invoices.count()).toBe(0);
      expect(await db.purchases.count()).toBe(0);
      expect((await db.products.get(productAId))?.stock).toBe(100);
      expect((await db.suppliers.get(supplierAId))?.balance).toBe(0);
      expect(await db.inventoryTransactions.count()).toBe(0);
      expect(await db.financialTransactions.count()).toBe(0);
      expect(await db.journalEntries.count()).toBe(0);
      expect(await db.journalLines.count()).toBe(0);
    } finally {
      putSpy.mockRestore();
    }
  });

});