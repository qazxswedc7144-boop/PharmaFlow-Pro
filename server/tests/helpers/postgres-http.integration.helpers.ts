import { afterAll, beforeAll, describe } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { requestContextPlugin } from "../../../apps/api/src/plugins/request-context.js";
import { authenticateToken } from "../../middleware/auth.middleware.js";
import { tenantContextMiddleware } from "../../middleware/tenant.middleware.js";
import { subscriptionGuard } from "../../middleware/subscription.middleware.js";
import { idempotencyMiddleware, shouldApplyIdempotency } from "../../modules/idempotency/idempotency.middleware.js";
import { prisma } from "../../database/prisma.js";

const enabled = Boolean(process.env.DATABASE_URL);
const password = "Ci-Only-Password-2026!";

function logProcessMemory(stage: string): void {
  const memory = process.memoryUsage();
  console.info(`[PostgreSQL HTTP] ${stage} (MB):`, {
    rss: Math.round(memory.rss / 1024 / 1024),
    heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
    heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
    external: Math.round(memory.external / 1024 / 1024),
  });
}

export interface PostgresHttpContext {
  suffix: string;
  usernameA: string;
  usernameB: string;
  tenantAId: string;
  tenantBId: string;
  userAId: string;
  userBId: string;
  branchAId: string;
  branchBId: string;
  planId: string;
  productAId: string;
  tokenA: string;
  tokenB: string;
  invoiceBId: string;
  baseUrl: string;
  server?: Server;
}

function createContext(): PostgresHttpContext {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  return {
    suffix,
    usernameA: `ci_a_${suffix}`,
    usernameB: `ci_b_${suffix}`,
    tenantAId: "",
    tenantBId: "",
    userAId: "",
    userBId: "",
    branchAId: "",
    branchBId: "",
    planId: "",
    productAId: "",
    tokenA: "",
    tokenB: "",
    invoiceBId: "",
    baseUrl: "",
  };
}

