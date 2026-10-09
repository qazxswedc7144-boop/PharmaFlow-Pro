// server/database/tenantPrisma.ts
import { prisma } from "./prisma.js";
import { getCurrentTenantId } from "../context/tenantContext.js";

export const TENANT_OWNED_MODELS = [
  "product",
  "customer",
  "supplier",
  "invoice",
  "invoiceItem",
  "journalEntry",
  "journalLine",
  "account",
  "inventoryBatch",
  "inventoryMovement",
  "branch",
  "branchInventory",
  "branchTransfer",
  "branchTransferItem",
  "branchUser",
  "payment",
  "expense",
  "reservation",
  "customRole",
  "userRole",
  "userPermissionOverride",
  "auditLog",
  "idempotencyKey",
  "syncQueue",
  "syncEvent",
  "tenantUser",
  "tenantSubscription",
  "license",
  "usageCounter",
  "crashLog",
  "deviceRegistration",
  "aiUsageLog"
] as const;

export type TenantOwnedModel = typeof TENANT_OWNED_MODELS[number];

const TENANT_OWNED_MODELS_SET = new Set<string>(
  TENANT_OWNED_MODELS.map((m) => m.toLowerCase())
);

export function isTenantOwnedModel(modelName: string): boolean {
  return TENANT_OWNED_MODELS_SET.has(modelName.toLowerCase());
}

/**
 * Creates a tenant-isolated proxy around the Prisma Client.
 * Automatically injects tenantId filter into where clauses and sets tenantId on writes.
 */
export function getTenantScopedPrisma(explicitTenantId?: string) {
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      const propStr = String(prop);
      const modelNameLower = propStr.toLowerCase();

      // If prop is a tenant-owned model
      if (isTenantOwnedModel(modelNameLower)) {
        const rawModel = (target as any)[prop];
        if (!rawModel) return rawModel;

        return new Proxy(rawModel, {
          get(modelTarget, operationProp) {
            const operation = String(operationProp);
            const originalMethod = modelTarget[operationProp];

            if (typeof originalMethod !== "function") {
              return originalMethod;
            }

            return async (...args: any[]) => {
              const currentTenantId = explicitTenantId || getCurrentTenantId();
              const [params = {}, ...rest] = args;

              // Read operations: inject tenantId into where filter
              if (["findMany", "findFirst", "count", "aggregate", "groupBy"].includes(operation)) {
                const scopedParams = {
                  ...params,
                  where: {
                    ...(params.where || {}),
                    tenantId: currentTenantId
                  }
                };
                return originalMethod.apply(modelTarget, [scopedParams, ...rest]);
              }

              // findUnique: translate to findFirst with tenant isolation to prevent cross-tenant ID discovery
              if (operation === "findUnique" || operation === "findUniqueOrThrow") {
                const scopedWhere = {
                  ...(params.where || {}),
                  tenantId: currentTenantId
                };
                return (modelTarget.findFirst || originalMethod).apply(modelTarget, [{
                  ...params,
                  where: scopedWhere
                }, ...rest]);
              }

              // Create operations: inject tenantId into data
              if (operation === "create") {
                const data = params.data || {};
                const scopedData = {
                  ...data,
                  tenantId: data.tenantId || currentTenantId
                };
                return originalMethod.apply(modelTarget, [{ ...params, data: scopedData }, ...rest]);
              }

              if (operation === "createMany") {
                const data = params.data;
                const scopedData = Array.isArray(data)
                  ? data.map((d: any) => ({ ...d, tenantId: d.tenantId || currentTenantId }))
                  : data;
                return originalMethod.apply(modelTarget, [{ ...params, data: scopedData }, ...rest]);
              }

              // Upsert operations: inject tenantId into where, update, and create
              if (operation === "upsert") {
                const scopedWhere = {
                  ...(params.where || {}),
                  tenantId: currentTenantId
                };
                const scopedCreate = {
                  ...(params.create || {}),
                  tenantId: params.create?.tenantId || currentTenantId
                };
                return originalMethod.apply(modelTarget, [{
                  ...params,
                  where: scopedWhere,
                  create: scopedCreate
                }, ...rest]);
              }

              // Update / Delete operations: enforce tenantId in where clause
              if (["update", "updateMany", "delete", "deleteMany"].includes(operation)) {
                const scopedWhere = {
                  ...(params.where || {}),
                  tenantId: currentTenantId
                };
                return originalMethod.apply(modelTarget, [{
                  ...params,
                  where: scopedWhere
                }, ...rest]);
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
 * Validates whether a given entity's tenantId matches the requesting tenant context.
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
