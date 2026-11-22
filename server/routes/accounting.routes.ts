// server/routes/accounting.routes.ts
import { Router, Response } from "express";
import { tenantPrisma as prisma } from "../database/tenantPrisma.js";
import { OfflineDatabaseError } from "../database/prisma.js";
import { runInTransaction } from "../core/database/transactionGuard.js";
import { authenticateToken, requireRoles, AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { Prisma, Role } from "@prisma/client";
import { LockingService } from "../modules/locking/locking.service.js";
import { AccountingEntrySchema } from "../../src/shared/validation/accounting.schema.js";
import { validateRequestBody } from "../middleware/validate.js";

export const accountingRouter = Router();

/**
 * Stored account balances use the universal debit-minus-credit convention.
 * Positive values are debit balances; negative values are credit balances,
 * regardless of the account's normal balance type.
 */
export function toTrialBalanceColumns(rawBalance: number): { debit: number; credit: number } {
  return rawBalance >= 0
    ? { debit: rawBalance, credit: 0 }
    : { debit: 0, credit: Math.abs(rawBalance) };
}

type AccountingPeriodInput = {
  clientId: string;
  startDate: Date;
  endDate: Date;
  isLocked: boolean;
};

function parseAccountingPeriodInput(value: any): AccountingPeriodInput | null {
  if (!value || typeof value !== "object" ||
      typeof value.clientId !== "string" || !value.clientId.trim() ||
      value.clientId.length > 128 ||
      typeof value.startDate !== "string" ||
      typeof value.endDate !== "string" ||
      (value.isLocked !== undefined && typeof value.isLocked !== "boolean")) {
    return null;
  }
  const startDate = new Date(value.startDate);
  const endDate = new Date(value.endDate);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate < startDate) {
    return null;
  }
  return {
    clientId: value.clientId.trim(),
    startDate,
    endDate,
    isLocked: value.isLocked === true
  };
}

function periodDto(period: any) {
  return {
    id: period.clientId,
    clientId: period.clientId,
    startDate: period.startDate.toISOString(),
    endDate: period.endDate.toISOString(),
    isLocked: period.isLocked,
    lockedBy: period.lockedBy,
    lockedAt: period.lockedAt?.toISOString() ?? null
  };
}

function periodsDoNotOverlap(periods: AccountingPeriodInput[]): boolean {
  const ordered = [...periods].sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  for (let index = 1; index < ordered.length; index += 1) {
    const current = ordered[index];
    const previous = ordered[index - 1];
    if (current && previous && current.startDate <= previous.endDate) return false;
  }
  return true;
}

function getTrustedPeriodTenant(req: AuthenticatedRequest, res: Response): string | null {
  const tenantId = req.user?.tenantId?.trim();
  const requestTenantId = (req as any).tenantId;
  if (!tenantId || (requestTenantId && requestTenantId !== tenantId)) {
    res.status(403).json({ error: "TRUSTED_TENANT_CONTEXT_REQUIRED" });
    return null;
  }
  return tenantId;
}

/**
 * GET /api/accounting/periods
 * Returns the authenticated tenant's authoritative accounting periods.
 */
accountingRouter.get("/periods", authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = getTrustedPeriodTenant(req, res);
  if (!tenantId) return;
  try {
    const periods = await prisma.accountingPeriod.findMany({
      where: { tenantId },
      orderBy: { startDate: "asc" }
    });
    return res.json({ success: true, periods: periods.map(periodDto) });
  } catch (error: any) {
    if (error instanceof OfflineDatabaseError) return res.status(503).json({ error: "DATABASE_UNAVAILABLE" });
    return res.status(500).json({ error: "ACCOUNTING_PERIODS_UNAVAILABLE" });
  }
});

/**
 * POST /api/accounting/periods/bootstrap
 * One-time import of tenant-owned Dexie periods into PostgreSQL.
 * Only tenant administrators may establish the initial authoritative set.
 */
