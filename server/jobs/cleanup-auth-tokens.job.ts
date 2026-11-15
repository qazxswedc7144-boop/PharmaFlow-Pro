import { prisma } from "../database/prisma.js";

const BATCH_SIZE = 1000;

type CleanupCounts = {
  sessions: number;
  refreshTokens: number;
};

/**
 * Deletes only expired authentication rows, in small independently committed
 * batches. SKIP LOCKED allows overlapping invocations without waiting on rows
 * already being processed by another worker.
 */
async function deleteExpiredSessionsBatch(): Promise<number> {
  return prisma.$executeRaw`
    WITH expired AS (
      SELECT "id"
      FROM "sessions"
      WHERE "expiresAt" < NOW()
      ORDER BY "expiresAt"
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "sessions" AS target
    USING expired
    WHERE target."id" = expired."id"
  `;
}

async function deleteExpiredRefreshTokensBatch(): Promise<number> {
  return prisma.$executeRaw`
    WITH expired AS (
      SELECT "id"
      FROM "refresh_tokens"
      WHERE "expiresAt" < NOW()
      ORDER BY "expiresAt"
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "refresh_tokens" AS target
    USING expired
    WHERE target."id" = expired."id"
  `;
}

async function drainBatches(deleteBatch: () => Promise<number>): Promise<number> {
  let totalDeleted = 0;

  while (true) {
    const deleted = await deleteBatch();
    if (!Number.isInteger(deleted) || deleted < 0 || deleted > BATCH_SIZE) {
      throw new Error("AUTH_TOKEN_CLEANUP_INVALID_BATCH_COUNT");
    }

    totalDeleted += deleted;
    if (deleted < BATCH_SIZE) return totalDeleted;
  }
}

export async function runCleanupAuthTokensJob(): Promise<CleanupCounts> {
  // Keep the two tables independent: a failure is surfaced to the caller and
  // never reported as a successful cleanup.
  const sessions = await drainBatches(deleteExpiredSessionsBatch);
  const refreshTokens = await drainBatches(deleteExpiredRefreshTokensBatch);

  return { sessions, refreshTokens };
}
