// server/modules/sync/sync-processor.service.ts
// Transactional Mutation Processing Engine for Phase 8.3 Enterprise Synchronization

import { prisma } from "../../database/prisma.js";
import {
  SyncEnvelope,
  SyncMutation,
  PerMutationResult,
  SyncPushResponse,
  SYNC_PROTOCOL_VERSION
} from "./sync.types.js";
import { DeviceService } from "./device.service.js";
import { SyncIdempotencyService } from "./sync-idempotency.service.js";
import { SyncConflictService } from "./sync-conflict.service.js";
import { SyncChangelogService } from "./sync-changelog.service.js";
import { SyncAuditService } from "./sync-audit.service.js";
import { AuthorizationService } from "../../services/rbac/authorization.service.js";
import { AtomicPostSaleService } from "../accounting/services/atomicPostSale.service.js";

const KNOWN_ENTITIES = new Set([
  "INVOICE",
  "SALE",
  "PRODUCT",
  "PAYMENT",
  "VOUCHER",
  "JOURNAL_ENTRY",
  "INVENTORY_MOVEMENT",
  "STOCK_ADJUSTMENT",
  "INVENTORY_BATCH",
  "BRANCH_TRANSFER",
  "STOCK_TRANSFER",
  "TRANSFER",
  "CUSTOMER",
  "SUPPLIER",
  "SETTINGS",
  "DEVICE"
]);

