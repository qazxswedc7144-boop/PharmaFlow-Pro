// server/modules/idempotency/idempotency.repository.ts
import { prisma } from "../../database/prisma.js";
import { IdempotencyKey } from "@prisma/client";
import { randomUUID } from "crypto";

const inMemoryFallbackStore = new Map<string, IdempotencyKey>();
const MAX_MEMORY_ENTRIES = 5000; // حد أقصى لمنع انهيار الذاكرة (OOM)

function isDbConnectionError(err: any): boolean {
  const msg = String(err?.message || err || "");
  // تم تحسين الفحص ليكون أكثر دقة وتجنب الأخطاء العامة
  return (
    msg.includes("P1001") || // Can't reach database server
    msg.includes("P1002") || // Database server timeout
    msg.includes("P1008") || // Operations timed out
    msg.includes("P1017") || // Server has closed the connection
    msg.includes("ECONNREFUSED") ||
    msg.includes("Can't reach database")
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
        // 🚨 تحذير: هذا الفحص يعمل فقط داخل نفس الـ Instance في Vercel
        const existing = inMemoryFallbackStore.get(cacheKey);
        if (existing) {
          if (new Date() > existing.expiresAt) {
            inMemoryFallbackStore.delete(cacheKey);
          } else {
            return { record: existing, isNew: false };
          }
        }
        
        // حماية الذاكرة من الامتلاء
        if (inMemoryFallbackStore.size >= MAX_MEMORY_ENTRIES) {
          const firstKey = inMemoryFallbackStore.keys().next().value;
          if (firstKey) inMemoryFallbackStore.delete(firstKey);
        }

        const mockRecord: IdempotencyKey = {
          id: randomUUID(),
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
      
      // معالجة خطأ الـ Race Condition (إذا تم إنشاء المفتاح من طلب آخر في نفس اللحظة)
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
          id: randomUUID(),
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
      throw error; // ✅ إعادة رمي الخطأ إذا لم يكن خطأ اتصال
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
      // ✅ إعادة رمي الخطأ بدلاً من ابتلاعه
      throw error; 
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
