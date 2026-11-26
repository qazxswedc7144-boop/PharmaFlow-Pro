// server/modules/idempotency/idempotency.repository.ts
import { prisma } from "../../database/prisma.js";
import { IdempotencyKey } from "@prisma/client";
import { getTenantContext } from "../../context/tenantContext.js";

// In-memory fallback store to ensure absolute operational resilience under DB degradation or sandbox limits
// Note: Process-local only; never guarantees distributed multi-server idempotency.
const inMemoryFallbackStore = new Map<string, IdempotencyKey>();

export type IdempotencyLockReleaseStatus = "RELEASED" | "NOT_FOUND" | "DB_ERROR";

export interface IdempotencyLockReleaseResult {
  status: IdempotencyLockReleaseStatus;
  released: boolean;
  releasedCount: number;
  durableConfirmed: boolean;
  error?: unknown;
}

function isDbConnectionError(err: any): boolean {
  const msg = String(err?.message || err || "");
  return (
    msg.includes("P1001") ||
    msg.includes("P1002") ||
    msg.includes("P1008") ||
    msg.includes("P1017") ||
    msg.includes("Can't reach database") || 
    msg.includes("Database unavailable") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("database server") ||
    msg.includes("Closed") ||
    msg.includes("closed") ||
    msg.includes("connection") ||
    msg.includes("socket") ||
    msg.includes("terminated") ||
    msg.includes("reach database") ||
    msg.includes("Can't reach")
  );
}

export class IdempotencyRepository {
  /**
   * Retrieves an idempotency key record from the database, falling back to cache if DB is offline.
   */
  static async findByKey(key: string, tenantId?: string | null): Promise<IdempotencyKey | null> {
    const effectiveTenantId = tenantId || getTenantContext()?.tenantId || null;
    if (!effectiveTenantId) {
      throw new Error("TENANT_ID_REQUIRED_FOR_IDEMPOTENCY: findByKey requires a tenantId.");
    }
    const cacheKey = `${effectiveTenantId}:${key}`;
    const cached = inMemoryFallbackStore.get(cacheKey);
    if (cached) {
      if (new Date() > cached.expiresAt) {
        inMemoryFallbackStore.delete(cacheKey);
      } else {
        return cached;
      }
    }

    try {
      return await prisma.idempotencyKey.findUnique({
        where: {
          tenantId_key: {
            tenantId: effectiveTenantId,
            key
          }
        }
      });
    } catch (error) {
      if (isDbConnectionError(error)) {
        return inMemoryFallbackStore.get(cacheKey) || null;
      }
      throw error;
    }
  }

  /**
   * Tries to find or create a lock for a given key.
   */
  static async acquireLock(
    key: string,
    requestHash: string,
    endpoint: string,
    requestMethod: string,
    userId: string | null,
    tenantId: string | null = null,
    expiresInMs = 24 * 60 * 60 * 1000 // default 24 hours
  ): Promise<{ record: IdempotencyKey; isNew: boolean }> {
    const expiresAt = new Date(Date.now() + expiresInMs);
    const effectiveTenantId = tenantId || getTenantContext()?.tenantId || null;

    if (!effectiveTenantId) {
      throw new Error("TENANT_ID_REQUIRED_FOR_IDEMPOTENCY: acquireLock requires a valid tenantId.");
    }
    const cacheKey = `${effectiveTenantId}:${key}`;

    try {
      // Try DB-level transaction
      return await prisma.$transaction(async (tx) => {
        const existing = await tx.idempotencyKey.findUnique({
          where: {
            tenantId_key: {
              tenantId: effectiveTenantId,
              key
            }
          }
        });

        if (existing) {
          return { record: existing, isNew: false };
        }

        const created = await tx.idempotencyKey.create({
          data: {
            key,
            tenantId: effectiveTenantId,
            requestHash,
            endpoint,
            requestMethod,
            userId,
            processing: true,
            lockedAt: new Date(),
            expiresAt
          }
        });

        return { record: created, isNew: true };
      });
    } catch (error) {
      if (isDbConnectionError(error)) {
        const existing = inMemoryFallbackStore.get(cacheKey);
        if (existing) {
          if (new Date() > existing.expiresAt) {
            inMemoryFallbackStore.delete(cacheKey);
          } else {
            return { record: existing, isNew: false };
          }
        }

        const mockRecord: IdempotencyKey = {
          id: Math.random().toString(36).substring(3, 11),
          tenantId: effectiveTenantId,
          key,
          requestHash,
          endpoint,
          requestMethod,
          userId,
          responseBody: null,
          responseStatus: null,
          processing: true,
          lockedAt: new Date(),
          expiresAt,
          createdAt: new Date()
        };

        inMemoryFallbackStore.set(cacheKey, mockRecord);
        return { record: mockRecord, isNew: true };
      }

      // Concurrency retry
      const checkAgain = await prisma.idempotencyKey.findUnique({
        where: {
          tenantId_key: {
            tenantId: effectiveTenantId,
            key
          }
        }
      });
      if (checkAgain) {
        return { record: checkAgain, isNew: false };
      }
      throw error;
    }
  }

