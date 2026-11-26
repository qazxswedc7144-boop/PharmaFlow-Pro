// ==========================================
// FILE: src/features/sync/sync.types.ts
// Phase 8.3 Enterprise Offline-First Sync Types
// ==========================================

export const SYNC_PROTOCOL_VERSION = 1;
export const CLIENT_VERSION = "8.3.0";

export type SyncStatus = 
  | "PENDING" 
  | "PROCESSING" 
  | "COMPLETED" 
  | "FAILED" 
  | "CONFLICT" 
  | "DUPLICATE" 
  | "REJECTED" 
  | "UNAUTHORIZED"
  | "LOCAL_ONLY"
  | "PENDING_SYNC"
  | "SYNCING"
  | "SYNCED"
  | "RETRY_PENDING"
  | "DEAD_LETTER";

export type MutationOperation = "CREATE" | "UPDATE" | "DELETE" | "POST" | "CANCEL" | "ADJUST";

export type SyncConflictCategory =
  | "SAME_RECORD_CONFLICT"
  | "VERSION_CONFLICT"
  | "STOCK_CONFLICT"
  | "ACCOUNTING_CONFLICT"
  | "DUPLICATE_MUTATION"
  | "BRANCH_CONFLICT"
  | "TENANT_CONFLICT"
  | "PERMISSION_CONFLICT"
  | "DELETED_RECORD_CONFLICT"
  | "SCHEMA_VERSION_CONFLICT"
  | "IMMUTABLE_FINANCIAL_CONFLICT"
  | "CONCURRENT_OFFLINE_CONFLICT"
  | "SEQUENCE_GAP_DETECTED";

export type ReportingSyncTag =
  | "LOCAL_UNSYNCED"
  | "SYNCED"
  | "PARTIALLY_SYNCED"
  | "CONFLICTED"
  | "CLOUD_AUTHORITATIVE";

export interface LocalSyncQueueItem {
  id?: number; // Auto-increment from Dexie
  mutationId: string; // Unique UUID
  tenantId?: string;
  branchId?: string | null;
  deviceId: string;
  userId?: string;
  sessionId?: string;
  entityType: string; // "PRODUCT" | "INVENTORY_BATCH" | "INVOICE" | "JOURNAL_ENTRY" | "PAYMENT" | "CUSTOMER" | "SUPPLIER"
  operationType: MutationOperation;
  payload: Record<string, unknown>;
  syncStatus: SyncStatus;
  retryCount: number;
  errorCode?: string;
  lastError?: string;
  idempotencyKey: string;
  version?: number;
  logicalTimestamp: number;
  actorId: string;
  correlationId?: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface LocalSyncEvent {
  id?: number;
  eventId: string;
  sequence: string;
  entityType: string;
  payload: Record<string, unknown>;
  createdAt: Date | string;
}

export interface FailedMutationLog {
  id?: number;
  mutationId: string;
  reason: string;
  conflictCategory?: SyncConflictCategory;
  payload: Record<string, unknown>;
  tenantId?: string;
  branchId?: string | null;
  createdAt: Date | string;
}

export interface SyncConflictRecord {
  id?: number;
  conflictId: string;
  mutationId: string;
  category: SyncConflictCategory;
  entity: string;
  entityId: string;
  message: string;
  clientRecord: Record<string, unknown>;
  serverRecord?: Record<string, unknown> | null;
  status: "OPEN" | "RESOLVED" | "OVERRIDDEN";
  detectedAt: Date | string;
}

export interface NetworkState {
  status: "ONLINE" | "OFFLINE" | "RECONNECTING" | "SYNCING" | "SYNCED" | "PARTIAL" | "ERROR" | "CONFLICT";
  isQueueDraining: boolean;
  lastSyncAt?: number;
  pendingCount?: number;
  lastError?: string | null;
}

export interface DeviceMetadata {
  deviceId: string;
  installationId?: string;
  deviceName: string;
  tenantId: string;
  branchId: string;
  userId: string;
  status: "ACTIVE" | "REVOKED" | "SUSPENDED" | "OFFLINE" | "SYNCING" | "STALE" | "UNKNOWN";
  syncHealth?: "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "STALE";
  lastSyncedSequence?: number;
  lastAcknowledgedSequence?: number;
  versionVector?: Record<string, number>;
  registeredAt?: string;
  lastSeenAt?: string;
}
