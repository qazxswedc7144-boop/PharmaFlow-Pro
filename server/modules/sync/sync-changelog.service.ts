// server/modules/sync/sync-changelog.service.ts
// Change Log and Cursor-Based Delta Engine for Phase 8.3 Enterprise Synchronization

import { SyncChange } from "./sync.types.js";
import { prisma } from "../../database/prisma.js";

export class SyncChangelogService {
  // In-memory change log ring buffer for high performance with durable storage
  private static changes: SyncChange[] = [];
  private static cursorCounter: number = Date.now();
  private static MAX_IN_MEMORY_LOGS = 5000;

  /**
   * Generates next monotonic sequence cursor
   */
  private static getNextCursor(): number {
    this.cursorCounter++;
    return this.cursorCounter;
  }

  /**
   * Appends a new change record to the sync change log
   */
  static recordChange(change: Omit<SyncChange, "id" | "cursor" | "createdAt">, tx: any): Promise<SyncChange>;
  static recordChange(change: Omit<SyncChange, "id" | "cursor" | "createdAt">): SyncChange;
  static recordChange(
    change: Omit<SyncChange, "id" | "cursor" | "createdAt">,
    tx?: any
  ): SyncChange | Promise<SyncChange> {
    const cursor = this.getNextCursor();
    const id = `CHG-${cursor}-${Math.random().toString(36).substring(2, 7)}`;
    const createdAt = new Date().toISOString();

    // This is a plain value, not a Promise/thenable. Returning a thenable that
    // resolves to itself causes Promise assimilation to recurse until heap exhaustion.
    const fullChange = {
      ...change,
      id,
      cursor,
      createdAt,
      valueOf() { return this.cursor; },
      [Symbol.toPrimitive]() { return this.cursor; },
    } as SyncChange & { valueOf(): number; [Symbol.toPrimitive](): number };

    // 1. Record in-memory for immediate use in current request lifecycle/process
    this.changes.push(fullChange as any);

    // Keep memory footprint controlled
    if (this.changes.length > this.MAX_IN_MEMORY_LOGS) {
      this.changes.splice(0, this.changes.length - this.MAX_IN_MEMORY_LOGS);
    }

    // 2. Persist to Prisma SyncEvent log. In a business transaction, return a
    // Promise that resolves only after the event is written on that same tx.
    const client = tx || prisma;
    const eventPromise = client.syncEvent.create({
      data: {
        eventId: id,
        tenantId: change.tenantId,
        clientTime: new Date(createdAt),
        userId: change.actorId || "system",
        deviceId: change.deviceId || "system",
        eventType: change.operation,
        entityType: change.entity,
        entityId: change.entityId,
        payload: change.payload as any,
        branchId: change.branchId || null
      }
    });

    if (tx) {
      return eventPromise.then(() => fullChange);
    }

    // Preserve the synchronous in-memory return for legacy non-transactional
    // callers while keeping their durable write best-effort as before.
    if (prisma.isConnected && prisma.isConnected()) {
      eventPromise.catch((err: any) => {
        console.warn("[SyncChangelog] Prisma sync event logging warning:", err.message);
      });
    }

    return fullChange;
  }

  /**
   * Pulls delta changes strictly filtered by tenantId, branchId, and cursor
   */
  static async getChangesSince(params: {
    tenantId: string;
    branchId?: string | null;
    cursor?: number | string;
    batchSize?: number;
    entities?: string[];
  }): Promise<{
    changes: SyncChange[];
    cursor: number;
    nextCursor: number;
    hasMore: boolean;
  }> {
    const minCursor = Number(params.cursor) || 0;
    const batchSize = Math.min(params.batchSize || 100, 500);

    // Filter in-memory logs first
    let matchingChanges = this.changes.filter((c) => {
      // 1. Strict Tenant Filtering
      if (c.tenantId !== params.tenantId) return false;

      // 2. Cursor Filtering
      if (c.cursor <= minCursor) return false;

      // 3. Entity Filtering (optional)
      if (params.entities && params.entities.length > 0) {
        if (!params.entities.includes(c.entity)) return false;
      }

      // 4. Branch Filtering (Global items have branchId: null)
      if (params.branchId && c.branchId && c.branchId !== params.branchId) {
        return false;
      }

      return true;
    });

    // If memory has fewer records than requested or is empty, try database fallback
    if (matchingChanges.length === 0 && prisma.isConnected && prisma.isConnected()) {
      try {
        const dbEvents = await prisma.syncEvent.findMany({
          where: {
            tenantId: params.tenantId,
            branchId: params.branchId || undefined,
            id: minCursor ? { gt: String(minCursor) } : undefined
          },
          take: batchSize + 1,
          orderBy: { createdAt: "asc" }
        }).catch(() => []);

        matchingChanges = dbEvents.map((evt, idx) => ({
          id: evt.eventId,
          tenantId: evt.tenantId || params.tenantId,
          branchId: evt.branchId || null,
          entity: evt.entityType,
          entityId: evt.entityId,
          operation: evt.eventType as any,
          version: 1,
          mutationId: evt.eventId,
          createdAt: evt.createdAt.toISOString(),
          actorId: evt.userId,
          deviceId: evt.deviceId,
          payload: (evt.payload as any) || {},
          cursor: minCursor + idx + 1
        }));
      } catch (err: any) {
        console.warn("[SyncChangelog] Database fallback error:", err.message);
      }
    }

    const hasMore = matchingChanges.length > batchSize;
    const paged = matchingChanges.slice(0, batchSize);
    const lastChange = paged[paged.length - 1];
    const nextCursor = lastChange ? lastChange.cursor : minCursor;

    return {
      changes: paged,
      cursor: minCursor,
      nextCursor,
      hasMore
    };
  }

  /**
   * Gets current global sequence cursor
   */
  static getCurrentCursor(): number {
    return this.cursorCounter;
  }
}
