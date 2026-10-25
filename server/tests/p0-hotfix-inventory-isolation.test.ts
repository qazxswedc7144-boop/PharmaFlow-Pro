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

    await InventoryService.updateStock(productId, -5);
    
    const product = await db.products.get(productId);
    expect(product?.stock).toBe(95);

    const tx = await db.inventoryTransactions.toArray();
    expect(tx[0].tenantId).toBe('REAL-ACC-999');
    expect(tx[0].branchId).toBe('REAL-BR-999');
  });
});
