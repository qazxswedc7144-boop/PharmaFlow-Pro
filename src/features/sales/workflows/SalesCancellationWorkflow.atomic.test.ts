import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecuteReversal, mockEnqueueWithinTransaction, mockAuditLog, mockPublish, mockReverseFinancial, mockPostAccounting } = vi.hoisted(() => ({
  mockExecuteReversal: vi.fn(),
  mockEnqueueWithinTransaction: vi.fn(),
  mockAuditLog: vi.fn(),
  mockPublish: vi.fn(),
  mockReverseFinancial: vi.fn(),
  mockPostAccounting: vi.fn()
}));

vi.mock('@features/inventory/services/UnifiedInventoryMutationEngine', () => ({
  UnifiedInventoryMutationEngine: {
    getInstance: () => ({ executeReversal: mockExecuteReversal })
  }
}));

vi.mock('@/features/sync/sync.engine', () => ({
  DistributedSyncEngine: {
    getInstance: () => ({ enqueueWithinTransaction: mockEnqueueWithinTransaction })
  }
}));

vi.mock('@/services/system/AuditService', () => ({
  AuditService: { log: mockAuditLog }
}));

vi.mock('@/services/system/ProjectionEventBus', () => ({
  ProjectionEventBus: { publish: mockPublish }
}));

vi.mock('@/database/repositories/FinancialTransactionRepository', () => ({
  FinancialTransactionRepository: { reverseTransactions: mockReverseFinancial }
}));

vi.mock('@features/accounting/services/AccountingEngine', () => ({
  AccountingEngine: { postInvoice: mockPostAccounting }
}));

import { salesCancellationWorkflow } from './SalesCancellationWorkflow';

