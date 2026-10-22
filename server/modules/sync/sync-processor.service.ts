// server/modules/sync/sync-processor.service.ts
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
  "INVOICE", "SALE", "PRODUCT", "PAYMENT", "VOUCHER", "JOURNAL_ENTRY", 
  "INVENTORY_MOVEMENT", "STOCK_ADJUSTMENT", "INVENTORY_BATCH", 
  "BRANCH_TRANSFER", "STOCK_TRANSFER", "TRANSFER", "CUSTOMER", 
  "SUPPLIER", "SETTINGS", "DEVICE"
]);

export class SyncProcessorService {
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
      applied: [] as string[], successful: [] as string[], duplicates: [] as string[],
      conflicts: [] as string[], rejected: [] as string[], unauthorized: [] as string[]
    };

    if (envelope.schemaVersion && envelope.schemaVersion !== SYNC_PROTOCOL_VERSION) {
      await SyncAuditService.logEvent({
        tenantId: authenticatedTenantId, branchId: envelope.branchId, userId: authenticatedUserId, deviceId: envelope.deviceId,
        operation: "SCHEMA_VERSION_REJECTED", result: "FAILURE", error: `Schema mismatch`, metadata: { clientVersion: envelope.clientVersion }
      });
      return this.buildRejectResponse("SCHEMA_VERSION_MISMATCH", "إصدار بروتوكول المزامنة غير متطابق.", authenticatedTenantId, envelope.branchId, serverTimestamp, envelope.mutations, summary);
    }

    if (envelope.tenantId && envelope.tenantId !== authenticatedTenantId) {
      await SyncAuditService.logEvent({
        tenantId: authenticatedTenantId, branchId: envelope.branchId, userId: authenticatedUserId, deviceId: envelope.deviceId,
        operation: "TENANT_MISMATCH", result: "FAILURE", error: `Tenant mismatch`, metadata: { envelopeTenant: envelope.tenantId }
      });
      return this.buildRejectResponse("TENANT_MISMATCH", "انتهاك عزل المنشآت: معرف المنشأة لا يطابق جلسة المصادقة.", authenticatedTenantId, envelope.branchId, serverTimestamp, envelope.mutations, summary);
    }

    const tenantId = authenticatedTenantId;
    const targetBranchId = envelope.branchId || null;

    if (targetBranchId && userAllowedBranches && userAllowedBranches.length > 0) {
      const isAllowedBranch = userAllowedBranches.includes(targetBranchId) || ["ADMIN", "PLATFORM_OWNER", "TENANT_ADMIN"].includes(authenticatedUserRole || "");
      if (!isAllowedBranch) {
        return this.buildRejectResponse("BRANCH_ACCESS_DENIED", `غير مصرح للجهاز بإرسال مزامنة للفرع [${targetBranchId}].`, tenantId, targetBranchId, serverTimestamp, envelope.mutations, summary);
      }
    }

    const deviceVerification = await DeviceService.verifyDevice(tenantId, envelope.deviceId);
    if (!deviceVerification.allowed) {
      return this.buildRejectResponse(deviceVerification.status === "REVOKED" ? "DEVICE_REVOKED" : "DEVICE_SUSPENDED", deviceVerification.reason || "الجهاز ملغى أو معلق.", tenantId, targetBranchId, serverTimestamp, envelope.mutations, summary);
    }

    DeviceService.touchDevice(tenantId, envelope.deviceId);

    let effectivePermissions = new Set<string>();
    try {
      effectivePermissions = await AuthorizationService.getUserEffectivePermissions(tenantId, authenticatedUserId, authenticatedUserRole);
    } catch (err) { /* fallback */ }

    const mutations = Array.isArray(envelope.mutations) ? envelope.mutations : [];

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

      const requiredPermission = this.getRequiredPermission(entity, operation);
      const isPrivileged = ["ADMIN", "PLATFORM_OWNER", "TENANT_ADMIN", "PHARMACIST_IN_CHARGE", "SUPER_ADMIN"].includes(authenticatedUserRole || "");
      if (requiredPermission && !isPrivileged && !effectivePermissions.has(requiredPermission)) {
        results.push({ id: mutationId, mutationId, status: "UNAUTHORIZED", success: false, errorCode: "PERMISSION_DENIED", message: "Unauthorized" });
        summary.unauthorized.push(mutationId);
        continue;
      }

      const idempotencyCheck = await SyncIdempotencyService.check(tenantId, envelope.deviceId, idempotencyKey, payload);
      if (idempotencyCheck.isDuplicate) {
        results.push({ ...(idempotencyCheck.previousResult || { mutationId, status: "DUPLICATE" }), id: mutationId, mutationId, status: "DUPLICATE", success: true });
        summary.duplicates.push(mutationId);
        continue;
      }

      try {
        const fullResult = await prisma.$transaction(async (tx) => {
          const mutationResult = await this.executeEntityMutation({
            mutation, tenantId, branchId: targetBranchId, userId: authenticatedUserId, deviceId: envelope.deviceId, version: version || 1, tx
          });

          const result: PerMutationResult = { ...mutationResult, id: mutationId, mutationId };

          if (result.status === "SUCCESS") {
            await SyncIdempotencyService.record(tenantId, envelope.deviceId, idempotencyKey, payload, result, tx);
            await SyncChangelogService.recordChange({
              tenantId, branchId: targetBranchId, entity, entityId: entityId || mutationId, operation,
              version: result.serverVersion || (version || 1) + 1, mutationId, actorId: authenticatedUserId, deviceId: envelope.deviceId, payload: payload || {}
            }, tx);

            if (result.effects && result.effects.length > 0) {
              for (const effect of result.effects) {
                await SyncChangelogService.recordChange({
                  tenantId, branchId: targetBranchId, entity: effect.entity, entityId: effect.entityId, operation: effect.operation,
                  version: 1, mutationId, actorId: authenticatedUserId, deviceId: envelope.deviceId, payload: effect.payload
                }, tx);
              }
            }
          }
          return result;
        });

        results.push(fullResult);
        if (fullResult.status === "SUCCESS") { summary.successful.push(mutationId); summary.applied.push(mutationId); }
        else if (fullResult.status === "CONFLICT") { summary.conflicts.push(mutationId); }
        else { summary.rejected.push(mutationId); }
      } catch (err: any) {
        console.error(`[SyncProcessor] Mutation ${mutationId} fatal error:`, err);
        results.push({ id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "PROCESSING_EXCEPTION", message: err.message });
        summary.rejected.push(mutationId);
      }
    }

    return {
      success: summary.rejected.length === 0 && summary.unauthorized.length === 0,
      tenantId, branchId: targetBranchId, serverTimestamp, processedCount: results.length, results, summary
    };
  }
  private static buildRejectResponse(code: string, msg: string, tenantId: string, branchId: string | null, serverTimestamp: number, mutations: SyncMutation[] | undefined, summary: any): SyncPushResponse {
  return {
    success: false, errorCode: code, error: msg, tenantId, branchId, serverTimestamp, processedCount: (mutations || []).length,
    results: (mutations || []).map((m) => ({ id: m.id, mutationId: m.id, status: "REJECTED", success: false, errorCode: code, message: msg })),
    summary
  };
}

