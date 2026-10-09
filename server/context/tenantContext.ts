// server/context/tenantContext.ts
import { AsyncLocalStorage } from "async_hooks";

export interface TenantContext {
  tenantId: string;
  tenantName?: string;
  branchId?: string | null;
  userId?: string | null;
  username?: string | null;
  role?: string | null;
  subscriptionPlan?: string | null;
  isActive?: boolean;
  correlationId?: string;
  requestId?: string;
  ipAddress?: string;
}

export const tenantStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Returns the active tenant context for the current asynchronous execution chain.
 */
export function getTenantContext(): TenantContext | undefined {
  return tenantStorage.getStore();
}

/**
 * Returns the current tenantId or a fallback for offline/development mode.
 */
export function getCurrentTenantId(fallback?: string): string {
  const store = tenantStorage.getStore();
  if (store?.tenantId) {
    return store.tenantId;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("TENANT_REQUIRED: tenantId is mandatory in production context.");
  }
  return fallback || process.env.DEFAULT_TENANT_ID || "dev-tenant";
}

/**
 * Returns the current correlationId if available in context.
 */
export function getCorrelationId(): string | undefined {
  return tenantStorage.getStore()?.correlationId;
}

/**
 * Returns the current requestId if available in context.
 */
export function getRequestId(): string | undefined {
  return tenantStorage.getStore()?.requestId;
}

/**
 * Helper to run a callback inside a specific tenant context.
 */
export function runWithTenantContext<T>(context: TenantContext, callback: () => T): T {
  return tenantStorage.run(context, callback);
}