  /**
   * Persists the outcome of the request under the safe key, setting processing to false.
   */
  static async resolveKey(
    key: string,
    responseBody: any,
    responseStatus: number,
    tenantId?: string | null
  ): Promise<IdempotencyKey> {
    const effectiveTenantId = tenantId || getTenantContext()?.tenantId || null;
    if (!effectiveTenantId) {
      throw new Error("TENANT_ID_REQUIRED_FOR_IDEMPOTENCY: resolveKey requires a tenantId.");
    }
    const cacheKey = `${effectiveTenantId}:${key}`;
    const cached = inMemoryFallbackStore.get(cacheKey);
    if (cached) {
      cached.processing = false;
      cached.responseBody = responseBody ?? null;
      cached.responseStatus = responseStatus;
      cached.lockedAt = null;
    }

    try {
      return await prisma.idempotencyKey.update({
        where: {
          tenantId_key: {
            tenantId: effectiveTenantId,
            key
          }
        },
        data: {
          processing: false,
          responseBody: responseBody ?? null,
          responseStatus,
          lockedAt: null
        }
      });
    } catch (error) {
      if (cached) return cached;
      if (isDbConnectionError(error)) {
        // Fallback create if not there
        const mockRecord: IdempotencyKey = {
          id: Math.random().toString(36).substring(3, 11),
          tenantId: effectiveTenantId,
          key,
          requestHash: "",
          endpoint: "",
          requestMethod: "",
          userId: null,
          responseBody: responseBody ?? null,
          responseStatus,
          processing: false,
          lockedAt: null,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          createdAt: new Date()
        };
        inMemoryFallbackStore.set(cacheKey, mockRecord);
        return mockRecord;
      }
      throw error;
    }
  }

  /**
   * Releases an unresolved lock (responseStatus === null) in durable PostgreSQL storage first,
   * then removes any matching unresolved process-local cache entry only after DB confirmation.
   * Returns an explicit discriminated result distinguishing RELEASED, NOT_FOUND, and DB_ERROR.
   */
  static async releaseLock(
    key: string,
    tenantId?: string | null
  ): Promise<IdempotencyLockReleaseResult> {
    const effectiveTenantId = tenantId || getTenantContext()?.tenantId || null;
    if (!effectiveTenantId) {
      throw new Error("TENANT_ID_REQUIRED_FOR_IDEMPOTENCY: releaseLock requires a tenantId.");
    }
    const cacheKey = `${effectiveTenantId}:${key}`;

    try {
      const deleteResult = await prisma.idempotencyKey.deleteMany({
        where: {
          tenantId: effectiveTenantId,
          key,
          responseStatus: null
        }
      });

      const releasedCount = Number(deleteResult?.count ?? 0);

      if (releasedCount > 0) {
        const cached = inMemoryFallbackStore.get(cacheKey);
        if (cached && cached.responseStatus === null) {
          inMemoryFallbackStore.delete(cacheKey);
        }
        return {
          status: "RELEASED",
          released: true,
          releasedCount,
          durableConfirmed: true
        };
      }

      // Durable DB confirmed zero releasable unresolved rows for this tenant+key.
      // Never delete a resolved entry (responseStatus !== null) and never report
      // RELEASED from process-local memory alone.
      const cached = inMemoryFallbackStore.get(cacheKey);
      if (cached && cached.responseStatus === null) {
        inMemoryFallbackStore.delete(cacheKey);
      }
      return {
        status: "NOT_FOUND",
        released: false,
        releasedCount: 0,
        durableConfirmed: true
      };
    } catch (error) {
      // Do NOT remove the local cache entry when durable DB release fails,
      // and do NOT swallow the DB failure as a successful release.
      return {
        status: "DB_ERROR",
        released: false,
        releasedCount: 0,
        durableConfirmed: false,
        error
      };
    }
  }

  /**
   * Cleans up expired keys from the database.
   */
  static async deleteExpiredKeys(): Promise<number> {
    let memoryPurged = 0;
    const now = new Date();

    // In-memory sweeping
    for (const [key, record] of inMemoryFallbackStore.entries()) {
      if (now > record.expiresAt) {
        inMemoryFallbackStore.delete(key);
        memoryPurged++;
      }
    }

    try {
      const result = await prisma.idempotencyKey.deleteMany({
        where: {
          expiresAt: {
            lt: now
          }
        }
      });
      return result.count + memoryPurged;
    } catch (error) {
      if (isDbConnectionError(error)) {
        return memoryPurged;
      }
      throw error;
    }
  }
}
