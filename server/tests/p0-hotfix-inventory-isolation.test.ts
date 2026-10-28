import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/core/db';
import { InventoryService } from '@/features/inventory/services/InventoryService';
import { ProductRepository } from '@/features/inventory/services/ProductRepository';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { PriceHistoryRepository } from '@/database/repositories/PriceHistoryRepository';

describe('P0 Hotfix: Inventory Tenant/Branch Isolation Tests', () => {
  const validTenant = 'REAL-TENANT-001';
  const validBranch = 'REAL-BRANCH-001';
  const productId = 'PROD-TEST-001';

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.products.clear();
    await db.inventoryTransactions.clear();
    await db.warehouseStock.clear();
    await db.branchInventory.clear();
    
    await db.branches.clear();
    await db.branches.add({
      id: validBranch,
      code: validBranch,
      name: 'Test Branch',
      tenantId: validTenant,
      isActive: true
    } as any);

    await db.branchInventory.add({
      id: `INV-${validBranch}-${productId}`,
      branchId: validBranch,
      productId,
      stockQuantity: 100,
      tenantId: validTenant
    } as any);

    // Default valid session
    TokenProvider.setSession({
      id: 'user-1',
      tenantId: validTenant,
      branchId: validBranch,
      role: 'ADMIN'
    } as any, 'token', 'refresh');

    await db.products.add({
      id: productId,
      name: 'Test Product',
      stock: 100,
      tenantId: validTenant,
      branchId: validBranch,
      isActive: true
    } as any);

    await db.warehouseStock.add({
      id: `WHS-MAIN-${productId}`,
      warehouseId: 'WH-MAIN',
      productId,
      quantity: 100,
      tenantId: validTenant,
      branchId: validBranch
    } as any);
  });

  it('1. resetStock without trusted tenant context (forbidden value) throws error', async () => {
    TokenProvider.setSession({ tenantId: 'TEN-DEV-001', branchId: validBranch } as any, 'token', 'refresh');
    await expect(InventoryService.resetStock(productId)).rejects.toThrow(/TRUSTED_TENANT_CONTEXT_REQUIRED/);
  });

  it('2. resetStock without trusted branch context (forbidden value) throws error', async () => {
    TokenProvider.setSession({ tenantId: validTenant, branchId: 'BR-MAIN' } as any, 'token', 'refresh');
    await expect(InventoryService.resetStock(productId)).rejects.toThrow(/TRUSTED_BRANCH_CONTEXT_REQUIRED/);
  });

  it('3. recordMovement without trusted tenant context throws error', async () => {
    TokenProvider.setSession({ tenantId: 'default', branchId: validBranch } as any, 'token', 'refresh');
    await expect(InventoryService.recordMovement({
      type: 'ADJUSTMENT',
      productId,
      warehouseId: 'WH-MAIN',
      quantity: 10,
      userId: 'user-1'
    })).rejects.toThrow(/TRUSTED_TENANT_CONTEXT_REQUIRED/);
  });

  it('4. recordMovement without trusted branch context throws error', async () => {
    TokenProvider.setSession({ tenantId: validTenant, branchId: 'branch_default' } as any, 'token', 'refresh');
    await expect(InventoryService.recordMovement({
      type: 'ADJUSTMENT',
      productId,
      warehouseId: 'WH-MAIN',
      quantity: 10,
      userId: 'user-1'
    })).rejects.toThrow(/TRUSTED_BRANCH_CONTEXT_REQUIRED/);
  });

  it('5. adjustStock without trusted tenant context throws error', async () => {
    TokenProvider.setSession({ tenantId: '', branchId: validBranch } as any, 'token', 'refresh');
    await expect(InventoryService.adjustStock({
      productId,
      newQty: 50,
      userId: 'user-1'
    })).rejects.toThrow(/TRUSTED_TENANT_CONTEXT_REQUIRED/);
  });

  it('6. adjustStock without trusted branch context throws error', async () => {
    TokenProvider.setSession({ tenantId: validTenant, branchId: '' } as any, 'token', 'refresh');
    await expect(InventoryService.adjustStock({
      productId,
      newQty: 50,
      userId: 'user-1'
    })).rejects.toThrow(/TRUSTED_BRANCH_CONTEXT_REQUIRED/);
  });

  it('7. TEN-DEV-001 is strictly rejected for all mutations', async () => {
    TokenProvider.setSession({ tenantId: 'TEN-DEV-001', branchId: validBranch } as any, 'token', 'refresh');
    await expect(InventoryService.updateStock(productId, 10)).rejects.toThrow(/TRUSTED_TENANT_CONTEXT_REQUIRED/);
  });

  it('8. BR-MAIN is strictly rejected for all mutations', async () => {
    TokenProvider.setSession({ tenantId: validTenant, branchId: 'BR-MAIN' } as any, 'token', 'refresh');
    await expect(InventoryService.updateStock(productId, 10)).rejects.toThrow(/TRUSTED_BRANCH_CONTEXT_REQUIRED/);
  });

  it('11. Valid real tenant and branch allows mutation to succeed', async () => {
    TokenProvider.setSession({ tenantId: 'REAL-ACC-999', branchId: 'REAL-BR-999' } as any, 'token', 'refresh');
    
    await db.branches.add({
      id: 'REAL-BR-999',
      code: 'REAL-BR-999',
      name: 'Test Branch 999',
      tenantId: 'REAL-ACC-999',
      isActive: true
    } as any);

    // Update product to match new tenant for test
    await db.products.update(productId, { tenantId: 'REAL-ACC-999', branchId: 'REAL-BR-999' });
    await db.warehouseStock.put({
      id: `WHS-MAIN-${productId}`,
      warehouseId: 'WH-MAIN',
      productId,
      quantity: 100,
      tenantId: 'REAL-ACC-999',
      branchId: 'REAL-BR-999'
    } as any);
    await db.branchInventory.put({
      id: `INV-REAL-BR-999-${productId}`,
      branchId: 'REAL-BR-999',
      productId,
      stockQuantity: 100,
      tenantId: 'REAL-ACC-999'
    } as any);

    await InventoryService.updateStock(productId, -5);
    
    const product = await db.products.get(productId);
    expect(product?.stock).toBe(95);

    const tx = await db.inventoryTransactions.toArray();
    expect(tx[0].tenantId).toBe('REAL-ACC-999');
    expect(tx[0].branchId).toBe('REAL-BR-999');
  });

  it('A. tenant A + branch A => accepted', async () => {
    TokenProvider.setSession({ tenantId: 'TENANT-A', branchId: 'BRANCH-A' } as any, 'token', 'refresh');
    await db.branches.put({
      id: 'BRANCH-A',
      code: 'BRANCH-A',
      name: 'Branch A',
      tenantId: 'TENANT-A',
      isActive: true
    } as any);
    await db.products.put({
      id: 'PROD-A',
      name: 'Product A',
      stock: 50,
      tenantId: 'TENANT-A',
      branchId: 'BRANCH-A',
      isActive: true
    } as any);
    await db.warehouseStock.put({
      id: 'WHS-A',
      warehouseId: 'WH-MAIN',
      productId: 'PROD-A',
      quantity: 50,
      tenantId: 'TENANT-A',
      branchId: 'BRANCH-A'
    } as any);
    await db.branchInventory.put({
      id: 'BINV-A',
      branchId: 'BRANCH-A',
      productId: 'PROD-A',
      stockQuantity: 50,
      tenantId: 'TENANT-A'
    } as any);

    const res = await InventoryService.updateStock('PROD-A', 10);
    expect(res?.stock).toBe(60);
  });

  it('B. tenant A + branch B belonging to tenant B => rejected (CROSS_TENANT_VIOLATION)', async () => {
    await db.branches.put({
      id: 'BRANCH-B',
      code: 'BRANCH-B',
      name: 'Branch B',
      tenantId: 'TENANT-B',
      isActive: true
    } as any);
    TokenProvider.setSession({ tenantId: 'TENANT-A', branchId: 'BRANCH-B' } as any, 'token', 'refresh');

    await expect(InventoryService.updateStock(productId, 10)).rejects.toThrow(/CROSS_TENANT_VIOLATION/);
  });

  it('C. missing branchId where required => rejected', async () => {
    TokenProvider.setSession({ tenantId: validTenant, branchId: '' } as any, 'token', 'refresh');
    await expect(InventoryService.updateStock(productId, 10)).rejects.toThrow(/TRUSTED_BRANCH_CONTEXT_REQUIRED/);
  });

  it('D. unknown/unbound branch => rejected', async () => {
    TokenProvider.setSession({ tenantId: validTenant, branchId: 'UNKNOWN-BRANCH-999' } as any, 'token', 'refresh');
    await expect(InventoryService.updateStock(productId, 10)).rejects.toThrow(/CROSS_TENANT_VIOLATION/);
  });

  it('E. existing valid inventory mutation behavior remains unchanged', async () => {
    TokenProvider.setSession({ tenantId: validTenant, branchId: validBranch } as any, 'token', 'refresh');
    await InventoryService.updateStock(productId, -10);
    const prod = await db.products.get(productId);
    expect(prod?.stock).toBe(90);
  });

  describe('Central Tenant Isolation #2: Product & Warehouse Boundaries', () => {
    it('A. tenant A + product A + warehouse A => mutation succeeds', async () => {
      TokenProvider.setSession({ tenantId: 'TENANT-A', branchId: 'BRANCH-A' } as any, 'token', 'refresh');
      await db.branches.put({
        id: 'BRANCH-A',
        code: 'BRANCH-A',
        name: 'Branch A',
        tenantId: 'TENANT-A',
        isActive: true
      } as any);
      await db.products.put({
        id: 'PROD-A',
        name: 'Product A',
        stock: 50,
        tenantId: 'TENANT-A',
        branchId: 'BRANCH-A',
        isActive: true
      } as any);
      await db.warehouseStock.put({
        id: 'WHS-A-1',
        warehouseId: 'WH-A',
        productId: 'PROD-A',
        quantity: 50,
        tenantId: 'TENANT-A',
        branchId: 'BRANCH-A'
      } as any);
      await db.branchInventory.put({
        id: 'BINV-A-1',
        branchId: 'BRANCH-A',
        productId: 'PROD-A',
        stockQuantity: 50,
        tenantId: 'TENANT-A'
      } as any);

      const res = await InventoryService.updateStock('PROD-A', 10, { warehouseId: 'WH-A' });
      expect(res?.stock).toBe(60);

      const ws = await db.warehouseStock.get('WHS-A-1');
      expect(ws?.quantity).toBe(60);
    });

    it('B. tenant A + product B belonging to tenant B => mutation is rejected with CROSS_TENANT_VIOLATION', async () => {
      TokenProvider.setSession({ tenantId: 'TENANT-A', branchId: 'BRANCH-A' } as any, 'token', 'refresh');
      await db.products.put({
        id: 'PROD-B-FOREIGN',
        name: 'Product B Foreign',
        stock: 50,
        tenantId: 'TENANT-B',
        branchId: 'BRANCH-B',
        isActive: true
      } as any);

      await expect(
        InventoryService.updateStock('PROD-B-FOREIGN', 10, { warehouseId: 'WH-A' })
      ).rejects.toThrow(/CROSS_TENANT_VIOLATION/);
    });

    it('C. tenant A + warehouse context belonging to tenant B => mutation is rejected with CROSS_TENANT_VIOLATION', async () => {
      TokenProvider.setSession({ tenantId: 'TENANT-A', branchId: 'BRANCH-A' } as any, 'token', 'refresh');
      await db.branches.put({
        id: 'BRANCH-A',
        code: 'BRANCH-A',
        name: 'Branch A',
        tenantId: 'TENANT-A',
        isActive: true
      } as any);
      await db.products.put({
        id: 'PROD-A',
        name: 'Product A',
        stock: 50,
        tenantId: 'TENANT-A',
        branchId: 'BRANCH-A',
        isActive: true
      } as any);

      // Foreign warehouse belonging to TENANT-B
      await db.warehouseStock.put({
        id: 'WHS-FOREIGN-B',
        warehouseId: 'WH-FOREIGN-B',
        productId: 'PROD-B-FOREIGN',
        quantity: 50,
        tenantId: 'TENANT-B',
        branchId: 'BRANCH-B'
      } as any);

      await expect(
        InventoryService.updateStock('PROD-A', 10, { warehouseId: 'WH-FOREIGN-B' })
      ).rejects.toThrow(/CROSS_TENANT_VIOLATION/);
    });

    it('D. unknown/unbound product or warehouse => fail closed', async () => {
      TokenProvider.setSession({ tenantId: 'TENANT-A', branchId: 'BRANCH-A' } as any, 'token', 'refresh');
      await db.branches.put({
        id: 'BRANCH-A',
        code: 'BRANCH-A',
        name: 'Branch A',
        tenantId: 'TENANT-A',
        isActive: true
      } as any);
      await db.products.put({
        id: 'PROD-A',
        name: 'Product A',
        stock: 50,
        tenantId: 'TENANT-A',
        branchId: 'BRANCH-A',
        isActive: true
      } as any);

      // 1. Unknown product fails closed in engine
      const { unifiedInventoryMutationEngine } = await import('@/features/inventory/services/UnifiedInventoryMutationEngine');
      await expect(
        unifiedInventoryMutationEngine.executeMutation({
          productId: 'UNKNOWN-PROD-999',
          warehouseId: 'WH-MAIN',
          delta: 10,
          docType: 'ADJUSTMENT',
          docId: 'ADJ-FAIL-01',
          movementType: 'ADJUSTMENT',
          userId: 'user-1',
          tenantId: 'TENANT-A',
          branchId: 'BRANCH-A',
          transactionUuid: 'TX-FAIL-UNKNOWN-PROD'
        })
      ).rejects.toThrow();

      // 2. Unknown / unbound warehouse fails closed
      await expect(
        InventoryService.updateStock('PROD-A', 10, { warehouseId: 'UNKNOWN-WH-999' })
      ).rejects.toThrow(/CROSS_TENANT_VIOLATION/);
    });

    it('E. existing valid tenant/branch/product/warehouse mutation remains unchanged', async () => {
      TokenProvider.setSession({ tenantId: validTenant, branchId: validBranch } as any, 'token', 'refresh');
      await InventoryService.updateStock(productId, -5, { warehouseId: 'WH-MAIN' });
      const prod = await db.products.get(productId);
      expect(prod?.stock).toBe(95);

      const ws = await db.warehouseStock.get(`WHS-MAIN-${productId}`);
      expect(ws?.quantity).toBe(95);
    });
  });

  describe('Targeted Tenant Read Isolation #3: ProductRepository History Isolation', () => {
    const tenantA = 'TENANT-READ-A';
    const tenantB = 'TENANT-READ-B';
    const productA = 'PROD-READ-A';
    const productB = 'PROD-READ-B';

    beforeEach(async () => {
      // Seed Product A for Tenant A
      await db.products.put({
        id: productA,
        name: 'Product A',
        price: 100,
        stock: 50,
        tenantId: tenantA,
        isActive: true
      } as any);

      // Seed Product B for Tenant B
      await db.products.put({
        id: productB,
        name: 'Product B',
        price: 200,
        stock: 40,
        tenantId: tenantB,
        isActive: true
      } as any);

      // Seed Price History for Product A (Tenant A)
      await db.priceHistory.put({
        id: 'PH-A-1',
        productId: productA,
        name: 'Product A',
        partnerId: 'PARTNER-A',
        Price: 95,
        date: '2026-01-01',
        tenantId: tenantA
      } as any);

      // Seed Price History for Product B (Tenant B)
      await db.priceHistory.put({
        id: 'PH-B-1',
        productId: productB,
        name: 'Product B',
        partnerId: 'PARTNER-B',
        Price: 195,
        date: '2026-01-02',
        tenantId: tenantB
      } as any);

      // Seed Purchase Invoice for Product A (Tenant A)
      await db.invoices.put({
        id: 'INV-PUR-A-1',
        type: 'PURCHASE',
        tenantId: tenantA,
        date: '2026-01-10',
        items: [{ productId: productA, unitPrice: 90, quantity: 10 }]
      } as any);

      // Seed Purchase Invoice for Product B (Tenant B)
      await db.invoices.put({
        id: 'INV-PUR-B-1',
        type: 'PURCHASE',
        tenantId: tenantB,
        date: '2026-01-12',
        items: [{ productId: productB, unitPrice: 180, quantity: 5 }]
      } as any);
    });

    it('A. Tenant A requests history for Product A belonging to Tenant A => existing records are returned', async () => {
      TokenProvider.setSession({ tenantId: tenantA, branchId: 'BR-A' } as any, 'tok', 'ref');

      const priceHistory = await ProductRepository.getPriceHistory(productA);
      expect(priceHistory.length).toBeGreaterThan(0);
      expect((priceHistory[0] as any).Price).toBe(95);

      const purchaseHistory = await ProductRepository.getPurchaseHistory(productA);
      expect(purchaseHistory.length).toBeGreaterThan(0);
      expect(purchaseHistory[0].id).toBe('INV-PUR-A-1');
    });

    it('B. Tenant A attempts to obtain history for Product B belonging to Tenant B => must not expose Tenant B data', async () => {
      TokenProvider.setSession({ tenantId: tenantA, branchId: 'BR-A' } as any, 'tok', 'ref');

      const priceHistory = await ProductRepository.getPriceHistory(productB);
      expect(priceHistory).toEqual([]);

      const purchaseHistory = await ProductRepository.getPurchaseHistory(productB);
      expect(purchaseHistory).toEqual([]);
    });

    it('C. Tenant context missing or untrusted where required => returns safe empty array', async () => {
      // 1. Missing tenant context
      TokenProvider.setSession({ tenantId: undefined, branchId: undefined } as any, 'tok', 'ref');
      expect(await ProductRepository.getPriceHistory(productA)).toEqual([]);
      expect(await ProductRepository.getPurchaseHistory(productA)).toEqual([]);

      // 2. Forbidden / untrusted tenant context
      TokenProvider.setSession({ tenantId: 'TEN-DEV-001', branchId: 'BR-A' } as any, 'tok', 'ref');
      expect(await ProductRepository.getPriceHistory(productA)).toEqual([]);
      expect(await ProductRepository.getPurchaseHistory(productA)).toEqual([]);
    });

    it('D. Existing valid callers and behavior remain unchanged', async () => {
      TokenProvider.setSession({ tenantId: tenantA, branchId: 'BR-A' } as any, 'tok', 'ref');

      // Caller: InventoryService.getProductDetails
      const details = await InventoryService.getProductDetails(productA);
      expect(details).toBeDefined();
      expect(details.priceHist).toBeDefined();
      expect(details.purchHist).toBeDefined();
      expect(details.priceHist.length).toBeGreaterThan(0);
      expect(details.purchHist.length).toBeGreaterThan(0);
    });

    it('E. Cross-verify both getPriceHistory and getPurchaseHistory enforce tenant boundaries', async () => {
      TokenProvider.setSession({ tenantId: tenantA, branchId: 'BR-A' } as any, 'tok', 'ref');

      // Directly verify both methods for Product A (authorized)
      const pricesA = await ProductRepository.getPriceHistory(productA, 10);
      const purchasesA = await ProductRepository.getPurchaseHistory(productA, 10);
      expect(pricesA.every(p => ((p as any).tenantId === tenantA))).toBe(true);
      expect(purchasesA.every(p => ((p as any).tenantId === tenantA))).toBe(true);

      // Directly verify both methods for Product B (unauthorized cross-tenant)
      const pricesB = await ProductRepository.getPriceHistory(productB, 10);
      const purchasesB = await ProductRepository.getPurchaseHistory(productB, 10);
      expect(pricesB).toHaveLength(0);
      expect(purchasesB).toHaveLength(0);
    });
  });

  describe('Security Fix #4: Authoritative Tenant Resolution', () => {
    const tenantA = 'TENANT-SEC-A';
    const tenantB = 'TENANT-SEC-B';
    const productA = 'PROD-SEC-A';
    const productUnbound = 'PROD-SEC-UNBOUND';

    beforeEach(async () => {
      await db.products.put({
        id: productA,
        name: 'Sec Product A',
        tenantId: tenantA,
        isActive: true
      } as any);

      await db.products.put({
        id: productUnbound,
        name: 'Sec Product Unbound',
        // No tenantId
        isActive: true
      } as any);

      await db.priceHistory.put({
        id: 'PH-SEC-A-1',
        productId: productA,
        Price: 100,
        date: '2026-01-01',
        tenantId: tenantA
      } as any);
    });

    it('A. Authoritative session resolution: Session tenant is used even if caller passes different tenantId', async () => {
      TokenProvider.setSession({ tenantId: tenantA } as any, 'tok', 'ref');
      // Caller passes tenantB, but session is tenantA. Should return tenantA data.
      const history = await ProductRepository.getPriceHistory(productA, 5, tenantB);
      expect(history).toEqual([]); // Should be rejected because tenantB (caller) != tenantA (session)
    });

    it('B. Tenant ID conflict (Session != Caller) => reject', async () => {
      TokenProvider.setSession({ tenantId: tenantA } as any, 'tok', 'ref');
      await expect(ProductRepository.getPriceHistory(productA, 5, tenantB)).resolves.toEqual([]);
    });

    it('C. Fail-closed for unbound products (product has no tenantId)', async () => {
      TokenProvider.setSession({ tenantId: tenantA } as any, 'tok', 'ref');
      const history = await ProductRepository.getPriceHistory(productUnbound);
      expect(history).toEqual([]);
    });

    it('D. Fail-closed for cross-tenant product access', async () => {
      TokenProvider.setSession({ tenantId: tenantB } as any, 'tok', 'ref');
      const history = await ProductRepository.getPriceHistory(productA);
      expect(history).toEqual([]);
    });

    it('E. Forbidden tenants are strictly rejected', async () => {
      TokenProvider.setSession({ tenantId: 'TEN-DEV-001' } as any, 'tok', 'ref');
      const history = await ProductRepository.getPriceHistory(productA);
      expect(history).toEqual([]);
    });

    it('F. PriceHistoryRepository.record throws on conflict', async () => {
      TokenProvider.setSession({ tenantId: tenantA } as any, 'tok', 'ref');
      await expect(PriceHistoryRepository.record(productA, 'Test', 'P1', 10, '2026-01-01', tenantB))
        .rejects.toThrow(/TENANT_CONFLICT/);
    });

    it('G. Backward compatibility: if session is empty, caller tenant is used', async () => {
      TokenProvider.setSession({ tenantId: undefined } as any, 'tok', 'ref');
      // Update: Security Fix #5 now rejects even if session is empty but tenantId is passed
      await expect(ProductRepository.getPriceHistory(productA, 5, tenantA)).resolves.toEqual([]);
    });

    it('H. Security Fix #5: Missing session tenant with caller tenant => reject', async () => {
      TokenProvider.setSession({ tenantId: undefined } as any, 'tok', 'ref');
      const history = await ProductRepository.getPriceHistory(productA, 5, tenantA);
      expect(history).toEqual([]);
    });

    it('I. Security Fix #5: Conflict handling (Session A, Caller B) => reject', async () => {
      TokenProvider.setSession({ tenantId: tenantA } as any, 'tok', 'ref');
      const history = await ProductRepository.getPriceHistory(productA, 5, tenantB);
      expect(history).toEqual([]);
    });

    it('J. Security Fix #5: PriceHistoryRepository.record rejected when session is missing', async () => {
      TokenProvider.setSession({ tenantId: undefined } as any, 'tok', 'ref');
      await expect(PriceHistoryRepository.record(productA, 'Test', 'P1', 10, '2026-01-01', tenantA))
        .rejects.toThrow(/SECURITY_VIOLATION/);
    });

    it('K. Security Fix #5: Legitimate internal workflow (sets session) => accepted', async () => {
      // Simulate internal script setting a session
      TokenProvider.setSession({ tenantId: tenantA } as any, 'mock-tok', 'mock-ref');
      const history = await ProductRepository.getPriceHistory(productA);
      expect(history.length).toBeGreaterThan(0);
    });
  });

  describe('Security Fix #6B: ProductRepository Tenant Isolation Regression Verification', () => {
    const tenantAlpha = 'TENANT-ALPHA';
    const tenantBeta = 'TENANT-BETA';
    const branchAlpha = 'BRANCH-ALPHA-1';
    const branchBeta = 'BRANCH-BETA-1';

    const productA1 = 'PROD-A-001';
    const productA2 = 'PROD-A-002';
    const productB1 = 'PROD-B-001';
    const productUnbound = 'PROD-UNBOUND-999';

    const sharedBarcode = 'BARCODE-COLLISION-9999';

    beforeEach(async () => {
      vi.clearAllMocks();
      TokenProvider.setSession({ tenantId: undefined, branchId: undefined, user: undefined } as any, '', '');
      await db.products.clear();
      await db.inventoryTransactions.clear();
      await db.purchasesByItem.clear();
      await db.warehouseStock.clear();
      await db.invoices.clear();
      await db.priceHistory.clear();

      const now = new Date();
      const expirySoon = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days
      const expiryFar = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days

      // Seed Tenant A Products
      await db.products.put({
        id: productA1,
        name: 'Amoxicillin 500mg',
        barcode: sharedBarcode, // Overlapping barcode
        sku: 'SKU-AMOX-500',
        price: 25.5,
        stock: 50,
        tenantId: tenantAlpha,
        branchId: branchAlpha,
        categoryName: 'Antibiotics',
        supplierId: 'SUP-A1',
        supplierName: 'PharmaSupply Alpha',
        ExpiryDate: expirySoon,
        Is_Active: true,
        is_active: true
      } as any);

      await db.products.put({
        id: productA2,
        name: 'Paracetamol 500mg',
        barcode: 'BAR-A-PARA',
        sku: 'SKU-PARA-500',
        price: 10.0,
        stock: 100,
        tenantId: tenantAlpha,
        branchId: branchAlpha,
        categoryName: 'Analgesics',
        supplierId: 'SUP-A2',
        supplierName: 'PharmaSupply Alpha',
        ExpiryDate: expiryFar,
        Is_Active: true,
        is_active: true
      } as any);

      // Seed Tenant B Products (with matching overlapping barcode)
      await db.products.put({
        id: productB1,
        name: 'Ibuprofen 400mg',
        barcode: sharedBarcode, // Overlapping barcode with Tenant A
        sku: 'SKU-IBU-400',
        price: 18.0,
        stock: 30,
        tenantId: tenantBeta,
        branchId: branchBeta,
        categoryName: 'NSAID',
        supplierId: 'SUP-B1',
        supplierName: 'Beta Medical Supplies',
        ExpiryDate: expirySoon,
        Is_Active: true,
        is_active: true
      } as any);

      // Seed Unbound Product (no tenantId)
      await db.products.put({
        id: productUnbound,
        name: 'Unbound Legacy Aspirin',
        barcode: 'BAR-UNBOUND',
        sku: 'SKU-UNBOUND',
        price: 5.0,
        stock: 10,
        categoryName: 'General',
        ExpiryDate: expirySoon,
        Is_Active: true,
        is_active: true
      } as any);

      // Seed Inventory Transactions for productA1:
      // Valid Tenant Alpha transactions (+20, +30)
      await db.inventoryTransactions.put({
        id: 'ITX-A-1',
        productId: productA1,
        tenantId: tenantAlpha,
        QuantityChange: 20,
        TransactionType: 'PURCHASE'
      } as any);

      await db.inventoryTransactions.put({
        id: 'ITX-A-2',
        productId: productA1,
        tenantId: tenantAlpha,
        QuantityChange: 30,
        TransactionType: 'PURCHASE'
      } as any);

      // Foreign Tenant Beta transaction (+100) referencing productA1
      await db.inventoryTransactions.put({
        id: 'ITX-B-1',
        productId: productA1,
        tenantId: tenantBeta,
        QuantityChange: 100,
        TransactionType: 'PURCHASE'
      } as any);

      // Unbound transaction (+50) referencing productA1 without tenantId
      await db.inventoryTransactions.put({
        id: 'ITX-UNBOUND-1',
        productId: productA1,
        QuantityChange: 50,
        TransactionType: 'ADJUSTMENT'
      } as any);

      // Seed purchasesByItem for productA1:
      await db.purchasesByItem.put({
        id: 'PBI-A-1',
        productId: productA1,
        unitCost: 22.0,
        supplierId: 'SUP-A1',
        supplierName: 'PharmaSupply Alpha',
        tenantId: tenantAlpha
      } as any);

      await db.purchasesByItem.put({
        id: 'PBI-B-1',
        productId: productA1,
        unitCost: 999.0,
        supplierId: 'SUP-B1',
        supplierName: 'Attacker Foreign Supplier',
        tenantId: tenantBeta
      } as any);

      await db.purchasesByItem.put({
        id: 'PBI-UNBOUND-1',
        productId: productA1,
        unitCost: 888.0,
        supplierId: 'SUP-ROGUE',
        supplierName: 'Rogue Supplier'
      } as any);
    });

    // 1. getAll
    it('Fix 6B.1: getAll returns only same-tenant active products for authenticated session', async () => {
      TokenProvider.setSession({ tenantId: tenantAlpha, branchId: branchAlpha } as any, 'tok', 'ref');
      const products = await ProductRepository.getAll();
      expect(products).toHaveLength(2);
      expect(products.map(p => p.id)).toEqual(expect.arrayContaining([productA1, productA2]));
      expect(products.every(p => p.tenantId === tenantAlpha)).toBe(true);
    });

    it('Fix 6B.2: getAll cross-tenant denial (Tenant Beta sees only Tenant Beta products)', async () => {
      TokenProvider.setSession({ tenantId: tenantBeta, branchId: branchBeta } as any, 'tok', 'ref');
      const products = await ProductRepository.getAll();
      expect(products).toHaveLength(1);
      expect(products[0].id).toBe(productB1);
      expect(products[0].tenantId).toBe(tenantBeta);
    });

    it('Fix 6B.3: getAll fails closed on missing session or conflicting tenantId', async () => {
      TokenProvider.setSession({ tenantId: undefined } as any, 'tok', 'ref');
      expect(await ProductRepository.getAll()).toEqual([]);

      TokenProvider.setSession({ tenantId: tenantAlpha } as any, 'tok', 'ref');
      expect(await ProductRepository.getAll({ tenantId: tenantBeta })).toEqual([]);
    });

    it('Fix 6B.4: getAll excludes unbound products', async () => {
      TokenProvider.setSession({ tenantId: tenantAlpha } as any, 'tok', 'ref');
      const products = await ProductRepository.getAll();
      expect(products.some(p => p.id === productUnbound)).toBe(false);
    });

    // 2. getById
    it('Fix 6B.5: getById returns product when session matches, fails closed otherwise', async () => {
      TokenProvider.setSession({ tenantId: tenantAlpha } as any, 'tok', 'ref');
      const prod = await ProductRepository.getById(productA1);
      expect(prod?.id).toBe(productA1);

      // Cross-tenant denial
      expect(await ProductRepository.getById(productB1)).toBeUndefined();

      // Conflicting tenant
      expect(await ProductRepository.getById(productA1, tenantBeta)).toBeUndefined();

      // Unbound product
      expect(await ProductRepository.getById(productUnbound)).toBeUndefined();

      // Missing session
      TokenProvider.setSession({ tenantId: undefined } as any, 'tok', 'ref');
      expect(await ProductRepository.getById(productA1)).toBeUndefined();
    });

    // 3. getByBarcode
    it('Fix 6B.6: getByBarcode resolves correct tenant record on barcode collision', async () => {
      // Tenant Alpha lookup
      TokenProvider.setSession({ tenantId: tenantAlpha } as any, 'tok', 'ref');
      const prodA = await ProductRepository.getByBarcode(sharedBarcode);
      expect(prodA?.id).toBe(productA1);
      expect(prodA?.tenantId).toBe(tenantAlpha);

      // Tenant Beta lookup
      TokenProvider.setSession({ tenantId: tenantBeta } as any, 'tok', 'ref');
      const prodB = await ProductRepository.getByBarcode(sharedBarcode);
      expect(prodB?.id).toBe(productB1);
      expect(prodB?.tenantId).toBe(tenantBeta);

      // Cross-tenant non-shared barcode
      expect(await ProductRepository.getByBarcode('BAR-A-PARA')).toBeUndefined();

      // Conflicting tenant
      TokenProvider.setSession({ tenantId: tenantAlpha } as any, 'tok', 'ref');
      expect(await ProductRepository.getByBarcode(sharedBarcode, tenantBeta)).toBeUndefined();

      // Unbound barcode
      expect(await ProductRepository.getByBarcode('BAR-UNBOUND')).toBeUndefined();

      // Missing session
      TokenProvider.setSession({ tenantId: undefined } as any, 'tok', 'ref');
      expect(await ProductRepository.getByBarcode(sharedBarcode)).toBeUndefined();
    });

    // 4. search
    it('Fix 6B.7: search returns matches strictly within session tenant context', async () => {
      TokenProvider.setSession({ tenantId: tenantAlpha } as any, 'tok', 'ref');
      const results = await ProductRepository.search('500mg');
      expect(results).toHaveLength(2);
      expect(results.every(p => p.tenantId === tenantAlpha)).toBe(true);

      // Cross-tenant search
      expect(await ProductRepository.search('Ibuprofen')).toHaveLength(0);

      // Conflicting caller tenant
      expect(await ProductRepository.search('Amoxicillin', 50, tenantBeta)).toHaveLength(0);

      // Unbound product search
      expect(await ProductRepository.search('Aspirin')).toHaveLength(0);

      // Missing session
      TokenProvider.setSession({ tenantId: undefined } as any, 'tok', 'ref');
      expect(await ProductRepository.search('Amoxicillin')).toHaveLength(0);
    });

    // 5. calculateCurrentBalance
    it('Fix 6B.8: calculateCurrentBalance sums valid tenant transactions and excludes foreign & unbound', async () => {
      TokenProvider.setSession({ tenantId: tenantAlpha } as any, 'tok', 'ref');
      // ITX-A-1 (+20) + ITX-A-2 (+30) = 50. Foreign (+100) and unbound (+50) excluded.
      expect(await ProductRepository.calculateCurrentBalance(productA1)).toBe(50);

      // Cross-tenant calculation returns 0
      TokenProvider.setSession({ tenantId: tenantBeta } as any, 'tok', 'ref');
      expect(await ProductRepository.calculateCurrentBalance(productA1)).toBe(0);

      // Conflicting tenant returns 0
      TokenProvider.setSession({ tenantId: tenantAlpha } as any, 'tok', 'ref');
      expect(await ProductRepository.calculateCurrentBalance(productA1, tenantBeta)).toBe(0);

      // Unbound product returns 0
      expect(await ProductRepository.calculateCurrentBalance(productUnbound)).toBe(0);

      // Missing session returns 0
      TokenProvider.setSession({ tenantId: undefined } as any, 'tok', 'ref');
      expect(await ProductRepository.calculateCurrentBalance(productA1)).toBe(0);
    });

    // 6. getItemAutoFillDetails
    it('Fix 6B.9: getItemAutoFillDetails uses same-tenant purchases without foreign or unbound leak', async () => {
      TokenProvider.setSession({ tenantId: tenantAlpha } as any, 'tok', 'ref');
      const details = await ProductRepository.getItemAutoFillDetails(productA1);
      expect(details).toBeDefined();
      expect(details?.lastPrice).toBe(22.0); // From PBI-A-1, NOT 999.0 (Beta) or 888.0 (Unbound)
      expect(details?.supplierId).toBe('SUP-A1');
      expect(details?.supplierName).toBe('PharmaSupply Alpha');

      // Cross-tenant denial
      TokenProvider.setSession({ tenantId: tenantBeta } as any, 'tok', 'ref');
      expect(await ProductRepository.getItemAutoFillDetails(productA1)).toBeNull();

      // Conflicting tenant
      TokenProvider.setSession({ tenantId: tenantAlpha } as any, 'tok', 'ref');
      expect(await ProductRepository.getItemAutoFillDetails(productA1, tenantBeta)).toBeNull();

      // Unbound product
      expect(await ProductRepository.getItemAutoFillDetails(productUnbound)).toBeNull();

      // Missing session
      TokenProvider.setSession({ tenantId: undefined } as any, 'tok', 'ref');
      expect(await ProductRepository.getItemAutoFillDetails(productA1)).toBeNull();
    });

    // 7. getExpiringSoon
    it('Fix 6B.10: getExpiringSoon returns only same-tenant products expiring within days', async () => {
      TokenProvider.setSession({ tenantId: tenantAlpha } as any, 'tok', 'ref');
      const expiring = await ProductRepository.getExpiringSoon(30);
      expect(expiring).toHaveLength(1);
      expect(expiring[0].id).toBe(productA1);
      expect(expiring[0].tenantId).toBe(tenantAlpha);

      // Tenant Beta
      TokenProvider.setSession({ tenantId: tenantBeta } as any, 'tok', 'ref');
      const expiringBeta = await ProductRepository.getExpiringSoon(30);
      expect(expiringBeta).toHaveLength(1);
      expect(expiringBeta[0].id).toBe(productB1);
      expect(expiringBeta[0].tenantId).toBe(tenantBeta);

      // Conflicting tenant
      TokenProvider.setSession({ tenantId: tenantAlpha } as any, 'tok', 'ref');
      expect(await ProductRepository.getExpiringSoon(30, tenantBeta)).toEqual([]);

      // Missing session
      TokenProvider.setSession({ tenantId: undefined } as any, 'tok', 'ref');
      expect(await ProductRepository.getExpiringSoon(30)).toEqual([]);
    });

    // 8. Write paths: save and delete
    it('Fix 6B.11: save and delete enforce tenant boundaries and avoid orphaned products', async () => {
      TokenProvider.setSession({ tenantId: tenantAlpha, branchId: branchAlpha } as any, 'tok', 'ref');
      const newProdId = 'PROD-NEW-WRITE';
      await ProductRepository.save({
        id: newProdId,
        name: 'New Product Write Test',
        price: 45,
        stock: 0,
        Is_Active: true
      } as any);

      const saved = await db.products.get(newProdId);
      expect(saved).toBeDefined();
      expect(saved?.tenantId).toBe(tenantAlpha);

      // Save without session throws CANNOT_SAVE
      TokenProvider.setSession({ tenantId: undefined } as any, 'tok', 'ref');
      await expect(ProductRepository.save({
        id: 'PROD-NO-SESS',
        name: 'No Sess',
        price: 10,
        stock: 0
      } as any)).rejects.toThrow(/CANNOT_SAVE/);

      // Save with conflicting tenant throws CANNOT_SAVE
      TokenProvider.setSession({ tenantId: tenantAlpha } as any, 'tok', 'ref');
      await expect(ProductRepository.save({
        id: 'PROD-CONF-SESS',
        name: 'Conf Sess',
        tenantId: tenantBeta,
        price: 10,
        stock: 0
      } as any)).rejects.toThrow(/CANNOT_SAVE/);

      // Delete same-tenant product
      await ProductRepository.delete(productA2);
      const deletedProd = await db.products.get(productA2);
      expect(deletedProd?.is_active).toBe(false);

      // Delete cross-tenant product refused
      await ProductRepository.delete(productB1);
      const foreignProd = await db.products.get(productB1);
      expect(foreignProd?.is_active).not.toBe(false);
    });
  });
});

