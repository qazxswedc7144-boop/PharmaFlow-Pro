import 'fake-indexeddb/auto';
const { getCurrentSession } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(() => ({
    isAuthenticated: true,
    token: 'purchase-sync-test-token',
    tenantId: 'TENANT-PURCHASE-SYNC',
    branchId: 'BRANCH-PURCHASE-SYNC',
    user: { id: 'USER-PURCHASE-SYNC', tenantId: 'TENANT-PURCHASE-SYNC' }
  }))
}));

vi.mock('@/services/auth/tokenProvider', () => ({
  TokenProvider: { getCurrentSession }
}));

import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/core/db';
import { TransactionBoundary } from '@/core/integrity/transactionBoundary';
import { DistributedSyncEngine } from '@features/sync/sync.engine';
import { InvoiceRepository } from '@/database/repositories/invoice.repository';
import { FinancialTransactionRepository } from '@/database/repositories/FinancialTransactionRepository';
import { AccountingEngine } from '@features/accounting/services/AccountingEngine';
import { ProjectionEventBus } from '@/services/system/ProjectionEventBus';
import { purchaseWorkflow } from './PurchaseWorkflow';

const context = (idempotencyKey: string) => ({
  workflowId: 'WF-PURCHASE-SYNC',
  correlationId: 'CORR-PURCHASE-SYNC',
  idempotencyKey,
  tenantId: 'TENANT-PURCHASE-SYNC',
  branchId: 'BRANCH-PURCHASE-SYNC',
  userId: 'USER-PURCHASE-SYNC',
  deviceId: 'DEVICE-PURCHASE-SYNC',
  operationType: 'PURCHASE',
  startedAt: '2026-11-13T00:00:00.000Z'
});

const postedPurchaseInput = (overrides: Record<string, unknown> = {}) => ({
  supplierId: 'مورد نقدي',
  isCash: true,
  invoiceNumber: 'PUR-SYNC-001',
  date: '2026-11-13T00:00:00.000Z',
  items: [{
    productId: 'SERVICE-PURCHASE-1',
    quantity: 1,
    unitPrice: 100,
    isService: true
  }] as any,
  total: 100,
  invoiceStatus: 'POSTED' as const,
  ...overrides
});