accountingRouter.post("/periods/bootstrap", authenticateToken,
  requireRoles([Role.PLATFORM_OWNER, Role.TENANT_ADMIN, Role.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = getTrustedPeriodTenant(req, res);
    if (!tenantId) return;
    const rawPeriods = req.body?.periods;
    if (!Array.isArray(rawPeriods) || rawPeriods.length < 1 || rawPeriods.length > 100) {
      return res.status(400).json({ error: "INVALID_ACCOUNTING_PERIODS" });
    }
    const periods = rawPeriods.map(parseAccountingPeriodInput);
    if (periods.some((period) => !period) ||
        new Set(periods.map((period) => period!.clientId)).size !== periods.length ||
        !periodsDoNotOverlap(periods as AccountingPeriodInput[])) {
      return res.status(422).json({ error: "INVALID_OR_OVERLAPPING_ACCOUNTING_PERIODS" });
    }

    try {
      const created = await runInTransaction("AccountingPeriodBootstrap", async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`;
        const existingCount = await tx.accountingPeriod.count({ where: { tenantId } });
        if (existingCount > 0) {
          const error: any = new Error("ACCOUNTING_PERIODS_ALREADY_INITIALIZED");
          error.code = "ACCOUNTING_PERIODS_ALREADY_INITIALIZED";
          throw error;
        }
        const now = new Date();
        await tx.accountingPeriod.createMany({
          data: (periods as AccountingPeriodInput[]).map((period) => ({
            tenantId,
            clientId: period.clientId,
            startDate: period.startDate,
            endDate: period.endDate,
            isLocked: period.isLocked,
            lockedBy: period.isLocked ? (req.user?.userId || null) : null,
            lockedAt: period.isLocked ? now : null
          }))
        });
        const rows = await tx.accountingPeriod.findMany({ where: { tenantId }, orderBy: { startDate: "asc" } });
        await tx.auditLog.create({
          data: {
            tenantId,
            userId: req.user?.userId || null,
            action: "CREATE",
            entity: "AccountingPeriodBootstrap",
            entityId: tenantId,
            after: JSON.stringify(rows.map(periodDto)),
            ipAddress: req.ip
          }
        });
        return rows;
      });
      return res.status(201).json({ success: true, periods: created.map(periodDto) });
    } catch (error: any) {
      if (error.code === "ACCOUNTING_PERIODS_ALREADY_INITIALIZED") {
        return res.status(409).json({ error: error.code });
      }
      if (error instanceof OfflineDatabaseError) return res.status(503).json({ error: "DATABASE_UNAVAILABLE" });
      return res.status(500).json({ error: "ACCOUNTING_PERIOD_BOOTSTRAP_FAILED" });
    }
  }
);

/**
 * POST /api/accounting/periods
 * Creates a tenant-wide period without overlapping an existing period.
 */
accountingRouter.post("/periods", authenticateToken,
  requireRoles([Role.PLATFORM_OWNER, Role.TENANT_ADMIN, Role.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = getTrustedPeriodTenant(req, res);
    if (!tenantId) return;
    const period = parseAccountingPeriodInput(req.body);
    if (!period || period.isLocked) return res.status(400).json({ error: "INVALID_ACCOUNTING_PERIOD" });
    try {
      const created = await runInTransaction("AccountingPeriodCreate", async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`;
        const overlap = await tx.accountingPeriod.findFirst({
          where: { tenantId, startDate: { lte: period.endDate }, endDate: { gte: period.startDate } },
          select: { id: true }
        });
        if (overlap) {
          const error: any = new Error("ACCOUNTING_PERIOD_OVERLAP");
          error.code = "ACCOUNTING_PERIOD_OVERLAP";
          throw error;
        }
        const row = await tx.accountingPeriod.create({
          data: { ...period, tenantId, lockedBy: null, lockedAt: null }
        });
        await tx.auditLog.create({
          data: {
            tenantId,
            userId: req.user?.userId || null,
            action: "CREATE",
            entity: "AccountingPeriod",
            entityId: row.id,
            after: JSON.stringify(periodDto(row)),
            ipAddress: req.ip
          }
        });
        return row;
      });
      return res.status(201).json({ success: true, period: periodDto(created) });
    } catch (error: any) {
      if (error.code === "ACCOUNTING_PERIOD_OVERLAP") return res.status(409).json({ error: error.code });
      if (error instanceof OfflineDatabaseError) return res.status(503).json({ error: "DATABASE_UNAVAILABLE" });
      return res.status(500).json({ error: "ACCOUNTING_PERIOD_CREATE_FAILED" });
    }
  }
);

