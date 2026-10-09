// server/modules/sync/sync-idempotency.service.ts
// Logical Idempotency Engine for Phase 8.3 Enterprise Synchronization

import crypto from "crypto";
import { prisma } from "../../database/prisma.js";
import { PerMutationResult } from "./sync.types.js";

interface StoredIdempotencyRecord {
  scopedKey: string;
  tenantId: string;
  deviceId: string;
  idempotencyKey: string;
  payloadHash: string;
  result: PerMutationResult;
  status: "IN_FLIGHT" | "COMPLETED";
  createdAt: number;
  expiresAt: number;
}

export class SyncIdempotencyService {
  // In-memory cache with 24-hour TTL for processed mutations
  private static store = new Map<string, StoredIdempotencyRecord>();
  private static TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Generates composite idempotency key scoped strictly by tenant and device
   */
  static getScopedKey(tenantId: string, deviceId: string, idempotencyKey: string): string {
    return `${tenantId}:${deviceId}:${idempotencyKey}`;
  }

  /**
   * Computes SHA-256 hash of mutation payload to detect tampering and identical replays
   */
  static computePayloadHash(payload: unknown): string {
    try {
      if (payload === null || payload === undefined) return "empty_hash";
      const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
      return crypto.createHash("sha256").update(serialized || "").digest("hex");
    } catch {
      return crypto.createHash("sha256").update(String(payload)).digest("hex");
    }
  }

  /**
   * Checks if a mutation was already processed or is currently in flight.
   */
  static async check(
    tenantId: string,
    deviceId: string,
    idempotencyKey: string,
    currentPayload: unknown
  ): Promise<{
    isDuplicate: boolean;
    isPayloadMismatch: boolean;
    previousResult?: PerMutationResult;
  }> {
    const scopedKey = this.getScopedKey(tenantId, deviceId, idempotencyKey);
    
    // 1. Check in-memory first for high-speed local hits
    let existing = this.store.get(scopedKey);

    // 2. Fallback to Database for cross-instance and durability
    if (!existing) {
      try {
        const dbKey = await prisma.idempotencyKey.findUnique({
          where: {
            tenantId_key: {
              tenantId,
              key: scopedKey
            }
          }
        });
        
        if (dbKey && dbKey.expiresAt > new Date()) {
          existing = {
            scopedKey,
            tenantId,
            deviceId,
            idempotencyKey,
            payloadHash: dbKey.requestHash,
            status: dbKey.processing ? "IN_FLIGHT" : "COMPLETED",
            result: (dbKey.responseBody as any) || { status: "SUCCESS" },
            createdAt: dbKey.createdAt.getTime(),
            expiresAt: dbKey.expiresAt.getTime()
          };
          this.store.set(scopedKey, existing);
        }
      } catch (err) {
        console.warn("[SyncIdempotency] Database lookup failed:", err);
      }
    }

    if (!existing) {
      return { isDuplicate: false, isPayloadMismatch: false };
    }

    // Check expiration
    if (Date.now() > existing.expiresAt) {
      this.store.delete(scopedKey);
      return { isDuplicate: false, isPayloadMismatch: false };
    }

    const currentHash = this.computePayloadHash(currentPayload);
    const isPayloadMismatch = existing.payloadHash !== currentHash;

    return {
      isDuplicate: true,
      isPayloadMismatch,
      previousResult: existing.result
    };
  }

  /**
   * Checks idempotency status returning detailed state for test suite and API
   */
  static async checkIdempotency(params: {
    tenantId: string;
    deviceId: string;
    idempotencyKey: string;
    payload: unknown;
  }): Promise<{
    status: "NOT_SEEN" | "SEEN_SUCCESS" | "HASH_MISMATCH" | "IN_FLIGHT";
    cachedResponse?: any;
  }> {
    const scopedKey = this.getScopedKey(params.tenantId, params.deviceId, params.idempotencyKey);
    const existing = this.store.get(scopedKey);

    if (!existing) {
      return { status: "NOT_SEEN" };
    }

    if (Date.now() > existing.expiresAt) {
      this.store.delete(scopedKey);
      return { status: "NOT_SEEN" };
    }

    const currentHash = this.computePayloadHash(params.payload);
    if (existing.payloadHash !== currentHash) {
      return { status: "HASH_MISMATCH" };
    }

    if (existing.status === "IN_FLIGHT") {
      return { status: "IN_FLIGHT" };
    }

    return {
      status: "SEEN_SUCCESS",
      cachedResponse: existing.result.details || existing.result
    };
  }

