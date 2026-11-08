import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  handlePreRequest: vi.fn(),
}));

vi.mock("../modules/idempotency/idempotency.service.js", () => ({
  IdempotencyService: {
    handlePreRequest: state.handlePreRequest,
    resolveRequest: vi.fn(),
    releaseLock: vi.fn(),
  },
}));

import { idempotencyMiddleware, shouldApplyIdempotency } from "../modules/idempotency/idempotency.middleware.js";

describe("Idempotency middleware eligibility and error disclosure", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("only enables write methods and explicitly excludes sync pull", () => {
    expect(shouldApplyIdempotency({ method: "GET", path: "/api/invoices" } as any)).toBe(false);
    expect(shouldApplyIdempotency({ method: "POST", path: "/api/v1/sync/pull" } as any)).toBe(false);
    expect(shouldApplyIdempotency({ method: "POST", path: "/api/invoices/create" } as any)).toBe(true);
    expect(shouldApplyIdempotency({ method: "PATCH", path: "/api/invoices/1" } as any)).toBe(true);
    expect(shouldApplyIdempotency({ method: "DELETE", path: "/api/invoices/1" } as any)).toBe(true);
  });

  it("never returns stack traces or internal error messages in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    state.handlePreRequest.mockRejectedValueOnce(Object.assign(new Error("database credentials leaked"), {
      stack: "SECRET_STACK_TRACE",
    }));

    const req: any = {
      headers: { "idempotency-key": "test-key" },
      method: "POST",
      path: "/api/invoices/create",
      originalUrl: "/api/invoices/create",
      body: { tenantId: "tenant-test" },
    };
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    await idempotencyMiddleware(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    const payload = res.json.mock.calls[0][0];
    expect(payload).not.toHaveProperty("stack");
    expect(payload.message).not.toContain("database credentials");
    expect(payload.message).not.toContain("SECRET_STACK_TRACE");
  });
});