async function setAccountingPeriodLock(
  req: AuthenticatedRequest,
  res: Response,
  isLocked: boolean
) {
  const tenantId = getTrustedPeriodTenant(req, res);
  if (!tenantId) return;
  const clientId = typeof req.params.clientId === "string" ? req.params.clientId.trim() : "";
  if (!clientId) return res.status(400).json({ error: "INVALID_ACCOUNTING_PERIOD_ID" });
  try {
    const updated = await runInTransaction("AccountingPeriodLock", async (tx) => {
      const before = await tx.accountingPeriod.findFirst({ where: { tenantId, clientId } });
      if (!before) {
        const error: any = new Error("ACCOUNTING_PERIOD_NOT_FOUND");
        error.code = "ACCOUNTING_PERIOD_NOT_FOUND";
        throw error;
      }
      const after = await tx.accountingPeriod.update({
        where: { id: before.id },
        data: {
          isLocked,
          lockedBy: isLocked ? (req.user?.userId || null) : null,
          lockedAt: isLocked ? new Date() : null
        }
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: req.user?.userId || null,
          action: "UPDATE",
          entity: "AccountingPeriod",
          entityId: after.id,
          before: JSON.stringify(periodDto(before)),
          after: JSON.stringify(periodDto(after)),
          ipAddress: req.ip
        }
      });
      return after;
    });
    return res.json({ success: true, period: periodDto(updated) });
  } catch (error: any) {
    if (error.code === "ACCOUNTING_PERIOD_NOT_FOUND") return res.status(404).json({ error: error.code });
    if (error instanceof OfflineDatabaseError) return res.status(503).json({ error: "DATABASE_UNAVAILABLE" });
    return res.status(500).json({ error: "ACCOUNTING_PERIOD_LOCK_UPDATE_FAILED" });
  }
}

accountingRouter.patch("/periods/:clientId/lock", authenticateToken,
  requireRoles([Role.PLATFORM_OWNER, Role.TENANT_ADMIN, Role.ADMIN]),
  (req: AuthenticatedRequest, res: Response) => setAccountingPeriodLock(req, res, true)
);
accountingRouter.patch("/periods/:clientId/unlock", authenticateToken,
  requireRoles([Role.PLATFORM_OWNER, Role.TENANT_ADMIN, Role.ADMIN]),
  (req: AuthenticatedRequest, res: Response) => setAccountingPeriodLock(req, res, false)
);

/**
 * POST /api/accounting/journal
 * Manually posts a multi-line general journal entry directly to the Ledger.
 * Uses Row-Level Locking, version checks, and Double-entry balancing enforcement.
 */
