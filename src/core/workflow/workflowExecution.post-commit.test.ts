import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEmit,
  mockInvalidate,
  mockUpdateStatus,
  mockDelete,
  mockExecuteDomainSteps,
  mockExecuteWithGuard,
} = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  mockInvalidate: vi.fn(),
  mockUpdateStatus: vi.fn(),
  mockDelete: vi.fn(),
  mockExecuteDomainSteps: vi.fn(),
  mockExecuteWithGuard: vi.fn(),
}));

vi.mock('@/core/workflow/workflowAuthorization', () => ({
  WorkflowAuthorization: { authorize: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/core/workflow/workflowValidation', () => ({
  WorkflowValidation: { validate: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/core/workflow/workflowHooks', () => ({
  WorkflowHooksRunner: { runHook: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/core/workflow/workflowEvents', () => ({
  WorkflowEventBus: { emit: mockEmit },
}));

vi.mock('@/core/workflow/workflowRecovery', () => ({
  WorkflowRecovery: { registerFailure: vi.fn().mockResolvedValue('POST-COMMIT-INCIDENT') },
}));

vi.mock('@/core/integrity/executionGuard', () => ({
  ExecutionGuard: {
    executeWithGuard: mockExecuteWithGuard,
  },
}));

vi.mock('@/core/integrity/transactionBoundary', () => ({
  TransactionBoundary: {
    executeAtomic: vi.fn(async (_tables: string[], operation: (tx: unknown) => Promise<unknown>) => operation({})),
  },
}));

vi.mock('@/core/integrity/idempotencyRegistry', () => ({
  IdempotencyRegistry: {
    get: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    updateStatus: mockUpdateStatus,
    delete: mockDelete,
  },
}));

vi.mock('@/services/saas/usageMeterService', () => ({
  UsageMeterService: { invalidate: mockInvalidate },
}));

vi.mock('@/services/system/AuditService', () => ({
  AuditService: { log: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/core/observability', () => ({
  observabilityService: { recordMetric: vi.fn() },
}));

import { WorkflowExecutionPipeline } from '@/core/workflow/workflowExecution';

const context = {
  workflowId: 'workflow-post-commit-test',
  correlationId: 'correlation-post-commit-test',
  idempotencyKey: 'idempotency-post-commit-test',
  tenantId: 'tenant-post-commit-test',
  branchId: 'branch-post-commit-test',
  userId: 'user-post-commit-test',
  deviceId: 'device-post-commit-test',
  operationType: 'POST',
  startedAt: '2026-11-10T00:00:00.000Z',
  metadata: {},
};

const workflow = {
  id: 'POST_COMMIT_TEST',
  name: 'Post-commit test workflow',
  operationType: 'POST',
  tables: ['invoices'],
  executeDomainSteps: mockExecuteDomainSteps,
};

describe('WorkflowExecutionPipeline post-commit guarantees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmit.mockResolvedValue(undefined);
    mockInvalidate.mockImplementation(() => undefined);
    mockUpdateStatus.mockResolvedValue(undefined);
    mockDelete.mockResolvedValue(undefined);
    mockExecuteDomainSteps.mockResolvedValue({ refId: 'invoice-post-commit-test' });
    mockExecuteWithGuard.mockImplementation(async (_options: unknown, operation: () => Promise<unknown>) => operation());
  });

  it('keeps a committed workflow successful when the completion event fails', async () => {
    mockEmit.mockImplementation(async (event: string) => {
      if (event === 'WORKFLOW_COMPLETED') throw new Error('POST_COMMIT_EVENT_FAILED');
    });

    const result = await WorkflowExecutionPipeline.run(workflow as any, {}, context as any);

    expect(mockExecuteDomainSteps).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ refId: 'invoice-post-commit-test' });
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      context.idempotencyKey,
      'COMMITTED',
      { refId: 'invoice-post-commit-test' },
      undefined,
      context.tenantId,
    );
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('does not report transaction failure or delete idempotency when usage-meter invalidation fails', async () => {
    mockInvalidate.mockImplementation(() => {
      throw new Error('USAGE_METER_INVALIDATION_FAILED');
    });

    const result = await WorkflowExecutionPipeline.run(workflow as any, {}, context as any);

    expect(mockExecuteDomainSteps).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ refId: 'invoice-post-commit-test' });
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      context.idempotencyKey,
      'COMMITTED',
      { refId: 'invoice-post-commit-test' },
      undefined,
      context.tenantId,
    );
    expect(mockDelete).not.toHaveBeenCalled();
  });
  it('does not delete or leave idempotency processing when the guard throws after the transaction commits', async () => {
    mockExecuteWithGuard.mockImplementationOnce(async (_options: unknown, operation: () => Promise<unknown>) => {
      await operation();
      throw new Error('EXECUTION_GUARD_POST_COMMIT_FAILED');
    });

    const result = await WorkflowExecutionPipeline.run(workflow as any, {}, context as any);

    expect(mockExecuteDomainSteps).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ refId: 'invoice-post-commit-test' });
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      context.idempotencyKey,
      'COMMITTED',
      { refId: 'invoice-post-commit-test' },
      undefined,
      context.tenantId,
    );
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

