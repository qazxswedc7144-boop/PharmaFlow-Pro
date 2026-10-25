// server/modules/sync/sync.router.ts
// Enterprise Synchronization REST Router for Phase 8.3

import { Router, Request, Response } from "express";
import { authenticateToken, AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { tenantContextMiddleware } from "../../middleware/tenant.middleware.js";
import { SyncProcessorService } from "./sync-processor.service.js";
import { SyncChangelogService } from "./sync-changelog.service.js";
import { DeviceService } from "./device.service.js";
import { SyncConflictService } from "./sync-conflict.service.js";
import { SyncAuditService } from "./sync-audit.service.js";
import { SyncMetricsService } from "./sync-metrics.service.js";
import { SyncFinancialIntegrityService } from "./sync-financial-integrity.service.js";
import { CompensatingTransactionService } from "./compensating-transaction.service.js";
import { SyncEnvelope, SyncPullRequest, SYNC_PROTOCOL_VERSION } from "./sync.types.js";
import { prisma } from "../../database/prisma.js";

export const syncRouter = Router();

// Apply authentication and tenant isolation context middleware
syncRouter.use(authenticateToken);
syncRouter.use(tenantContextMiddleware);

/**
 * GET /status (or /api/v1/sync/status)
 * Dynamic health and pipeline diagnostics for the synchronization engine.
 */
syncRouter.get("/status", async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId || tenantId === "default-tenant" || tenantId === "TEN-DEV-001") {
       res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
       return;
    }
    const currentCursor = SyncChangelogService.getCurrentCursor();
    const openConflicts = SyncConflictService.getConflicts(tenantId).length;
    const metrics = SyncMetricsService.getMetrics(tenantId);

    res.status(200).json({
      status: "healthy",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      timestamp: Date.now(),
      tenantId,
      connections: {
        database: prisma.isConnected && prisma.isConnected() ? "CONNECTED" : "FALLBACK",
        syncQueue: "ACTIVE",
        changeLog: "ACTIVE"
      },
      metrics: {
        currentCursor,
        openConflicts,
        systemLatency: "OK",
        mutationsProcessed: metrics.mutationsProcessed,
        duplicatesCount: metrics.duplicatesCount,
        conflictsCount: metrics.conflictsCount,
        lastSuccessfulSync: metrics.lastSuccessfulSync
      }
    });
  } catch (error: any) {
    res.status(500).json({ status: "error", error: error.message });
  }
});

/**
 * GET /metrics
 * Structured synchronization metrics and observability
 */
