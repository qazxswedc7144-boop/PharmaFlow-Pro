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
import { FinancialTransactionService } from "../accounting/services/financialTransaction.service.js";

const KNOWN_ENTITIES = new Set([
  "INVOICE", "SALE", "PURCHASE", "PRODUCT", "PAYMENT", "VOUCHER", "JOURNAL_ENTRY", 
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
  }): Promise<SyncPushResponse> {
    const { envelope, authenticatedTenantId, authenticatedUserId, authenticatedUserRole } = params;
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

    // 🚨 SECURITY FIX: PHARMACIST_IN_CHARGE removed from branch bypass
    const isPrivileged = ["ADMIN", "PLATFORM_OWNER", "TENANT_ADMIN", "SUPER_ADMIN"].includes((authenticatedUserRole || "").toUpperCase());

    try {
      if (targetBranchId) {
        const branchInTenant = await prisma.branch.findFirst({
          where: { id: targetBranchId, tenantId },
          select: { id: true }
        });

        if (!branchInTenant) {
          await SyncAuditService.logEvent({
            tenantId, branchId: targetBranchId, userId: authenticatedUserId, deviceId: envelope.deviceId,
            operation: "BRANCH_MISMATCH", result: "FAILURE",
            error: "Requested branch does not belong to the authenticated tenant context",
            metadata: { requestedBranch: targetBranchId }
          });
          return this.buildRejectResponse(
            "BRANCH_NOT_IN_TENANT",
            `انتهاك أمني: الفرع [${targetBranchId}] لا ينتمي لهذه المنشأة.`,
            tenantId, targetBranchId, serverTimestamp, envelope.mutations, summary
          );
        }

        if (!isPrivileged) {
          const [hasBranchMembership, hasBranchRoleAssignment] = await Promise.all([
            prisma.branchUser.findFirst({
              where: { userId: authenticatedUserId, branchId: targetBranchId, tenantId },
              select: { id: true }
            }),
            prisma.userRole.findFirst({
              where: { userId: authenticatedUserId, branchId: targetBranchId, tenantId },
              select: { id: true }
            })
          ]);

          if (!hasBranchMembership && !hasBranchRoleAssignment) {
            await SyncAuditService.logEvent({
              tenantId, branchId: targetBranchId, userId: authenticatedUserId, deviceId: envelope.deviceId,
              operation: "PERMISSION_DENIED", result: "FAILURE",
              error: "User attempted to sync a branch without membership or explicit role assignment",
              metadata: { requestedBranch: targetBranchId }
            });
            return this.buildRejectResponse(
              "BRANCH_ACCESS_DENIED",
              `غير مصرح لك بالوصول إلى بيانات الفرع [${targetBranchId}]. يرجى التواصل مع الإدارة.`,
              tenantId, targetBranchId, serverTimestamp, envelope.mutations, summary
            );
          }
        }
      } else {
        if (!isPrivileged) {
          const [userBranchesCount, userBranchRolesCount] = await Promise.all([
            prisma.branchUser.count({ where: { userId: authenticatedUserId, tenantId } }),
            prisma.userRole.count({ where: { userId: authenticatedUserId, tenantId, NOT: { branchId: null } } })
          ]);

          if (userBranchesCount > 0 || userBranchRolesCount > 0) {
            return this.buildRejectResponse(
              "BRANCH_REQUIRED",
              "يجب تحديد معرف الفرع للمزامنة (أنت مقيد بصلاحيات فروع محددة).",
              tenantId, null, serverTimestamp, envelope.mutations, summary
            );
          }

          return this.buildRejectResponse(
            "BRANCH_ACCESS_DENIED",
            "غير مصرح بإجراء مزامنة على مستوى المنشأة.",
            tenantId, null, serverTimestamp, envelope.mutations, summary
          );
        }
      }
    } catch (err: any) {
      console.error(`[SyncProcessor] Branch verification failed:`, err);
      await SyncAuditService.logEvent({
        tenantId, branchId: targetBranchId, userId: authenticatedUserId, deviceId: envelope.deviceId,
        operation: "SYNC_REJECTED", result: "FAILURE", error: err.message
      });
      return this.buildRejectResponse("SECURITY_VERIFICATION_FAILED", "فشل التحقق من صلاحيات الوصول. تم رفض الطلب للأمان.", tenantId, targetBranchId, serverTimestamp, envelope.mutations, summary);
    }

    const deviceVerification = await DeviceService.verifyDevice(tenantId, envelope.deviceId);
    if (!deviceVerification.allowed) {
      return this.buildRejectResponse(deviceVerification.status === "REVOKED" ? "DEVICE_REVOKED" : "DEVICE_SUSPENDED", deviceVerification.reason || "الجهاز ملغى أو معلق.", tenantId, targetBranchId, serverTimestamp, envelope.mutations, summary);
    }

    DeviceService.touchDevice(tenantId, envelope.deviceId);

    let effectivePermissions = new Set<string>();
    try {
      effectivePermissions = await AuthorizationService.getUserEffectivePermissions(tenantId, authenticatedUserId, authenticatedUserRole);
    } catch (err: any) {
      console.error(`[SyncProcessor] Failed to fetch permissions for user ${authenticatedUserId}:`, err);
      await SyncAuditService.logEvent({
        tenantId, userId: authenticatedUserId, deviceId: envelope.deviceId,
        operation: "PERMISSION_DENIED", result: "FAILURE", error: err.message
      });
      return this.buildRejectResponse("PERMISSION_FETCH_FAILED", "تعذر التحقق من صلاحيات المستخدم. تم رفض الطلب للأمان.", tenantId, targetBranchId, serverTimestamp, envelope.mutations, summary);
    }

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
      const isPrivilegedForOp = ["ADMIN", "PLATFORM_OWNER", "TENANT_ADMIN", "SUPER_ADMIN"].includes((authenticatedUserRole || "").toUpperCase());
      if (requiredPermission && !isPrivilegedForOp && !effectivePermissions.has(requiredPermission)) {
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
            mutation, tenantId, branchId: targetBranchId, userId: authenticatedUserId, userRole: authenticatedUserRole, deviceId: envelope.deviceId, version: version || 1, tx
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
        else if (fullResult.status === "UNAUTHORIZED") { summary.unauthorized.push(mutationId); }
        else { summary.rejected.push(mutationId); }
      } catch (err: any) {
        console.error(`[SyncProcessor] Mutation ${mutationId} fatal error:`, err);
        results.push({ id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "PROCESSING_EXCEPTION", message: err.message });
        summary.rejected.push(mutationId);
      }
    }

    return {
      success: summary.rejected.length === 0 && summary.unauthorized.length === 0 && summary.conflicts.length === 0,
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
      case "INVOICE": case "SALE": 
        return operation === "CREATE" || operation === "POST" ? "sales.invoice.create" : "sales.invoice.update";
      case "PURCHASE":
        return "purchases.create";
      case "PRODUCT": 
        return "inventory.products.manage";
      case "PAYMENT": case "VOUCHER": 
        return "accounting.voucher.create";
      case "JOURNAL_ENTRY": 
        return "accounting.journal.post";
      case "CUSTOMER": 
        return "crm.customers.manage";
      case "SUPPLIER": 
        return "crm.suppliers.manage";
      case "INVENTORY_BATCH": case "INVENTORY_MOVEMENT": case "STOCK_ADJUSTMENT": 
        return "inventory.stock.manage";
      case "BRANCH_TRANSFER": case "STOCK_TRANSFER": case "TRANSFER": 
        return "inventory.transfers.manage";
      case "SETTINGS": 
        return "system.settings.manage";
      case "DEVICE": 
        return "system.devices.manage";
      default: 
        return "system.data.mutate";
    }
  }

  private static async executeEntityMutation(params: {
    mutation: SyncMutation; tenantId: string; branchId: string | null; userId: string; userRole?: string; deviceId: string; version: number; tx: any;
  }): Promise<PerMutationResult> {
    const { mutation, tenantId, branchId, version, tx, userRole } = params;
    const { id: mutationId, entity, payload } = mutation;
    const data = payload || {};
    const entityId = mutation.entityId || data.id || mutationId;
    const operation = (mutation.operation || "CREATE").toUpperCase();
    const upperEntity = entity.toUpperCase();

    if (upperEntity === "PURCHASE") {
      return this.handlePurchaseCreate({
        mutation,
        tenantId,
        branchId,
        userId: params.userId,
        deviceId: params.deviceId,
        version,
        tx
      });
    }

    const entityConfig = this.getEntityPrismaConfig(upperEntity);
    if (!entityConfig) {
      return { id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "UNSUPPORTED_ENTITY", message: `Entity ${entity} has no registered persistence model` };
    }

    const { modelName } = entityConfig;
    const model = tx[modelName];

    // 🚨 SECURITY FIX: Case-insensitive POST detection
    if ((upperEntity === "INVOICE" || upperEntity === "SALE") && operation === "POST") {
      try {
        // Keep the accounting/FIFO posting graph out of ordinary Sync requests.
        // Load it only when a real SALE POST mutation reaches this branch.
        const { AtomicPostSaleService } = await import("../accounting/services/atomicPostSale.service.js");
        const postResult = await AtomicPostSaleService.executePostSaleCommand({
          payload: { ...data, tenantId }, tenantId, userId: params.userId, userRole, ipAddress: "127.0.0.1", tx
        });
        return { id: mutationId, mutationId, status: "SUCCESS", success: true, serverVersion: version + 1, processedAt: new Date().toISOString(), details: postResult, effects: postResult.effects };
      } catch (err: any) {
        const errorCode = err.code || err.message || "BUSINESS_COMMAND_FAILED";
        return {
          id: mutationId,
          mutationId,
          status: errorCode === "PRICE_OVERRIDE_FORBIDDEN" ? "UNAUTHORIZED" : "FAILED",
          success: false,
          errorCode,
          message: err.message || "Business command failed"
        };
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

    if (upperEntity === "PRODUCT" && existingAny?.deletedAt) {
      return { id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "ENTITY_SOFT_DELETED", message: "لا يمكن تعديل سجل محذوف." };
    }

    if (operation === "DELETE") {
      if (!existingAny) return { id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "ENTITY_NOT_FOUND", message: "السجل المطلوب حذفه غير موجود." };
      await model.delete({ where: { id: entityId, tenantId } });
      return { id: mutationId, mutationId, status: "SUCCESS", success: true, serverVersion: version + 1, processedAt: new Date().toISOString() };
    }

    if (operation === "UPDATE") {
      if (!existingAny) return { id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "ENTITY_NOT_FOUND", message: "السجل المطلوب تحديثه غير موجود." };
      if (upperEntity === "INVOICE" && existingAny.documentStatus === "POSTED") {
        return { id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "POSTED_INVOICE_IMMUTABLE", message: "Cannot update posted invoice via raw sync" };
      }

      const conflictCheck = SyncConflictService.evaluateConflict({ mutation, existingServerRecord: existingAny, tenantId, branchId });
      if (conflictCheck.hasConflict) {
        return { id: mutationId, mutationId, status: "CONFLICT", success: false, errorCode: conflictCheck.category!, conflict: { category: conflictCheck.category!, message: conflictCheck.message!, serverRecord: existingAny, clientRecord: data, resolutionStrategy: conflictCheck.resolutionStrategy } };
      }

      const updateData = this.buildEntityUpdateData(upperEntity, data, branchId);
      await model.update({ where: { id: entityId, tenantId }, data: updateData });
      return { id: mutationId, mutationId, status: "SUCCESS", success: true, serverVersion: version + 1, processedAt: new Date().toISOString() };
    }

    if (existingAny) {
      if (upperEntity === "INVOICE" && existingAny.documentStatus === "POSTED") {
        return { id: mutationId, mutationId, status: "REJECTED", success: false, errorCode: "POSTED_INVOICE_IMMUTABLE", message: "Cannot update posted invoice via raw sync" };
      }

      const conflictCheck = SyncConflictService.evaluateConflict({ mutation, existingServerRecord: existingAny, tenantId, branchId });
      if (conflictCheck.hasConflict) {
        return { id: mutationId, mutationId, status: "CONFLICT", success: false, errorCode: conflictCheck.category!, conflict: { category: conflictCheck.category!, message: conflictCheck.message!, serverRecord: existingAny, clientRecord: data, resolutionStrategy: conflictCheck.resolutionStrategy } };
      }

      const updateData = this.buildEntityUpdateData(upperEntity, data, branchId);
      await model.update({ where: { id: entityId, tenantId }, data: updateData });
    } else {
      const createData = this.buildEntityCreateData(upperEntity, entityId, data, tenantId, branchId);
      await model.create({ data: createData });
    }

    return { id: mutationId, mutationId, status: "SUCCESS", success: true, serverVersion: version + 1, processedAt: new Date().toISOString() };
  }

  private static async handlePurchaseCreate(params: {
    mutation: SyncMutation;
    tenantId: string;
    branchId: string | null;
    userId: string;
    deviceId: string;
    version: number;
    tx: any;
  }): Promise<PerMutationResult> {
    const { mutation, tenantId, branchId, version, tx } = params;
    const mutationId = mutation.id;
    const payload = (mutation.payload || {}) as Record<string, any>;
    const purchase = payload.purchase && typeof payload.purchase === "object"
      ? payload.purchase as Record<string, any>
      : payload;
    const reject = (errorCode: string, message: string): PerMutationResult => ({
      id: mutationId,
      mutationId,
      status: "REJECTED",
      success: false,
      errorCode,
      message
    });

    const operation = String(mutation.operation || "CREATE").toUpperCase();
    if (operation !== "CREATE") {
      return reject("PURCHASE_OPERATION_NOT_SUPPORTED", "PURCHASE sync currently accepts CREATE only.");
    }

    if (!branchId) {
      return reject("PURCHASE_BRANCH_REQUIRED", "A trusted branch context is required for purchase synchronization.");
    }

    const payloadTenantId = payload.tenantId ?? purchase.tenantId ?? purchase.tenant_id;
    const payloadBranchId = payload.branchId ?? purchase.branchId ?? purchase.branch_id;
    if (payloadTenantId && payloadTenantId !== tenantId) {
      return reject("TENANT_MISMATCH", "Purchase payload tenant does not match the authenticated tenant.");
    }
    if (payloadBranchId && payloadBranchId !== branchId) {
      return reject("BRANCH_MISMATCH", "Purchase payload branch does not match the authenticated branch.");
    }

    const documentStatus = String(
      purchase.documentStatus ??
      purchase.document_status ??
      purchase.InvoiceStatus ??
      purchase.invoiceStatus ??
      ""
    ).trim().toUpperCase();
    if (documentStatus !== "POSTED") {
      return reject("PURCHASE_NOT_POSTED", "Only POSTED purchase invoices can be synchronized.");
    }
    if (purchase.isReturn === true || purchase.is_return === true) {
      return reject("PURCHASE_RETURN_NOT_SUPPORTED", "Purchase returns require their separate reversal workflow.");
    }
    if (String(purchase.type || "").trim().toUpperCase() !== "PURCHASE") {
      return reject("INVALID_PURCHASE_TYPE", "The synchronized document must explicitly be a PURCHASE invoice.");
    }

    const payloadId = typeof payload.id === "string" ? payload.id.trim() : "";
    const nestedId = typeof purchase.id === "string" ? purchase.id.trim() : "";
    if (payloadId && nestedId && payloadId !== nestedId) {
      return reject("PURCHASE_ID_MISMATCH", "Top-level and nested purchase identifiers do not match.");
    }
    const invoiceId = payloadId || nestedId ||
      (mutation.entityId && mutation.entityId !== "unknown" ? mutation.entityId : "");
    if (!invoiceId || invoiceId === "unknown") {
      return reject("PURCHASE_ID_REQUIRED", "A stable purchase invoice identifier is required.");
    }
    if (mutation.entityId && mutation.entityId !== "unknown" && mutation.entityId !== invoiceId) {
      return reject("PURCHASE_ENTITY_ID_MISMATCH", "Mutation entityId does not match the purchase invoice identifier.");
    }

    const invoiceNumber = String(purchase.invoiceNumber ?? purchase.invoice_number ?? "").trim();
    const supplierId = String(
      purchase.partnerId ??
      purchase.partner_id ??
      purchase.supplierId ??
      purchase.supplier_id ??
      ""
    ).trim();
    const rawPaymentStatus = String(purchase.paymentStatus ?? purchase.payment_status ?? "").trim().toUpperCase();
    const rawFinancialStatus = String(purchase.financialStatus ?? purchase.financial_status ?? "").trim().toUpperCase();
    const rawDate = purchase.date ?? purchase.Date;
    const invoiceDate = rawDate ? new Date(rawDate) : null;
    const totalAmount = Number(purchase.totalAmount ?? purchase.finalTotal ?? purchase.grandTotal);
    const rawItems = purchase.items;

    if (!invoiceNumber) return reject("PURCHASE_INVOICE_NUMBER_REQUIRED", "Purchase invoiceNumber is required.");
    if (!supplierId) return reject("PURCHASE_SUPPLIER_REQUIRED", "Purchase supplierId is required.");
    if (!invoiceDate || !Number.isFinite(invoiceDate.getTime())) {
      return reject("PURCHASE_DATE_INVALID", "Purchase date must be a valid date.");
    }
    if (!Number.isFinite(totalAmount) || totalAmount < 0) {
      return reject("PURCHASE_TOTAL_INVALID", "Purchase totalAmount must be a finite non-negative number.");
    }
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return reject("PURCHASE_ITEMS_REQUIRED", "A posted purchase must contain at least one invoice item.");
    }

    const existingInvoice = await tx.invoice.findFirst({
      where: {
        tenantId,
        OR: [
          { id: invoiceId },
          { clientRefId: invoiceId },
          { invoiceNumber }
        ]
      },
      select: { id: true }
    });
    if (existingInvoice) {
      return reject("PURCHASE_ALREADY_EXISTS", "A purchase with this identifier or invoice number already exists.");
    }

    const branch = await tx.branch.findFirst({
      where: { id: branchId, tenantId },
      select: { id: true }
    });
    if (!branch) {
      return reject("PURCHASE_BRANCH_NOT_FOUND", "The target branch does not belong to the authenticated tenant.");
    }

    const cashSupplierLabels = new Set(["مورد نقدي", "CASH", "CASH_SUPPLIER", "SUPP-GEN"]);
    const isCashPayment = rawPaymentStatus === "CASH" || rawFinancialStatus === "PAID";
    const isCashSupplierPlaceholder = cashSupplierLabels.has(supplierId) && isCashPayment;
    if (!isCashSupplierPlaceholder) {
      const supplier = await tx.supplier.findFirst({
        where: { id: supplierId, tenantId },
        select: { id: true }
      });
      if (!supplier) {
        return reject("PURCHASE_SUPPLIER_NOT_FOUND", "The supplier does not belong to the authenticated tenant.");
      }
    }

    const normalizedItems: Array<{
      productId: string;
      qty: number;
      price: number;
      cost: number;
      total: number;
      expiryDate: Date | null;
      batchNumber: string;
      note: string | null;
      category: string | null;
      tracksStock: boolean;
    }> = [];

    for (let index = 0; index < rawItems.length; index++) {
      const item = rawItems[index] as Record<string, any>;
      const productId = String(item.productId ?? item.product_id ?? "").trim();
      const qty = Number(item.quantity ?? item.qty);
      const price = Number(item.unitPrice ?? item.unit_price ?? item.price);
      const itemDiscount = Number(item.discount ?? item.discount_val ?? 0);

      if (!productId) return reject("PURCHASE_ITEM_PRODUCT_REQUIRED", `Purchase item ${index + 1} has no productId.`);
      if (!Number.isSafeInteger(qty) || qty <= 0) {
        return reject("PURCHASE_ITEM_QUANTITY_INVALID", `Purchase item ${index + 1} quantity must be a positive integer.`);
      }
      if (!Number.isFinite(price) || price < 0) {
        return reject("PURCHASE_ITEM_PRICE_INVALID", `Purchase item ${index + 1} has an invalid unit price.`);
      }
      if (!Number.isFinite(itemDiscount) || itemDiscount < 0 || itemDiscount > qty * price) {
        return reject("PURCHASE_ITEM_DISCOUNT_INVALID", `Purchase item ${index + 1} has an invalid discount.`);
      }

      const product = await tx.product.findFirst({
        where: { id: productId, tenantId },
        select: { id: true, cost: true }
      });
      if (!product) {
        return reject("PURCHASE_ITEM_PRODUCT_NOT_FOUND", `Purchase item ${index + 1} product is missing or belongs to another tenant.`);
      }

      const rawCost = item.unitCost ?? item.unit_cost ?? item.cost ?? item.costPrice ?? item.cost_price ?? item.unitPrice ?? item.price;
      const cost = rawCost === undefined || rawCost === null ? Number(product.cost) : Number(rawCost);
      if (!Number.isFinite(cost) || cost < 0) {
        return reject("PURCHASE_ITEM_COST_INVALID", `Purchase item ${index + 1} has no valid unit cost.`);
      }

      const lineTotal = Math.round((qty * price - itemDiscount) * 10000) / 10000;
      const rawExpiry = item.expiryDate ?? item.expiry_date ?? null;
      const expiryDate = rawExpiry === null || rawExpiry === undefined || rawExpiry === ""
        ? null
        : new Date(rawExpiry);
      if (expiryDate && !Number.isFinite(expiryDate.getTime())) {
        return reject("PURCHASE_ITEM_EXPIRY_INVALID", `Purchase item ${index + 1} has an invalid expiry date.`);
      }

      const isService = item.isService === true ||
        item.trackStock === false ||
        String(item.itemType ?? item.type ?? "").toUpperCase() === "SERVICE";
      if (isService) {
        return reject(
          "PURCHASE_NON_STOCK_ITEM_NOT_SUPPORTED",
          `Purchase item ${index + 1} is a non-stock service line; server purchase posting currently requires stock-tracked items.`
        );
      }
      const suppliedBatchNumber = String(item.batchNumber ?? item.batch_number ?? item.note ?? "").trim();
      // Prisma requires a batchNumber. When the supplier batch is absent, use a
      // deterministic internal reference (not a claimed supplier batch number).
      const batchNumber = suppliedBatchNumber || `AUTO-PUR-${invoiceId}-${index + 1}`;

      normalizedItems.push({
        productId,
        qty,
        price,
        cost,
        total: lineTotal,
        expiryDate,
        batchNumber,
        // InvoiceItem has no dedicated batchNumber column. The existing server
        // posting service consumes note as the purchase batch reference.
        note: batchNumber,
        category: item.category ?? null,
        tracksStock: true
      });
    }

    const computedSubtotal = normalizedItems.reduce((sum, item) => sum + item.total, 0);
    const subtotalAmount = Number(purchase.subtotal ?? computedSubtotal);
    const discountAmount = Number(
      purchase.discountAmount ??
      purchase.discountTotal ??
      purchase.discount ??
      purchase.discount_val ??
      0
    );
    const discountPercent = Number(purchase.discountPercent ?? 0);
    const taxAmount = Number(purchase.taxAmount ?? purchase.taxTotal ?? purchase.tax ?? purchase.tax_val ?? 0);
    const otherFees = Number(purchase.otherFees ?? 0);
    const expectedTotal = subtotalAmount - discountAmount + taxAmount + otherFees;

    if (
      !Number.isFinite(subtotalAmount) ||
      !Number.isFinite(discountAmount) ||
      !Number.isFinite(discountPercent) ||
      !Number.isFinite(taxAmount) ||
      !Number.isFinite(otherFees) ||
      Math.abs(subtotalAmount - computedSubtotal) > 0.02 ||
      Math.abs(expectedTotal - totalAmount) > 0.02
    ) {
      return reject("PURCHASE_TOTAL_MISMATCH", "Purchase item totals, discounts, tax and totalAmount are inconsistent.");
    }

    const paidAmount = Number(purchase.paidAmount ?? purchase.paid_amount ?? 0);
    const remainingAmount = Number(purchase.remainingAmount ?? purchase.remaining_amount ?? Math.max(0, totalAmount - paidAmount));
    const paymentStatus = rawPaymentStatus === "CASH" || rawPaymentStatus === "PAID" ||
      rawFinancialStatus === "PAID" || (paidAmount >= totalAmount && totalAmount > 0)
      ? "PAID"
      : rawPaymentStatus === "PARTIALLY_PAID" || (paidAmount > 0 && remainingAmount > 0)
        ? "PARTIALLY_PAID"
        : "UNPAID";

    await tx.invoice.create({
      data: {
        id: invoiceId,
        invoiceNumber,
        clientRefId: invoiceId,
        date: invoiceDate,
        type: "PURCHASE",
        partnerId: supplierId,
        partnerType: "SUPPLIER",
        subtotalAmount,
        discountPercent,
        discountAmount,
        taxAmount,
        totalAmount,
        status: "DRAFT",
        paymentStatus,
        documentStatus: "ACTIVE",
        isSynced: true,
        branchId,
        tenantId
      }
    });

    await tx.invoiceItem.createMany({
      data: normalizedItems.map(item => ({
        invoiceId,
        tenantId,
        productId: item.productId,
        qty: item.qty,
        price: item.price,
        cost: item.cost,
        total: item.total,
        expiryDate: item.expiryDate,
        note: item.note,
        category: item.category
      }))
    });

    const invoiceForPosting = await tx.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      include: { items: { include: { product: true } } }
    });
    if (!invoiceForPosting) {
      throw new Error("PURCHASE_POSTING_INVOICE_NOT_FOUND: Created purchase invoice could not be reloaded for posting.");
    }

    // Use the existing server posting engine in this same Prisma transaction.
    // It creates FIFO stock layers/movements, the balanced journal entry,
    // account balance updates, audit trail, and the final POSTED state atomically.
    const postingResult = await FinancialTransactionService.executeInvoiceLedgerPosting(
      tx,
      invoiceForPosting,
      params.userId,
      null,
      tenantId,
      params.userRole
    );

    for (const item of normalizedItems) {
      await tx.branchInventory.upsert({
        where: { branchId_productId: { branchId, productId: item.productId } },
        create: {
          tenantId,
          branchId,
          productId: item.productId,
          stockQuantity: item.qty
        },
        update: { stockQuantity: { increment: item.qty } }
      });
    }

    return {
      id: mutationId,
      mutationId,
      status: "SUCCESS",
      success: true,
      serverVersion: version + 1,
      processedAt: new Date().toISOString(),
      details: {
        invoiceId,
        invoiceNumber,
        itemCount: normalizedItems.length,
        stockItemCount: normalizedItems.length,
        journalId: postingResult.journalId,
        cogs: postingResult.cogs
      }
    };
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
    delete safeData.branchId;

    switch (entity.toUpperCase()) {
      case "INVOICE": case "SALE":
        return { invoiceNumber: safeData.invoiceNumber || safeData.invoice_number, date: safeData.date ? new Date(safeData.date) : undefined, partnerId: safeData.partnerId !== undefined ? safeData.partnerId : undefined, partnerType: safeData.partnerType || undefined, type: safeData.type || undefined, paymentStatus: safeData.paymentStatus || undefined, documentStatus: safeData.documentStatus || undefined, branchId: branchId, isSynced: true, updatedAt: new Date() };
      case "PRODUCT":
        return { name: safeData.name || undefined, sku: safeData.sku || undefined, barcode: safeData.barcode || undefined, price: safeData.basePrice !== undefined ? safeData.basePrice : (safeData.price !== undefined ? safeData.price : undefined), cost: safeData.costPrice !== undefined ? safeData.costPrice : (safeData.cost !== undefined ? safeData.cost : undefined), updatedAt: new Date() };
      case "PAYMENT": case "VOUCHER":
        return { paymentNumber: safeData.paymentNumber || safeData.payment_number || undefined, date: safeData.date ? new Date(safeData.date) : undefined, amount: safeData.amount !== undefined ? safeData.amount : undefined, partnerId: safeData.partnerId || safeData.supplier_id || safeData.customer_id || undefined, partnerType: safeData.partnerType || (safeData.supplier_id ? "SUPPLIER" : (safeData.customer_id ? "CUSTOMER" : undefined)), paymentMethod: safeData.paymentMethod || undefined, notes: safeData.notes !== undefined ? safeData.notes : undefined, branchId: branchId, updatedAt: new Date() };
      case "CUSTOMER": case "SUPPLIER":
        return { name: safeData.name || undefined, phone: safeData.phone || undefined, email: safeData.email || undefined, balance: safeData.balance !== undefined ? safeData.balance : undefined, updatedAt: new Date() };
      default:
        return { updatedAt: new Date() };
    }
  }

  private static buildEntityCreateData(entity: string, entityId: string, data: any, tenantId: string, branchId: string | null): any {
    switch (entity.toUpperCase()) {
      case "INVOICE": case "SALE":
        return { id: entityId, invoiceNumber: data.invoiceNumber || data.invoice_number || `INV-${Date.now()}`, date: new Date(data.date || Date.now()), partnerId: data.partnerId || "", partnerType: data.partnerType || "CUSTOMER", type: data.type || "SALE", paymentStatus: data.paymentStatus || "PAID", documentStatus: data.documentStatus || "ACTIVE", totalAmount: data.totalAmount || data.total || 0, branchId: branchId, tenantId, isSynced: true };
      case "PRODUCT":
        return { id: entityId, name: data.name || "Product", sku: data.sku || `SKU-${Date.now()}`, barcode: data.barcode || null, price: data.basePrice !== undefined ? data.basePrice : (data.price !== undefined ? data.price : 0), cost: data.costPrice !== undefined ? data.costPrice : (data.cost !== undefined ? data.cost : 0), tenantId };
      case "PAYMENT": case "VOUCHER":
        return { id: entityId, paymentNumber: data.paymentNumber || data.payment_number || `PMT-${Date.now()}`, date: new Date(data.date || Date.now()), amount: data.amount || 0, partnerId: data.partnerId || data.supplier_id || data.customer_id || "", partnerType: data.partnerType || (data.supplier_id ? "SUPPLIER" : "CUSTOMER"), paymentMethod: data.paymentMethod || "CASH", notes: data.notes || null, branchId: branchId, tenantId };
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
