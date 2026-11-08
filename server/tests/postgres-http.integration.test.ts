import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { prisma } from "../database/prisma.js";

const enabled = Boolean(process.env.DATABASE_URL);
const password = "Ci-Only-Password-2026!";
const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const usernameA = `ci_a_${suffix}`;
const usernameB = `ci_b_${suffix}`;

let server: Server | undefined;
let baseUrl = "";
let tenantAId = "";
let tenantBId = "";
let userAId = "";
let userBId = "";
let branchAId = "";
let branchBId = "";
let planId = "";
let productAId = "";
let tokenA = "";
let tokenB = "";
let invoiceBId = "";

async function request(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
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

async function login(username: string): Promise<string> {
  const response = await request("/api/v1/auth/login", {
    method: "POST",
    body: { username, password },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.success).toBe(true);
  expect(response.body.accessToken).toBeTruthy();
  return response.body.accessToken as string;
}

describe.skipIf(!enabled).sequential("Real PostgreSQL + Express HTTP integration", () => {
  beforeAll(async () => {
    // A real connection is mandatory: fail rather than allowing Prisma's offline fallback.
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;

    const plan = await prisma.subscriptionPlan.create({
      data: {
        code: `CI_${suffix}`,
        name: "CI Integration Unlimited",
        price: 0,
        durationDays: 30,
        transactionLimit: -1,
      },
    });
    planId = plan.id;

    const tenantA = await prisma.tenant.create({ data: { name: `CI Tenant A ${suffix}` } });
    const tenantB = await prisma.tenant.create({ data: { name: `CI Tenant B ${suffix}` } });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    const passwordHash = await bcrypt.hash(password, 4);
    const userA = await prisma.user.create({
      data: { username: usernameA, passwordHash, role: "ADMIN", isActive: true },
    });
    const userB = await prisma.user.create({
      data: { username: usernameB, passwordHash, role: "ADMIN", isActive: true },
    });
    userAId = userA.id;
    userBId = userB.id;

    await prisma.tenantUser.createMany({
      data: [
        { tenantId: tenantAId, userId: userAId, role: "TENANT_ADMIN" },
        { tenantId: tenantBId, userId: userBId, role: "TENANT_ADMIN" },
      ],
    });

    const branchA = await prisma.branch.create({
      data: { tenantId: tenantAId, code: `A-${suffix}`, name: "CI Branch A", isActive: true },
    });
    const branchB = await prisma.branch.create({
      data: { tenantId: tenantBId, code: `B-${suffix}`, name: "CI Branch B", isActive: true },
    });
    branchAId = branchA.id;
    branchBId = branchB.id;

    await prisma.tenantSubscription.createMany({
      data: [
        { tenantId: tenantAId, planId, startDate: new Date(), endDate: new Date(Date.now() + 30 * 86400000), isActive: true },
        { tenantId: tenantBId, planId, startDate: new Date(), endDate: new Date(Date.now() + 30 * 86400000), isActive: true },
      ],
    });
    await prisma.usageCounter.createMany({
      data: [
        { tenantId: tenantAId, transactionCount: 0 },
        { tenantId: tenantBId, transactionCount: 0 },
      ],
    });

    const product = await prisma.product.create({
      data: {
        tenantId: tenantAId,
        name: "CI FIFO Product",
        sku: `FIFO-${suffix}`,
        price: 10,
        cost: 3,
        stockQuantity: 6,
        isActive: true,
      },
    });
    productAId = product.id;

    await prisma.inventoryBatch.create({
      data: {
        tenantId: tenantAId,
        productId: productAId,
        batchNumber: `BATCH-${suffix}`,
        initialQty: 6,
        stockQuantity: 6,
        cost: 3,
        expiryDate: new Date(Date.now() + 180 * 86400000),
      },
    });

    const invoiceB = await prisma.invoice.create({
      data: {
        tenantId: tenantBId,
        invoiceNumber: `TENANT-B-${suffix}`,
        type: "SALE",
        totalAmount: 7,
        status: "DRAFT",
        paymentStatus: "UNPAID",
        documentStatus: "ACTIVE",
      },
    });
    invoiceBId = invoiceB.id;

    const app = buildApp();
    server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server?.once("listening", resolve);
      server?.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    tokenA = await login(usernameA);
    tokenB = await login(usernameB);
  }, 60000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }

    if (tenantAId || tenantBId) {
      const tenantIds = [tenantAId, tenantBId].filter(Boolean);
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => {});
    }
    const userIds = [userAId, userBId].filter(Boolean);
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    }
    if (planId) {
      await prisma.subscriptionPlan.deleteMany({ where: { id: planId } }).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it("authenticates both isolated tenant users through the real login HTTP route", async () => {
    const meA = await request("/api/v1/auth/me", { token: tokenA });
    const meB = await request("/api/v1/auth/me", { token: tokenB });

    expect(meA.status).toBe(200);
    expect(meA.body.user.tenantId).toBe(tenantAId);
    expect(meB.status).toBe(200);
    expect(meB.body.user.tenantId).toBe(tenantBId);

    const sessions = await prisma.session.count({
      where: { userId: { in: [userAId, userBId] } },
    });
    expect(sessions).toBe(2);
  });

  it("registers a device and executes Sync Push/Pull over real HTTP with PostgreSQL persistence", async () => {
    const deviceId = `ci-device-${suffix}`;
    const registration = await request("/api/v1/sync/device/register", {
      method: "POST",
      token: tokenA,
      body: {
        deviceId,
        deviceName: "CI Integration Device",
        branchId: branchAId,
        appVersion: "ci",
        schemaVersion: 1,
      },
    });

    expect(registration.status, JSON.stringify(registration.body)).toBe(200);
    expect(registration.body.success).toBe(true);

    const persistedDevice = await prisma.deviceRegistration.findUnique({ where: { deviceId } });
    expect(persistedDevice?.tenantId).toBe(tenantAId);
    expect(persistedDevice?.branchId).toBe(branchAId);

    const customerId = randomUUID();
    const mutationId = randomUUID();
    const mutationKey = randomUUID();
    const push = await request("/api/v1/sync/push", {
      method: "POST",
      token: tokenA,
      body: {
        deviceId,
        branchId: branchAId,
        schemaVersion: 1,
        mutations: [{
          id: mutationId,
          entity: "CUSTOMER",
          entityId: customerId,
          operation: "CREATE",
          payload: { name: "CI Sync Customer", phone: "0000000000", balance: 0 },
          idempotencyKey: mutationKey,
          timestamp: Date.now(),
          version: 1,
        }],
      },
    });

    expect(push.status, JSON.stringify(push.body)).toBe(200);
    expect(push.body.results?.[0]?.status).toBe("SUCCESS");

    const persistedCustomer = await prisma.customer.findUnique({ where: { id: customerId } });
    expect(persistedCustomer?.tenantId).toBe(tenantAId);
    expect(persistedCustomer?.name).toBe("CI Sync Customer");

    const persistedIdempotency = await prisma.idempotencyKey.findFirst({
      where: { tenantId: tenantAId, key: `${tenantAId}:${deviceId}:${mutationKey}` },
    });
    expect(persistedIdempotency).toBeTruthy();

    const pull = await request("/api/v1/sync/pull", {
      method: "POST",
      token: tokenA,
      body: { cursor: 0, batchSize: 100 },
    });
    expect(pull.status, JSON.stringify(pull.body)).toBe(200);
    expect(pull.body.success).toBe(true);
    expect(pull.body.tenantId).toBe(tenantAId);
    expect(pull.body.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ entity: "CUSTOMER", entityId: customerId })])
    );
  });

  it("prevents tenant A from reading tenant B invoice through the authenticated HTTP API", async () => {
    const denied = await request(`/api/invoices/${invoiceBId}`, { token: tokenA });
    expect(denied.status).toBe(404);
    expect(denied.body.error).toBe("NOT_FOUND");

    const allowed = await request(`/api/invoices/${invoiceBId}`, { token: tokenB });
    expect(allowed.status).toBe(200);
    expect(allowed.body.invoice.tenantId).toBe(tenantBId);
  });

  it("posts a persisted Draft through HTTP and verifies FIFO stock plus balanced PostgreSQL ledger rows", async () => {
    const created = await request("/api/invoices/create", {
      method: "POST",
      token: tokenA,
      body: {
        invoiceNumber: `FIFO-SALE-${suffix}`,
        type: "SALE",
        totalAmount: 9999,
        paymentStatus: "PAID",
        items: [{ productId: productAId, qty: 2, price: 9999 }],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.success).toBe(true);
    const draft = created.body.invoice;
    expect(draft.status).toBe("DRAFT");
    expect(draft.documentStatus).toBe("ACTIVE");
    // The server must use the tenant catalog price (10), not the client-supplied price (9999).
    expect(Number(draft.totalAmount)).toBe(20);
    expect(draft.items).toHaveLength(1);

    const posted = await request("/api/invoices/post", {
      method: "POST",
      token: tokenA,
      body: { invoiceId: draft.id },
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.success).toBe(true);

    const storedInvoice = await prisma.invoice.findUnique({ where: { id: draft.id } });
    expect(storedInvoice?.status).toBe("CONFIRMED");
    expect(storedInvoice?.documentStatus).toBe("POSTED");

    const storedProduct = await prisma.product.findUnique({ where: { id: productAId } });
    const storedBatch = await prisma.inventoryBatch.findFirst({
      where: { tenantId: tenantAId, productId: productAId },
    });
    expect(storedProduct?.stockQuantity).toBe(4);
    expect(storedBatch?.stockQuantity).toBe(4);

    const movement = await prisma.inventoryMovement.findFirst({
      where: { tenantId: tenantAId, referenceId: draft.id, type: "STOCK_OUT" },
    });
    expect(movement?.qty).toBe(-2);

    const journal = await prisma.journalEntry.findFirst({
      where: { tenantId: tenantAId, sourceId: draft.id, sourceType: "INVOICE" },
      include: { lines: true },
    });
    expect(journal).toBeTruthy();
    expect(Number(journal?.debitTotal)).toBe(26);
    expect(Number(journal?.creditTotal)).toBe(26);
    expect(journal?.lines.length).toBe(4);

    const retry = await request("/api/invoices/post", {
      method: "POST",
      token: tokenA,
      body: { invoiceId: draft.id },
    });
    expect(retry.status).toBe(400);

    const journalCount = await prisma.journalEntry.count({
      where: { tenantId: tenantAId, sourceId: draft.id, sourceType: "INVOICE" },
    });
    const movementCount = await prisma.inventoryMovement.count({
      where: { tenantId: tenantAId, referenceId: draft.id, type: "STOCK_OUT" },
    });
    expect(journalCount).toBe(1);
    expect(movementCount).toBe(1);
  });
});
