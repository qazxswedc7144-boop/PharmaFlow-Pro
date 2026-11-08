// server/modules/sync/sync-audit.service.ts
// Audit Engine for Phase 8.3 Enterprise Synchronization Security

import { SyncAuditEventType, SyncAuditLogRecord } from "./sync.types.js";
import { prisma } from "../../database/prisma.js";

export class SyncAuditService {
  private static auditLogs: SyncAuditLogRecord[] = [];
  private static MAX_LOGS = 2000;

  /**
   * Logs a synchronization security event
   */
  static async logEvent(params: {
    tenantId: string;
    branchId?: string | null;
    userId?: string | null;
    deviceId?: string | null;
    mutationId?: string | null;
    operation: SyncAuditEventType;
    result: "SUCCESS" | "FAILURE" | "WARNING";
    error?: string | null;
    metadata?: Record<string, any>;
  }): Promise<SyncAuditLogRecord> {
    const id = `SAUD-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const timestamp = new Date().toISOString();

    const record: SyncAuditLogRecord = {
      id,
      tenantId: params.tenantId,
      branchId: params.branchId || null,
      userId: params.userId || "system",
      deviceId: params.deviceId || "unknown-device",
      mutationId: params.mutationId || null,
      timestamp,
      operation: params.operation,
      result: params.result,
      error: params.error || null,
      metadata: params.metadata || {}
    };

    this.auditLogs.unshift(record);

    if (this.auditLogs.length > this.MAX_LOGS) {
      this.auditLogs.pop();
    }

    // Persist to Prisma AuditLog when active
    if (prisma.isConnected && prisma.isConnected()) {
      try {
        await prisma.auditLog.create({
          data: {
            action: params.operation === "SYNC_PUSH" ? "UPDATE" : "CREATE",
            entity: "SyncTransaction",
            entityId: params.mutationId || id,
            after: JSON.stringify({
              operation: params.operation,
              result: params.result,
              deviceId: params.deviceId,
              tenantId: params.tenantId,
              branchId: params.branchId,
              error: params.error,
              metadata: params.metadata
            }),
            tenantId: params.tenantId,
            branchId: params.branchId || null,
            userId: params.userId || null,
            timestamp: new Date(timestamp)
          }
        }).catch((err) => {
          console.warn("[SyncAudit] Prisma AuditLog write warning:", err.message);
        });
      } catch (err: any) {
        console.warn("[SyncAudit] Audit persistence warning:", err.message);
      }
    }

    return record;
  }

  /**
   * Retrieves sync audit logs with tenant and branch scoping
   */
  static getLogs(params: {
    tenantId: string;
    branchId?: string | null;
    operation?: SyncAuditEventType;
    limit?: number;
  }): SyncAuditLogRecord[] {
    const limit = Math.min(params.limit || 100, 500);

    return this.auditLogs
      .filter((l) => {
        if (l.tenantId !== params.tenantId) return false;
        if (params.branchId && l.branchId && l.branchId !== params.branchId) return false;
        if (params.operation && l.operation !== params.operation) return false;
        return true;
      })
      .slice(0, limit);
  }
}