syncRouter.get("/metrics", async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId || tenantId === "default-tenant" || tenantId === "TEN-DEV-001") {
       res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
       return;
    }
    const snapshot = SyncMetricsService.getMetrics(tenantId);

    res.status(200).json({
      success: true,
      data: snapshot
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /push (or /api/v1/sync/push)
 * Batch processing of mutations with strict tenant, branch, device, idempotency, and RBAC enforcement.
 */
syncRouter.post("/push", async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  const authReq = req as AuthenticatedRequest;
  const authenticatedTenantId = authReq.user?.tenantId;
  if (!authenticatedTenantId || authenticatedTenantId === "default-tenant" || authenticatedTenantId === "TEN-DEV-001") {
     res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
     return;
  }
  const authenticatedUserId = authReq.user?.userId || "system";
  const authenticatedUserRole = authReq.user?.role as string | undefined;

  try {
    const rawBody = req.body || {};
    const rawBytes = JSON.stringify(rawBody).length;
    
    // Normalize into SyncEnvelope structure
    const envelope: SyncEnvelope = {
      // Normalize into SyncEnvelope structure
      tenantId: authenticatedTenantId,
      branchId: rawBody.branchId || req.headers["x-branch-id"],
      userId: rawBody.userId || authenticatedUserId,
      deviceId: rawBody.deviceId || (req.headers["x-device-id"] as string) || "unidentified-device",
      idempotencyKey: rawBody.idempotencyKey || (req.headers["idempotency-key"] as string),
      timestamp: rawBody.timestamp || Date.now(),
      schemaVersion: rawBody.schemaVersion || SYNC_PROTOCOL_VERSION,
      clientVersion: rawBody.clientVersion || "8.3.0",
      mutations: Array.isArray(rawBody.mutations) ? rawBody.mutations : []
    };

    const response = await SyncProcessorService.processBatch({
      envelope,
      authenticatedTenantId,
      authenticatedUserId,
      authenticatedUserRole
    });

    const durationMs = Date.now() - startTime;
    SyncMetricsService.recordPushMetrics({
      tenantId: authenticatedTenantId,
      durationMs,
      processedCount: response.processedCount,
      failedCount: response.summary.rejected.length + response.summary.unauthorized.length,
      duplicateCount: response.summary.duplicates.length,
      conflictCount: response.summary.conflicts.length,
      payloadBytes: rawBytes,
      success: response.success
    });

    res.status(response.success ? 200 : 400).json(response);
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    SyncMetricsService.recordPushMetrics({
      tenantId: authenticatedTenantId,
      durationMs,
      processedCount: 0,
      failedCount: 1,
      duplicateCount: 0,
      conflictCount: 0,
      payloadBytes: 0,
      success: false,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: error.message || "Internal sync processing error"
    });
  }
});

/**
 * POST /pull & GET /pull
 * Incremental, cursor-based delta synchronization pulling downstream updates isolated by tenant & branch.
 */
const handlePull = async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  const authReq = req as AuthenticatedRequest;
  const authenticatedTenantId = authReq.user?.tenantId;
  if (!authenticatedTenantId || authenticatedTenantId === "default-tenant" || authenticatedTenantId === "TEN-DEV-001") {
     res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
     return;
  }

  try {
    const bodyOrQuery = req.method === "GET" ? req.query : req.body;
    const pullRequest: SyncPullRequest = {
      cursor: bodyOrQuery.cursor,
      batchSize: bodyOrQuery.batchSize ? parseInt(String(bodyOrQuery.batchSize), 10) : 100,
      entities: bodyOrQuery.entities ? (Array.isArray(bodyOrQuery.entities) ? bodyOrQuery.entities : [String(bodyOrQuery.entities)]) : undefined,
      lastSyncTimestamp: bodyOrQuery.lastSyncTimestamp,
      branchId: bodyOrQuery.branchId || (req.headers["x-branch-id"] as string) || null,
      tenantId: authenticatedTenantId
    };

    // 1. Fetch from changelog service with strict tenant and branch isolation
    const changelogDelta = await SyncChangelogService.getChangesSince({
      tenantId: authenticatedTenantId,
      branchId: pullRequest.branchId,
      cursor: pullRequest.cursor,
      batchSize: pullRequest.batchSize,
      entities: pullRequest.entities
    });

    // 2. Also fetch updated products and invoices from Prisma if DB connected
    let dbProducts: any[] = [];
    let dbInvoices: any[] = [];

    if (prisma.isConnected && prisma.isConnected()) {
      const sinceTime = pullRequest.lastSyncTimestamp ? new Date(pullRequest.lastSyncTimestamp) : new Date(0);

      const productWhere: any = { updatedAt: { gt: sinceTime }, tenantId: authenticatedTenantId };
      const invoiceWhere: any = { createdAt: { gt: sinceTime }, tenantId: authenticatedTenantId };
      if (pullRequest.branchId) {
        invoiceWhere.branchId = pullRequest.branchId;
      }

      dbProducts = await prisma.product.findMany({ where: productWhere, take: 50 }).catch(() => []);
      dbInvoices = await prisma.invoice.findMany({ where: invoiceWhere, take: 50 }).catch(() => []);
    }

    await SyncAuditService.logEvent({
      tenantId: authenticatedTenantId,
      branchId: pullRequest.branchId,
      userId: authReq.user?.userId,
      deviceId: req.headers["x-device-id"] as string,
      operation: "SYNC_PULL",
      result: "SUCCESS",
      metadata: {
        cursor: pullRequest.cursor,
        nextCursor: changelogDelta.nextCursor,
        returnedChangesCount: changelogDelta.changes.length
      }
    });

    const responsePayload = {
      success: true,
      tenantId: authenticatedTenantId,
      branchId: pullRequest.branchId,
      cursor: changelogDelta.cursor,
      nextCursor: changelogDelta.nextCursor,
      hasMore: changelogDelta.hasMore,
      serverTimestamp: Date.now(),
      changes: changelogDelta.changes,
      delta: {
        products: dbProducts,
        invoices: dbInvoices
      }
    };

    const durationMs = Date.now() - startTime;
    SyncMetricsService.recordPullMetrics({
      tenantId: authenticatedTenantId,
      durationMs,
      changesReturned: changelogDelta.changes.length,
      responseBytes: JSON.stringify(responsePayload).length,
      success: true
    });

    res.status(200).json(responsePayload);
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    SyncMetricsService.recordPullMetrics({
      tenantId: authenticatedTenantId,
      durationMs,
      changesReturned: 0,
      responseBytes: 0,
      success: false,
      error: error.message
    });

    res.status(500).json({ success: false, error: error.message });
  }
};

