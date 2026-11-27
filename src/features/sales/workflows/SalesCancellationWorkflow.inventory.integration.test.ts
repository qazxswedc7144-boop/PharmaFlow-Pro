import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT_ID = 'tenant-cancellation-integration';
const BRANCH_ID = 'branch-cancellation-integration';
const USER_ID = 'user-cancellation-integration';
const PRODUCT_ID = 'product-cancellation-integration';
const INVOICE_ID = 'sale-cancellation-integration';
const WAREHOUSE_ID = 'warehouse-cancellation-integration';
const FIFO_LAYER_ID = 'fifo-layer-cancellation-integration';
const FIFO_LOG_ID = 'fifo-log-cancellation-integration';

const { getCurrentSession, periodSnapshot } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(() => ({
    isAuthenticated: true,
    token: 'cancellation-integration-token',
    tenantId: 'tenant-cancellation-integration',
    branchId: 'branch-cancellation-integration',
    user: {
      id: 'user-cancellation-integration',
      tenantId: 'tenant-cancellation-integration',
      branchId: 'branch-cancellation-integration',
      role: 'admin'
    }
  })),
  periodSnapshot: {
    tenantId: 'tenant-cancellation-integration',
    periodId: 'period-cancellation-integration',
    periodStartMs: Date.parse('2026-01-01T00:00:00.000Z'),
    periodEndMs: Date.parse('2026-12-31T23:59:59.999Z'),
    checkedDateStr: '2026-11-27T00:00:00.000Z',
    isLocked: false,
    verifiedAt: Date.now()
  }
}));

vi.mock('@/services/auth/tokenProvider', () => ({
  TokenProvider: {
    getCurrentSession,
    getAuthHeaders: () => ({})
  }
}));

vi.mock('@/features/sync/device.manager', () => ({
  DeviceManager: {
    getDeviceIdentity: () => ({ deviceId: 'device-cancellation-integration' })
  }
}));

vi.mock('@/services/transactions/PeriodLockEngine', () => ({
  PeriodLockEngine: {
    assertVerifiedPeriodSnapshot: (snapshot: any) => snapshot,
    verifyPeriodForTransaction: vi.fn(async () => periodSnapshot),
    verifyOpenPeriodForTransaction: vi.fn(async () => periodSnapshot)
  }
}));

vi.mock('@/services/system/AuditService', () => ({
  AuditService: { log: vi.fn().mockResolvedValue(undefined) }
}));

vi.mock('@/services/system/ProjectionEventBus', () => ({
  ProjectionEventBus: { publish: vi.fn().mockResolvedValue(undefined) }
}));

import { db } from '@/core/db';
import { salesCancellationWorkflow } from './SalesCancellationWorkflow';

const context = {
  workflowId: 'workflow-cancellation-integration',
  correlationId: 'correlation-cancellation-integration',
  idempotencyKey: 'idempotency-cancellation-integration',
  tenantId: TENANT_ID,
  branchId: BRANCH_ID,
  userId: USER_ID,
  deviceId: 'device-cancellation-integration',
  operationType: 'INVOICE_CANCEL',
  startedAt: '2026-11-27T00:00:00.000Z',
  metadata: {
    verifiedAccountingPeriods: {
      '2026-11-27T00:00:00.000Z': periodSnapshot
    }
  }
} as any;

async function seedCancellationState(includeOriginalMovement: boolean): Promise<void> {
  await db.branches.put({
    id: BRANCH_ID,
    code: BRANCH_ID,
    name: 'Cancellation Integration Branch',
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID,
    isActive: true
  } as any);

  await db.products.put({
    id: PRODUCT_ID,
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID,
    branchId: BRANCH_ID,
    name: 'Cancellation Integration Product',
    stock: 9,
    StockQuantity: 9,
    costPrice: 10,
    CostPrice: 10,
    is_active: true
  } as any);

  await db.warehouseStock.put({
    id: 'warehouse-stock-cancellation-integration',
    warehouseId: WAREHOUSE_ID,
    productId: PRODUCT_ID,
    quantity: 9,
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID,
    branchId: BRANCH_ID
  } as any);

  await db.branchInventory.put({
    id: 'branch-inventory-cancellation-integration',
    branchId: BRANCH_ID,
    productId: PRODUCT_ID,
    stockQuantity: 9,
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID
  } as any);

  await db.invoices.put({
    id: INVOICE_ID,
    type: 'SALE',
    documentStatus: 'POSTED',
    status: 'POSTED',
    InvoiceStatus: 'POSTED',
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
    total: 50,
    items: [{ productId: PRODUCT_ID, quantity: 1, unitPrice: 50, total: 50 }]
  } as any);

  if (!includeOriginalMovement) return;

  await db.inventory_layers.put({
    id: FIFO_LAYER_ID,
    product_id: PRODUCT_ID,
    item_id: PRODUCT_ID,
    quantity_initial: 10,
    quantity_remaining: 9,
    unit_cost: 10,
    reference_id: 'purchase-cancellation-integration',
    purchase_id: 'purchase-cancellation-integration',
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID,
    created_at: '2026-11-20T00:00:00.000Z'
  } as any);

  await db.fifo_consumption_log.put({
    id: FIFO_LOG_ID,
    sale_id: INVOICE_ID,
    invoice_id: INVOICE_ID,
    layer_id: FIFO_LAYER_ID,
    product_id: PRODUCT_ID,
    item_id: PRODUCT_ID,
    quantity_consumed: 1,
    unit_cost: 10,
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID
  } as any);

  await db.inventoryTransactions.put({
    id: 'original-sale-movement-cancellation-integration',
    TransactionID: 'original-sale-movement-cancellation-integration',
    productId: PRODUCT_ID,
    product_id: PRODUCT_ID,
    warehouseId: WAREHOUSE_ID,
    warehouse_id: WAREHOUSE_ID,
    branchId: BRANCH_ID,
    branch_id: BRANCH_ID,
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID,
    SourceDocumentType: 'SALE',
    sourceDocType: 'SALE',
    SourceDocumentID: INVOICE_ID,
    sourceDocId: INVOICE_ID,
    source_doc_id: INVOICE_ID,
    TransactionType: 'SALE',
    transactionType: 'SALE',
    transaction_type: 'SALE',
    QuantityChange: -1,
    quantityChange: -1,
    before_qty: 10,
    after_qty: 9,
    unit_cost: 10,
    unit_price: 50,
    TransactionDate: '2026-11-27T00:00:00.000Z',
    UserID: USER_ID,
    idempotencyKey: 'original-sale-movement-idempotency'
  } as any);
}

