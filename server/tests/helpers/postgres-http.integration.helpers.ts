import { afterAll, beforeAll, describe, type TestContext } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../../app.js";
import { prisma } from "../../database/prisma.js";

const enabled = Boolean(process.env.DATABASE_URL);
const password = "Ci-Only-Password-2026!";

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
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
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

async function initialize(ctx: PostgresHttpContext): Promise<void> {
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

  const app = buildApp();
  ctx.server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    ctx.server?.once("listening", resolve);
    ctx.server?.once("error", reject);
  });
  const address = ctx.server.address() as AddressInfo;
  ctx.baseUrl = `http://127.0.0.1:${address.port}`;

  ctx.tokenA = await login(ctx, ctx.usernameA);
  ctx.tokenB = await login(ctx, ctx.usernameB);
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
    if (tenantIds.length) {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => {});
    }
    const userIds = [ctx.userAId, ctx.userBId].filter(Boolean);
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    }
    if (ctx.planId) {
      await prisma.subscriptionPlan.deleteMany({ where: { id: ctx.planId } }).catch(() => {});
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

export function definePostgresHttpSuite(
  name: string,
  registerTests: (getContext: () => PostgresHttpContext) => void
): void {
  const suite = enabled ? describe : describe.skip;
  suite(name, { concurrent: false }, () => {
    const ctx = createContext();
    beforeAll(async () => initialize(ctx), 60000);
    afterAll(async () => cleanup(ctx), 30000);
    registerTests(() => ctx);
  });
}
