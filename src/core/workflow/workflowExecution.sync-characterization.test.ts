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
  mockVerifyOpenPeriod,
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
  mockVerifyOpenPeriod: vi.fn(),
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
vi.mock('@/services/transactions/PeriodLockEngine', () => ({
  PeriodLockEngine: {
    verifyOpenPeriodForTransaction: mockVerifyOpenPeriod
  }
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
import { journalPostingWorkflow } from '@/features/accounting/workflows/JournalPostingWorkflow';
import { inventoryAdjustmentWorkflow } from '@/features/inventory/workflows/InventoryAdjustmentWorkflow';
import { inventoryTransferWorkflow } from '@/features/inventory/workflows/InventoryTransferWorkflow';
import { salesCancellationWorkflow } from '@/features/sales/workflows/SalesCancellationWorkflow';
import { salesReturnWorkflow } from '@/features/returns/workflows/SalesReturnWorkflow';
import { purchaseReturnWorkflow } from '@/features/returns/workflows/PurchaseReturnWorkflow';
import { voucherWorkflow } from '@/features/accounting/workflows/VoucherWorkflow';
import { voucherCancellationWorkflow } from '@/features/accounting/workflows/VoucherCancellationWorkflow';


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
    mockVerifyOpenPeriod.mockResolvedValue({
      tenantId: context.tenantId,
      periodId: 'PERIOD-SYNC-CHAR-001',
      periodStartMs: Date.parse('2026-01-01T00:00:00.000Z'),
      periodEndMs: Date.parse('2026-12-31T23:59:59.999Z'),
      checkedDateStr: context.startedAt,
      isLocked: false,
      verifiedAt: Date.now()
    });
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

  it.each([
    {
      workflow: journalPostingWorkflow,
      expectedEntity: 'ACCOUNTING.JOURNAL.POST',
      expectedOperation: 'JOURNAL_POSTING',
      resultId: 'JE-CHAR-001'
    },
    {
      workflow: inventoryAdjustmentWorkflow,
      expectedEntity: 'INVENTORY.ADJUSTMENT.PROCESS',
      expectedOperation: 'INVENTORY_ADJUSTMENT',
      resultId: 'ADJ-CHAR-001'
    },
    {
      workflow: inventoryTransferWorkflow,
      expectedEntity: 'INVENTORY.TRANSFER.CREATE',
      expectedOperation: 'INVENTORY_TRANSFER',
      resultId: 'TRF-CHAR-001'
    },
    {
      workflow: salesCancellationWorkflow,
      expectedEntity: 'SALES.INVOICE.CANCEL',
      expectedOperation: 'INVOICE_CANCEL',
      resultId: 'CANCEL-CHAR-001'
    },
    {
      workflow: salesReturnWorkflow,
      expectedEntity: 'RETURNS.SALES.PROCESS',
      expectedOperation: 'SALES_RETURN',
      resultId: 'SRET-CHAR-001'
    },
    {
      workflow: purchaseReturnWorkflow,
      expectedEntity: 'RETURNS.PURCHASE.PROCESS',
      expectedOperation: 'PURCHASE_RETURN',
      resultId: 'PRET-CHAR-001'
    }
  ])('uses the real $workflow.id and $workflow.operationType for Generic fallback', async ({
    workflow,
    expectedEntity,
    expectedOperation,
    resultId
  }) => {
    const domainResult = {
      refId: resultId,
      status: 'POSTED',
      syncContractMustNotOverrideFallback: true
    };
    const executeSpy = vi.spyOn(workflow, 'executeDomainSteps').mockResolvedValue(domainResult as never);
    // This suite characterizes Pipeline sync routing/serialization only.
    // WorkflowValidation is isolated at file scope; domain rules remain covered
    // by each workflow's dedicated validation and financial-integrity tests.

    const input = workflow === inventoryAdjustmentWorkflow
      ? { productId: 'PRODUCT-CHAR-001', warehouseId: 'WH-CHAR-001', actualQty: 10, userId: context.userId }
      : { items: [{ productId: 'PRODUCT-CHAR-001', quantity: 1, unitPrice: 1 }], total: 1, date: context.startedAt };

    const result = await WorkflowExecutionPipeline.run(workflow as any, input, context as any);

    expect(result.success).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(mockEnqueueWithinTransaction).not.toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(
      expectedOperation,
      {
        id: resultId,
        refId: resultId,
        status: 'POSTED',
        syncContractMustNotOverrideFallback: true,
        workflowId: context.workflowId,
        operationType: expectedOperation
      },
      expectedEntity,
      context.idempotencyKey,
      { tenantId: context.tenantId, branchId: context.branchId }
    );
    expect(transactionCommitted.value).toBe(true);
  });


  it.each([
    {
      label: 'supplier payment CREATE',
      workflow: voucherWorkflow,
      operation: 'CREATE',
      domainResult: {
        id: 'PYMT-SYNC-CHAR-001',
        voucher: {
          id: 'PYMT-SYNC-CHAR-001',
          voucherId: 'PYMT-SYNC-CHAR-001',
          date: context.startedAt,
          amount: 275,
          type: 'PAYMENT',
          partnerId: 'SUPPLIER-SYNC-CHAR-001',
          notes: 'Supplier payment characterization'
        },
        paymentMethod: 'TRANSFER',
        allocations: [{ invoiceId: 'PUR-SYNC-CHAR-001', amount: 175, note: 'Partial settlement' }]
      },
      expectedPayload: {
        id: 'PYMT-SYNC-CHAR-001',
        paymentNumber: 'PYMT-SYNC-CHAR-001',
        date: context.startedAt,
        amount: 275,
        type: 'PAYMENT',
        partnerType: 'SUPPLIER',
        partnerId: 'SUPPLIER-SYNC-CHAR-001',
        paymentMethod: 'TRANSFER',
        notes: 'Supplier payment characterization',
        allocations: [{ invoiceId: 'PUR-SYNC-CHAR-001', amount: 175, note: 'Partial settlement' }],
        tenantId: context.tenantId,
        branchId: context.branchId
      }
    },
    {
      label: 'customer receipt CREATE',
      workflow: voucherWorkflow,
      operation: 'CREATE',
      domainResult: {
        id: 'RCPT-SYNC-CHAR-001',
        voucher: {
          id: 'RCPT-SYNC-CHAR-001',
          voucherId: 'RCPT-SYNC-CHAR-001',
          date: context.startedAt,
          amount: 125,
          type: 'RECEIPT',
          partnerId: 'CUSTOMER-SYNC-CHAR-001',
          notes: 'Customer receipt characterization'
        },
        paymentMethod: 'CASH',
        allocations: [{ invoiceId: 'SAL-SYNC-CHAR-001', amount: 125 }]
      },
      expectedPayload: {
        id: 'RCPT-SYNC-CHAR-001',
        paymentNumber: 'RCPT-SYNC-CHAR-001',
        date: context.startedAt,
        amount: 125,
        type: 'RECEIPT',
        partnerType: 'CUSTOMER',
        partnerId: 'CUSTOMER-SYNC-CHAR-001',
        paymentMethod: 'CASH',
        notes: 'Customer receipt characterization',
        allocations: [{ invoiceId: 'SAL-SYNC-CHAR-001', amount: 125 }],
        tenantId: context.tenantId,
        branchId: context.branchId
      }
    },
    {
      label: 'supplier payment CANCEL',
      workflow: voucherCancellationWorkflow,
      operation: 'CANCEL',
      domainResult: {
        success: true,
        id: 'PYMT-CANCEL-SYNC-CHAR-001',
        type: 'PAYMENT',
        partnerId: 'SUPPLIER-SYNC-CHAR-001',
        amount: 275,
        reason: 'Supplier payment cancellation characterization'
      },
      expectedPayload: {
        id: 'PYMT-CANCEL-SYNC-CHAR-001',
        type: 'PAYMENT',
        partnerId: 'SUPPLIER-SYNC-CHAR-001',
        amount: 275,
        reason: 'Supplier payment cancellation characterization',
        tenantId: context.tenantId,
        branchId: context.branchId
      }
    },
    {
      label: 'customer receipt CANCEL',
      workflow: voucherCancellationWorkflow,
      operation: 'CANCEL',
      domainResult: {
        success: true,
        id: 'RCPT-CANCEL-SYNC-CHAR-001',
        type: 'RECEIPT',
        partnerId: 'CUSTOMER-SYNC-CHAR-001',
        amount: 125,
        reason: 'Customer receipt cancellation characterization'
      },
      expectedPayload: {
        id: 'RCPT-CANCEL-SYNC-CHAR-001',
        type: 'RECEIPT',
        partnerId: 'CUSTOMER-SYNC-CHAR-001',
        amount: 125,
        reason: 'Customer receipt cancellation characterization',
        tenantId: context.tenantId,
        branchId: context.branchId
      }
    }
  ])('keeps $label on the in-transaction sync path with the exact contract payload', async ({
    workflow,
    operation,
    domainResult,
    expectedPayload
  }) => {
    const contract = (workflow as any).syncContract;
    const executeSpy = vi.spyOn(workflow, 'executeDomainSteps').mockImplementation(async () => {
      await mockEnqueueWithinTransaction(
        contract.operation,
        contract.buildPayload(domainResult, context),
        contract.entityType,
        context.idempotencyKey,
        { tenantId: context.tenantId, branchId: context.branchId }
      );
      return domainResult as never;
    });

    const result = await WorkflowExecutionPipeline.run(workflow as any, {}, context as any);

    expect(result.success).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect((workflow as any).syncHandledInDomainTransaction).toBe(true);
    expect(mockEnqueueWithinTransaction).toHaveBeenCalledTimes(1);
    expect(mockEnqueueWithinTransaction).toHaveBeenCalledWith(
      operation,
      expectedPayload,
      'VOUCHER',
      context.idempotencyKey,
      { tenantId: context.tenantId, branchId: context.branchId }
    );
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockRequestSync).toHaveBeenCalledTimes(1);
    expect(transactionCommitted.value).toBe(true);
  });

});