private static getRequiredPermission(entity: string, operation: string): string | null {
  switch (entity.toUpperCase()) {
    case "INVOICE": case "SALE": return operation === "CREATE" || operation === "POST" ? "sales.invoice.create" : "sales.invoice.update";
    case "PRODUCT": return "inventory.products.manage";
    case "PAYMENT": case "VOUCHER": return "accounting.voucher.create";
    case "JOURNAL_ENTRY": return "accounting.journal.post";
    default: return null;
  }
}

private static async executeEntityMutation(params: {
  mutation: SyncMutation; tenantId: string; branchId: string | null; userId: string; deviceId: string; version: number; tx: any;
}): Promise<PerMutationResult> {
  const { mutation, tenantId, branchId, version, tx } = params;
  const { id: mutationId, entity, payload } = mutation;
  const data = payload || {};
  const entityId = mutation.entityId || data.id || mutationId;
  const operation = (mutation.operation || "CREATE").toUpperCase();

  const entityConfig = this.getEntityPrismaConfig(entity);
  if (!entityConfig) {
    return { id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "UNSUPPORTED_ENTITY", message: `Entity ${entity} has no registered persistence model` };
  }

  const { modelName } = entityConfig;
  const model = tx[modelName];

  if ((entity === "INVOICE" || entity === "SALE") && operation === "POST") {
    try {
      const postResult = await AtomicPostSaleService.executePostSaleCommand({
        payload: { ...data, tenantId }, tenantId, userId: params.userId, ipAddress: "127.0.0.1", tx
      });
      return { id: mutationId, mutationId, status: "SUCCESS", success: true, serverVersion: version + 1, processedAt: new Date().toISOString(), details: postResult, effects: postResult.effects };
    } catch (err: any) {
      return { id: mutationId, mutationId, status: "FAILED", success: false, errorCode: "BUSINESS_COMMAND_FAILED", message: err.message };
    }
  }

  let existingAny: any = null;
  try {
    if (typeof model?.findFirst === "function") {
      existingAny = await model.findFirst({ where: { id: entityId } }).catch(() => null);
    } else if (typeof model?.findUnique === "function") {
      existingAny = await model.findUnique({ where: { id: entityId } }).catch(() => null);
      if (existingAny && existingAny.tenantId !== tenantId) {
        existingAny = null;
        throw new Error("CROSS_TENANT_VIOLATION");
      }
    }
  } catch (e: any) {
    if (e.message === "CROSS_TENANT_VIOLATION") {
       await SyncAuditService.logEvent({ tenantId, branchId, userId: params.userId, deviceId: params.deviceId, operation: "CROSS_TENANT_MUTATION_BLOCKED", result: "FAILURE", error: `Cross-tenant violation`, metadata: { mutationId, entity, entityId } });
       return { id: mutationId, mutationId, status: "UNAUTHORIZED", success: false, errorCode: "CROSS_TENANT_VIOLATION", message: "انتهاك عزل المنشآت: لا يمكن إجراء عمليات على سجل ينتمي لمنشأة أخرى." };
    }
    existingAny = null;
  }

  if (existingAny && existingAny.tenantId !== tenantId) {
    await SyncAuditService.logEvent({ tenantId, branchId, userId: params.userId, deviceId: params.deviceId, operation: "CROSS_TENANT_MUTATION_BLOCKED", result: "FAILURE", error: `Cross-tenant violation`, metadata: { mutationId, entity, entityId } });
    return { id: mutationId, mutationId, status: "UNAUTHORIZED", success: false, errorCode: "CROSS_TENANT_VIOLATION", message: "انتهاك عزل المنشآت: لا يمكن إجراء عمليات على سجل ينتمي لمنشأة أخرى." };
  }

  if (entity === "PRODUCT" && existingAny?.deletedAt) {
    return { id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "ENTITY_SOFT_DELETED", message: "لا يمكن تعديل سجل محذوف." };
  }
      if (operation === "DELETE") {
      if (!existingAny) return { id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "ENTITY_NOT_FOUND", message: "السجل المطلوب حذفه غير موجود." };
      await model.delete({ where: { id: entityId, tenantId } });
      return { id: mutationId, mutationId, status: "SUCCESS", success: true, serverVersion: version + 1, processedAt: new Date().toISOString() };
    }

    if (operation === "UPDATE") {
      if (!existingAny) return { id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "ENTITY_NOT_FOUND", message: "السجل المطلوب تحديثه غير موجود." };
      if (entity === "INVOICE" && existingAny.documentStatus === "POSTED") {
        return { id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "POSTED_INVOICE_IMMUTABLE", message: "Cannot update posted invoice via raw sync" };
      }

      const conflictCheck = SyncConflictService.evaluateConflict({ mutation, existingServerRecord: existingAny, tenantId, branchId });
      if (conflictCheck.hasConflict) {
        return { id: mutationId, mutationId, status: "CONFLICT", success: false, errorCode: conflictCheck.category, conflict: { category: conflictCheck.category, message: conflictCheck.message, serverRecord: existingAny, clientRecord: data, resolutionStrategy: conflictCheck.resolutionStrategy } };
      }

      const updateData = this.buildEntityUpdateData(entity, data, branchId);
      await model.update({ where: { id: entityId, tenantId }, data: updateData });
      return { id: mutationId, mutationId, status: "SUCCESS", success: true, serverVersion: version + 1, processedAt: new Date().toISOString() };
    }

    if (existingAny) {
      if (entity === "INVOICE" && existingAny.documentStatus === "POSTED") {
        return { id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "POSTED_INVOICE_IMMUTABLE", message: "Cannot update posted invoice via raw sync" };
      }

      const conflictCheck = SyncConflictService.evaluateConflict({ mutation, existingServerRecord: existingAny, tenantId, branchId });
      if (conflictCheck.hasConflict) {
        return { id: mutationId, mutationId, status: "CONFLICT", success: false, errorCode: conflictCheck.category, conflict: { category: conflictCheck.category, message: conflictCheck.message, serverRecord: existingAny, clientRecord: data, resolutionStrategy: conflictCheck.resolutionStrategy } };
      }

      const updateData = this.buildEntityUpdateData(entity, data, branchId);
      await model.update({ where: { id: entityId, tenantId }, data: updateData });
    } else {
      const createData = this.buildEntityCreateData(entity, entityId, data, tenantId, branchId);
      await model.create({ data: createData });
    }

    return { id: mutationId, mutationId, status: "SUCCESS", success: true, serverVersion: version + 1, processedAt: new Date().toISOString() };
  }

  private static getEntityPrismaConfig(entity: string): { modelName: string } | null {
    switch (entity.toUpperCase()) {
      case "INVOICE": case "SALE": return { modelName: "invoice" };
      case "PRODUCT": return { modelName: "product" };
      case "JOURNAL_ENTRY": return { modelName: "journalEntry" };
      case "INVENTORY_BATCH": return { modelName: "inventoryBatch" };
      case "BRANCH_TRANSFER": case "STOCK_TRANSFER": case "TRANSFER": return { modelName: "branchTransfer" };
      case "PAYMENT": case "VOUCHER": return { modelName: "payment" };
      case "CUSTOMER": return { modelName: "customer" };
      case "SUPPLIER": return { modelName: "supplier" };
      case "INVENTORY_MOVEMENT": case "STOCK_ADJUSTMENT": return { modelName: "inventoryMovement" };
      default: return null;
    }
  }

  private static buildEntityUpdateData(entity: string, data: any, branchId: string | null): any {
    const safeData = { ...data };
    delete safeData.tenantId;
    delete safeData.createdAt;
    delete safeData.id;

    switch (entity.toUpperCase()) {
      case "INVOICE": case "SALE":
        return { invoiceNumber: safeData.invoiceNumber || safeData.invoice_number, date: safeData.date ? new Date(safeData.date) : undefined, partnerId: safeData.partnerId !== undefined ? safeData.partnerId : undefined, partnerType: safeData.partnerType || undefined, type: safeData.type || undefined, paymentStatus: safeData.paymentStatus || undefined, documentStatus: safeData.documentStatus || undefined, branchId: safeData.branchId || branchId, isSynced: true, updatedAt: new Date() };
      case "PRODUCT":
        return { name: safeData.name || undefined, sku: safeData.sku || undefined, barcode: safeData.barcode || undefined, price: safeData.basePrice !== undefined ? safeData.basePrice : (safeData.price !== undefined ? safeData.price : undefined), cost: safeData.costPrice !== undefined ? safeData.costPrice : (safeData.cost !== undefined ? safeData.cost : undefined), updatedAt: new Date() };
      case "PAYMENT": case "VOUCHER":
        return { paymentNumber: safeData.paymentNumber || safeData.payment_number || undefined, date: safeData.date ? new Date(safeData.date) : undefined, amount: safeData.amount !== undefined ? safeData.amount : undefined, partnerId: safeData.partnerId || safeData.supplier_id || safeData.customer_id || undefined, partnerType: safeData.partnerType || (safeData.supplier_id ? "SUPPLIER" : (safeData.customer_id ? "CUSTOMER" : undefined)), paymentMethod: safeData.paymentMethod || undefined, notes: safeData.notes !== undefined ? safeData.notes : undefined, branchId: safeData.branchId || branchId, updatedAt: new Date() };
      case "CUSTOMER": case "SUPPLIER":
        return { name: safeData.name || undefined, phone: safeData.phone || undefined, email: safeData.email || undefined, balance: safeData.balance !== undefined ? safeData.balance : undefined, updatedAt: new Date() };
      default:
        return { updatedAt: new Date() };
    }
  }

  private static buildEntityCreateData(entity: string, entityId: string, data: any, tenantId: string, branchId: string | null): any {
    switch (entity.toUpperCase()) {
      case "INVOICE": case "SALE":
        return { id: entityId, invoiceNumber: data.invoiceNumber || data.invoice_number || `INV-${Date.now()}`, date: new Date(data.date || Date.now()), partnerId: data.partnerId || "", partnerType: data.partnerType || "CUSTOMER", type: data.type || "SALE", paymentStatus: data.paymentStatus || "PAID", documentStatus: data.documentStatus || "ACTIVE", totalAmount: data.totalAmount || data.total || 0, branchId: data.branchId || branchId, tenantId, isSynced: true };
      case "PRODUCT":
        return { id: entityId, name: data.name || "Product", sku: data.sku || `SKU-${Date.now()}`, barcode: data.barcode || null, price: data.basePrice !== undefined ? data.basePrice : (data.price !== undefined ? data.price : 0), cost: data.costPrice !== undefined ? data.costPrice : (data.cost !== undefined ? data.cost : 0), tenantId };
      case "PAYMENT": case "VOUCHER":
        return { id: entityId, paymentNumber: data.paymentNumber || data.payment_number || `PMT-${Date.now()}`, date: new Date(data.date || Date.now()), amount: data.amount || 0, partnerId: data.partnerId || data.supplier_id || data.customer_id || "", partnerType: data.partnerType || (data.supplier_id ? "SUPPLIER" : "CUSTOMER"), paymentMethod: data.paymentMethod || "CASH", notes: data.notes || null, branchId: data.branchId || branchId, tenantId };
      case "CUSTOMER": case "SUPPLIER":
        return { id: entityId, name: data.name || "Entity", phone: data.phone || null, email: data.email || null, balance: data.balance || 0, tenantId };
      default:
        return { id: entityId, tenantId };
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