describe('PurchaseWorkflow V-30B transactional sync', () => {
  beforeEach(async () => {
    await db.open();
    await (db as any).syncQueue.clear();
    await (db as any).outbox.clear();

    vi.spyOn(InvoiceRepository, 'savePurchase').mockResolvedValue({
      id: 'PUR-LOCAL-001',
      invoiceNumber: 'PUR-SYNC-001',
      totalAmount: 100,
      document_status: 'POSTED'
    } as any);
    vi.spyOn(FinancialTransactionRepository, 'record').mockResolvedValue(undefined as any);
    vi.spyOn(AccountingEngine, 'postInvoice').mockResolvedValue(undefined as any);
    vi.spyOn(ProjectionEventBus, 'publish').mockResolvedValue(undefined as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await (db as any).syncQueue.clear();
    await (db as any).outbox.clear();
  });

  it('declares domain-transaction ownership and both durable sync stores', () => {
    expect((purchaseWorkflow as any).syncHandledInDomainTransaction).toBe(true);
    expect(purchaseWorkflow.tables).toEqual(
      expect.arrayContaining(['syncQueue', 'outbox'])
    );
  });

  it('enqueues a POSTED purchase inside the same Dexie transaction and persists both records', async () => {
    const engine = DistributedSyncEngine.getInstance();
    const originalEnqueue = engine.enqueueWithinTransaction.bind(engine);
    let activeTransaction: any;

    const enqueue = vi.spyOn(engine, 'enqueueWithinTransaction').mockImplementation(
      async (...args: any[]) => {
        activeTransaction = (Dexie as any).currentTransaction;
        return originalEnqueue(...args as Parameters<typeof engine.enqueueWithinTransaction>);
      }
    );

    const ctx = context('PURCHASE-IDEM-POSTED-001');
    const result = await TransactionBoundary.executeAtomic(
      purchaseWorkflow.tables!,
      tx => purchaseWorkflow.executeDomainSteps(postedPurchaseInput() as any, ctx as any, tx)
    );

    expect(result.refId).toBe('PUR-LOCAL-001');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(activeTransaction).toBeTruthy();
    const transactionTables = [
      ...(Array.isArray(activeTransaction.tables)
        ? activeTransaction.tables.map((table: any) => table?.name ?? table)
        : activeTransaction.tables instanceof Map
          ? Array.from(activeTransaction.tables.keys())
          : Object.keys(activeTransaction.tables || {})),
      ...(Array.isArray(activeTransaction.storeNames) ? activeTransaction.storeNames : [])
    ];
    expect(transactionTables).toEqual(expect.arrayContaining(['syncQueue', 'outbox']));

    const queueRow = await (db as any).syncQueue.where('idempotencyKey').equals(ctx.idempotencyKey).first();
    const outboxRow = await (db as any).outbox.where('idempotencyKey').equals(ctx.idempotencyKey).first();
    expect(queueRow).toBeTruthy();
    expect(outboxRow).toBeTruthy();
    expect(queueRow.entityType).toBe('PURCHASE');
    expect(queueRow.payload.id).toBe('PUR-LOCAL-001');
    expect(outboxRow.entityType).toBe('PURCHASE');
    expect(outboxRow.operation).toBe('CREATE');
  });

  it('fails closed and rolls back when enqueue returns without both durable records', async () => {
    const engine = DistributedSyncEngine.getInstance();
    const ctx = context('PURCHASE-IDEM-FAIL-CLOSED-001');
    vi.spyOn(engine, 'enqueueWithinTransaction').mockResolvedValue({
      mutationId: 'MUTATION-WITHOUT-ROWS',
      idempotencyKey: ctx.idempotencyKey
    });

    await expect(
      TransactionBoundary.executeAtomic(
        purchaseWorkflow.tables!,
        tx => purchaseWorkflow.executeDomainSteps(postedPurchaseInput() as any, ctx as any, tx)
      )
    ).rejects.toThrow('PURCHASE_SYNC_DURABILITY_FAILED');

    expect(await (db as any).syncQueue.where('idempotencyKey').equals(ctx.idempotencyKey).count()).toBe(0);
    expect(await (db as any).outbox.where('idempotencyKey').equals(ctx.idempotencyKey).count()).toBe(0);
  });

  it('does not enqueue DRAFT purchases', async () => {
    const engine = DistributedSyncEngine.getInstance();
    const enqueue = vi.spyOn(engine, 'enqueueWithinTransaction');
    const ctx = context('PURCHASE-IDEM-DRAFT-001');

    await TransactionBoundary.executeAtomic(
      purchaseWorkflow.tables!,
      tx => purchaseWorkflow.executeDomainSteps(
        postedPurchaseInput({ invoiceStatus: 'DRAFT' }) as any,
        ctx as any,
        tx
      )
    );

    expect(enqueue).not.toHaveBeenCalled();
    expect(await (db as any).syncQueue.where('idempotencyKey').equals(ctx.idempotencyKey).count()).toBe(0);
    expect(await (db as any).outbox.where('idempotencyKey').equals(ctx.idempotencyKey).count()).toBe(0);
  });

  it('does not enqueue purchase returns through the PURCHASE create contract', async () => {
    const engine = DistributedSyncEngine.getInstance();
    const enqueue = vi.spyOn(engine, 'enqueueWithinTransaction');
    const ctx = context('PURCHASE-IDEM-RETURN-001');

    await TransactionBoundary.executeAtomic(
      purchaseWorkflow.tables!,
      tx => purchaseWorkflow.executeDomainSteps(
        postedPurchaseInput({ isReturn: true }) as any,
        ctx as any,
        tx
      )
    );

    expect(enqueue).not.toHaveBeenCalled();
    expect(await (db as any).syncQueue.where('idempotencyKey').equals(ctx.idempotencyKey).count()).toBe(0);
    expect(await (db as any).outbox.where('idempotencyKey').equals(ctx.idempotencyKey).count()).toBe(0);
  });
});
