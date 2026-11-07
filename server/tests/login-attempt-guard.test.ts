import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  count: vi.fn(),
  create: vi.fn()
}));

vi.mock("../database/prisma.js", () => ({
  prisma: {
    auditLog: {
      count: prismaMocks.count,
      create: prismaMocks.create
    }
  }
}));

import {
  loginAttemptGuard,
  recordFailedLoginAttempt,
  LoginAttemptAuditError
} from "../security/loginAttemptGuard.js";

function makeRequest(username = "pharmacist", ip = "203.0.113.10") {
  return {
    body: { username },
    ip,
    socket: { remoteAddress: ip }
  } as any;
}

function makeResponse() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn()
  } as any;
}

describe("persistent login attempt throttling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.count.mockResolvedValue(0);
    prismaMocks.create.mockResolvedValue({ id: "audit-attempt-1" });
  });

  it("allows login when persistent failed-attempt counts are below the thresholds", async () => {
    const req = makeRequest();
    const res = makeResponse();
    const next = vi.fn();

    await loginAttemptGuard(req, res, next);

    expect(prismaMocks.count).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("blocks a username after 20 failed attempts in the rolling 15-minute window", async () => {
    prismaMocks.count.mockResolvedValueOnce(20).mockResolvedValueOnce(0);
    const req = makeRequest();
    const res = makeResponse();
    const next = vi.fn();

    await loginAttemptGuard(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "900");
    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it("blocks an IP after 50 failed attempts across usernames", async () => {
    prismaMocks.count.mockResolvedValueOnce(0).mockResolvedValueOnce(50);
    const req = makeRequest();
    const res = makeResponse();
    const next = vi.fn();

    await loginAttemptGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed when persistent throttling cannot reach PostgreSQL", async () => {
    prismaMocks.count.mockRejectedValue(new Error("database unavailable"));
    const req = makeRequest();
    const res = makeResponse();
    const next = vi.fn();

    await loginAttemptGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("persists failed attempts using the existing AuditLog schema", async () => {
    await recordFailedLoginAttempt("pharmacist", "203.0.113.10", "user-1", "tenant-1");

    expect(prismaMocks.create).toHaveBeenCalledWith({
      data: {
        action: "USER_LOGIN",
        entity: "User",
        entityId: "pharmacist",
        userId: "user-1",
        tenantId: "tenant-1",
        after: JSON.stringify({ status: "FAILED" }),
        ipAddress: "203.0.113.10"
      }
    });
  });

  it("does not silently ignore failure to persist a failed login attempt", async () => {
    prismaMocks.create.mockRejectedValue(new Error("write failed"));

    await expect(recordFailedLoginAttempt("pharmacist", "203.0.113.10"))
      .rejects.toBeInstanceOf(LoginAttemptAuditError);
  });
});
