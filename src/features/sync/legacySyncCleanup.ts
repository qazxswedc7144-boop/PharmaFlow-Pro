import { db, getTrustedSyncOwner } from '@/core/db';

export interface TrustedSyncCleanupOwner { tenantId: string; userId: string; }
export interface LegacySyncCleanupSummary {
  scanned: { outbox: number; syncQueue: number };
  deleted: { outbox: number; syncQueue: number };
  skipped: { otherTenant: number; otherUser: number; activePending: number; recent: number };
}
const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function getRecordTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return Number.NaN;
}

export function isLegacySyncRecordRemovable(record: any, owner: TrustedSyncCleanupOwner, cutoff: number, statusField: 'status' | 'syncStatus'): boolean {
  if (!record || record.tenantId !== owner.tenantId) return false;
  if (typeof record.userId !== 'string' || !record.userId.trim()) return true;
  if (record.userId !== owner.userId) return false;
  const status = String(record[statusField] || '').toUpperCase();
  const createdAt = getRecordTimestamp(record.createdAt);
  if (!Number.isFinite(createdAt) || createdAt >= cutoff) return false;
  // Never purge a current user's pending/retrying work based on age alone.
  if (['PENDING', 'RETRY_PENDING', 'RETRYING', 'PROCESSING', 'SENDING'].includes(status)) return false;
  return status === 'FAILED';
}

/** Runs after authentication. Deletes ownerless rows only inside the exact active tenant.
 * Current-user FAILED rows are eligible after 30 days; pending/retry work is preserved.
 */
export async function cleanupLegacyLocalSyncRecords(now: number = Date.now()): Promise<LegacySyncCleanupSummary> {
  const owner = getTrustedSyncOwner();
  if (!owner?.tenantId || !owner?.userId) throw new Error('TRUSTED_USER_CONTEXT_REQUIRED: Legacy sync cleanup requires an authenticated tenant/user owner.');
  if (!db.isOpen()) await db.open();
  const nativeDb = (db as any).backendDB?.();
  if (!nativeDb) throw new Error('LEGACY_SYNC_CLEANUP_UNAVAILABLE: Native IndexedDB handle is unavailable.');
  const cutoff = now - RETENTION_DAYS * DAY_MS;
  const summary: LegacySyncCleanupSummary = {
    scanned: { outbox: 0, syncQueue: 0 }, deleted: { outbox: 0, syncQueue: 0 },
    skipped: { otherTenant: 0, otherUser: 0, activePending: 0, recent: 0 }
  };
  const stores = ['outbox', 'syncQueue'].filter(name => nativeDb.objectStoreNames.contains(name));
  if (!stores.length) return summary;

  await new Promise<void>((resolve, reject) => {
    const tx = nativeDb.transaction(stores, 'readwrite');
    for (const name of stores) {
      const bucket = name as 'outbox' | 'syncQueue';
      const request = tx.objectStore(name).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const currentOwner = getTrustedSyncOwner();
        if (!currentOwner || currentOwner.tenantId !== owner.tenantId || currentOwner.userId !== owner.userId) {
          try { tx.abort(); } catch {}
          return;
        }
        const record = cursor.value;
        summary.scanned[bucket]++;
        const field: 'status' | 'syncStatus' = bucket === 'outbox' ? 'status' : 'syncStatus';
        const status = String(record?.[field] || '').toUpperCase();
        const createdAt = getRecordTimestamp(record?.createdAt);
        if (record?.tenantId !== owner.tenantId) summary.skipped.otherTenant++;
        else if (typeof record?.userId === 'string' && record.userId.trim() && record.userId !== owner.userId) summary.skipped.otherUser++;
        else if (isLegacySyncRecordRemovable(record, owner, cutoff, field)) {
          cursor.delete();
          summary.deleted[bucket]++;
        } else if (record?.userId === owner.userId && ['PENDING','RETRY_PENDING','RETRYING','PROCESSING','SENDING'].includes(status)) {
          summary.skipped.activePending++;
        } else if (!Number.isFinite(createdAt) || createdAt >= cutoff) summary.skipped.recent++;
        cursor.continue();
      };
      request.onerror = () => { try { tx.abort(); } catch {} };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('LEGACY_SYNC_CLEANUP_FAILED'));
    tx.onabort = () => reject(tx.error || new Error('LEGACY_SYNC_CLEANUP_ABORTED'));
  });
  return summary;
}