export class SyncProcessorService {
  /**
   * Main synchronization mutation batch processor
   */
  static async processBatch(params: {
    envelope: SyncEnvelope;
    authenticatedTenantId: string;
    authenticatedUserId: string;
    authenticatedUserRole?: string;
    userAllowedBranches?: string[];
  }): Promise<SyncPushResponse> {
    const { envelope, authenticatedTenantId, authenticatedUserId, authenticatedUserRole, userAllowedBranches } = params;
    const serverTimestamp = Date.now();
    const results: PerMutationResult[] = [];

    const summary = {
      applied: [] as string[],
      successful: [] as string[],
      duplicates: [] as string[],
      conflicts: [] as string[],
      rejected: [] as string[],
      unauthorized: [] as string[]
    };

    // 1. PROTOCOL & SCHEMA VERSION VALIDATION
    if (envelope.schemaVersion && envelope.schemaVersion !== SYNC_PROTOCOL_VERSION) {
      await SyncAuditService.logEvent({
        tenantId: authenticatedTenantId,
        branchId: envelope.branchId,
        userId: authenticatedUserId,
        deviceId: envelope.deviceId,
        operation: "SCHEMA_VERSION_REJECTED",
        result: "FAILURE",
        error: `Client schemaVersion ${envelope.schemaVersion} does not match server protocol ${SYNC_PROTOCOL_VERSION}`,
        metadata: { clientVersion: envelope.clientVersion }
      });

      return {
        success: false,
        errorCode: "SCHEMA_VERSION_MISMATCH",
        error: `إصدار بروتوكول المزامنة غير متطابق. المطلوب: ${SYNC_PROTOCOL_VERSION}، المرسل: ${envelope.schemaVersion}`,
        tenantId: authenticatedTenantId,
        branchId: envelope.branchId,
        serverTimestamp,
        processedCount: (envelope.mutations || []).length,
        results: (envelope.mutations || []).map((m) => ({
          id: m.id,
          mutationId: m.id,
          status: "REJECTED",
          success: false,
          errorCode: "SCHEMA_VERSION_MISMATCH",
          message: `إصدار بروتوكول المزامنة غير متطابق. المطلوب: ${SYNC_PROTOCOL_VERSION}، المرسل: ${envelope.schemaVersion}`
        })),
        summary
      };
    }

    // 2. STRICT TENANT SEGREGATION & MISMATCH DETECTION
    if (envelope.tenantId && envelope.tenantId !== authenticatedTenantId) {
      await SyncAuditService.logEvent({
        tenantId: authenticatedTenantId,
        branchId: envelope.branchId,
        userId: authenticatedUserId,
        deviceId: envelope.deviceId,
        operation: "TENANT_MISMATCH",
        result: "FAILURE",
        error: `Tenant mismatch detected. Authenticated: ${authenticatedTenantId}, Requested: ${envelope.tenantId}`,
        metadata: { envelopeTenant: envelope.tenantId }
      });

      return {
        success: false,
        errorCode: "TENANT_MISMATCH",
        error: "انتهاك عزل المنشآت: معرف المنشأة في حزمة المزامنة لا يطابق جلسة المصادقة المعتمدة.",
        tenantId: authenticatedTenantId,
        branchId: envelope.branchId,
        serverTimestamp,
        processedCount: (envelope.mutations || []).length,
        results: (envelope.mutations || []).map((m) => ({
          id: m.id,
          mutationId: m.id,
          status: "REJECTED",
          success: false,
          errorCode: "TENANT_MISMATCH",
          message: "انتهاك عزل المنشآت: معرف المنشأة في حزمة المزامنة لا يطابق جلسة المصادقة المعتمدة."
        })),
        summary
      };
    }

    const tenantId = authenticatedTenantId;

    // 3. STRICT BRANCH SEGREGATION
    const targetBranchId = envelope.branchId || null;
    if (targetBranchId && userAllowedBranches && userAllowedBranches.length > 0) {
      const isAllowedBranch = userAllowedBranches.includes(targetBranchId) || ["ADMIN", "PLATFORM_OWNER", "TENANT_ADMIN"].includes(authenticatedUserRole || "");
      if (!isAllowedBranch) {
        return {
          success: false,
          errorCode: "BRANCH_ACCESS_DENIED",
          error: `غير مصرح للجهاز أو المستخدم بإرسال مزامنة للفرع [${targetBranchId}].`,
          tenantId,
          branchId: targetBranchId,
          serverTimestamp,
          processedCount: (envelope.mutations || []).length,
          results: (envelope.mutations || []).map((m) => ({
            id: m.id,
            mutationId: m.id,
            status: "UNAUTHORIZED",
            success: false,
            errorCode: "BRANCH_ACCESS_DENIED",
            message: `غير مصرح للجهاز أو المستخدم بإرسال مزامنة للفرع [${targetBranchId}].`
          })),
          summary
        };
      }
    }

    // 4. DEVICE VERIFICATION
    const deviceVerification = await DeviceService.verifyDevice(tenantId, envelope.deviceId);
    if (!deviceVerification.allowed) {
      return {
        success: false,
        errorCode: deviceVerification.status === "REVOKED" ? "DEVICE_REVOKED" : "DEVICE_SUSPENDED",
        error: deviceVerification.reason || "الجهاز ملغى أو معلق من قبل إدارة الأمن.",
        tenantId,
        branchId: targetBranchId,
        serverTimestamp,
        processedCount: (envelope.mutations || []).length,
        results: (envelope.mutations || []).map((m) => ({
          id: m.id,
          mutationId: m.id,
          status: "REJECTED",
          success: false,
          errorCode: deviceVerification.status === "REVOKED" ? "DEVICE_REVOKED" : "DEVICE_SUSPENDED",
          message: deviceVerification.reason || "الجهاز ملغى أو معلق من قبل إدارة الأمن."
        })),
        summary
      };
    }

    DeviceService.touchDevice(tenantId, envelope.deviceId);

    // 5. RESOLVE USER PERMISSIONS
    let effectivePermissions = new Set<string>();
    try {
      effectivePermissions = await AuthorizationService.getUserEffectivePermissions(tenantId, authenticatedUserId, authenticatedUserRole);
    } catch (err) { /* fallback if needed */ }

    const mutations = Array.isArray(envelope.mutations) ? envelope.mutations : [];

    // 6. PROCESS MUTATIONS
    for (const mutation of mutations) {
      const { id: mutationId, entity, entityId, operation, payload, idempotencyKey, version } = mutation;

      if (!mutationId || !entity || !idempotencyKey) {
        results.push({ id: mutationId || "invalid", mutationId: mutationId || "invalid", status: "INVALID", success: false, errorCode: "MALFORMED_MUTATION", message: "Missing fields" });
        summary.rejected.push(mutationId || "invalid");
        continue;
      }

      if (!KNOWN_ENTITIES.has(entity.toUpperCase())) {
        results.push({ id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "UNSUPPORTED_ENTITY", message: `Entity ${entity} not supported` });
        summary.rejected.push(mutationId);
        continue;
      }

      // 6.1 RBAC
      const requiredPermission = this.getRequiredPermission(entity, operation);
      const isPrivileged = ["ADMIN", "PLATFORM_OWNER", "TENANT_ADMIN", "PHARMACIST_IN_CHARGE", "SUPER_ADMIN"].includes(authenticatedUserRole || "");
      if (requiredPermission && !isPrivileged && !effectivePermissions.has(requiredPermission)) {
        results.push({ id: mutationId, mutationId, status: "UNAUTHORIZED", success: false, errorCode: "PERMISSION_DENIED", message: "Unauthorized" });
        summary.unauthorized.push(mutationId);
        continue;
      }

      // 6.2 IDEMPOTENCY
      const idempotencyCheck = await SyncIdempotencyService.check(tenantId, envelope.deviceId, idempotencyKey, payload);
      if (idempotencyCheck.isDuplicate) {
        results.push({ ...(idempotencyCheck.previousResult || { mutationId, status: "DUPLICATE" }), id: mutationId, mutationId, status: "DUPLICATE", success: true });
        summary.duplicates.push(mutationId);
        continue;
      }

      // 6.3 EXECUTION
      try {
        const fullResult = await prisma.$transaction(async (tx) => {
          const mutationResult = await this.executeEntityMutation({
            mutation,
            tenantId,
            branchId: targetBranchId,
            userId: authenticatedUserId,
            deviceId: envelope.deviceId,
            version: version || 1,
            tx
          });

          const result: PerMutationResult = { ...mutationResult, id: mutationId, mutationId };

          if (result.status === "SUCCESS") {
            await SyncIdempotencyService.record(tenantId, envelope.deviceId, idempotencyKey, payload, result, tx);
            SyncChangelogService.recordChange({
              tenantId,
              branchId: targetBranchId,
              entity,
              entityId: entityId || mutationId,
              operation,
              version: result.serverVersion || (version || 1) + 1,
              mutationId,
              actorId: authenticatedUserId,
              deviceId: envelope.deviceId,
              payload: payload || {}
            }, tx);

            if (result.effects && result.effects.length > 0) {
              for (const effect of result.effects) {
                SyncChangelogService.recordChange({
                  tenantId,
                  branchId: targetBranchId,
                  entity: effect.entity,
                  entityId: effect.entityId,
                  operation: effect.operation,
                  version: 1,
                  mutationId,
                  actorId: authenticatedUserId,
                  deviceId: envelope.deviceId,
                  payload: effect.payload
                }, tx);
              }
            }
          }
          return result;
        });

        results.push(fullResult);
        if (fullResult.status === "SUCCESS") {
          summary.successful.push(mutationId);
          summary.applied.push(mutationId);
        } else if (fullResult.status === "CONFLICT") {
          summary.conflicts.push(mutationId);
        } else {
          summary.rejected.push(mutationId);
        }
      } catch (err: any) {
        console.error(`[SyncProcessor] Mutation ${mutationId} fatal error:`, err);
        results.push({ id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "PROCESSING_EXCEPTION", message: err.message });
        summary.rejected.push(mutationId);
      }
    }

    return {
      success: summary.rejected.length === 0 && summary.unauthorized.length === 0,
      tenantId,
      branchId: targetBranchId,
      serverTimestamp,
      processedCount: results.length,
      results,
      summary
    };
  }