syncRouter.post("/pull", handlePull);
syncRouter.get("/pull", handlePull);

/**
 * POST /device/register
 * Secure Device Registration Endpoint
 */
syncRouter.post("/device/register", async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const authenticatedTenantId = authReq.user?.tenantId;
    if (!authenticatedTenantId || authenticatedTenantId === "default-tenant" || authenticatedTenantId === "TEN-DEV-001") {
       res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
       return;
    }
    const authenticatedUserId = authReq.user?.userId || "system";

    const { deviceId, deviceName, branchId, appVersion, schemaVersion } = req.body;

    if (!deviceId) {
      res.status(400).json({ success: false, error: "deviceId is required for device registration." });
      return;
    }

    const device = await DeviceService.registerDevice({
      deviceId,
      deviceName: deviceName || "POS Terminal",
      tenantId: authenticatedTenantId,
      branchId: branchId,
      userId: authenticatedUserId,
      appVersion: appVersion || "8.3.0",
      schemaVersion: schemaVersion || SYNC_PROTOCOL_VERSION
    });

    await SyncAuditService.logEvent({
      tenantId: authenticatedTenantId,
      branchId,
      userId: authenticatedUserId,
      deviceId,
      operation: "DEVICE_REGISTERED",
      result: "SUCCESS",
      metadata: { deviceName, appVersion }
    });

    res.status(200).json({
      success: true,
      data: device
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /device/revoke
 * Endpoint to revoke or disable a compromised/lost device
 */
syncRouter.post("/device/revoke", async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const authenticatedTenantId = authReq.user?.tenantId;
    if (!authenticatedTenantId || authenticatedTenantId === "default-tenant" || authenticatedTenantId === "TEN-DEV-001") {
       res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
       return;
    }
    const { deviceId, reason } = req.body;

    if (!deviceId) {
      res.status(400).json({ success: false, error: "deviceId is required for device revocation." });
      return;
    }

    const updated = await DeviceService.updateDeviceStatus(
      authenticatedTenantId,
      deviceId,
      "REVOKED",
      reason || "Security Revocation"
    );

    await SyncAuditService.logEvent({
      tenantId: authenticatedTenantId,
      userId: authReq.user?.userId,
      deviceId,
      operation: "DEVICE_REVOKED",
      result: "SUCCESS",
      error: reason,
      metadata: { newStatus: "REVOKED" }
    });

    res.status(200).json({
      success: true,
      message: `Device [${deviceId}] successfully revoked.`,
      data: updated
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /device/:deviceId/status
 * Check device registration and authorization status
 */
syncRouter.get("/device/:deviceId/status", async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const authenticatedTenantId = authReq.user?.tenantId;
    if (!authenticatedTenantId || authenticatedTenantId === "default-tenant" || authenticatedTenantId === "TEN-DEV-001") {
       res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
       return;
    }
    const deviceId = req.params.deviceId || "";

    const verification = await DeviceService.verifyDevice(authenticatedTenantId, deviceId);
    res.status(200).json({
      success: true,
      data: verification
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /device/:deviceId/status
 * Security admin action to update status of a device (ACTIVE / REVOKED / SUSPENDED)
 */
syncRouter.post("/device/:deviceId/status", async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const authenticatedTenantId = authReq.user?.tenantId;
    if (!authenticatedTenantId || authenticatedTenantId === "default-tenant" || authenticatedTenantId === "TEN-DEV-001") {
       res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
       return;
    }
    const deviceId = req.params.deviceId || "";
    const { status, reason } = req.body;

    if (!status || !["ACTIVE", "REVOKED", "SUSPENDED"].includes(status)) {
      res.status(400).json({ success: false, error: "Valid status required ('ACTIVE', 'REVOKED', 'SUSPENDED')." });
      return;
    }

    const updated = await DeviceService.updateDeviceStatus(authenticatedTenantId, deviceId, status, reason);

    await SyncAuditService.logEvent({
      tenantId: authenticatedTenantId,
      userId: authReq.user?.userId,
      deviceId,
      operation: status === "REVOKED" ? "DEVICE_REVOKED" : "DEVICE_SUSPENDED",
      result: "SUCCESS",
      error: reason,
      metadata: { newStatus: status }
    });

    res.status(200).json({
      success: true,
      data: updated
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /conflicts
 * Retrieve open conflicts for the tenant and branch
 */
syncRouter.get("/conflicts", async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId || tenantId === "default-tenant" || tenantId === "TEN-DEV-001") {
       res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
       return;
    }
    const branchId = req.query.branchId ? String(req.query.branchId) : undefined;

    const conflicts = SyncConflictService.getConflicts(tenantId, branchId);
    res.status(200).json({
      success: true,
      data: conflicts
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /conflicts/:conflictId/resolve
 * Resolve conflict manually via management workflow
 */
syncRouter.post("/conflicts/:conflictId/resolve", async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId || tenantId === "default-tenant" || tenantId === "TEN-DEV-001") {
       res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
       return;
    }
    const conflictId = req.params.conflictId || "";
    const { strategy } = req.body;

    const resolved = SyncConflictService.resolveConflict(
      conflictId,
      strategy || "MANUAL_MERGE",
      authReq.user?.username || "admin"
    );

    if (!resolved) {
      res.status(404).json({ success: false, error: "Conflict record not found." });
      return;
    }

    res.status(200).json({
      success: true,
      data: resolved
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /audit-logs
 * Query synchronization security audit records
 */
syncRouter.get("/audit-logs", async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId || tenantId === "default-tenant" || tenantId === "TEN-DEV-001") {
       res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
       return;
    }
    const branchId = req.query.branchId ? String(req.query.branchId) : undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;

    const logs = SyncAuditService.getLogs({ tenantId, branchId, limit });
    res.status(200).json({
      success: true,
      data: logs
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /ack
 * Acknowledge receipt of pull deltas
 */
syncRouter.post("/ack", async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const authenticatedTenantId = authReq.user?.tenantId;
    if (!authenticatedTenantId || authenticatedTenantId === "default-tenant" || authenticatedTenantId === "TEN-DEV-001") {
       res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
       return;
    }
    const { ackId, deviceId, sequence } = req.body;

    if (deviceId && sequence !== undefined) {
      DeviceService.updateDeviceSequence(authenticatedTenantId, deviceId, { ackSequence: Number(sequence) });
    }

    res.status(200).json({
      success: true,
      message: `Acknowledge packet ${ackId} registered successfully for device ${deviceId || "unspecified"}`
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /devices
 * List all registered devices for the authenticated tenant (Multi-Device Fleet)
 */
syncRouter.get("/devices", async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const authenticatedTenantId = authReq.user?.tenantId;
    if (!authenticatedTenantId || authenticatedTenantId === "default-tenant" || authenticatedTenantId === "TEN-DEV-001") {
       res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
       return;
    }
    const devices = DeviceService.getTenantDevices(authenticatedTenantId);

    res.status(200).json({
      success: true,
      data: devices
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /device/:deviceId/sequence
 * Update cursor sequence and version vector for a device
 */
syncRouter.post("/device/:deviceId/sequence", async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const authenticatedTenantId = authReq.user?.tenantId;
    if (!authenticatedTenantId || authenticatedTenantId === "default-tenant" || authenticatedTenantId === "TEN-DEV-001") {
       res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
       return;
    }
    const deviceId = String(req.params.deviceId || "");
    const { syncedSequence, ackSequence, versionVector } = req.body;

    if (!deviceId) {
      res.status(400).json({ success: false, error: "deviceId parameter is required" });
      return;
    }

    if (syncedSequence !== undefined || ackSequence !== undefined) {
      DeviceService.updateDeviceSequence(authenticatedTenantId, deviceId, {
        syncedSequence: syncedSequence !== undefined ? Number(syncedSequence) : undefined,
        ackSequence: ackSequence !== undefined ? Number(ackSequence) : undefined
      });
    }

    if (versionVector && typeof versionVector === "object") {
      DeviceService.updateVersionVector(authenticatedTenantId, deviceId, versionVector);
    }

    const updated = await DeviceService.getDevice(authenticatedTenantId, deviceId);
    res.status(200).json({
      success: true,
      data: updated
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /integrity-check
 * Verifies financial ledger integrity and accounting invariants
 */
syncRouter.post("/integrity-check", async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const authenticatedTenantId = authReq.user?.tenantId;
    if (!authenticatedTenantId || authenticatedTenantId === "default-tenant" || authenticatedTenantId === "TEN-DEV-001") {
       res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
       return;
    }
    const branchId = req.body.branchId || undefined;

    const report = await SyncFinancialIntegrityService.verifyTenantIntegrity(
      authenticatedTenantId,
      branchId
    );

    res.status(200).json({
      success: true,
      data: report
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /compensating-transaction
 * Creates a formal compensating event (Reversing Journal Entry, Credit Note, Inventory Reconciliation)
 */
syncRouter.post("/compensating-transaction", async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const authenticatedTenantId = authReq.user?.tenantId;
    if (!authenticatedTenantId || authenticatedTenantId === "default-tenant" || authenticatedTenantId === "TEN-DEV-001") {
       res.status(403).json({ success: false, error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
       return;
    }
    const authenticatedUserId = authReq.user?.userId || "system";
    const { type, payload } = req.body;

    if (!type || !payload) {
      res.status(400).json({ success: false, error: "type and payload are required." });
      return;
    }

    let result: any = null;

    if (type === "REVERSING_JOURNAL_ENTRY") {
      result = CompensatingTransactionService.generateReversingJournalEntry({
        ...payload,
        tenantId: authenticatedTenantId,
        actorId: authenticatedUserId
      });
    } else if (type === "CREDIT_NOTE") {
      result = CompensatingTransactionService.generateCreditNote({
        ...payload,
        tenantId: authenticatedTenantId,
        actorId: authenticatedUserId
      });
    } else if (type === "INVENTORY_RECONCILIATION") {
      result = CompensatingTransactionService.generateInventoryReconciliation({
        ...payload,
        tenantId: authenticatedTenantId,
        actorId: authenticatedUserId
      });
    } else {
      res.status(400).json({ success: false, error: `Unsupported compensating transaction type: ${type}` });
      return;
    }

    await SyncAuditService.logEvent({
      tenantId: authenticatedTenantId,
      userId: authenticatedUserId,
      operation: "COMPENSATING_TRANSACTION_CREATED",
      result: "SUCCESS",
      metadata: { type, id: result.id }
    });

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});
