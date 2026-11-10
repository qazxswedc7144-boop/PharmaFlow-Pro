import { describe, it, expect, beforeEach, vi } from 'vitest';
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

  it('P0-1: Creates purchase with manual invoice number and ensures internal ID is different', async () => {
    // Sanity check
    const b = await db.branches.get(branchId);
    if (!b) throw new Error(`TEST SANITY FAILED: Branch ${branchId} not found in DB before test execution`);

    const manualInvNum = 'INV-2026-00125';
    const res = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
      supplierId: supplierAId,
      invoiceNumber: manualInvNum,
      items: [{ productId: productAId, quantity: 10, unitCost: 8, unitPrice: 8 } as any],
      total: 80
    });

    expect(res.success).toBe(true);
    const inv = await db.invoices.get(res.refId);
    expect(inv?.invoice_number).toBe(manualInvNum);
    expect(inv?.invoiceNumber).toBe(manualInvNum);
    expect(inv?.id).not.toBe(manualInvNum);
  });

  it('P0-2: Verifies supplier balance reversal and re-application during edit', async () => {
    // 1. Create original purchase (1000)
    const createRes = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
      supplierId: supplierAId,
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
      items: [{ productId: productAId, quantity: 100, unitCost: 10, unitPrice: 10 } as any],
      total: 1000
    });

    expect((await db.suppliers.get(supplierAId))?.balance).toBe(1000);
    expect((await db.suppliers.get(supplierBId))?.balance).toBe(0);

    // 2. Edit and change to Supplier B with total 500
    await UnifiedBusinessWorkflowOrchestrator.processPurchase({
      id: createRes.refId,
      supplierId: supplierBId,
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
});
