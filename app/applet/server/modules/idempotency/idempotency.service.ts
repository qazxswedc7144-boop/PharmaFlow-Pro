// server/modules/idempotency/idempotency.service.ts
import crypto from "crypto";
import pino from "pino";
import { IdempotencyRepository } from "./idempotency.repository.js";
import { IdempotencyMetrics } from "./idempotency.types.js";

const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  base: { service: "pharmaflow-idempotency" },
  timestamp: pino.stdTimeFunctions.isoTime
});

const metrics: IdempotencyMetrics = {
  preventedDuplicates: 0,
  replayedRequests: 0,
  hashMismatches: 0,
  concurrentLockPrevention: 0
};

export class IdempotencyService {
  private static inFlightKeys = new Set<string>();

  static generateRequestHash(
    endpoint: string,
    method: string,
    body: any,
    userId: string | null
  ): string {
    const serializedBody = typeof body === "string" 
      ? body 
      : JSON.stringify(body ?? {});
          
    const rawString = `${method.toUpperCase()}:${endpoint}:${serializedBody}:${userId ?? "anonymous"}`;
    return crypto.createHash("sha256").update(rawString).digest("hex");
  }

  static getMetrics(): IdempotencyMetrics {
    return { ...metrics };
  }

  static async handlePreRequest(
    tenantId: string = "default-tenant",
    key: string,
    endpoint: string,
    method: string,
    body: any,
    userId: string | null
  ): Promise<{ status: "PROCESS"; hash: string } | { status: "REPLAY"; code: number; body: any }> {
    const threadKey = `${tenantId}:${key}`;
    if (this.inFlightKeys.has(threadKey)) {
      metrics.concurrentLockPrevention++;
      logger.warn({ tenantId, key, endpoint, method }, "Locked concurrent execution prevented via in-flight registry.");
      throw new Error("CONCURRENT_LOCK");
    }

    this.inFlightKeys.add(threadKey);
    try {
      const hash = this.generateRequestHash(endpoint, method, body, userId);
      const existing = await IdempotencyRepository.findByKey(tenantId, key);
      if (existing) {
        if (existing.processing) {
          metrics.concurrentLockPrevention++;
          logger.warn({ tenantId, key, endpoint, method }, "Concurrent attempt blocked right after retrieval conflict.");
          throw new Error("CONCURRENT_LOCK");
        }
        if (existing.requestHash !== hash) {
          metrics.hashMismatches++;
          logger.error(
            { tenantId, key, existingHash: existing.requestHash, incomingHash: hash, endpoint, method },
            "Idempotency key abuse security check failed. Body payload mismatch."
          );
          throw new Error("HASH_MISMATCH");
        }
        metrics.preventedDuplicates++;
        metrics.replayedRequests++;
        logger.info(
          { tenantId, key, responseStatus: existing.responseStatus, endpoint },
          "Duplicate attempt intercepted. Replaying previous safe financial outcome."
        );
        this.inFlightKeys.delete(threadKey);
        return {
          status: "REPLAY",
          code: existing.responseStatus ?? 200,
          body: existing.responseBody
        };
      }

      const { record, isNew } = await IdempotencyRepository.acquireLock(
        tenantId,
        key,
        hash,
        endpoint,
        method,
        userId
      );
      if (!isNew && record.processing) {
        metrics.concurrentLockPrevention++;
        logger.warn({ tenantId, key, endpoint, method }, "Concurrent attempt blocked on db lock acquisition.");
        throw new Error("CONCURRENT_LOCK");
      }
      logger.info({ tenantId, key, endpoint, method, userId, hash }, "Idempotency key acquired. Proceeding to process.");
      return { status: "PROCESS", hash };
    } catch (err) {
      this.inFlightKeys.delete(threadKey);
      throw err;
    }
  }

  static async resolveRequest(tenantId: string = "default-tenant", key: string, responseStatus: number, responseBody: any): Promise<void> {
    const threadKey = `${tenantId}:${key}`;
    this.inFlightKeys.delete(threadKey);
    await IdempotencyRepository.resolveKey(tenantId, key, responseBody, responseStatus);
    logger.debug({ tenantId, key, responseStatus }, "Idempotent response result cached successfully.");
  }

  static async releaseLock(tenantId: string = "default-tenant", key: string): Promise<void> {
    const threadKey = `${tenantId}:${key}`;
    this.inFlightKeys.delete(threadKey);
    await IdempotencyRepository.releaseLock(tenantId, key);
    logger.warn({ tenantId, key }, "Processing lock released due to system recovery intervention.");
  }
}
