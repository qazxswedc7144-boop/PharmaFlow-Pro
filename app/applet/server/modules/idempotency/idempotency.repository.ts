// server/modules/idempotency/idempotency.repository.ts
import { prisma } from "../../database/prisma.js";
import { IdempotencyKey } from "@prisma/client";

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
  static async findByKey(tenantId: string, key: string): Promise<IdempotencyKey | null> {
    try {
      return await prisma.idempotencyKey.findUnique({
        where: { tenantId_key: { tenantId, key } }
      });
    } catch (error) {
      if (isDbConnectionError(error)) {
        const cacheKey = `${tenantId}:${key}`;
        const cached = inMemoryFallbackStore.get(cacheKey);
        if (cached && new Date() > cached.expiresAt) {
          inMemoryFallbackStore.delete(cacheKey);
          return null;
        }
        return cached || null;
      }
      throw error;
    }
  }

  static async acquireLock(
    tenantId: string,
    key: string,
    requestHash: string,
    endpoint: string,
    requestMethod: string,
    userId: string | null,
    expiresInMs = 24 * 60 * 60 * 1000
  ): Promise<{ record: IdempotencyKey; isNew: boolean }> {
    const expiresAt = new Date(Date.now() + expiresInMs);
    const cacheKey = `${tenantId}:${key}`;
    try {
      return await prisma.$transaction(async (tx) => {
        const existing = await tx.idempotencyKey.findUnique({
          where: { tenantId_key: { tenantId, key } }
        });
        if (existing) {
          return { record: existing, isNew: false };
        }
        const created = await tx.idempotencyKey.create({
          data: {
            key,
            tenantId,
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
          tenantId,
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
      const checkAgain = await prisma.idempotencyKey.findUnique({
        where: { tenantId_key: { tenantId, key } }
      });
      if (checkAgain) {
        return { record: checkAgain, isNew: false };
      }
      throw error;
    }
  }

  static async resolveKey(
    tenantId: string,
    key: string,
    responseBody: any,
    responseStatus: number
  ): Promise<IdempotencyKey> {
    const cacheKey = `${tenantId}:${key}`;
    try {
      return await prisma.idempotencyKey.update({
        where: { tenantId_key: { tenantId, key } },
        data: {
          processing: false,
          responseBody: responseBody ?? null,
          responseStatus,
          lockedAt: null
        }
      });
    } catch (error) {
      if (isDbConnectionError(error)) {
        const cached = inMemoryFallbackStore.get(cacheKey);
        if (cached) {
          cached.processing = false;
          cached.responseBody = responseBody ?? null;
          cached.responseStatus = responseStatus;
          cached.lockedAt = null;
          return cached;
        }
        const mockRecord: IdempotencyKey = {
          id: Math.random().toString(36).substring(3, 11),
          tenantId,
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

  static async releaseLock(tenantId: string, key: string): Promise<IdempotencyKey | null> {
    const cacheKey = `${tenantId}:${key}`;
    try {
      return await prisma.idempotencyKey.update({
        where: { tenantId_key: { tenantId, key } },
        data: {
          processing: false,
          lockedAt: null
        }
      });
    } catch (error) {
      if (isDbConnectionError(error)) {
        const cached = inMemoryFallbackStore.get(cacheKey);
        if (cached) {
          cached.processing = false;
          cached.lockedAt = null;
          return cached;
        }
        return null;
      }
      return null;
    }
  }

  static async deleteExpiredKeys(): Promise<number> {
    let memoryPurged = 0;
    const now = new Date();
    for (const [cacheKey, record] of inMemoryFallbackStore.entries()) {
      if (now > record.expiresAt) {
        inMemoryFallbackStore.delete(cacheKey);
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
