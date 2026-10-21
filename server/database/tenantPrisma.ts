// server/database/tenantPrisma.ts
import { prisma } from "./prisma.js";
import { getCurrentTenantId } from "../context/tenantContext.js";
import { Prisma } from "@prisma/client";

export const TENANT_OWNED_MODELS = [
  "product", "customer", "supplier", "invoice", "invoiceItem",
  "journalEntry", "journalLine", "account", "inventoryBatch",
  "inventoryMovement", "branch", "branchInventory", "branchTransfer",
  "branchTransferItem", "branchUser", "payment", "expense",
  "reservation", "customRole", "userRole", "userPermissionOverride",
  "auditLog", "idempotencyKey", "syncQueue", "syncEvent",
  "tenantUser", "tenantSubscription", "license", "usageCounter",
  "crashLog", "deviceRegistration", "aiUsageLog"
] as const;

export type TenantOwnedModel = typeof TENANT_OWNED_MODELS[number];

const TENANT_OWNED_MODELS_SET = new Set<string>(
  TENANT_OWNED_MODELS.map((m) => m.toLowerCase())
);

const SYSTEM_ALLOWED_MODELS = new Set(["customrole"]);

export function isTenantOwnedModel(modelName: string): boolean {
  return TENANT_OWNED_MODELS_SET.has(modelName.toLowerCase());
}

/**
 * دالة مساعدة لحقن tenantId بشكل تعاودي في عمليات الكتابة المتداخلة
 */
function injectTenantIdToData(data: any, currentTenantId: string, modelName: string): any {
  if (!data || typeof data !== "object") return data;

  const isSystemAllowed = SYSTEM_ALLOWED_MODELS.has(modelName.toLowerCase());
  const targetTenantId = isSystemAllowed && data.isSystemRole ? null : (data.tenantId || currentTenantId);

  const newData = { ...data, tenantId: targetTenantId };

  // معالجة العلاقات المتداخلة
  for (const key of Object.keys(newData)) {
    const value = newData[key];
    if (value && typeof value === "object") {
      if (value.create) {
        newData[key] = {
          ...value,
          create: injectTenantIdToData(value.create, currentTenantId, key)
        };
      } else if (value.createMany && Array.isArray(value.createMany.data)) {
        newData[key] = {
          ...value,
          createMany: {
            ...value.createMany,
            data: value.createMany.data.map((item: any) => injectTenantIdToData(item, currentTenantId, key))
          }
        };
      } else if (value.update) {
        newData[key] = {
          ...value,
          update: injectTenantIdToData(value.update, currentTenantId, key)
        };
      }
    }
  }

  return newData;
}

/**
 * ينشئ وكيل (Proxy) معزول للمستأجر
 */
