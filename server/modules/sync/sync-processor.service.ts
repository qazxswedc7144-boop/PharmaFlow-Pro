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
    const operation = (mutation.operation || "CREATE").toUpperCase();

    // Map entity to Prisma delegate model name and whether it has composite id_tenantId
    const entityConfig = this.getEntityPrismaConfig(entity);
    if (!entityConfig) {
      return {
        id: mutationId,
        mutationId,
        status: "REJECTED",
        success: false,
        errorCode: "UNSUPPORTED_ENTITY",
        message: `Entity ${entity} has no registered persistence model`
      };
    }

    const { modelName, hasCompositeUnique } = entityConfig;
    const model = tx[modelName];

    // Special Business Workflow: INVOICE / SALE POST Operation
    if ((entity === "INVOICE" || entity === "SALE") && operation === "POST") {
      try {
        const postResult = await AtomicPostSaleService.executePostSaleCommand({
          payload: { ...data, tenantId },
          tenantId,
          userId: params.userId,
          ipAddress: "127.0.0.1",
          tx
        });
        return {
          id: mutationId,
          mutationId,
          status: "SUCCESS",
          success: true,
          serverVersion: version + 1,
          processedAt: new Date().toISOString(),
          details: postResult,
          effects: postResult.effects
        };
      } catch (err: any) {
        return {
          id: mutationId,
          mutationId,
          status: "FAILED",
          success: false,
          errorCode: "BUSINESS_COMMAND_FAILED",
          message: err.message
        };
      }
    }

    // -------------------------------------------------------------------------
    // 1. TRANSACTIONAL OWNERSHIP LOOKUP (Prevents TOCTOU & UUID Hijacking)
    // -------------------------------------------------------------------------
    let existingAny: any = null;
    try {
      if (typeof model?.findFirst === "function") {
        existingAny = await model.findFirst({
          where: { id: entityId }
        }).catch(() => null);
      } else if (typeof model?.findUnique === "function") {
        existingAny = await model.findUnique({
          where: { id: entityId }
        }).catch(() => null);
      }
    } catch {
      existingAny = null;
    }

    // -------------------------------------------------------------------------
    // 2. STRICT TENANT ISOLATION BARRIER: CROSS-TENANT MUTATION DETECTION
    // -------------------------------------------------------------------------
    // If the record exists in the database but belongs to a foreign tenant: DENY!
    if (existingAny && existingAny.tenantId && existingAny.tenantId !== tenantId) {
      await SyncAuditService.logEvent({
        tenantId,
        branchId,
        userId: params.userId,
        deviceId: params.deviceId,
        operation: "CROSS_TENANT_MUTATION_BLOCKED",
        result: "FAILURE",
        error: `Cross-tenant violation: Entity [${entity}] with ID [${entityId}] belongs to tenant [${existingAny.tenantId}], requested by [${tenantId}]`,
        metadata: {
          mutationId,
          entity,
          entityId,
          operation,
          targetRecordTenant: existingAny.tenantId,
          authenticatedTenant: tenantId
        }
      });

      return {
        id: mutationId,
        mutationId,
        status: "UNAUTHORIZED",
        success: false,
        errorCode: "CROSS_TENANT_VIOLATION",
        message: "انتهاك عزل المنشآت: لا يمكن إجراء عمليات أو تعديل أو حذف سجل ينتمي لمنشأة أخرى."
      };
    }

    // -------------------------------------------------------------------------
    // 3. OPERATION ROUTING & ISOLATION ENFORCEMENT
    // -------------------------------------------------------------------------

    // CASE A: DELETE OPERATION
    if (operation === "DELETE") {
      if (!existingAny) {
        return {
          id: mutationId,
          mutationId,
          status: "REJECTED",
          success: false,
          errorCode: "ENTITY_NOT_FOUND",
          message: "السجل المطلوب حذفه غير موجود."
        };
      }

      if (hasCompositeUnique) {
        await model.delete({
          where: { id_tenantId: { id: entityId, tenantId } }
        });
      } else {
        await model.delete({
          where: { id: entityId }
        });
      }

      return {
        id: mutationId,
        mutationId,
        status: "SUCCESS",
        success: true,
        serverVersion: version + 1,
        processedAt: new Date().toISOString()
      };
    }

    // CASE B: UPDATE OPERATION
    if (operation === "UPDATE") {
      if (!existingAny) {
        return {
          id: mutationId,
          mutationId,
          status: "REJECTED",
          success: false,
          errorCode: "ENTITY_NOT_FOUND",
          message: "السجل المطلوب تحديثه غير موجود."
        };
      }

      // Check immutable posted invoices
      if (entity === "INVOICE" && existingAny.documentStatus === "POSTED") {
        return {
          id: mutationId,
          mutationId,
          status: "REJECTED",
          success: false,
          errorCode: "POSTED_INVOICE_IMMUTABLE",
          message: "Cannot update posted invoice via raw sync"
        };
      }

      // Conflict Check
      const conflictCheck = SyncConflictService.evaluateConflict({
        mutation,
        existingServerRecord: existingAny,
        tenantId,
        branchId
      });
      if (conflictCheck.hasConflict) {
        return {
          id: mutationId,
          mutationId,
          status: "CONFLICT",
          success: false,
          errorCode: conflictCheck.category,
          conflict: {
            category: conflictCheck.category || "SAME_RECORD_CONFLICT",
            message: conflictCheck.message || "Conflict detected",
            serverRecord: existingAny,
            clientRecord: data,
            resolutionStrategy: conflictCheck.resolutionStrategy
          }
        };
      }

      // Execute update strictly scoped
      const updateData = this.buildEntityUpdateData(entity, data, branchId);
      if (hasCompositeUnique) {
        await model.update({
          where: { id_tenantId: { id: entityId, tenantId } },
          data: updateData
        });
      } else {
        await model.update({
          where: { id: entityId },
          data: updateData
        });
      }

      return {
        id: mutationId,
        mutationId,
        status: "SUCCESS",
        success: true,
        serverVersion: version + 1,
        processedAt: new Date().toISOString()
      };
    }

    // CASE C: CREATE / UPSERT OPERATION
    if (existingAny) {
      // Record exists and belongs to the SAME tenant
      if (entity === "INVOICE" && existingAny.documentStatus === "POSTED") {
        return {
          id: mutationId,
          mutationId,
          status: "REJECTED",
          success: false,
          errorCode: "POSTED_INVOICE_IMMUTABLE",
          message: "Cannot update posted invoice via raw sync"
        };
      }

      const conflictCheck = SyncConflictService.evaluateConflict({
        mutation,
        existingServerRecord: existingAny,
        tenantId,
        branchId
      });
      if (conflictCheck.hasConflict) {
        return {
          id: mutationId,
          mutationId,
          status: "CONFLICT",
          success: false,
          errorCode: conflictCheck.category,
          conflict: {
            category: conflictCheck.category || "SAME_RECORD_CONFLICT",
            message: conflictCheck.message || "Conflict detected",
            serverRecord: existingAny,
            clientRecord: data,
            resolutionStrategy: conflictCheck.resolutionStrategy
          }
        };
      }

      const updateData = this.buildEntityUpdateData(entity, data, branchId);
      if (hasCompositeUnique) {
        await model.update({
          where: { id_tenantId: { id: entityId, tenantId } },
          data: updateData
        });
      } else {
        await model.update({
          where: { id: entityId },
          data: updateData
        });
      }
    } else {
      // Record does not exist anywhere -> CREATE cleanly under authenticated tenantId
      const createData = this.buildEntityCreateData(entity, entityId, data, tenantId, branchId);
      await model.create({
        data: createData
      });
    }

    return {
      id: mutationId,
      mutationId,
      status: "SUCCESS",
      success: true,
      serverVersion: version + 1,
      processedAt: new Date().toISOString()
    };
  }

  private static getEntityPrismaConfig(entity: string): { modelName: string; hasCompositeUnique: boolean } | null {
    switch (entity.toUpperCase()) {
      case "INVOICE":
      case "SALE":
        return { modelName: "invoice", hasCompositeUnique: true };
      case "PRODUCT":
        return { modelName: "product", hasCompositeUnique: true };
      case "JOURNAL_ENTRY":
        return { modelName: "journalEntry", hasCompositeUnique: true };
      case "INVENTORY_BATCH":
        return { modelName: "inventoryBatch", hasCompositeUnique: true };
      case "BRANCH_TRANSFER":
      case "STOCK_TRANSFER":
      case "TRANSFER":
        return { modelName: "branchTransfer", hasCompositeUnique: true };
      case "PAYMENT":
      case "VOUCHER":
        return { modelName: "payment", hasCompositeUnique: false };
      case "CUSTOMER":
        return { modelName: "customer", hasCompositeUnique: false };
      case "SUPPLIER":
        return { modelName: "supplier", hasCompositeUnique: false };
      case "INVENTORY_MOVEMENT":
      case "STOCK_ADJUSTMENT":
        return { modelName: "inventoryMovement", hasCompositeUnique: false };
      default:
        return null;
    }
  }

  private static buildEntityUpdateData(entity: string, data: any, branchId: string | null): any {
    switch (entity.toUpperCase()) {
      case "INVOICE":
      case "SALE":
        return {
          invoiceNumber: data.invoiceNumber || data.invoice_number,
          date: data.date ? new Date(data.date) : undefined,
          partnerId: data.partnerId !== undefined ? data.partnerId : undefined,
          partnerType: data.partnerType || undefined,
          type: data.type || undefined,
          paymentStatus: data.paymentStatus || undefined,
          documentStatus: data.documentStatus || undefined,
          branchId: data.branchId || branchId,
          isSynced: true,
          updatedAt: new Date()
        };
      case "PRODUCT":
        return {
          name: data.name || undefined,
          sku: data.sku || undefined,
          barcode: data.barcode || undefined,
          price: data.basePrice !== undefined ? data.basePrice : (data.price !== undefined ? data.price : undefined),
          cost: data.costPrice !== undefined ? data.costPrice : (data.cost !== undefined ? data.cost : undefined),
          updatedAt: new Date()
        };
      case "PAYMENT":
      case "VOUCHER":
        return {
          paymentNumber: data.paymentNumber || data.payment_number || undefined,
          date: data.date ? new Date(data.date) : undefined,
          amount: data.amount !== undefined ? data.amount : undefined,
          partnerId: data.partnerId || data.supplier_id || data.customer_id || undefined,
          partnerType: data.partnerType || (data.supplier_id ? "SUPPLIER" : (data.customer_id ? "CUSTOMER" : undefined)),
          paymentMethod: data.paymentMethod || undefined,
          notes: data.notes !== undefined ? data.notes : undefined,
          branchId: data.branchId || branchId,
          updatedAt: new Date()
        };
      case "CUSTOMER":
        return {
          name: data.name || undefined,
          phone: data.phone || undefined,
          email: data.email || undefined,
          balance: data.balance !== undefined ? data.balance : undefined,
          updatedAt: new Date()
        };
      case "SUPPLIER":
        return {
          name: data.name || undefined,
          phone: data.phone || undefined,
          email: data.email || undefined,
          balance: data.balance !== undefined ? data.balance : undefined,
          updatedAt: new Date()
        };
      default:
        return {
          updatedAt: new Date()
        };
    }
  }

  private static buildEntityCreateData(entity: string, entityId: string, data: any, tenantId: string, branchId: string | null): any {
    switch (entity.toUpperCase()) {
      case "INVOICE":
      case "SALE":
        return {
          id: entityId,
          invoiceNumber: data.invoiceNumber || data.invoice_number || `INV-${Date.now()}`,
          date: new Date(data.date || Date.now()),
          partnerId: data.partnerId || "",
          partnerType: data.partnerType || "CUSTOMER",
          type: data.type || "SALE",
          paymentStatus: data.paymentStatus || "PAID",
          documentStatus: data.documentStatus || "ACTIVE",
          totalAmount: data.totalAmount || data.total || 0,
          branchId: data.branchId || branchId,
          tenantId,
          isSynced: true
        };
      case "PRODUCT":
        return {
          id: entityId,
          name: data.name || "Product",
          sku: data.sku || `SKU-${Date.now()}`,
          barcode: data.barcode || null,
          price: data.basePrice !== undefined ? data.basePrice : (data.price !== undefined ? data.price : 0),
          cost: data.costPrice !== undefined ? data.costPrice : (data.cost !== undefined ? data.cost : 0),
          tenantId
        };
      case "PAYMENT":
      case "VOUCHER":
        return {
          id: entityId,
          paymentNumber: data.paymentNumber || data.payment_number || `PMT-${Date.now()}`,
          date: new Date(data.date || Date.now()),
          amount: data.amount || 0,
          partnerId: data.partnerId || data.supplier_id || data.customer_id || "",
          partnerType: data.partnerType || (data.supplier_id ? "SUPPLIER" : "CUSTOMER"),
          paymentMethod: data.paymentMethod || "CASH",
          notes: data.notes || null,
          branchId: data.branchId || branchId,
          tenantId
        };
      case "CUSTOMER":
        return {
          id: entityId,
          name: data.name || "Customer",
          phone: data.phone || null,
          email: data.email || null,
          balance: data.balance || 0,
          tenantId
        };
      case "SUPPLIER":
        return {
          id: entityId,
          name: data.name || "Supplier",
          phone: data.phone || null,
          email: data.email || null,
          balance: data.balance || 0,
          tenantId
        };
      default:
        return {
          id: entityId,
          tenantId
        };
    }
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