accountingRouter.post("/journal", authenticateToken, requireRoles([Role.PLATFORM_OWNER, Role.TENANT_ADMIN, Role.ADMIN, Role.ACCOUNTANT]), validateRequestBody(AccountingEntrySchema), async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.user?.tenantId?.trim();
  const requestTenantId = (req as any).tenantId;
  if (!tenantId || (requestTenantId && requestTenantId !== tenantId)) {
    return res.status(403).json({
      error: "TRUSTED_TENANT_CONTEXT_REQUIRED",
      message: "A trusted, matching tenant session is required to post a journal."
    });
  }

  const userId = req.user?.userId || "SYSTEM";
  const branchId = "BRH-MAIN-001";
  const key = `purchase:journal:${userId}`;

  const lock = await LockingService.acquireLock({
    key,
    branchId,
    lockType: "PURCHASE",
    ownerId: userId,
    ttl: 15000
  });

  if (!lock) {
    return res.status(423).json({
      error: "LOCK_CONFLICT",
      message: "An active posting operation is already running for your account. Please wait."
    });
  }

  try {
    const data = req.body; // sanitized and verified by validateRequestBody

    const result = await runInTransaction("AccountingService", async (tx) => {
      const sumDebits = data.lines.reduce((sum: number, l: any) => sum + l.debit, 0);
      const sumCredits = data.lines.reduce((sum: number, l: any) => sum + l.credit, 0);

      // Verify general ledger balance
      if (Math.abs(sumDebits - sumCredits) > 0.0001) {
        throw new Error(`UNBALANCED_ENTRY: Debits sum (${sumDebits}) must exactly equal credits sum (${sumCredits}).`);
      }

      // Lock only accounts owned by the authenticated tenant.
      const accountIds: string[] = [...new Set<string>(data.lines.map((line: any) => line.accountId as string))];
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "accounts"
          WHERE id IN (${Prisma.join(accountIds)})
            AND "tenantId" = ${tenantId}
          FOR UPDATE`
      );

      // Resolve every account inside the same tenant before creating any ledger rows.
      // findFirst is intentional: it allows an explicit tenant predicate in the lookup.
      const accountsById = new Map<string, { id: string; version: number }>();
      for (const accountId of accountIds) {
        const account = await tx.account.findFirst({
          where: { id: accountId, tenantId },
          select: { id: true, version: true }
        });
        if (!account) {
          throw new Error("ACCOUNT_NOT_FOUND_OR_FORBIDDEN: One or more accounts do not belong to the authenticated tenant.");
        }
        accountsById.set(accountId, { id: account.id, version: account.version });
      }

      // Create main entry only after all account ownership checks pass.
      const entry = await tx.journalEntry.create({
        data: {
          tenantId,
          date: new Date(),
          sourceType: "MANUAL",
          status: "POSTED",
          description: data.description || "قيد محاسبي يدوي",
          debitTotal: sumDebits,
          creditTotal: sumCredits,
          lines: {
            create: data.lines.map((line: any) => ({
              tenantId,
              accountId: line.accountId,
              debit: line.debit,
              credit: line.credit,
              description: line.description
            }))
          }
        }
      });

      // Update account balances with version checking (Optimistic locking)
      for (const line of data.lines) {
        const adjustment = line.debit - line.credit;
        const currentAccount = accountsById.get(line.accountId);
        if (!currentAccount) {
          throw new Error("ACCOUNT_NOT_FOUND_OR_FORBIDDEN: Account is not available in the authenticated tenant.");
        }

        await tx.account.update({
          where: {
            id_tenantId: { id: line.accountId, tenantId },
            version: currentAccount.version
          },
          data: {
            balance: { increment: adjustment },
            version: { increment: 1 }
          }
        });

        // Preserve optimistic-lock correctness if the same account appears on multiple lines.
        currentAccount.version += 1;
      }

      // Record detailed Audit trail
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: req.user?.userId || null,
          action: "POST_JOURNAL",
          entity: "JournalEntry",
          entityId: entry.id,
          before: null,
          after: JSON.stringify(entry),
          ipAddress: req.ip
        }
      });

      return entry;
    });

    return res.status(201).json({
      success: true,
      message: "Journal registered and posted successfully.",
      journalId: result.id
    });
  } catch (err: any) {
    if (err instanceof OfflineDatabaseError) return res.status(503).json({ success: false, offline: true, message: "Database unavailable." });
    return res.status(400).json({
      error: "JOURNAL_FAILED",
      message: err.message || err
    });
  } finally {
    await LockingService.releaseLock(key, lock.id, branchId, userId);
  }
});

/**
 * GET /api/reports/trial-balance
 * Generates an instantaneous Trial Balance report mapping all debit/credit ledgers
 */
accountingRouter.get("/reports/trial-balance", authenticateToken, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const rawAccounts = await prisma.account.findMany({
      orderBy: { code: "asc" }
    });

    let cumulativeDebitSum = 0;
    let cumulativeCreditSum = 0;

    const trialEntries = rawAccounts.map(acc => {
      const balance = Number(acc.balance);
      const { debit: debitSummary, credit: creditSummary } = toTrialBalanceColumns(balance);

      cumulativeDebitSum += debitSummary;
      cumulativeCreditSum += creditSummary;

      return {
        accountId: acc.id,
        code: acc.code,
        name: acc.name,
        type: acc.type,
        debit: debitSummary,
        credit: creditSummary,
        rawBalance: balance
      };
    });

    return res.json({
      success: true,
      reportDate: new Date().toISOString(),
      summary: {
        totalDebits: cumulativeDebitSum,
        totalCredits: cumulativeCreditSum,
        isBalanced: Math.abs(cumulativeDebitSum - cumulativeCreditSum) < 0.01
      },
      accounts: trialEntries
    });
  } catch (err: any) {
    return res.status(500).json({ error: "INTERNAL_ERROR", message: err.message });
  }
});

/**
 * GET /api/accounting/accounts
 * Fetch all registered chart of accounts
 */
accountingRouter.get("/accounts", authenticateToken, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const accounts = await prisma.account.findMany({
      orderBy: { code: "asc" },
      include: {
        parent: true
      }
    });

    return res.json({
      success: true,
      accounts
    });
  } catch (err: any) {
    return res.status(500).json({ error: "INTERNAL_ERROR", message: err.message });
  }
});
