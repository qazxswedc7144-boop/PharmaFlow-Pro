-- Preserve distinct immutable audit semantics for distributed locks and replication.
-- IF NOT EXISTS keeps this migration safe if an enum value was provisioned manually.
ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'LOCK_ACQUIRED';
ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'LOCK_RELEASED';
ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'LOCK_EXTENDED';
ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'LOCK_RECOVERY';
ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'REPLICATION_PUBLISHED';