describe('SalesCancellationWorkflow atomic inventory and sync contract', () => {
  const invoice = {
    id: 'SALE-CANCEL-001',
    type: 'SALE',
    documentStatus: 'POSTED',
    status: 'POSTED',
    total: 240,
    items: [{ productId: 'PRODUCT-001', quantity: 2 }]
  };
  const periodVerification = {
    tenantId: 'TENANT-001',
    periodId: 'PERIOD-2026',
    periodStartMs: Date.parse('2026-01-01T00:00:00.000Z'),
    periodEndMs: Date.parse('2026-12-31T23:59:59.999Z'),
    checkedDateStr: '2026-11-27T00:00:00.000Z',
    isLocked: false,
    verifiedAt: Date.now()
  };
  const ctx = {
    workflowId: 'WF-CANCEL-001',
    correlationId: 'CORR-CANCEL-001',
    idempotencyKey: 'IDEM-CANCEL-001',
    tenantId: 'TENANT-001',
    branchId: 'BRANCH-001',
    userId: 'USER-001',
    deviceId: 'DEVICE-001',
    operationType: 'INVOICE_CANCEL',
    startedAt: '2026-11-27T00:00:00.000Z',
    metadata: { verifiedAccountingPeriods: { '2026-11-27T00:00:00.000Z': periodVerification } }
  };

  let invoicePut: ReturnType<typeof vi.fn>;
  let tx: { table: (name: string) => any };

  beforeEach(() => {
    vi.clearAllMocks();
    invoicePut = vi.fn().mockResolvedValue(invoice.id);
    tx = {
      table: (name: string) => ({
        get: vi.fn().mockImplementation((name: string) =>
          name === 'invoices' ? invoice :
          name === 'financialTransactions' ? { isReversal: true, Entity_Type: 'Customer', Entity_Name: 'عميل نقدي' } :
          undefined
        ),
        put: invoicePut,
        update: vi.fn().mockResolvedValue(1),
        where: vi.fn().mockReturnValue({
          equals: vi.fn().mockReturnValue({
            and: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue([{
                id: 'JE-CANCEL-001',
                sourceType: 'SALE',
                tenantId: ctx.tenantId,
                branchId: ctx.branchId
              }])
            })
          })
        })
      })
    };
    mockExecuteReversal.mockResolvedValue([{ success: true, transactionId: 'REV-001', productId: 'PRODUCT-001', delta: 2 }]);
    mockReverseFinancial.mockResolvedValue({ reversedCount: 1, reversalIds: ['FT-REV-CANCEL-001'] });
    mockPostAccounting.mockResolvedValue(undefined);
    mockEnqueueWithinTransaction.mockResolvedValue({
      mutationId: 'MUT-CANCEL-001',
      idempotencyKey: ctx.idempotencyKey
    });
    mockAuditLog.mockResolvedValue(undefined);
    mockPublish.mockResolvedValue(undefined);
  });

  it('reverses original stock movements and writes cancellation Queue/Outbox inside the supplied transaction', async () => {
    const result = await salesCancellationWorkflow.executeDomainSteps({ invoiceId: invoice.id, reason: 'test' }, ctx as any, tx);

    expect(result).toEqual({ success: true, invoiceId: invoice.id });
    expect(mockExecuteReversal).toHaveBeenCalledWith(expect.objectContaining({
      originalDocumentId: invoice.id,
      originalDocumentType: 'SALE',
      transactionUuid: ctx.idempotencyKey,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      periodVerification
    }), tx);
    expect(mockReverseFinancial).toHaveBeenCalledWith(
      invoice.id,
      tx,
      ctx.idempotencyKey,
      ctx.tenantId,
      ctx.branchId,
      { requireActiveTransaction: true, referenceTable: 'Sales_Invoices' }
    );
    expect(mockPostAccounting).toHaveBeenCalledWith(
      expect.objectContaining({
        id: invoice.id,
        type: 'SALE',
        isReversal: true,
        transactionUuid: ctx.idempotencyKey
      }),
      undefined,
      tx
    );
    expect(invoicePut).toHaveBeenCalledWith(expect.objectContaining({
      id: invoice.id,
      documentStatus: 'CANCELLED',
      status: 'CANCELLED'
    }));
    expect(mockEnqueueWithinTransaction).toHaveBeenCalledWith(
      'INVOICE_CANCEL',
      expect.objectContaining({ id: invoice.id, invoiceId: invoice.id, documentStatus: 'CANCELLED' }),
      'INVOICE',
      ctx.idempotencyKey,
      { tenantId: ctx.tenantId, branchId: ctx.branchId }
    );
  });

  it('fails closed when a posted invoice has no active scoped journal entry', async () => {
    const missingJournalTx = {
      table: (name: string) => ({
        get: vi.fn().mockResolvedValue(name === 'invoices' ? invoice : undefined),
        put: invoicePut,
        update: vi.fn().mockResolvedValue(1),
        where: vi.fn().mockReturnValue({
          equals: vi.fn().mockReturnValue({
            and: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) })
          })
        })
      })
    };

    await expect(
      salesCancellationWorkflow.executeDomainSteps({ invoiceId: invoice.id }, ctx as any, missingJournalTx)
    ).rejects.toThrow('ACCOUNTING_REVERSAL_SOURCE_MISSING');

    expect(mockReverseFinancial).not.toHaveBeenCalled();
    expect(mockPostAccounting).not.toHaveBeenCalled();
    expect(mockExecuteReversal).not.toHaveBeenCalled();
    expect(mockEnqueueWithinTransaction).not.toHaveBeenCalled();
  });

  it('rejects an already-cancelled invoice inside the transaction before any side effects', async () => {
    const cancelledInvoice = { ...invoice, documentStatus: 'CANCELLED', status: 'CANCELLED' };
    const cancelledTx = {
      table: (name: string) => ({
        get: vi.fn().mockResolvedValue(name === 'invoices' ? cancelledInvoice : undefined),
        put: invoicePut
      })
    };

    await expect(
      salesCancellationWorkflow.executeDomainSteps({ invoiceId: invoice.id }, ctx as any, cancelledTx)
    ).rejects.toThrow('INVOICE_ALREADY_CANCELLED');

    expect(mockExecuteReversal).not.toHaveBeenCalled();
    expect(mockEnqueueWithinTransaction).not.toHaveBeenCalled();
    expect(invoicePut).not.toHaveBeenCalled();
  });

  it('aborts cancellation and does not enqueue when inventory reversal fails', async () => {
    mockExecuteReversal.mockRejectedValue(new Error('INVENTORY_REVERSAL_FAILED'));

    await expect(
      salesCancellationWorkflow.executeDomainSteps({ invoiceId: invoice.id }, ctx as any, tx)
    ).rejects.toThrow('INVENTORY_REVERSAL_FAILED');

    expect(invoicePut).not.toHaveBeenCalled();
    expect(mockEnqueueWithinTransaction).not.toHaveBeenCalled();
  });

  it('fails closed when a posted stock-tracked invoice has no reversal movement', async () => {
    mockExecuteReversal.mockResolvedValue([]);

    await expect(
      salesCancellationWorkflow.executeDomainSteps({ invoiceId: invoice.id }, ctx as any, tx)
    ).rejects.toThrow('INVENTORY_REVERSAL_INCOMPLETE');

    expect(invoicePut).not.toHaveBeenCalled();
    expect(mockEnqueueWithinTransaction).not.toHaveBeenCalled();
  });

  it('fails closed when the reversed quantity does not match the posted invoice quantity', async () => {
    mockExecuteReversal.mockResolvedValue([{
      success: true,
      transactionId: 'REV-PARTIAL',
      productId: 'PRODUCT-001',
      delta: 1
    }]);

    await expect(
      salesCancellationWorkflow.executeDomainSteps({ invoiceId: invoice.id }, ctx as any, tx)
    ).rejects.toThrow('INVENTORY_REVERSAL_INCOMPLETE');

    expect(invoicePut).not.toHaveBeenCalled();
    expect(mockEnqueueWithinTransaction).not.toHaveBeenCalled();
  });

  it('allows a posted service-only invoice without inventory reversal movements', async () => {
    const serviceInvoice = {
      ...invoice,
      items: [{ productId: 'SERVICE-001', quantity: 1, isService: true }]
    };
    const serviceTx = {
      table: (name: string) => ({
        get: vi.fn().mockImplementation((name: string) =>
          name === 'invoices' ? serviceInvoice :
          name === 'financialTransactions' ? { isReversal: true, Entity_Type: 'Customer', Entity_Name: 'عميل نقدي' } :
          undefined
        ),
        put: invoicePut,
        update: vi.fn().mockResolvedValue(1),
        where: vi.fn().mockReturnValue({
          equals: vi.fn().mockReturnValue({
            and: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue([{
                id: 'JE-CANCEL-001',
                sourceType: 'SALE',
                tenantId: ctx.tenantId,
                branchId: ctx.branchId
              }])
            })
          })
        })
      })
    };
    mockExecuteReversal.mockResolvedValue([]);

    const result = await salesCancellationWorkflow.executeDomainSteps(
      { invoiceId: invoice.id },
      ctx as any,
      serviceTx
    );

    expect(result).toEqual({ success: true, invoiceId: invoice.id });
    expect(invoicePut).toHaveBeenCalled();
    expect(mockEnqueueWithinTransaction).toHaveBeenCalled();
  });

  it('reverses purchase stock with the opposite quantity sign and updates the legacy purchase row', async () => {
    const purchaseInvoice = {
      ...invoice,
      type: 'PURCHASE',
      items: [{ productId: 'PRODUCT-001', quantity: 2 }],
      paymentStatus: 'Cash'
    };
    const purchaseUpdate = vi.fn().mockResolvedValue(1);
    const purchaseTx = {
      table: (name: string) => ({
        get: vi.fn().mockImplementation((key: string) => {
          if (name === 'invoices' || name === 'purchases') return purchaseInvoice;
          if (name === 'financialTransactions') {
            return { isReversal: true, Entity_Type: 'Supplier', Entity_Name: 'مورد نقدي' };
          }
          return undefined;
        }),
        put: invoicePut,
        update: purchaseUpdate,
        where: vi.fn().mockReturnValue({
          equals: vi.fn().mockReturnValue({
            and: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue([{
                id: 'JE-PURCHASE-001',
                sourceType: 'PURCHASE',
                tenantId: ctx.tenantId,
                branchId: ctx.branchId
              }])
            })
          })
        })
      })
    };
    mockExecuteReversal.mockResolvedValue([{
      success: true,
      transactionId: 'REV-PURCHASE-001',
      productId: 'PRODUCT-001',
      delta: -2
    }]);

    const result = await salesCancellationWorkflow.executeDomainSteps(
      { invoiceId: invoice.id },
      ctx as any,
      purchaseTx
    );

    expect(result).toEqual({ success: true, invoiceId: invoice.id });
    expect(mockExecuteReversal).toHaveBeenCalledWith(
      expect.objectContaining({ originalDocumentType: 'PURCHASE' }),
      purchaseTx
    );
    expect(mockReverseFinancial).toHaveBeenCalledWith(
      invoice.id,
      purchaseTx,
      ctx.idempotencyKey,
      ctx.tenantId,
      ctx.branchId,
      { requireActiveTransaction: true, referenceTable: 'Purchase_Invoices' }
    );
    expect(mockPostAccounting).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'PURCHASE', isReversal: true }),
      undefined,
      purchaseTx
    );
    expect(purchaseUpdate).toHaveBeenCalledWith(invoice.id, expect.objectContaining({
      invoiceStatus: 'CANCELLED',
      status: 'CANCELLED'
    }));
  });

  it('uses the inverse stock sign when cancelling a posted sales return', async () => {
    const returnInvoice = { ...invoice, isReturn: true };
    const returnTx = {
      table: (name: string) => ({
        get: vi.fn().mockImplementation((key: string) =>
          name === 'invoices' ? returnInvoice :
          name === 'financialTransactions' ? { isReversal: true, Entity_Type: 'Customer', Entity_Name: 'عميل نقدي' } :
          undefined
        ),
        put: invoicePut,
        update: vi.fn().mockResolvedValue(1),
        where: vi.fn().mockReturnValue({
          equals: vi.fn().mockReturnValue({
            and: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue([{
                id: 'JE-RETURN-001',
                sourceType: 'SALE_RETURN',
                tenantId: ctx.tenantId,
                branchId: ctx.branchId
              }])
            })
          })
        })
      })
    };
    mockExecuteReversal.mockResolvedValue([{
      success: true,
      transactionId: 'REV-RETURN-001',
      productId: 'PRODUCT-001',
      delta: -2
    }]);

    const result = await salesCancellationWorkflow.executeDomainSteps(
      { invoiceId: invoice.id },
      ctx as any,
      returnTx
    );

    expect(result).toEqual({ success: true, invoiceId: invoice.id });
    expect(mockExecuteReversal).toHaveBeenCalledWith(
      expect.objectContaining({ originalDocumentType: 'SALE_RETURN' }),
      returnTx
    );
  });

  it('propagates Queue/Outbox failure so the surrounding transaction can roll back', async () => {
    mockEnqueueWithinTransaction.mockRejectedValue(new Error('SYNC_OUTBOX_REQUIRED'));

    await expect(
      salesCancellationWorkflow.executeDomainSteps({ invoiceId: invoice.id }, ctx as any, tx)
    ).rejects.toThrow('SYNC_OUTBOX_REQUIRED');
  });

  it('rejects execution without an active transaction', async () => {
    await expect(
      salesCancellationWorkflow.executeDomainSteps({ invoiceId: invoice.id }, ctx as any)
    ).rejects.toThrow('TRANSACTION_REQUIRED');
  });
});
