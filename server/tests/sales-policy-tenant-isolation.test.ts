import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockAuthorization } = vi.hoisted(() => {
  const prisma: any = {
    tenantSalesPolicy: { upsert: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
  };
  return {
    mockPrisma: prisma,
    mockAuthorization: { can: vi.fn() },
  };
});

vi.mock("../database/tenantPrisma.js", () => ({ tenantPrisma: mockPrisma }));
vi.mock("../database/prisma.js", () => ({
  OfflineDatabaseError: class OfflineDatabaseError extends Error {},
}));
vi.mock("../services/rbac/authorization.service.js", () => ({
  AuthorizationService: mockAuthorization,
}));

import { salesPolicyRouter } from "../routes/sales-policy.routes.js";

const tenantId = "tenant-policy-a";

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

async function invoke(method: "get" | "put", body?: unknown) {
  const layer = (salesPolicyRouter as any).stack.find(
    (entry: any) => entry.route?.path === "/" && entry.route?.methods?.[method],
  );
  if (!layer) throw new Error(`Sales policy ${method.toUpperCase()} route not registered`);

  const req: any = {
    body,
    headers: {},
    user: { tenantId, userId: "policy-admin", username: "admin", role: "TENANT_ADMIN" },
    ip: "127.0.0.1",
  };
  const res = makeResponse();

  for (const routeLayer of layer.route.stack) {
    await routeLayer.handle(req, res, () => {});
    if (res.statusCode >= 400) break;
  }
  return res;
}

describe("Tenant sales policy API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorization.can.mockResolvedValue(true);
    mockPrisma.tenantSalesPolicy.upsert.mockResolvedValue({
      id: "policy-a",
      tenantId,
      maxDiscountPercent: 10,
      taxRatePercent: 5,
      taxMode: "EXCLUSIVE",
      updatedBy: "policy-admin",
      updatedAt: new Date("2026-11-07T00:00:00.000Z"),
    });
    mockPrisma.auditLog.create.mockResolvedValue({});
  });

  it("reads only the authenticated tenant policy and initializes safe defaults", async () => {
    const response = await invoke("get");

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.tenantSalesPolicy.upsert).toHaveBeenCalledWith({
      where: { tenantId },
      create: { tenantId },
      update: {},
    });
    expect(response.body.policy.maxDiscountPercent).toBe(10);
    expect(response.body.policy.taxMode).toBe("EXCLUSIVE");
  });

  it("persists policy under authenticated tenant and writes an audit record atomically", async () => {
    const response = await invoke("put", {
      maxDiscountPercent: 12,
      taxRatePercent: 5,
      taxMode: "INCLUSIVE",
    });

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.tenantSalesPolicy.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId },
      create: expect.objectContaining({ tenantId, taxMode: "INCLUSIVE", updatedBy: "policy-admin" }),
      update: expect.objectContaining({ taxMode: "INCLUSIVE", updatedBy: "policy-admin" }),
    }));
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId, entity: "TenantSalesPolicy", entityId: "policy-a" }),
    }));
  });

  it("rejects a client attempt to set another tenant's policy", async () => {
    const response = await invoke("put", {
      tenantId: "tenant-policy-victim",
      maxDiscountPercent: 12,
      taxRatePercent: 0,
      taxMode: "NONE",
    });

    expect(response.statusCode).toBe(400);
    expect(mockPrisma.tenantSalesPolicy.upsert).not.toHaveBeenCalled();
  });

  it("rejects invalid tax mode/rate combinations", async () => {
    const response = await invoke("put", {
      maxDiscountPercent: 12,
      taxRatePercent: 5,
      taxMode: "NONE",
    });

    expect(response.statusCode).toBe(400);
    expect(mockPrisma.tenantSalesPolicy.upsert).not.toHaveBeenCalled();
  });

  it("denies policy mutation without settings.update permission", async () => {
    mockAuthorization.can.mockResolvedValue(false);
    const response = await invoke("put", {
      maxDiscountPercent: 12,
      taxRatePercent: 0,
      taxMode: "NONE",
    });

    expect(response.statusCode).toBe(403);
    expect(mockPrisma.tenantSalesPolicy.upsert).not.toHaveBeenCalled();
  });
});
