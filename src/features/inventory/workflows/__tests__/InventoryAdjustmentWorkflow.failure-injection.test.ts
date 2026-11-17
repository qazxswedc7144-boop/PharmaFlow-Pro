import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT_ID = 'tenant-adjustment-atomicity';
const BRANCH_ID = 'branch-adjustment-atomicity';
const PRODUCT_ID = 'product-adjustment-atomicity';
const WAREHOUSE_ID = 'WH-MAIN';

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

vi.mock('@/store/authStore', () => ({
  useAuthStore: {
    getState: () => ({
      user: {
        id: 'user-adjustment-atomicity',
        userId: 'user-adjustment-atomicity',
        tenantId: 'tenant-adjustment-atomicity',
        branchId: 'branch-adjustment-atomicity',
        role: 'admin',
      },
      tenantId: 'tenant-adjustment-atomicity',
      branchId: 'branch-adjustment-atomicity',
      isAuthenticated: true,
    }),
  },
}));

vi.mock('@/core/workflow/workflowAuthorization', () => ({
  WorkflowAuthorization: { authorize: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/core/workflow/workflowValidation', () => ({
  WorkflowValidation: {
    validate: vi.fn(async (workflow: any, input: any, ctx: any) => {
      await workflow.validateInput(input);
      await workflow.validateBusinessRules(input, ctx);
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

vi.mock('@/features/sync/sync.engine', () => ({
  DistributedSyncEngine: {
    getInstance: () => ({
      enqueue: vi.fn().mockResolvedValue({ mutationId: 'sync-adjustment-test' }),
      requestSync: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

import { db } from '@/core/db';
import { WorkflowExecutionPipeline } from '@/core/workflow/workflowExecution';
import { InventoryAdjustmentWorkflow } from '../InventoryAdjustmentWorkflow';

type FailurePoint = 'journal-entry' | 'journal-line' | 'account-balance';

function createContext(suffix: string) {
  return {
    workflowId: `workflow-adjustment-${suffix}`,
    idempotencyKey: `adjustment-atomicity-${suffix}`,
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
    userId: 'user-adjustment-atomicity',
    startedAt: '2026-11-17T00:00:00.000Z',
    correlationId: `correlation-adjustment-${suffix}`,
    operationType: 'ADJUST',
    permissions: ['inventory.adjust', 'inventory.manage'],
  } as any;
}

function createInput() {
  return {
    productId: PRODUCT_ID,
    warehouseId: WAREHOUSE_ID,
    actualQty: 12,
    userId: 'user-adjustment-atomicity',
    notes: 'atomicity failure injection',
  };
}

async function seedState() {
  await db.branches.put({
    id: BRANCH_ID,
    code: BRANCH_ID,
    tenantId: TENANT_ID,
    name: 'Atomicity Test Branch',
  } as any);

  await db.products.put({
    id: PRODUCT_ID,
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
    name: 'Atomicity Test Product',
    is_active: true,
    stock: 10,
    StockQuantity: 10,
    CostPrice: 5,
    costPrice: 5,
  } as any);

  await db.warehouseStock.put({
    id: 'warehouse-stock-adjustment-atomicity',
    warehouseId: WAREHOUSE_ID,
    productId: PRODUCT_ID,
    quantity: 10,
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
  } as any);

  await db.branchInventory.put({
    id: `INV-${BRANCH_ID}-${PRODUCT_ID}`,
    branchId: BRANCH_ID,
    productId: PRODUCT_ID,
    stockQuantity: 10,
    tenantId: TENANT_ID,
  } as any);

  await db.accounts.bulkPut([
    { id: 'ACC-102', tenantId: TENANT_ID, name: 'Inventory', balance: 100 },
    { id: 'ACC-401', tenantId: TENANT_ID, name: 'Adjustment Gain', balance: 0 },
  ] as any);
}

async function expectNoPartialCommit() {
  const product = await db.products.get(PRODUCT_ID);
  const warehouse = await db.warehouseStock.get('warehouse-stock-adjustment-atomicity');
  const branchStock = await db.branchInventory.get(`INV-${BRANCH_ID}-${PRODUCT_ID}`);

  expect(product?.stock).toBe(10);
  expect(product?.StockQuantity).toBe(10);
  expect(warehouse?.quantity).toBe(10);
  expect(branchStock?.stockQuantity).toBe(10);
  expect(await db.inventoryTransactions.count()).toBe(0);
  expect(await db.inventory_layers.count()).toBe(0);
  expect(await db.fifo_consumption_log.count()).toBe(0);
  expect(await db.journalEntries.count()).toBe(0);
  expect(await db.journalLines.count()).toBe(0);
  expect((await db.accounts.get('ACC-102'))?.balance).toBe(100);
  expect((await db.accounts.get('ACC-401'))?.balance).toBe(0);
}

describe('InventoryAdjustmentWorkflow atomicity through the real workflow pipeline', () => {
  let cleanupHooks: Array<() => void> = [];

  beforeEach(async () => {
    getCurrentSession.mockClear();
    await db.delete();
    await db.open();
    await seedState();
    cleanupHooks = [];
  });

  afterEach(() => {
    cleanupHooks.forEach((cleanup) => cleanup());
    cleanupHooks = [];
    vi.restoreAllMocks();
  });

  it('commits stock projections, canonical ledger, journal and account balances together', async () => {
    const result = await WorkflowExecutionPipeline.run(
      new InventoryAdjustmentWorkflow(),
      createInput(),
      createContext('success'),
    );

    expect(result.success).toBe(true);
    expect(await db.products.get(PRODUCT_ID)).toMatchObject({ stock: 12, StockQuantity: 12 });
    expect(await db.warehouseStock.get('warehouse-stock-adjustment-atomicity')).toMatchObject({ quantity: 12 });
    expect(await db.branchInventory.get(`INV-${BRANCH_ID}-${PRODUCT_ID}`)).toMatchObject({ stockQuantity: 12 });
    expect(await db.inventoryTransactions.count()).toBe(1);
    expect(await db.inventory_layers.count()).toBe(1);
    expect(await db.journalEntries.count()).toBe(1);
    expect(await db.journalLines.count()).toBe(2);
    expect((await db.accounts.get('ACC-102'))?.balance).toBe(110);
    expect((await db.accounts.get('ACC-401'))?.balance).toBe(-10);
  });

  it.each([
    'journal-entry',
    'journal-line',
    'account-balance',
  ] as const)(
    'rolls back all stock and accounting writes when %s persistence fails',
    async (failurePoint: FailurePoint) => {
      const fail = () => {
        throw new Error(`INJECTED_${failurePoint.toUpperCase().replace(/-/g, '_')}_FAILURE`);
      };

      if (failurePoint === 'journal-entry') {
        db.journalEntries.hook('creating', fail);
        cleanupHooks.push(() => db.journalEntries.hook('creating').unsubscribe(fail));
      } else if (failurePoint === 'journal-line') {
        db.journalLines.hook('creating', fail);
        cleanupHooks.push(() => db.journalLines.hook('creating').unsubscribe(fail));
      } else {
        db.accounts.hook('updating', fail);
        cleanupHooks.push(() => db.accounts.hook('updating').unsubscribe(fail));
      }

      const result = await WorkflowExecutionPipeline.run(
        new InventoryAdjustmentWorkflow(),
        createInput(),
        createContext(failurePoint),
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TRANSACTION_FAILED');
      await expectNoPartialCommit();
    },
  );
});
