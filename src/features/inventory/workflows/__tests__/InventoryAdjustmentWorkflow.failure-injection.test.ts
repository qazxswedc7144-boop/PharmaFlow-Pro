import Dexie from 'dexie';
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT_ID = 'tenant-adjustment-atomicity';
const BRANCH_ID = 'branch-adjustment-atomicity';
const USER_ID = 'user-adjustment-atomicity';
const PRODUCT_ID = 'product-adjustment-atomicity';
const WAREHOUSE_ID = 'warehouse-adjustment-atomicity';

const { getCurrentSession } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(() => ({
    isAuthenticated: true,
    token: 'adjustment-atomicity-test-token',
    tenantId: 'tenant-adjustment-atomicity',
    branchId: 'branch-adjustment-atomicity',
    user: {
      id: 'user-adjustment-atomicity',
      tenantId: 'tenant-adjustment-atomicity',
      branchId: 'branch-adjustment-atomicity',
      role: 'admin',
    },
  })),
}));

vi.mock('@/services/auth/tokenProvider', () => ({
  TokenProvider: { getCurrentSession },
}));
vi.mock('@/core/workflow/workflowAuthorization', () => ({
  WorkflowAuthorization: { authorize: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/core/workflow/workflowValidation', () => ({
  WorkflowValidation: {
    validate: vi.fn(async (workflow: any, input: any, ctx: any) => {
      await workflow.validateInput?.(input, ctx);
      await workflow.validateBusinessRules?.(input, ctx);
    }),
  },
}));
vi.mock('@/core/workflow/workflowHooks', () => ({
  WorkflowHooksRunner: { runHook: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/core/workflow/workflowEvents', () => ({
  WorkflowEventBus: { emit: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/core/workflow/workflowRecovery', () => ({
  WorkflowRecovery: { registerFailure: vi.fn().mockResolvedValue('INCIDENT-ADJUSTMENT-ATOMICITY') },
}));
vi.mock('@/core/integrity/executionGuard', () => ({
  ExecutionGuard: {
    executeWithGuard: vi.fn(async (_options: any, operation: () => Promise<unknown>) => operation()),
  },
}));
vi.mock('@/core/integrity/idempotencyRegistry', () => ({
  IdempotencyRegistry: {
    get: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@/services/system/AuditService', () => ({
  AuditService: { log: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/services/saas/usageMeterService', () => ({
  UsageMeterService: { invalidate: vi.fn() },
}));
vi.mock('@/core/observability', () => ({
  observabilityService: { recordMetric: vi.fn() },
}));
vi.mock('@/store/authStore', () => ({
  useAuthStore: {
    getState: () => ({
      user: {
        id: 'user-adjustment-atomicity',
        tenantId: 'tenant-adjustment-atomicity',
        branchId: 'branch-adjustment-atomicity',
        role: 'admin',
        permissions: ['inventory.adjust', 'inventory.manage'],
      },
      tenantId: 'tenant-adjustment-atomicity',
      branchId: 'branch-adjustment-atomicity',
      isAuthenticated: true,
      hasPermission: () => true,
    }),
  },
}));
vi.mock('@features/accounting/services/AccountingEngine', () => ({
  AccountingEngine: {
    getCoreAccount: vi.fn(async (type: string) => ({
      INVENTORY: 'ACC-102',
      SALES_REVENUE: 'ACC-401',
      COGS: 'ACC-501',
    }[type] || '')),
  },
}));
vi.mock('@/services/transactions/PeriodLockEngine', () => ({
  PeriodLockEngine: { isPeriodLocked: vi.fn().mockResolvedValue(false) },
}));

import { db } from '@/core/db';
import { WorkflowExecutionPipeline } from '@/core/workflow/workflowExecution';
import { inventoryAdjustmentWorkflow } from '../InventoryAdjustmentWorkflow';

const createContext = (suffix: string) => ({
  workflowId: `workflow-adjustment-atomicity-${suffix}`,
  correlationId: `correlation-adjustment-atomicity-${suffix}`,
  idempotencyKey: `adjustment-atomicity-${suffix}`,
  tenantId: TENANT_ID,
  branchId: BRANCH_ID,
  userId: USER_ID,
  deviceId: 'device-adjustment-atomicity',
  operationType: 'INVENTORY_ADJUSTMENT',
  startedAt: '2026-11-17T00:00:00.000Z',
});

const createInput = () => ({
  productId: PRODUCT_ID,
  warehouseId: WAREHOUSE_ID,
  actualQty: 110,
  userId: USER_ID,
  notes: 'Atomicity integration test',
});

describe('InventoryAdjustmentWorkflow full-pipeline atomicity', () => {
  beforeEach(async () => {
    getCurrentSession.mockClear();
    await db.delete();
    await db.open();

    await db.branches.put({
      id: BRANCH_ID,
      code: BRANCH_ID,
      name: 'Atomicity test branch',
      tenantId: TENANT_ID,
      isActive: true,
    } as any);

    await db.products.put({
      id: PRODUCT_ID,
      tenantId: TENANT_ID,
      branchId: BRANCH_ID,
      name: 'Atomicity test product',
      stock: 100,
      StockQuantity: 100,
      costPrice: 5,
      CostPrice: 5,
      is_active: true,
    } as any);

    await db.warehouseStock.put({
      id: 'warehouse-stock-adjustment-atomicity',
      warehouseId: WAREHOUSE_ID,
      productId: PRODUCT_ID,
      quantity: 100,
      tenantId: TENANT_ID,
      branchId: BRANCH_ID,
    } as any);

    await db.branchInventory.put({
      id: 'branch-inventory-adjustment-atomicity',
      branchId: BRANCH_ID,
      productId: PRODUCT_ID,
      stockQuantity: 100,
      tenantId: TENANT_ID,
    } as any);

    await db.accounts.bulkPut([
      { id: 'ACC-102', code: '102', name: 'Inventory', balance: 1000, tenantId: TENANT_ID, branchId: BRANCH_ID },
      { id: 'ACC-401', code: '401', name: 'Inventory Adjustment Gain', balance: 0, tenantId: TENANT_ID, branchId: BRANCH_ID },
      { id: 'ACC-501', code: '501', name: 'COGS', balance: 0, tenantId: TENANT_ID, branchId: BRANCH_ID },
    ] as any);
  });

  it('commits inventory projections, canonical movement, FIFO layer and balanced journal in one pipeline transaction', async () => {
    const result = await WorkflowExecutionPipeline.run(
      inventoryAdjustmentWorkflow,
      createInput() as any,
      createContext('SUCCESS') as any,
    );

    expect(result.success).toBe(true);
    const product = await db.products.get(PRODUCT_ID);
    const warehouse = await db.warehouseStock.get('warehouse-stock-adjustment-atomicity');
    const branchInventory = await db.branchInventory.get('branch-inventory-adjustment-atomicity');

    expect(product?.stock).toBe(110);
    expect(product?.StockQuantity).toBe(110);
    expect(warehouse?.quantity).toBe(110);
    expect(branchInventory?.stockQuantity).toBe(110);
    expect(await db.inventoryTransactions.count()).toBe(1);
    expect(await db.inventory_layers.count()).toBe(1);

    const entries = await db.journalEntries.toArray();
    const lines = await db.journalLines.toArray();
    expect(entries).toHaveLength(1);
    expect(lines).toHaveLength(2);
    expect(entries[0].totalDebit).toBe(50);
    expect(entries[0].totalCredit).toBe(50);
    expect(lines.reduce((sum, line) => sum + Number(line.debit || 0), 0)).toBe(50);
    expect(lines.reduce((sum, line) => sum + Number(line.credit || 0), 0)).toBe(50);
    expect((await db.accounts.get('ACC-102'))?.balance).toBe(1050);
    expect((await db.accounts.get('ACC-401'))?.balance).toBe(-50);
  });

  it('rolls back inventory, FIFO, journal and account balances when a journal-line write fails', async () => {
    const tablePrototype = Object.getPrototypeOf(db.journalLines);
    const originalAdd = tablePrototype.add;
    let journalLineWrites = 0;
    const addSpy = vi.spyOn(tablePrototype, 'add').mockImplementation(function (
      this: any,
      item: any,
      key?: any,
    ) {
      if (this.name === 'journalLines') {
        journalLineWrites += 1;
        // Fail the second line: the first line and its account-balance update
        // have already executed inside the same transaction at this point.
        if (journalLineWrites === 2) {
          return Promise.reject(new Error('INJECTED_SECOND_JOURNAL_LINE_FAILURE')) as any;
        }
      }
      return originalAdd.call(this, item, key);
    });

    const result = await WorkflowExecutionPipeline.run(
      inventoryAdjustmentWorkflow,
      createInput() as any,
      createContext('ROLLBACK') as any,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TRANSACTION_FAILED');

    const product = await db.products.get(PRODUCT_ID);
    const warehouse = await db.warehouseStock.get('warehouse-stock-adjustment-atomicity');
    const branchInventory = await db.branchInventory.get('branch-inventory-adjustment-atomicity');

    expect(product?.stock).toBe(100);
    expect(product?.StockQuantity).toBe(100);
    expect(warehouse?.quantity).toBe(100);
    expect(branchInventory?.stockQuantity).toBe(100);
    expect(await db.inventoryTransactions.count()).toBe(0);
    expect(await db.inventory_layers.count()).toBe(0);
    expect(await db.fifo_consumption_log.count()).toBe(0);
    expect(await db.journalEntries.count()).toBe(0);
    expect(await db.journalLines.count()).toBe(0);
    expect((await db.accounts.get('ACC-102'))?.balance).toBe(1000);
    expect((await db.accounts.get('ACC-401'))?.balance).toBe(0);

    addSpy.mockRestore();
  });
});
