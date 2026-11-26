import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  handlePreRequest: vi.fn(),
  resolveRequest: vi.fn(),
  releaseLock: vi.fn(),
}));

vi.mock("../modules/idempotency/idempotency.service.js", () => ({
  IdempotencyService: {
    handlePreRequest: state.handlePreRequest,
    resolveRequest: state.resolveRequest,
    releaseLock: state.releaseLock,
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

  it("does not cache HTTP 423 ACCOUNTING_PERIOD_LOCKED and releases the lock before sending", async () => {
    state.handlePreRequest.mockResolvedValueOnce({ status: "PROCESS", hash: "hash-423" });
    state.releaseLock.mockResolvedValueOnce(undefined);
    state.resolveRequest.mockResolvedValueOnce(undefined);

    const events: string[] = [];
    let releaseDone!: () => void;
    state.releaseLock.mockReset();
    state.releaseLock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseDone = () => {
          events.push("releaseLock:done");
          resolve();
        };
      })
    );

    const req: any = {
      headers: { "idempotency-key": "idem-423-key" },
      method: "POST",
      path: "/api/invoices/post",
      originalUrl: "/api/invoices/post",
      body: { invoiceId: "inv-1", tenantId: "tenant-test" },
    };
    const originalSend = vi.fn(() => {
      events.push("originalSend");
      return res;
    });
    const res: any = {
      statusCode: 423,
      send: originalSend,
      on: vi.fn(),
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    const next = vi.fn();

    await idempotencyMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    res.send(JSON.stringify({ error: "ACCOUNTING_PERIOD_LOCKED", message: "Period closed" }));
    expect(state.resolveRequest).not.toHaveBeenCalled();
    expect(state.releaseLock).toHaveBeenCalledWith("idem-423-key", "tenant-test");
    expect(originalSend).not.toHaveBeenCalled();

    releaseDone();
    await vi.waitFor(() => expect(originalSend).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["releaseLock:done", "originalSend"]);
  });

  it("continues caching HTTP 200 and non-423 4xx responses under the existing policy", async () => {
    state.handlePreRequest.mockResolvedValue({ status: "PROCESS", hash: "hash-ok" });
    state.resolveRequest.mockResolvedValue(undefined);
    state.releaseLock.mockResolvedValue(undefined);

    for (const [statusCode, body] of [
      [200, { success: true }],
      [423, { error: "LOCK_CONFLICT" }],
      [400, { error: "VALIDATION_FAILED" }],
    ] as const) {
      state.resolveRequest.mockClear();
      state.releaseLock.mockClear();
      const req: any = {
        headers: { "idempotency-key": `idem-${statusCode}` },
        method: "POST",
        path: "/api/invoices/post",
        originalUrl: "/api/invoices/post",
        body: { invoiceId: "inv-1", tenantId: "tenant-test" },
      };
      const originalSend = vi.fn();
      const res: any = {
        statusCode,
        send: originalSend,
        on: vi.fn(),
        setHeader: vi.fn(),
      };
      await idempotencyMiddleware(req, res, vi.fn());
      res.send(JSON.stringify(body));

      expect(originalSend).toHaveBeenCalledTimes(1);
      expect(state.resolveRequest).toHaveBeenCalledWith(`idem-${statusCode}`, statusCode, body, "tenant-test");
      expect(state.releaseLock).not.toHaveBeenCalled();
    }
  });
});

