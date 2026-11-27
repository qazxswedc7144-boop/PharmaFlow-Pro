import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEmit,
  mockInvalidate,
  mockSave,
  mockUpdateStatus,
  mockDelete,
  mockGet,
  mockExecuteDomainSteps,
  mockExecuteWithGuard,
} = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  mockInvalidate: vi.fn(),
  mockSave: vi.fn(),
  mockUpdateStatus: vi.fn(),
  mockDelete: vi.fn(),
  mockGet: vi.fn(),
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
    isLocked: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('@/core/integrity/transactionBoundary', () => ({
  TransactionBoundary: {
    executeAtomic: vi.fn(async (_tables: string[], operation: (tx: unknown) => Promise<unknown>) => operation({})),
  },
}));

vi.mock('@/core/integrity/idempotencyRegistry', () => ({
  IdempotencyRegistry: {
    get: mockGet,
    save: mockSave,
    updateStatus: mockUpdateStatus,
    delete: mockDelete,
  },
}));

vi.mock('@features/locking/lock.repository', () => ({
  LockRepository: { checkStrict: vi.fn().mockResolvedValue(false) }
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
import { LockRepository } from '@features/locking/lock.repository';

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
    mockSave.mockResolvedValue(undefined);
    mockUpdateStatus.mockResolvedValue(undefined);
    mockDelete.mockResolvedValue(undefined);
    mockGet.mockResolvedValue(undefined);
    vi.mocked(LockRepository.checkStrict).mockResolvedValue(false);
    mockExecuteDomainSteps.mockResolvedValue({ refId: 'invoice-post-commit-test' });
    mockExecuteWithGuard.mockImplementation(async (_options: unknown, operation: () => Promise<unknown>) => operation());
  });

  it('recovers a stale PROCESSING marker when durable domain state proves the workflow committed', async () => {
    const recoveredResult = { refId: 'invoice-recovered-from-durable-state' };
    const reconcileProcessing = vi.fn().mockResolvedValue({
      status: 'COMMITTED',
      result: recoveredResult
    });
    const recoverableWorkflow = { ...workflow, reconcileProcessing };
    mockGet.mockResolvedValueOnce({
      key: context.idempotencyKey,
      status: 'PROCESSING',
      tenantId: context.tenantId,
      branchId: context.branchId,
      createdAt: new Date(Date.now() - 16 * 60 * 1000).toISOString()
    });

    const result = await WorkflowExecutionPipeline.run(
      recoverableWorkflow as any,
      {},
      context as any
    );

    expect(reconcileProcessing).toHaveBeenCalledTimes(1);
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      context.idempotencyKey,
      'COMMITTED',
      recoveredResult,
      undefined,
      context.tenantId
    );
    expect(mockExecuteDomainSteps).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data).toEqual(recoveredResult);
  });

  it('retries a stale PROCESSING marker only after reconciliation proves no domain effects committed', async () => {
    const reconcileProcessing = vi.fn().mockResolvedValue({ status: 'NOT_COMMITTED' });
    const recoverableWorkflow = { ...workflow, reconcileProcessing };
    mockGet.mockResolvedValueOnce({
      key: context.idempotencyKey,
      status: 'PROCESSING',
      tenantId: context.tenantId,
      branchId: context.branchId,
      createdAt: new Date(Date.now() - 16 * 60 * 1000).toISOString()
    });

    const result = await WorkflowExecutionPipeline.run(
      recoverableWorkflow as any,
      {},
      context as any
    );

    expect(reconcileProcessing).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith(context.idempotencyKey, context.tenantId);
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({
      key: context.idempotencyKey,
      status: 'PROCESSING',
      tenantId: context.tenantId,
      branchId: context.branchId
    }));
    expect(mockExecuteDomainSteps).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ refId: 'invoice-post-commit-test' });
  });

  it('does not delete a fresh PROCESSING marker or execute a duplicate workflow', async () => {
    mockGet.mockResolvedValueOnce({
      key: context.idempotencyKey,
      status: 'PROCESSING',
      tenantId: context.tenantId,
      branchId: context.branchId,
      createdAt: new Date().toISOString()
    });
    const reconcileProcessing = vi.fn();
    const recoverableWorkflow = { ...workflow, reconcileProcessing };

    const result = await WorkflowExecutionPipeline.run(
      recoverableWorkflow as any,
      {},
      context as any
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(reconcileProcessing).not.toHaveBeenCalled();
    expect(mockExecuteDomainSteps).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('does not reconcile a stale marker while the distributed lock is active or unverifiable', async () => {
    const reconcileProcessing = vi.fn().mockResolvedValue({
      status: 'COMMITTED',
      result: { refId: 'should-not-be-replayed' }
    });
    const recoverableWorkflow = { ...workflow, reconcileProcessing };
    mockGet.mockResolvedValueOnce({
      key: context.idempotencyKey,
      status: 'PROCESSING',
      tenantId: context.tenantId,
      branchId: context.branchId,
      createdAt: new Date(Date.now() - 16 * 60 * 1000).toISOString()
    });
    vi.mocked(LockRepository.checkStrict).mockResolvedValueOnce(null);

    const result = await WorkflowExecutionPipeline.run(
      recoverableWorkflow as any,
      {},
      context as any
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(reconcileProcessing).not.toHaveBeenCalled();
    expect(mockExecuteDomainSteps).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('preserves an ambiguous stale PROCESSING marker for manual reconciliation', async () => {
    const reconcileProcessing = vi.fn().mockResolvedValue({
      status: 'UNKNOWN',
      reason: 'Partial durable effects require review.'
    });
    const recoverableWorkflow = { ...workflow, reconcileProcessing };
    mockGet.mockResolvedValueOnce({
      key: context.idempotencyKey,
      status: 'PROCESSING',
      tenantId: context.tenantId,
      branchId: context.branchId,
      createdAt: new Date(Date.now() - 16 * 60 * 1000).toISOString()
    });

    const result = await WorkflowExecutionPipeline.run(
      recoverableWorkflow as any,
      {},
      context as any
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    expect(reconcileProcessing).toHaveBeenCalledTimes(1);
    expect(mockExecuteDomainSteps).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('deletes only its own PROCESSING marker after a confirmed domain rollback', async () => {
    mockGet
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        key: context.idempotencyKey,
        status: 'PROCESSING',
        tenantId: context.tenantId,
        branchId: context.branchId
      });
    mockExecuteDomainSteps.mockRejectedValueOnce(new Error('forced domain rollback'));

    const result = await WorkflowExecutionPipeline.run(workflow, {}, context as any);

    expect(result.success).toBe(false);
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({
      key: context.idempotencyKey,
      status: 'PROCESSING'
    }));
    expect(mockDelete).toHaveBeenCalledWith(context.idempotencyKey, context.tenantId);
  });

  it('aborts before domain execution when durable PROCESSING persistence fails', async () => {
    mockSave.mockRejectedValueOnce(new Error('IDEMPOTENCY_DISK_WRITE_FAILED'));

    const result = await WorkflowExecutionPipeline.run(workflow as any, {}, context as any);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('IDEMPOTENCY_PERSISTENCE_FAILED');
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockExecuteDomainSteps).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
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

