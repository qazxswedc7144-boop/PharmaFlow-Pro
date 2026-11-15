import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  isConnected: vi.fn(),
  checkSubscriptionLimit: vi.fn(),
  runWithTenantContext: vi.fn((_context: unknown, callback: () => void) => callback())
}));

vi.mock("../database/prisma.js", () => ({
  prisma: {
    isConnected: mocks.isConnected,
    tenant: { findUnique: mocks.tenantFindUnique }
  }
}));

vi.mock("../context/tenantContext.js", () => ({
  runWithTenantContext: mocks.runWithTenantContext
}));

vi.mock("../modules/saas/saas.service.js", () => ({
  SaasService: { checkSubscriptionLimit: mocks.checkSubscriptionLimit }
}));

import { tenantContextMiddleware } from "../middleware/tenant.middleware.js";
import { subscriptionGuard } from "../middleware/subscription.middleware.js";

function makeResponse() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

describe("P0 middleware fail-closed behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isConnected.mockReturnValue(true);
  });

  it("returns 503 and never calls next when the tenant database lookup fails", async () => {
    mocks.tenantFindUnique.mockRejectedValue(new Error("database unavailable"));
    const req: any = {
      headers: {},
      body: {},
      user: { tenantId: "tenant-1", userId: "user-1", username: "admin", role: "ADMIN" }
    };
    const res = makeResponse();
    const next = vi.fn();

    await tenantContextMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: "TENANT_UNAVAILABLE" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 503 and never calls next when the tenant database is disconnected", async () => {
    mocks.isConnected.mockReturnValue(false);
    const req: any = {
      headers: {},
      body: {},
      user: { tenantId: "tenant-1", userId: "user-1", username: "admin", role: "ADMIN" }
    };
    const res = makeResponse();
    const next = vi.fn();

    await tenantContextMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: "TENANT_UNAVAILABLE" });
    expect(next).not.toHaveBeenCalled();
    expect(mocks.tenantFindUnique).not.toHaveBeenCalled();
  });

  it("returns 503 and never calls next when subscription verification throws", async () => {
    mocks.checkSubscriptionLimit.mockRejectedValue(new Error("subscription store unavailable"));
    const req: any = {
      method: "POST",
      path: "/purchases",
      headers: {},
      user: { tenantId: "tenant-1" }
    };
    const res = makeResponse();
    const next = vi.fn();

    await subscriptionGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: "SUBSCRIPTION_UNAVAILABLE" });
    expect(next).not.toHaveBeenCalled();
  });

  it("does not bypass subscription verification when tenant context is missing", async () => {
    const req: any = { method: "POST", path: "/purchases", headers: {}, user: undefined };
    const res = makeResponse();
    const next = vi.fn();

    await subscriptionGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: "SUBSCRIPTION_UNAVAILABLE" });
    expect(next).not.toHaveBeenCalled();
    expect(mocks.checkSubscriptionLimit).not.toHaveBeenCalled();
  });
});
