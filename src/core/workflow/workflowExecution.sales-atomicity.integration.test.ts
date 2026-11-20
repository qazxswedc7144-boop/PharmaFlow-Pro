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
  observabilityService: { recordMetric: vi.fn(), recordPerformance: vi.fn() },
}));

vi.mock('@features/auth/services/authService', () => ({
  authService: { getCurrentUser: () => ({ User_Email: 'sales-atomicity@test.local' }) },
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: { getState: () => ({ user: null, tenantId: TENANT_ID, branchId: BRANCH_ID, hasPermission: () => false }) },
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
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';
import { observabilityService } from '@/core/observability';

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

  it('replays a committed sale with the same idempotency key without repeating domain writes', async () => {
    const context = createContext('REPLAY');
    const input = createInput('REPLAY');

    const firstResult = await WorkflowExecutionPipeline.run(salesWorkflow, input as any, context);
    expect(firstResult.success).toBe(true);

    const savedMarker = vi.mocked(IdempotencyRegistry.save).mock.calls
      .map(([record]) => record)
      .find((record: any) => record.key === context.idempotencyKey);
    expect(savedMarker).toBeTruthy();

    const committedRecord = {
      ...savedMarker,
      status: 'COMMITTED',
      result: firstResult.data,
      responseData: firstResult.data,
    };

    // SalesWorkflow validation performs one lookup before the pipeline's
    // idempotency check. Return no record there, then the committed marker.
    vi.mocked(IdempotencyRegistry.get)
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce(committedRecord as any);

    const replayResult = await WorkflowExecutionPipeline.run(
      salesWorkflow,
      createInput('REPLAY') as any,
      createContext('REPLAY'),
    );

    expect(replayResult.success).toBe(true);
    expect(replayResult.warnings?.join(' ')).toContain('تم استرجاع النتيجة');
    expect(mockInventoryIssue).toHaveBeenCalledTimes(1);
    expect(mockPostInvoice).toHaveBeenCalledTimes(1);
    expect(await db.invoices.where('id').equals('SALE-ATOMICITY-REPLAY').count()).toBe(1);
    expect(await db.inventoryTransactions.where('id').equals('inventory-SALE-ATOMICITY-REPLAY').count()).toBe(1);
    expect(await db.journalEntries.where('id').equals('journal-SALE-ATOMICITY-REPLAY').count()).toBe(1);
    expect(await db.syncQueue.where('idempotencyKey').equals('sale-atomicity-REPLAY').count()).toBe(1);
    expect(await db.outbox.where('idempotencyKey').equals('sale-atomicity-REPLAY').count()).toBe(1);
  });

  it('does not delete a COMMITTED key when the same key is reused with a different payload', async () => {
    const context = createContext('MISMATCH');
    const firstResult = await WorkflowExecutionPipeline.run(
      salesWorkflow,
      createInput('MISMATCH') as any,
      context,
    );
    expect(firstResult.success).toBe(true);

    const savedMarker = vi.mocked(IdempotencyRegistry.save).mock.calls
      .map(([record]) => record)
      .find((record: any) => record.key === context.idempotencyKey);
    expect(savedMarker).toBeTruthy();
    const committedRecord = {
      ...savedMarker,
      status: 'COMMITTED',
      result: firstResult.data,
      responseData: firstResult.data,
    };

    const changedPayload = createInput('MISMATCH');
    changedPayload.invoiceNumber = 'INV-CHANGED-WITH-SAME-KEY';
    vi.mocked(IdempotencyRegistry.get)
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce(committedRecord as any)
      .mockResolvedValueOnce(committedRecord as any);

    const mismatchResult = await WorkflowExecutionPipeline.run(
      salesWorkflow,
      changedPayload as any,
      createContext('MISMATCH'),
    );

    expect(mismatchResult.success).toBe(false);
    expect(mismatchResult.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(IdempotencyRegistry.delete).not.toHaveBeenCalledWith(context.idempotencyKey, TENANT_ID);
    expect(mockInventoryIssue).toHaveBeenCalledTimes(1);
    expect(await db.invoices.where('id').equals('SALE-ATOMICITY-MISMATCH').count()).toBe(1);
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

  it('BENCHMARK: reports real stage Median/P95 using Dexie and the SalesWorkflow pipeline', async () => {
    const actualModule = await vi.importActual<typeof import('@/core/integrity/idempotencyRegistry')>(
      '@/core/integrity/idempotencyRegistry'
    );
    const actualRegistry = actualModule.IdempotencyRegistry;
    actualRegistry.clearInMemory();
    vi.mocked(IdempotencyRegistry.get).mockImplementation((key, tenantId) => actualRegistry.get(key, tenantId));
    vi.mocked(IdempotencyRegistry.save).mockImplementation(record => actualRegistry.save(record));
    vi.mocked(IdempotencyRegistry.updateStatus).mockImplementation((...args) => actualRegistry.updateStatus(...args));
    vi.mocked(IdempotencyRegistry.delete).mockImplementation((...args) => actualRegistry.delete(...args));

    const warmups = 5;
    const samples = 30;
    let sequence = 0;
    const runOne = async () => {
      sequence += 1;
      const result = await WorkflowExecutionPipeline.run(
        salesWorkflow,
        createInput(`BENCH-${sequence}`) as any,
        createContext(`BENCH-${sequence}`),
      );
      expect(result.success).toBe(true);
    };
    for (let i = 0; i < warmups; i += 1) await runOne();

    const metricRecorder = (observabilityService as any).recordPerformance;
    metricRecorder.mockClear();
    const endToEnd: number[] = [];
    for (let i = 0; i < samples; i += 1) {
      const startedAt = performance.now();
      await runOne();
      endToEnd.push(performance.now() - startedAt);
    }

    const summarize = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      const median = sorted.length % 2
        ? (sorted[middle] ?? 0)
        : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
      return {
        samples: values.length,
        medianMs: Number(median.toFixed(3)),
        p95Ms: Number((sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] || 0).toFixed(3))
      };
    };

    const calls = metricRecorder.mock.calls;
    const report: Record<string, ReturnType<typeof summarize>> = {};
    for (const stage of ['validation', 'idempotency', 'local_commit', 'sync_persistence', 'post_commit']) {
      const values = calls
        .filter(([name, category, , , metadata]) =>
          name === `workflow.stage.${stage}` &&
          category === (stage === 'sync_persistence' ? 'SYNC' : 'FINANCIAL_SAVE') &&
          (metadata as any)?.stage === stage
        )
        .map(([, , duration]) => Number(duration));
      expect(values).toHaveLength(samples);
      report[stage] = summarize(values);
    }
    report.end_to_end = summarize(endToEnd);

    console.info('SALES_SAVE_BENCHMARK ' + JSON.stringify({
      label: process.env.SALES_BENCH_LABEL || 'HEAD',
      runtime: process.version,
      warmups,
      report,
      note: 'Real Dexie IndexedDB transactions and SalesWorkflow; sync_persistence is durable Queue/Outbox write time nested within local_commit. React rendering and remote network round-trip are excluded.'
    }));

    expect(await db.invoices.count()).toBe(samples + warmups);
    expect(await db.syncQueue.count()).toBe(samples + warmups);
    expect(await db.outbox.count()).toBe(samples + warmups);
  });
});
