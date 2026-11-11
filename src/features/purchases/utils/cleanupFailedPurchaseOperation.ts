import { db } from '@/core/db';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';

/**
 * Removes durable sync/idempotency artifacts only after the purchase workflow
 * has been classified as rolled back (never for COMMITTED or PROCESSING work).
 * Tenant matching is fail-closed because syncQueue/outbox are tenant scoped.
 */
export async function cleanupFailedPurchaseOperation(operationId: string, tenantId?: string): Promise<void> {
  if (!operationId || !tenantId) {
    throw new Error('PURCHASE_OPERATION_CLEANUP_REQUIRES_OPERATION_AND_TENANT');
  }

  await db.transaction('rw', db.syncQueue, db.outbox, async () => {
    const [queueRows, outboxRows] = await Promise.all([
      db.syncQueue.where('idempotencyKey').equals(operationId).toArray(),
      db.outbox.where('idempotencyKey').equals(operationId).toArray()
    ]);

    for (const row of [...queueRows, ...outboxRows]) {
      if (row.tenantId !== tenantId) throw new Error('PURCHASE_OPERATION_CLEANUP_TENANT_MISMATCH');
    }
    for (const row of queueRows) {
      if (row.id == null) throw new Error('PURCHASE_SYNC_QUEUE_ROW_ID_MISSING');
      await db.syncQueue.delete(row.id);
    }
    for (const row of outboxRows) {
      if (row.id == null) throw new Error('PURCHASE_OUTBOX_ROW_ID_MISSING');
      await db.outbox.delete(row.id);
    }
  });

  const idempotencyRecord = await IdempotencyRegistry.get(operationId, tenantId);
  if (idempotencyRecord) {
    if (idempotencyRecord.tenantId !== tenantId) throw new Error('PURCHASE_IDEMPOTENCY_CLEANUP_TENANT_MISMATCH');
    await IdempotencyRegistry.delete(operationId, tenantId);
    if (await IdempotencyRegistry.get(operationId, tenantId)) {
      throw new Error('PURCHASE_IDEMPOTENCY_CLEANUP_VERIFY_FAILED');
    }
  }
}