async function executeCancellation(): Promise<any> {
  const tables = salesCancellationWorkflow.tables.map((tableName) => db.table(tableName));
  return db.transaction('rw', tables, async (tx) =>
    salesCancellationWorkflow.executeDomainSteps(
      { invoiceId: INVOICE_ID, reason: 'integration test' },
      context,
      tx
    )
  );
}

describe('SalesCancellationWorkflow real Dexie inventory and Outbox integration', () => {
  beforeEach(async () => {
    getCurrentSession.mockClear();
    await db.delete();
    await db.open();
  });

  afterEach(async () => {
    await db.close();
  });

  it('commits stock, FIFO, invoice status, Queue and Outbox as one real Dexie transaction', async () => {
    await seedCancellationState(true);

    const result = await executeCancellation();

    expect(result).toEqual({ success: true, invoiceId: INVOICE_ID });
    expect((await db.invoices.get(INVOICE_ID))?.documentStatus).toBe('CANCELLED');
    expect((await db.products.get(PRODUCT_ID))?.stock).toBe(10);
    expect((await db.warehouseStock.get('warehouse-stock-cancellation-integration'))?.quantity).toBe(10);
    expect((await db.branchInventory.get('branch-inventory-cancellation-integration'))?.stockQuantity).toBe(10);
    expect((await db.inventory_layers.get(FIFO_LAYER_ID))?.quantity_remaining).toBe(10);
    expect(await db.fifo_consumption_log.count()).toBe(0);

    const movements = await db.inventoryTransactions.where('source_doc_id').equals(INVOICE_ID).toArray();
    const reversal = movements.find((movement: any) => movement.TransactionType === 'REVERSAL');
    expect(reversal).toBeTruthy();
    expect(reversal?.reversedMovementId).toBe('original-sale-movement-cancellation-integration');
    expect(reversal?.QuantityChange).toBe(1);

    const queueRows = await db.syncQueue.toArray();
    const outboxRows = await db.outbox.toArray();
    expect(queueRows).toHaveLength(1);
    expect(outboxRows).toHaveLength(1);
    expect(queueRows[0].idempotencyKey).toBe(context.idempotencyKey);
    expect(outboxRows[0].idempotencyKey).toBe(context.idempotencyKey);
    expect(queueRows[0].mutationId).toBe(outboxRows[0].mutationId);
  });

  it('rejects a posted stock invoice with no canonical movement and leaves every record unchanged', async () => {
    await seedCancellationState(false);

    await expect(executeCancellation()).rejects.toThrow('INVENTORY_REVERSAL_INCOMPLETE');

    expect((await db.invoices.get(INVOICE_ID))?.documentStatus).toBe('POSTED');
    expect((await db.products.get(PRODUCT_ID))?.stock).toBe(9);
    expect((await db.warehouseStock.get('warehouse-stock-cancellation-integration'))?.quantity).toBe(9);
    expect((await db.branchInventory.get('branch-inventory-cancellation-integration'))?.stockQuantity).toBe(9);
    expect(await db.inventoryTransactions.count()).toBe(0);
    expect(await db.syncQueue.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('rolls back stock and invoice writes when the Outbox insert fails after Queue insert', async () => {
    await seedCancellationState(true);
    const outboxAdd = vi.spyOn(db.outbox, 'add').mockRejectedValueOnce(new Error('OUTBOX_INSERT_INJECTED_FAILURE'));

    await expect(executeCancellation()).rejects.toThrow('OUTBOX_INSERT_INJECTED_FAILURE');

    outboxAdd.mockRestore();
    expect((await db.invoices.get(INVOICE_ID))?.documentStatus).toBe('POSTED');
    expect((await db.products.get(PRODUCT_ID))?.stock).toBe(9);
    expect((await db.warehouseStock.get('warehouse-stock-cancellation-integration'))?.quantity).toBe(9);
    expect((await db.branchInventory.get('branch-inventory-cancellation-integration'))?.stockQuantity).toBe(9);
    expect((await db.inventory_layers.get(FIFO_LAYER_ID))?.quantity_remaining).toBe(9);
    expect(await db.fifo_consumption_log.count()).toBe(1);
    expect(await db.inventoryTransactions.count()).toBe(1);
    expect(await db.syncQueue.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });
});
