import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// 1. الاعتراض الأقوى: محاكاة متجر المصادقة (Auth Store) لإرجاع مستخدم وهمي
vi.mock('@/store/authStore', () => {
  return {
    useAuthStore: {
      getState: () => ({
        user: {
          tenantId: 'test-tenant',
          branchId: 'test-branch',
          userId: 'user-1',
          role: 'admin',
          User_Email: 'test@example.com'
        },
        tenantId: 'test-tenant',
        branchId: 'test-branch',
        isAuthenticated: true
      })
    }
  };
});

// 2. استيراد قاعدة البيانات بعد المحاكاة
import { db } from '@/core/db';
import { InventoryAdjustmentWorkflow } from '../InventoryAdjustmentWorkflow';

describe('InventoryAdjustmentWorkflow - Failure Injection', () => {
  const TENANT = 'test-tenant';
  const BRANCH = 'test-branch';

  beforeEach(async () => {
    await db.inventory.clear();
    await db.products.clear();
    await db.journalEntries.clear();
    await db.journalLines.clear();
    await db.accounts.clear();
    await db.settings.clear();
    await db.systemSettings.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should rollback stock when journal entry creation fails', async () => {
    // 1. Setup initial stock
    await db.products.put({ id: 'prod-1', tenantId: TENANT, branchId: BRANCH, name: 'Test Product', sku: 'SKU-1', price: 10, cost: 5 } as any);
    await db.inventory.put({ id: 'inv-1', tenantId: TENANT, branchId: BRANCH, productId: 'prod-1', quantity: 100, warehouseId: 'wh-1' } as any);

    // 2. Force the database add function to fail
    const spy = vi.spyOn(db.journalEntries, 'add').mockRejectedValue(new Error('FORCED_DB_FAILURE'));

    const workflow = new InventoryAdjustmentWorkflow();
    const input = { productId: 'prod-1', warehouseId: 'wh-1', actualQty: 90, userId: 'user-1', notes: 'test' };
    const ctx = { tenantId: TENANT, branchId: BRANCH, userId: 'user-1', idempotencyKey: 'key-1' } as any;

    // 3. Expect the workflow to throw an error
    await expect(workflow.executeDomainSteps(input, ctx, undefined)).rejects.toThrow();

    // 4. Verify the stock did NOT change (rolled back)
    const product = await db.inventory.get('inv-1');
    expect(product?.quantity).toBe(100);

    spy.mockRestore();
  });
});