export function getTenantScopedPrisma(explicitTenantId?: string) {
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      const propStr = String(prop);
      const modelNameLower = propStr.toLowerCase();

      if (isTenantOwnedModel(modelNameLower)) {
        const rawModel = (target as any)[prop];
        if (!rawModel) return rawModel;

        return new Proxy(rawModel, {
          get(modelTarget, operationProp) {
            const operation = String(operationProp);
            const originalMethod = modelTarget[operationProp as keyof typeof modelTarget];

            if (typeof originalMethod !== "function") {
              return originalMethod;
            }

            return async (...args: any[]) => {
              const currentTenantId = explicitTenantId || getCurrentTenantId();
              
              // 🚨 حماية إضافية: إذا حاول مستخدم تمرير tenantId لمؤسسة أخرى
              if (explicitTenantId && getCurrentTenantId() && explicitTenantId !== getCurrentTenantId()) {
                throw new Error("SECURITY_VIOLATION: Cannot specify a different tenantId.");
              }

              const [params = {}, ...rest] = args;
              const isSystemAllowed = SYSTEM_ALLOWED_MODELS.has(modelNameLower);

              // 1. عمليات القراءة
              if (["findMany", "findFirst", "count", "aggregate", "groupBy"].includes(operation)) {
                let scopedWhere = { ...(params.where || {}) };
                
                if (isSystemAllowed) {
                  scopedWhere = {
                    AND: [scopedWhere, { OR: [{ tenantId: currentTenantId }, { isSystemRole: true }] }]
                  };
                } else {
                  scopedWhere = { ...scopedWhere, tenantId: currentTenantId };
                }

                return originalMethod.apply(modelTarget, [{ ...params, where: scopedWhere }, ...rest]);
              }

              // 2. عمليات البحث الفريد
              if (operation === "findUnique" || operation === "findUniqueOrThrow") {
                let scopedWhere = { ...(params.where || {}) };
                
                if (isSystemAllowed) {
                  scopedWhere = {
                    AND: [scopedWhere, { OR: [{ tenantId: currentTenantId }, { isSystemRole: true }] }]
                  };
                } else {
                  scopedWhere = { ...scopedWhere, tenantId: currentTenantId };
                }

                const result = await modelTarget.findFirst({ ...params, where: scopedWhere });
                
                // 🚨 إصلاح: رمي خطأ Prisma الصحيح بدلاً من Error عادي
                if (operation === "findUniqueOrThrow" && !result) {
                  throw new Prisma.PrismaClientKnownRequestError(
                    `No ${propStr} found`,
                    { code: 'P2025', clientVersion: Prisma.prismaVersion.client }
                  );
                }
                
                return result;
              }

              // 3. عمليات الإنشاء
              if (operation === "create") {
                const scopedData = injectTenantIdToData(params.data || {}, currentTenantId, modelNameLower);
                return originalMethod.apply(modelTarget, [{ ...params, data: scopedData }, ...rest]);
              }

              // 4. عمليات الإنشاء المتعدد
              if (operation === "createMany") {
                const data = params.data;
                const scopedData = Array.isArray(data)
                  ? data.map((d: any) => injectTenantIdToData(d, currentTenantId, modelNameLower))
                  : data;
                return originalMethod.apply(modelTarget, [{ ...params, data: scopedData }, ...rest]);
              }

              // 5. عمليات التحديث أو الإنشاء
              if (operation === "upsert") {
                let scopedWhere = { ...(params.where || {}) };
                if (isSystemAllowed) {
                  scopedWhere = { AND: [scopedWhere, { OR: [{ tenantId: currentTenantId }, { isSystemRole: true }] }] };
                } else {
                  scopedWhere = { ...scopedWhere, tenantId: currentTenantId };
                }

                const scopedCreate = injectTenantIdToData(params.create || {}, currentTenantId, modelNameLower);
                const scopedUpdate = injectTenantIdToData(params.update || {}, currentTenantId, modelNameLower);
                
                return originalMethod.apply(modelTarget, [{
                  ...params,
                  where: scopedWhere,
                  create: scopedCreate,
                  update: scopedUpdate
                }, ...rest]);
              }

              // 6. عمليات التحديث والحذف
              if (["update", "updateMany", "delete", "deleteMany"].includes(operation)) {
                let scopedWhere = { ...(params.where || {}) };
                
                if (isSystemAllowed) {
                  scopedWhere = { ...scopedWhere, tenantId: currentTenantId, isSystemRole: false };
                } else {
                  scopedWhere = { ...scopedWhere, tenantId: currentTenantId };
                }

                if (operation === "update" && params.data) {
                   params.data = injectTenantIdToData(params.data, currentTenantId, modelNameLower);
                }

                return originalMethod.apply(modelTarget, [{ ...params, where: scopedWhere }, ...rest]);
              }

              return originalMethod.apply(modelTarget, args);
            };
          }
        });
      }

      return Reflect.get(target, prop, receiver);
    }
  });
}

export const tenantPrisma = getTenantScopedPrisma();

/**
 * التحقق من صحة وصول المستأجر لسجل معين
 */
export function validateTenantAccess(recordTenantId?: string | null, targetTenantId?: string): boolean {
  const current = targetTenantId || getCurrentTenantId();
  if (!current || current === "default-tenant") {
    return false;
  }
  if (!recordTenantId) {
    return false;
  }
  return recordTenantId === current;
    }