  /**
   * Marks a mutation as currently in-flight to prevent race condition replays
   */
  static async markInFlight(params: {
    tenantId: string;
    deviceId: string;
    idempotencyKey: string;
    payload: unknown;
  }): Promise<void> {
    const scopedKey = this.getScopedKey(params.tenantId, params.deviceId, params.idempotencyKey);
    const now = Date.now();
    const payloadHash = this.computePayloadHash(params.payload);

    this.store.set(scopedKey, {
      scopedKey,
      tenantId: params.tenantId,
      deviceId: params.deviceId,
      idempotencyKey: params.idempotencyKey,
      payloadHash,
      status: "IN_FLIGHT",
      result: {
        mutationId: params.idempotencyKey,
        status: "DUPLICATE",
        message: "Operation currently in flight"
      },
      createdAt: now,
      expiresAt: now + this.TTL_MS
    });
  }

  /**
   * Records a successful execution in idempotency store
   */
  static async recordSuccess(params: {
    tenantId: string;
    deviceId: string;
    idempotencyKey: string;
    payload: unknown;
    response: any;
  }): Promise<void> {
    const scopedKey = this.getScopedKey(params.tenantId, params.deviceId, params.idempotencyKey);
    const now = Date.now();
    const payloadHash = this.computePayloadHash(params.payload);

    this.store.set(scopedKey, {
      scopedKey,
      tenantId: params.tenantId,
      deviceId: params.deviceId,
      idempotencyKey: params.idempotencyKey,
      payloadHash,
      status: "COMPLETED",
      result: {
        mutationId: params.idempotencyKey,
        status: "DUPLICATE",
        details: params.response,
        processedAt: new Date().toISOString()
      },
      createdAt: now,
      expiresAt: now + this.TTL_MS
    });
  }

  /**
   * Records a processed mutation result
   */
  static async record(
    tenantId: string,
    deviceId: string,
    idempotencyKey: string,
    payload: unknown,
    result: PerMutationResult,
    tx?: any
  ): Promise<void> {
    const scopedKey = this.getScopedKey(tenantId, deviceId, idempotencyKey);
    const now = Date.now();
    const payloadHash = this.computePayloadHash(payload);
    const expiresAt = now + this.TTL_MS;

    const record: StoredIdempotencyRecord = {
      scopedKey,
      tenantId,
      deviceId,
      idempotencyKey,
      payloadHash,
      status: "COMPLETED",
      result: {
        ...result,
        status: "DUPLICATE" // When replayed in future, indicate DUPLICATE status
      },
      createdAt: now,
      expiresAt: expiresAt
    };

    // 1. Memory update
    this.store.set(scopedKey, record);

    // 2. Database update
    const client = tx || prisma;
    try {
      await client.idempotencyKey.upsert({
        where: {
          tenantId_key: {
            tenantId,
            key: scopedKey
          }
        },
        create: {
          key: scopedKey,
          tenantId,
          requestHash: payloadHash,
          endpoint: "sync_mutation",
          requestMethod: "POST",
          responseBody: record.result as any,
          responseStatus: 200,
          processing: false,
          expiresAt: new Date(expiresAt)
        },
        update: {
          responseBody: record.result as any,
          processing: false,
          expiresAt: new Date(expiresAt)
        }
      });
    } catch (err) {
      console.warn("[SyncIdempotency] Database persistence failed:", err);
    }
  }

  /**
   * Clean up expired entries periodically
   */
  static cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, item] of this.store.entries()) {
      if (now > item.expiresAt) {
        this.store.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }
}
