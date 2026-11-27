import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEmit,
  mockSave,
  mockUpdateStatus,
  mockDelete,
  mockExecuteWithGuard,
  mockEnqueue,
  mockEnqueueWithinTransaction,
  mockRequestSync,
  transactionCommitted
} = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  mockSave: vi.fn(),
  mockUpdateStatus: vi.fn(),
  mockDelete: vi.fn(),
  mockExecuteWithGuard: vi.fn(),
  mockEnqueue: vi.fn(),
  mockEnqueueWithinTransaction: vi.fn(),
  mockRequestSync: vi.fn(),
  transactionCommitted: { value: false }
}));

vi.mock('@/core/workflow/workflowAuthorization', () => ({
  WorkflowAuthorization: { authorize: vi.fn().mockResolvedValue(undefined) }
}));
vi.mock('@/core/workflow/workflowValidation', () => ({
  WorkflowValidation: { validate: vi.fn().mockResolvedValue(undefined) }
}));
vi.mock('@/core/workflow/workflowHooks', () => ({
  WorkflowHooksRunner: { runHook: vi.fn().mockResolvedValue(undefined) }
}));
vi.mock('@/core/workflow/workflowEvents', () => ({
  WorkflowEventBus: { emit: mockEmit }
}));
vi.mock('@/core/workflow/workflowRecovery', () => ({
  WorkflowRecovery: { registerFailure: vi.fn().mockResolvedValue('SYNC-CHARACTERIZATION-INCIDENT') }
}));
vi.mock('@/core/integrity/executionGuard', () => ({
  ExecutionGuard: {
    executeWithGuard: mockExecuteWithGuard,
    executeWithLocalGuard: mockExecuteWithGuard
  }
}));
vi.mock('@/core/integrity/transactionBoundary', () => ({
  TransactionBoundary: {
    executeAtomic: vi.fn(async (_tables: string[], operation: (tx: unknown) => Promise<unknown>) => {
      const result = await operation({ table: vi.fn(() => ({})) });
      transactionCommitted.value = true;
      return result;
    })
  }
}));
vi.mock('@/core/integrity/idempotencyRegistry', () => ({
  IdempotencyRegistry: {
    get: vi.fn().mockResolvedValue(undefined),
    save: mockSave,
    updateStatus: mockUpdateStatus,
    delete: mockDelete
  }
}));
vi.mock('@/services/saas/usageMeterService', () => ({
  UsageMeterService: { invalidate: vi.fn() }
}));
vi.mock('@/services/system/AuditService', () => ({
  AuditService: { log: vi.fn().mockResolvedValue(undefined) }
}));
vi.mock('@/core/observability', () => ({
  observabilityService: { recordMetric: vi.fn(), recordPerformance: vi.fn() }
}));
vi.mock('@/features/sync/sync.engine', () => ({
  DistributedSyncEngine: {
    getInstance: () => ({
      enqueue: mockEnqueue,
      enqueueWithinTransaction: mockEnqueueWithinTransaction,
      requestSync: mockRequestSync
    })
  }
}));

import { WorkflowExecutionPipeline } from '@/core/workflow/workflowExecution';

const context = {
  workflowId: 'WF-SYNC-CHAR-001',
  correlationId: 'CORR-SYNC-CHAR-001',
  idempotencyKey: 'IDEM-SYNC-CHAR-001',
  tenantId: 'TENANT-SYNC-CHAR-001',
  branchId: 'BRANCH-SYNC-CHAR-001',
  userId: 'USER-SYNC-CHAR-001',
  deviceId: 'DEVICE-SYNC-CHAR-001',
  operationType: 'CHARACTERIZATION',
  startedAt: '2026-11-27T00:00:00.000Z',
  metadata: {}
};

