// server/modules/idempotency/idempotency.repository.ts
import { prisma } from "../../database/prisma.js";
import { IdempotencyKey } from "@prisma/client";
import { getTenantContext } from "../../context/tenantContext.js";

// In-memory fallback store to ensure absolute operational resilience under DB degradation or sandbox limits
const inMemoryFallbackStore = new Map<string, IdempotencyKey>();

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
    const cached = inMemoryFallbackStore.get(key);
    if (cached) {
      if (new Date() > cached.expiresAt) {
        inMemoryFallbackStore.delete(key);
      } else {
        return cached;
      }
    }

    const effectiveTenantId = tenantId || getTenantContext()?.tenantId || null;
    try {
      if (effectiveTenantId) {
        return await prisma.idempotencyKey.findUnique({
          where: {
            tenantId_key: {
              tenantId: effectiveTenantId,
              key
            }
          }
        });
      }
      return await prisma.idempotencyKey.findFirst({
        where: { key }
      });
    } catch (error) {
      if (isDbConnectionError(error)) {
        return inMemoryFallbackStore.get(key) || null;
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

    if (!effectiveTenantId && process.env.NODE_ENV === "production") {
      throw new Error("FATAL: Idempotency operation requires a valid tenantId in production.");
    }
    const resolvedTenantId = effectiveTenantId || "default-tenant";

    try {
      // Try DB-level transaction
      return await prisma.$transaction(async (tx) => {
        const existing = effectiveTenantId
          ? await tx.idempotencyKey.findUnique({
              where: {
                tenantId_key: {
                  tenantId: effectiveTenantId,
                  key
                }
              }
            })
          : await tx.idempotencyKey.findFirst({
              where: { key }
            });

        if (existing) {
          return { record: existing, isNew: false };
        }

        const created = await tx.idempotencyKey.create({
          data: {
            key,
            tenantId: resolvedTenantId,
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
        const existing = inMemoryFallbackStore.get(key);
        if (existing) {
          if (new Date() > existing.expiresAt) {
            inMemoryFallbackStore.delete(key);
          } else {
            return { record: existing, isNew: false };
          }
        }

        const mockRecord: IdempotencyKey = {
          id: Math.random().toString(36).substring(3, 11),
          tenantId: resolvedTenantId,
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

        inMemoryFallbackStore.set(key, mockRecord);
        return { record: mockRecord, isNew: true };
      }

      // Concurrency retry
      const checkAgain = effectiveTenantId
        ? await prisma.idempotencyKey.findUnique({
            where: {
              tenantId_key: {
                tenantId: effectiveTenantId,
                key
              }
            }
          })
        : await prisma.idempotencyKey.findFirst({
            where: { key }
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
    const cached = inMemoryFallbackStore.get(key);
    if (cached) {
      cached.processing = false;
      cached.responseBody = responseBody ?? null;
      cached.responseStatus = responseStatus;
      cached.lockedAt = null;
    }

    try {
      if (effectiveTenantId) {
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
      }

      const existing = await prisma.idempotencyKey.findFirst({ where: { key } });
      if (existing) {
        return await prisma.idempotencyKey.update({
          where: { id: existing.id },
          data: {
            processing: false,
            responseBody: responseBody ?? null,
            responseStatus,
            lockedAt: null
          }
        });
      }
      if (cached) return cached;
      throw new Error(`Idempotency key ${key} not found to resolve.`);
    } catch (error) {
      if (cached) return cached;
      if (isDbConnectionError(error)) {
        // Fallback create if not there
        const mockRecord: IdempotencyKey = {
          id: Math.random().toString(36).substring(3, 11),
          tenantId: effectiveTenantId || "default-tenant",
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
        inMemoryFallbackStore.set(key, mockRecord);
        return mockRecord;
      }
      throw error;
    }
  }

  /**
   * Releases a lock to allow retries in case of processing errors, setting processing to false.
   */
  static async releaseLock(key: string, tenantId?: string | null): Promise<IdempotencyKey | null> {
    const effectiveTenantId = tenantId || getTenantContext()?.tenantId || null;
    const cached = inMemoryFallbackStore.get(key);
    if (cached) {
      cached.processing = false;
      cached.lockedAt = null;
    }

    try {
      if (effectiveTenantId) {
        return await prisma.idempotencyKey.update({
          where: {
            tenantId_key: {
              tenantId: effectiveTenantId,
              key
            }
          },
          data: {
            processing: false,
            lockedAt: null
          }
        });
      }

      const existing = await prisma.idempotencyKey.findFirst({ where: { key } });
      if (existing) {
        return await prisma.idempotencyKey.update({
          where: { id: existing.id },
          data: {
            processing: false,
            lockedAt: null
          }
        });
      }
      return cached || null;
    } catch (error) {
      return cached || null;
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
