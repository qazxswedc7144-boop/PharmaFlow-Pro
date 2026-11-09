import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT_ID = 'tenant-sales-atomicity';
const BRANCH_ID = 'branch-sales-atomicity';
const USER_ID = 'user-sales-atomicity';
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

const { getCurrentSession, mockInventoryIssue, mockPostInvoice } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(() => ({
    isAuthenticated: true,
    token: 'sales-atomicity-test-token',
    tenantId: 'tenant-sales-atomicity',
    branchId: 'branch-sales-atomicity',
    user: {
      id: 'user-sales-atomicity',
      tenantId: 'tenant-sales-atomicity',
      branchId: 'branch-sales-atomicity',
      role: 'admin',
    },
  })),
  mockInventoryIssue: vi.fn(),
  mockPostInvoice: vi.fn(),
}));

vi.mock('@/services/auth/tokenProvider', () => ({
  TokenProvider: { getCurrentSession },
}));

vi.mock('@/services/integrity/ValidationService', () => ({
  ValidationService: {
    validateInvoice: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
    validateInvoiceIdUniqueness: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('@/features/sales/services/tenantSalesPolicy.service', () => ({
  TenantSalesPolicyService: {
    getForTenant: vi.fn().mockResolvedValue({
      maxDiscountPercent: '0',
      taxRatePercent: '0',
      taxMode: 'NONE',
    }),
  },
}));

vi.mock('@features/inventory/services/UnifiedInventoryMutationEngine', () => ({
  UnifiedInventoryMutationEngine: {
    getInstance: () => ({
      executeIssueSale: mockInventoryIssue,
    }),
  },
}));

vi.mock('@features/accounting/services/AccountingEngine', () => ({
  AccountingEngine: { postInvoice: mockPostInvoice },
}));

vi.mock('@/services/system/ProjectionEventBus', () => ({
  ProjectionEventBus: { publish: vi.fn().mockResolvedValue(undefined) },
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
  WorkflowRecovery: { registerFailure: vi.fn().mockResolvedValue('INCIDENT-SALES-ATOMICITY') },
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

vi.mock('@features/auth/services/authService', () => ({
  authService: { getCurrentUser: () => ({ User_Email: 'sales-atomicity@test.local' }) },
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: { getState: () => ({ user: null, tenantId: TENANT_ID, branchId: BRANCH_ID }) },
}));

vi.mock('@/features/sync/device.manager', () => ({
  DeviceManager: {
    getDeviceIdentity: () => ({ deviceId: 'device-sales-atomicity' }),
    registerWithServer: vi.fn().mockResolvedValue(undefined),
  },
}));

import { db } from '@/core/db';
import { WorkflowExecutionPipeline } from '@/core/workflow/workflowExecution';
import { salesWorkflow } from '@/features/sales/workflows/SalesWorkflow';
import { DistributedSyncEngine } from '@/features/sync/sync.engine';

const createContext = (suffix: string) => ({
  workflowId: `workflow-sales-atomicity-${suffix}`,
  idempotencyKey: `sale-atomicity-${suffix}`,
  tenantId: TENANT_ID,
  branchId: BRANCH_ID,
  userId: USER_ID,
  startedAt: '2026-11-09T12:00:00.000Z',
  correlationId: `correlation-sales-atomicity-${suffix}`,
  operationType: 'POST',
  metadata: { warehouseId: 'WH-ATOMICITY' },
  permissions: ['sales.create', 'sales.edit'],
} as any);

const createInput = (suffix: string) => ({
  id: `SALE-ATOMICITY-${suffix}`,
  invoiceNumber: `INV-ATOMICITY-${suffix}`,
  isCash: true,
  currency: 'USD',
  total: 100,
  items: [{
    productId: PRODUCT_ID,
    quantity: 1,
    qty: 1,
    price: 100,
    unitPrice: 100,
  }],
});

describe('SalesWorkflow real pipeline atomicity integration', () => {
  beforeEach(async () => {
    getCurrentSession.mockClear();
    mockInventoryIssue.mockReset();
    mockPostInvoice.mockReset();

    await db.delete();
    await db.open();

    await db.products.put({
      id: PRODUCT_ID,
      tenantId: TENANT_ID,
      branchId: BRANCH_ID,
      name: 'Atomicity integration product',
      price: 100,
      CostPrice: 25,
      stock: 10,
    } as any);

    mockInventoryIssue.mockImplementation(async (command: any, tx: any) => {
      await tx.table('inventoryTransactions').add({
        id: `inventory-${command.invoiceId}`,
        invoiceId: command.invoiceId,
        productId: PRODUCT_ID,
        quantity: 1,
        transaction_type: 'SALE',
        tenantId: TENANT_ID,
        branchId: BRANCH_ID,
      });
      return [{ productId: PRODUCT_ID, calculatedCost: 25 }];
    });

    mockPostInvoice.mockImplementation(async (invoice: any, _cost: any, tx: any) => {
      const entryId = `journal-${invoice.id}`;
      await tx.table('journalEntries').add({
        id: entryId,
        sourceId: invoice.id,
        sourceType: 'SALE',
        status: 'Posted',
        TotalAmount: invoice.total,
        tenantId: TENANT_ID,
        branchId: BRANCH_ID,
      });
      await tx.table('journalLines').add({
        id: `line-${invoice.id}`,
        entryId,
        accountId: 'ACC-TEST',
        debit: invoice.total,
        credit: 0,
        tenantId: TENANT_ID,
        branchId: BRANCH_ID,
      });
    });

    const engine = DistributedSyncEngine.getInstance(db);
    vi.spyOn(engine, 'requestSync').mockResolvedValue(undefined);
  });

  it('commits the real SalesWorkflow invoice, inventory, financial, journal, Queue and Outbox writes together', async () => {
    const result = await WorkflowExecutionPipeline.run(
      salesWorkflow,
      createInput('SUCCESS') as any,
      createContext('SUCCESS'),
    );

    expect(result.success).toBe(true);
    expect(result.syncStatus).toBe('ENQUEUED');
    expect(await db.invoices.where('id').equals('SALE-ATOMICITY-SUCCESS').count()).toBe(1);
    expect(await db.sales.where('id').equals('SALE-ATOMICITY-SUCCESS').count()).toBe(1);
    expect(await db.inventoryTransactions.where('id').equals('inventory-SALE-ATOMICITY-SUCCESS').count()).toBe(1);
    expect(await db.financialTransactions.where('Reference_ID').equals('SALE-ATOMICITY-SUCCESS').count()).toBe(1);
    expect(await db.journalEntries.where('id').equals('journal-SALE-ATOMICITY-SUCCESS').count()).toBe(1);
    expect(await db.journalLines.where('id').equals('line-SALE-ATOMICITY-SUCCESS').count()).toBe(1);

    const queueRows = await db.syncQueue.where('idempotencyKey').equals('sale-atomicity-SUCCESS').toArray();
    const outboxRows = await db.outbox.where('idempotencyKey').equals('sale-atomicity-SUCCESS').toArray();
    expect(queueRows).toHaveLength(1);
    expect(outboxRows).toHaveLength(1);
    expect(queueRows[0].mutationId).toBe(outboxRows[0].mutationId);
    expect(outboxRows[0].operation).toBe('POST');
  });

  it('rolls back the real SalesWorkflow invoice, inventory, financial and journal writes when Outbox persistence fails', async () => {
    const outboxAdd = vi.spyOn(db.outbox, 'add').mockRejectedValueOnce(new Error('OUTBOX_WRITE_FAILED'));

    const result = await WorkflowExecutionPipeline.run(
      salesWorkflow,
      createInput('ROLLBACK') as any,
      createContext('ROLLBACK'),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TRANSACTION_FAILED');
    expect(await db.invoices.where('id').equals('SALE-ATOMICITY-ROLLBACK').count()).toBe(0);
    expect(await db.sales.where('id').equals('SALE-ATOMICITY-ROLLBACK').count()).toBe(0);
    expect(await db.inventoryTransactions.where('id').equals('inventory-SALE-ATOMICITY-ROLLBACK').count()).toBe(0);
    expect(await db.financialTransactions.where('Reference_ID').equals('SALE-ATOMICITY-ROLLBACK').count()).toBe(0);
    expect(await db.journalEntries.where('id').equals('journal-SALE-ATOMICITY-ROLLBACK').count()).toBe(0);
    expect(await db.journalLines.where('id').equals('line-SALE-ATOMICITY-ROLLBACK').count()).toBe(0);
    expect(await db.syncQueue.where('idempotencyKey').equals('sale-atomicity-ROLLBACK').count()).toBe(0);
    expect(await db.outbox.where('idempotencyKey').equals('sale-atomicity-ROLLBACK').count()).toBe(0);

    outboxAdd.mockRestore();
  });
});