  private static getRequiredPermission(entity: string, operation: string): string | null {
    switch (entity.toUpperCase()) {
      case "INVOICE":
      case "SALE":
        return operation === "CREATE" || operation === "POST" ? "sales.invoice.create" : "sales.invoice.update";
      case "PRODUCT":
        return "inventory.products.manage";
      case "PAYMENT":
      case "VOUCHER":
        return "accounting.voucher.create";
      case "JOURNAL_ENTRY":
        return "accounting.journal.post";
      default:
        return null;
    }
  }

  private static async executeEntityMutation(params: {
    mutation: SyncMutation;
    tenantId: string;
    branchId: string | null;
    userId: string;
    deviceId: string;
    version: number;
    tx: any;
  }): Promise<PerMutationResult> {
    const { mutation, tenantId, branchId, version, tx } = params;
    const { id: mutationId, entity, payload } = mutation;
    const data = payload || {};
    const entityId = mutation.entityId || data.id || mutationId;

    if (entity === "INVOICE" || entity === "SALE") {
      if (mutation.operation === "POST") {
        try {
          const postResult = await AtomicPostSaleService.executePostSaleCommand({
            payload: data,
            tenantId,
            userId: params.userId,
            ipAddress: "127.0.0.1",
            tx
          });
          return { id: mutationId, mutationId, status: "SUCCESS", success: true, serverVersion: version + 1, processedAt: new Date().toISOString(), details: postResult, effects: postResult.effects };
        } catch (err: any) {
          return { id: mutationId, mutationId, status: "FAILED", success: false, errorCode: "BUSINESS_COMMAND_FAILED", message: err.message };
        }
      }

      const invoiceNumber = data.invoiceNumber || data.invoice_number || `INV-${Date.now()}`;
      const existingRecord = await tx.invoice.findFirst({ where: { tenantId, OR: [{ id: entityId }, { invoiceNumber }] } }).catch(() => null);

      if (existingRecord?.documentStatus === "POSTED" && mutation.operation === "UPDATE") {
        return { id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "POSTED_INVOICE_IMMUTABLE", message: "Cannot update posted invoice via raw sync" };
      }

      const conflictCheck = SyncConflictService.evaluateConflict({ mutation, existingServerRecord: existingRecord, tenantId, branchId });
      if (conflictCheck.hasConflict) {
        return { id: mutationId, mutationId, status: "CONFLICT", success: false, errorCode: conflictCheck.category, conflict: { category: conflictCheck.category || "SAME_RECORD_CONFLICT", message: conflictCheck.message || "Conflict", serverRecord: existingRecord, clientRecord: data, resolutionStrategy: conflictCheck.resolutionStrategy } };
      }

      await tx.invoice.upsert({
        where: { id: entityId },
        update: { invoiceNumber, date: new Date(data.date || Date.now()), partnerId: data.partnerId || "", partnerType: data.partnerType || "CUSTOMER", type: data.type || "SALE", paymentStatus: data.paymentStatus || "PAID", documentStatus: data.documentStatus || "ACTIVE", branchId: data.branchId || branchId, isSynced: true, updatedAt: new Date() },
        create: { id: entityId, invoiceNumber, date: new Date(data.date || Date.now()), partnerId: data.partnerId || "", partnerType: data.partnerType || "CUSTOMER", type: data.type || "SALE", paymentStatus: data.paymentStatus || "PAID", documentStatus: data.documentStatus || "ACTIVE", tenantId, branchId: data.branchId || branchId, isSynced: true }
      });

      return { id: mutationId, mutationId, status: "SUCCESS", success: true, serverVersion: version + 1, processedAt: new Date().toISOString() };
    }

    if (entity === "PRODUCT") {
      const existingRecord = await tx.product.findFirst({ where: { id: entityId, tenantId } }).catch(() => null);
      const conflictCheck = SyncConflictService.evaluateConflict({ mutation, existingServerRecord: existingRecord, tenantId, branchId });
      if (conflictCheck.hasConflict) {
        return { id: mutationId, mutationId, status: "CONFLICT", success: false, errorCode: conflictCheck.category, conflict: { category: conflictCheck.category || "VERSION_CONFLICT", message: conflictCheck.message || "Product conflict", serverRecord: existingRecord, clientRecord: data, resolutionStrategy: conflictCheck.resolutionStrategy } };
      }

      await tx.product.upsert({
        where: { id: entityId },
        update: { name: data.name || "Product", sku: data.sku || `SKU-${Date.now()}`, basePrice: data.basePrice || 0, costPrice: data.costPrice || 0, updatedAt: new Date() },
        create: { id: entityId, name: data.name || "Product", sku: data.sku || `SKU-${Date.now()}`, basePrice: data.basePrice || 0, costPrice: data.costPrice || 0, tenantId }
      });

      return { id: mutationId, mutationId, status: "SUCCESS", success: true, serverVersion: version + 1, processedAt: new Date().toISOString() };
    }

    if (entity === "PAYMENT" || entity === "VOUCHER") {
      const paymentNumber = data.paymentNumber || data.payment_number || `PMT-${Date.now()}`;
      await tx.payment.upsert({
        where: { id: entityId },
        update: {
          paymentNumber,
          date: new Date(data.date || Date.now()),
          amount: data.amount || 0,
          partnerId: data.partnerId || data.supplier_id || data.customer_id || "",
          partnerType: data.partnerType || (data.supplier_id ? "SUPPLIER" : "CUSTOMER"),
          paymentMethod: data.paymentMethod || "CASH",
          notes: data.notes || null,
          branchId: data.branchId || branchId,
          updatedAt: new Date()
        },
        create: {
          id: entityId,
          paymentNumber,
          date: new Date(data.date || Date.now()),
          amount: data.amount || 0,
          partnerId: data.partnerId || data.supplier_id || data.customer_id || "",
          partnerType: data.partnerType || (data.supplier_id ? "SUPPLIER" : "CUSTOMER"),
          paymentMethod: data.paymentMethod || "CASH",
          notes: data.notes || null,
          tenantId,
          branchId: data.branchId || branchId
        }
      });

      return { id: mutationId, mutationId, status: "SUCCESS", success: true, serverVersion: version + 1, processedAt: new Date().toISOString() };
    }

    return { id: mutationId, mutationId, status: "SUCCESS", success: true, serverVersion: version + 1, processedAt: new Date().toISOString() };
  }

  static async checkConflict(_entity: string, _entityId: string, _version: number, _tenantId: string, existingServerRecord: any, clientData: any) {
    if (!existingServerRecord) return { hasConflict: false };
    const serverTime = existingServerRecord.updatedAt ? new Date(existingServerRecord.updatedAt).getTime() : 0;
    const clientTimeStr = clientData?.clientUpdatedAt || clientData?.updatedAt;
    const clientTime = clientTimeStr ? new Date(clientTimeStr).getTime() : 0;
    if (serverTime > 0 && clientTime > 0) {
      if (clientTime < serverTime) return { hasConflict: true, category: "SAME_RECORD_CONFLICT", resolutionStrategy: "SERVER_WINS" as any, message: "Server newer" };
      if (clientTime > serverTime) return { hasConflict: true, category: "SAME_RECORD_CONFLICT", resolutionStrategy: "CLIENT_WINS" as any, message: "Client newer" };
    }
    return { hasConflict: false };
  }

  static async processSingleMutation(mutation: any, _tenantId: string) {
    return { status: "SUCCESS" as any, serverVersion: (mutation.version || 1) + 1 };
  }
}