describe('WorkflowExecutionPipeline sync path characterization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionCommitted.value = false;
    mockEmit.mockResolvedValue(undefined);
    mockSave.mockResolvedValue(undefined);
    mockUpdateStatus.mockResolvedValue(undefined);
    mockDelete.mockResolvedValue(undefined);
    mockExecuteWithGuard.mockImplementation(async (_options: unknown, operation: () => Promise<unknown>) => operation());
    mockEnqueue.mockImplementation(async () => {
      expect(transactionCommitted.value).toBe(true);
      return { mutationId: 'MUT-GENERIC-001', idempotencyKey: context.idempotencyKey };
    });
    mockEnqueueWithinTransaction.mockImplementation(async () => {
      expect(transactionCommitted.value).toBe(false);
      return { mutationId: 'MUT-IN-TX-001', idempotencyKey: context.idempotencyKey };
    });
    mockRequestSync.mockImplementation(async () => {
      expect(transactionCommitted.value).toBe(true);
    });
  });

  it('records the actual Generic fallback arguments after the local transaction commits', async () => {
    const domainResult = { refId: 'DOC-GENERIC-001', amount: 125, status: 'POSTED' };
    const workflow = {
      id: 'generic.document.process',
      name: 'Generic characterization workflow',
      operationType: 'DOCUMENT_POST',
      tables: ['invoices'],
      executeDomainSteps: vi.fn().mockResolvedValue(domainResult)
    };

    const result = await WorkflowExecutionPipeline.run(workflow as any, { source: 'test' }, context as any);

    expect(result.success).toBe(true);
    expect(mockEnqueueWithinTransaction).not.toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(
      'DOCUMENT_POST',
      {
        id: 'DOC-GENERIC-001',
        refId: 'DOC-GENERIC-001',
        amount: 125,
        status: 'POSTED',
        workflowId: context.workflowId,
        operationType: 'DOCUMENT_POST'
      },
      'GENERIC.DOCUMENT.PROCESS',
      context.idempotencyKey,
      { tenantId: context.tenantId, branchId: context.branchId }
    );
    expect(transactionCommitted.value).toBe(true);
  });

  it('does not run Generic fallback for a workflow that owns its in-transaction mutation', async () => {
    const workflow = {
      id: 'INTERNAL.SYNC.PROCESS',
      name: 'Internal sync characterization workflow',
      operationType: 'INTERNAL_POST',
      syncHandledInDomainTransaction: true,
      tables: ['invoices', 'syncQueue', 'outbox'],
      executeDomainSteps: async () => {
        await mockEnqueueWithinTransaction(
          'CREATE',
          { id: 'DOC-INTERNAL-001', tenantId: context.tenantId, branchId: context.branchId },
          'INTERNAL_ENTITY',
          context.idempotencyKey,
          { tenantId: context.tenantId, branchId: context.branchId }
        );
        return { refId: 'DOC-INTERNAL-001' };
      }
    };

    const result = await WorkflowExecutionPipeline.run(workflow as any, {}, context as any);

    expect(result.success).toBe(true);
    expect(mockEnqueueWithinTransaction).toHaveBeenCalledWith(
      'CREATE',
      { id: 'DOC-INTERNAL-001', tenantId: context.tenantId, branchId: context.branchId },
      'INTERNAL_ENTITY',
      context.idempotencyKey,
      { tenantId: context.tenantId, branchId: context.branchId }
    );
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockRequestSync).toHaveBeenCalledTimes(1);
    expect(transactionCommitted.value).toBe(true);
  });

  it('serializes SALE using the strict flat Invoice DTO inside the transaction and dispatches only after commit', async () => {
    const workflow = {
      id: 'SALE',
      name: 'SALE characterization workflow',
      operationType: 'POST',
      tables: ['invoices', 'syncQueue', 'outbox'],
      executeDomainSteps: vi.fn().mockResolvedValue({
        refId: 'SALE-CHAR-001',
        sale: {
          invoiceNumber: 'INV-CHAR-001',
          type: 'SALE',
          partnerId: '11111111-1111-4111-8111-111111111111',
          totalAmount: 150,
          paymentStatus: 'PAID',
          items: [{
            productId: '22222222-2222-4222-8222-222222222222',
            quantity: 2,
            unitPrice: 75
          }]
        }
      })
    };

    const result = await WorkflowExecutionPipeline.run(workflow as any, {}, context as any);

    expect(result.success).toBe(true);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockEnqueueWithinTransaction).toHaveBeenCalledTimes(1);
    const saleEnqueueCall = mockEnqueueWithinTransaction.mock.calls[0];
    expect(saleEnqueueCall).toBeDefined();
    const [operation, payload, entityType, idempotencyKey, options] = saleEnqueueCall!;

    expect(transactionCommitted.value).toBe(true);
    expect(operation).toBe('POST');
    expect(entityType).toBe('SALE');
    expect(idempotencyKey).toBe(context.idempotencyKey);
    expect(options).toEqual({ tenantId: context.tenantId, branchId: context.branchId });
    expect(payload).toEqual(expect.objectContaining({
      invoiceNumber: 'INV-CHAR-001',
      type: 'SALE',
      partnerId: '11111111-1111-4111-8111-111111111111',
      partnerType: 'CUSTOMER',
      totalAmount: 150,
      paymentStatus: 'PAID',
      status: 'DRAFT',
      documentStatus: 'ACTIVE',
      items: [{
        productId: '22222222-2222-4222-8222-222222222222',
        qty: 2,
        price: 75
      }]
    }));
    expect(payload).not.toHaveProperty('tenantId');
    expect(payload).not.toHaveProperty('branchId');
    expect(mockRequestSync).toHaveBeenCalledTimes(1);
  });
});
