// server/modules/sync/sync.types.ts
// PharmaFlow PRO ERP - Phase 8.3 Enterprise Synchronization Architecture

export const SYNC_PROTOCOL_VERSION = 1;
export const CLIENT_VERSION = "8.3.0";

export type DeviceStatus = "ACTIVE" | "REVOKED" | "SUSPENDED" | "OFFLINE" | "SYNCING" | "STALE" | "UNKNOWN";
export type DeviceSyncHealth = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "STALE";

export interface VersionVector {
  [deviceId: string]: number;
}

export interface DeviceIdentity {
  deviceId: string;
  installationId?: string;
  deviceName: string;
  tenantId: string;
  branchId: string;
  userId: string;
  lastSeenAt: Date | string;
  lastSeen?: string;
  appVersion: string;
  schemaVersion: number;
  status: DeviceStatus;
  syncHealth?: DeviceSyncHealth;
  lastSyncedSequence?: number;
  lastAcknowledgedSequence?: number;
  versionVector?: VersionVector;
  registeredAt?: Date | string;
  revokedAt?: Date | string | null;
  revocationReason?: string | null;
}

export type ConflictClassificationCategory =
  | "METADATA_MUTABLE"
  | "INVENTORY_EVENT"
  | "FINANCIAL_TRANSACTION";

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

export interface SequenceGapInfo {
  expectedNextCursor: number;
  receivedCursor: number;
  missingCursors: number[];
  detectedAt: string;
}

export type SyncMutationStatus =
  | "SUCCESS"
  | "DUPLICATE"
  | "CONFLICT"
  | "REJECTED"
  | "FAILED"
  | "RETRY"
  | "INVALID"
  | "UNAUTHORIZED";

export type SyncAuditEventType =
  | "SYNC_PUSH"
  | "SYNC_PULL"
  | "SYNC_REJECTED"
  | "SYNC_CONFLICT"
  | "SYNC_DUPLICATE"
  | "DEVICE_REGISTERED"
  | "DEVICE_REVOKED"
  | "DEVICE_SUSPENDED"
  | "TENANT_MISMATCH"
  | "BRANCH_MISMATCH"
  | "PERMISSION_DENIED"
  | "SCHEMA_VERSION_REJECTED"
  | "COMPENSATING_TRANSACTION_CREATED"
  | "CROSS_TENANT_MUTATION_BLOCKED";

export type ReportingSyncTag =
  | "LOCAL_UNSYNCED"
  | "SYNCED"
  | "PARTIALLY_SYNCED"
  | "CONFLICTED"
  | "CLOUD_AUTHORITATIVE";

export interface SyncMutation {
  id: string; // mutationId
  entity: string; // e.g. "PRODUCT" | "INVOICE" | "PAYMENT" | "JOURNAL_ENTRY" | "INVENTORY_MOVEMENT" | "CUSTOMER" | "SUPPLIER" | "BRANCH_TRANSFER"
  entityId: string;
  operation: "CREATE" | "UPDATE" | "DELETE" | "POST" | "CANCEL" | "ADJUST";
  payload: Record<string, any>;
  version?: number;
  idempotencyKey: string;
  timestamp: string | number;
  branchId?: string | null;
  actorId?: string;
}

export interface SyncEnvelope {
  tenantId: string;
  branchId: string;
  userId: string;
  deviceId: string;
  mutationId?: string;
  idempotencyKey?: string;
  timestamp: string | number;
  schemaVersion: number;
  clientVersion: string;
  signature?: string;
  mutations: SyncMutation[];
}

export interface SyncEffect {
  entity: string;
  entityId: string;
  operation: "CREATE" | "UPDATE" | "DELETE" | "POST" | "CANCEL" | "ADJUST";
  payload: Record<string, any>;
}

export interface PerMutationResult {
  id?: string;
  mutationId: string;
  status: SyncMutationStatus;
  success?: boolean;
  errorCode?: string;
  error?: string;
  serverVersion?: number;
  conflict?: {
    category: SyncConflictCategory;
    message: string;
    serverRecord?: Record<string, any> | null;
    clientRecord?: Record<string, any> | null;
    resolutionStrategy?: "SERVER_WINS" | "CLIENT_WINS" | "MANUAL_MERGE" | "RETRY_WITH_NEW_VERSION" | "OPTIMISTIC_MERGE";
  } | null;
  message?: string;
  processedAt?: string;
  details?: any;
  effects?: SyncEffect[];
}

export interface SyncPushResponse {
  success: boolean;
  errorCode?: string;
  error?: string;
  message?: string;
  tenantId: string;
  branchId?: string | null;
  serverTimestamp: number;
  processedCount: number;
  results: PerMutationResult[];
  summary: {
    applied?: string[];
    successful: string[];
    duplicates: string[];
    conflicts: string[];
    rejected: string[];
    unauthorized: string[];
  };
}

export interface SyncChange {
  id: string;
  tenantId: string;
  branchId: string | null;
  entity: string;
  entityId: string;
  operation: "CREATE" | "UPDATE" | "DELETE" | "POST" | "CANCEL" | "ADJUST";
  version: number;
  mutationId: string;
  createdAt: string;
  actorId: string;
  deviceId: string;
  payload: Record<string, any>;
  cursor: number;
}

export interface SyncPullRequest {
  cursor?: number | string;
  batchSize?: number;
  entities?: string[];
  lastSyncTimestamp?: string | number;
  branchId?: string | null;
  tenantId?: string;
}

export interface SyncPullResponse {
  success: boolean;
  tenantId: string;
  branchId: string | null;
  cursor: number;
  nextCursor: number;
  hasMore: boolean;
  serverTimestamp: number;
  changes: SyncChange[];
  activeReservationsCount?: number;
}

export interface SyncAuditLogRecord {
  id: string;
  tenantId: string;
  branchId: string | null;
  userId: string;
  deviceId: string;
  mutationId: string | null;
  timestamp: string;
  operation: SyncAuditEventType;
  result: "SUCCESS" | "FAILURE" | "WARNING";
  error: string | null;
  metadata: Record<string, any>;
}
