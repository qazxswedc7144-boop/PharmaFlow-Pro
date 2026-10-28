import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/core/db';
import { InventoryService } from '@/features/inventory/services/InventoryService';
import { TokenProvider } from '@/services/auth/tokenProvider';

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
});