export async function request(
  ctx: PostgresHttpContext,
  path: string,
  options: { method?: string; token?: string; body?: unknown; branchId?: string } = {}
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.branchId ? { 'x-branch-id': options.branchId } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function login(ctx: PostgresHttpContext, username: string): Promise<string> {
  const response = await request(ctx, "/api/v1/auth/login", {
    method: "POST",
    body: { username, password },
  });
  if (response.status !== 200 || !response.body?.success || !response.body?.accessToken) {
    throw new Error(`Integration login failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
  return response.body.accessToken as string;
}

async function initialize(
  ctx: PostgresHttpContext,
  options: { includeInvoiceRoutes?: boolean; includeSyncRoutes?: boolean } = {}
): Promise<void> {
  // A real connection is mandatory: fail rather than allowing Prisma's offline fallback.
  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`;

  const plan = await prisma.subscriptionPlan.create({
    data: {
      code: `CI_${ctx.suffix}`,
      name: "CI Integration Unlimited",
      price: 0,
      durationDays: 30,
      transactionLimit: -1,
    },
  });
  ctx.planId = plan.id;

  const tenantA = await prisma.tenant.create({ data: { name: `CI Tenant A ${ctx.suffix}` } });
  const tenantB = await prisma.tenant.create({ data: { name: `CI Tenant B ${ctx.suffix}` } });
  ctx.tenantAId = tenantA.id;
  ctx.tenantBId = tenantB.id;

  const passwordHash = await bcrypt.hash(password, 4);
  const userA = await prisma.user.create({
    data: { username: ctx.usernameA, passwordHash, role: "ADMIN", isActive: true },
  });
  const userB = await prisma.user.create({
    data: { username: ctx.usernameB, passwordHash, role: "ADMIN", isActive: true },
  });
  ctx.userAId = userA.id;
  ctx.userBId = userB.id;

  await prisma.tenantUser.createMany({
    data: [
      { tenantId: ctx.tenantAId, userId: ctx.userAId, role: "TENANT_ADMIN" },
      { tenantId: ctx.tenantBId, userId: ctx.userBId, role: "TENANT_ADMIN" },
    ],
  });

  const branchA = await prisma.branch.create({
    data: { tenantId: ctx.tenantAId, code: `A-${ctx.suffix}`, name: "CI Branch A", isActive: true },
  });
  const branchB = await prisma.branch.create({
    data: { tenantId: ctx.tenantBId, code: `B-${ctx.suffix}`, name: "CI Branch B", isActive: true },
  });
  ctx.branchAId = branchA.id;
  ctx.branchBId = branchB.id;

  await prisma.tenantSubscription.createMany({
    data: [
      { tenantId: ctx.tenantAId, planId: ctx.planId, startDate: new Date(), endDate: new Date(Date.now() + 30 * 86400000), isActive: true },
      { tenantId: ctx.tenantBId, planId: ctx.planId, startDate: new Date(), endDate: new Date(Date.now() + 30 * 86400000), isActive: true },
    ],
  });
  await prisma.usageCounter.createMany({
    data: [
      { tenantId: ctx.tenantAId, transactionCount: 0 },
      { tenantId: ctx.tenantBId, transactionCount: 0 },
    ],
  });

  const product = await prisma.product.create({
    data: {
      tenantId: ctx.tenantAId,
      name: "CI FIFO Product",
      sku: `FIFO-${ctx.suffix}`,
      price: 10,
      cost: 3,
      stockQuantity: 6,
      isActive: true,
    },
  });
  ctx.productAId = product.id;

  await prisma.inventoryBatch.create({
    data: {
      tenantId: ctx.tenantAId,
      productId: ctx.productAId,
      batchNumber: `BATCH-${ctx.suffix}`,
      initialQty: 6,
      stockQuantity: 6,
      cost: 3,
      expiryDate: new Date(Date.now() + 180 * 86400000),
    },
  });

  const invoiceB = await prisma.invoice.create({
    data: {
      tenantId: ctx.tenantBId,
      invoiceNumber: `TENANT-B-${ctx.suffix}`,
      type: "SALE",
      totalAmount: 7,
      status: "DRAFT",
      paymentStatus: "UNPAID",
      documentStatus: "ACTIVE",
    },
  });
  ctx.invoiceBId = invoiceB.id;

  // Mount the real production auth/sync routers with the same relevant
  // middleware chain, without importing unrelated reporting, AI, inventory,
  // and platform route trees into this focused integration worker.
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(requestContextPlugin);
  app.use((req, res, next) => {
    if (!shouldApplyIdempotency(req)) return next();
    return idempotencyMiddleware(req, res, next);
  });
  // Import only the production route trees required by this suite. Each
  // Vitest invocation runs in its own Node process, so this also bounds the
  // module graph and memory retained by the worker.
  const { authV1Router } = await import("../../../apps/api/src/modules/auth/auth.routes.js");
  const { authRouter } = await import("../../routes/auth.routes.js");
  app.use("/api/v1/auth", authV1Router);
  app.use("/api/auth", authRouter);
  app.use("/api", authenticateToken);
  app.use("/api", tenantContextMiddleware);
  app.use("/api", subscriptionGuard);

  if (options.includeSyncRoutes) {
    logProcessMemory("Before production Sync router import");
    const { syncV1Router } = await import("../../../apps/api/src/modules/sync/sync.routes.js");
    logProcessMemory("After production Sync router import");
    app.use("/api/v1/sync", syncV1Router);
  }

  // Load the heavier invoice route tree only for the invoice suite.
  if (options.includeInvoiceRoutes) {
    const { invoiceRouter } = await import("../../routes/invoice.routes.js");
    app.use("/api/invoices", invoiceRouter);
  }

  logProcessMemory("Before HTTP server listen");
  ctx.server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    ctx.server?.once("listening", resolve);
    ctx.server?.once("error", reject);
  });
  const address = ctx.server.address() as AddressInfo;
  ctx.baseUrl = `http://127.0.0.1:${address.port}`;
  logProcessMemory("After HTTP server listen");

  logProcessMemory("Before tenant A login");
  ctx.tokenA = await login(ctx, ctx.usernameA);
  logProcessMemory("After tenant A login");
  logProcessMemory("Before tenant B login");
  ctx.tokenB = await login(ctx, ctx.usernameB);
  logProcessMemory("After tenant B login");
}

async function cleanup(ctx: PostgresHttpContext): Promise<void> {
  try {
    if (ctx.server) {
      const activeServer = ctx.server;
      await new Promise<void>((resolve, reject) => {
        activeServer.close((error) => error ? reject(error) : resolve());
        activeServer.closeIdleConnections?.();
        activeServer.closeAllConnections?.();
      });
      ctx.server = undefined;
    }

    const tenantIds = [ctx.tenantAId, ctx.tenantBId].filter(Boolean);
    const userIds = [ctx.userAId, ctx.userBId].filter(Boolean);

    if (tenantIds.length || userIds.length || ctx.planId) {
      await prisma.$transaction(async (tx) => {
        if (tenantIds.length) {
          const tenantScope = { tenantId: { in: tenantIds } };

          // Audit rows may not carry tenantId on every legacy path; also scope
          // cleanup by the two uniquely-created CI users.
          await tx.auditLog.deleteMany({
            where: {
              OR: [
                { tenantId: { in: tenantIds } },
                ...(userIds.length ? [{ userId: { in: userIds } }] : []),
              ],
            },
          });

          // Remove restrictive children before their parents using the actual
          // Prisma FK graph. No constraints are disabled and no broad CASCADE is used.
          await tx.journalLine.deleteMany({ where: tenantScope });
          await tx.journalEntry.deleteMany({ where: tenantScope });

          await tx.invoiceItem.deleteMany({ where: tenantScope });
          await tx.invoice.deleteMany({ where: tenantScope });

          await tx.inventoryMovement.deleteMany({ where: tenantScope });
          await tx.reservation.deleteMany({ where: tenantScope });
          await tx.branchTransferItem.deleteMany({ where: tenantScope });
          await tx.branchTransfer.deleteMany({ where: tenantScope });
          await tx.branchInventory.deleteMany({ where: tenantScope });
          await tx.inventoryBatch.deleteMany({ where: tenantScope });

          await tx.product.deleteMany({ where: tenantScope });
          await tx.account.deleteMany({ where: tenantScope });
          await tx.customer.deleteMany({ where: tenantScope });
          await tx.supplier.deleteMany({ where: tenantScope });
          await tx.payment.deleteMany({ where: tenantScope });
          await tx.expense.deleteMany({ where: tenantScope });

          await tx.deviceRegistration.deleteMany({ where: tenantScope });
          await tx.usageCounter.deleteMany({ where: tenantScope });
          await tx.syncQueue.deleteMany({ where: tenantScope });
          await tx.syncEvent.deleteMany({ where: tenantScope });
          await tx.idempotencyKey.deleteMany({ where: tenantScope });
          await tx.tenantSubscription.deleteMany({ where: tenantScope });
          await tx.license.deleteMany({ where: tenantScope });

          await tx.branchUser.deleteMany({ where: tenantScope });
          await tx.userRole.deleteMany({ where: tenantScope });
          await tx.userPermissionOverride.deleteMany({ where: tenantScope });
          await tx.tenantUser.deleteMany({ where: tenantScope });
          await tx.branch.deleteMany({ where: tenantScope });
          await tx.tenant.deleteMany({ where: { id: { in: tenantIds } } });
        }

        if (userIds.length) {
          await tx.auditLog.deleteMany({ where: { userId: { in: userIds } } });
          await tx.user.deleteMany({ where: { id: { in: userIds } } });
        }

        if (ctx.planId) {
          await tx.tenantSubscription.deleteMany({ where: { planId: ctx.planId } });
          await tx.subscriptionPlan.deleteMany({ where: { id: ctx.planId } });
        }
      });
    }

    // Verify that this run's uniquely-scoped fixtures were actually removed.
    const remaining: Record<string, number> = {};
    if (tenantIds.length) {
      const [tenants, invoices, journalEntries, journalLines, products, customers, branches, subscriptions, devices, idempotencyKeys, syncEvents] =
        await Promise.all([
          prisma.tenant.count({ where: { id: { in: tenantIds } } }),
          prisma.invoice.count({ where: { tenantId: { in: tenantIds } } }),
          prisma.journalEntry.count({ where: { tenantId: { in: tenantIds } } }),
          prisma.journalLine.count({ where: { tenantId: { in: tenantIds } } }),
          prisma.product.count({ where: { tenantId: { in: tenantIds } } }),
          prisma.customer.count({ where: { tenantId: { in: tenantIds } } }),
          prisma.branch.count({ where: { tenantId: { in: tenantIds } } }),
          prisma.tenantSubscription.count({ where: { tenantId: { in: tenantIds } } }),
          prisma.deviceRegistration.count({ where: { tenantId: { in: tenantIds } } }),
          prisma.idempotencyKey.count({ where: { tenantId: { in: tenantIds } } }),
          prisma.syncEvent.count({ where: { tenantId: { in: tenantIds } } }),
        ]);
      Object.assign(remaining, { tenants, invoices, journalEntries, journalLines, products, customers, branches, subscriptions, devices, idempotencyKeys, syncEvents });
    }
    if (userIds.length) {
      remaining.users = await prisma.user.count({ where: { id: { in: userIds } } });
      remaining.userAuditLogs = await prisma.auditLog.count({ where: { userId: { in: userIds } } });
    }
    if (ctx.planId) {
      remaining.subscriptionPlans = await prisma.subscriptionPlan.count({ where: { id: ctx.planId } });
      remaining.planSubscriptions = await prisma.tenantSubscription.count({ where: { planId: ctx.planId } });
    }
    const leftovers = Object.entries(remaining).filter(([, count]) => count > 0);
    if (leftovers.length) {
      throw new Error(`PostgreSQL integration fixture cleanup left rows behind: ${JSON.stringify(Object.fromEntries(leftovers))}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

export function definePostgresHttpSuite(
  name: string,
  registerTests: (getContext: () => PostgresHttpContext) => void,
  options: { includeInvoiceRoutes?: boolean; includeSyncRoutes?: boolean } = {}
): void {
  const suite = enabled ? describe : describe.skip;
  suite(name, { concurrent: false }, () => {
    const ctx = createContext();
    beforeAll(async () => initialize(ctx, options), 60000);
    afterAll(async () => cleanup(ctx), 30000);
    registerTests(() => ctx);
  });
}
