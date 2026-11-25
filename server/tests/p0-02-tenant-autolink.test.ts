import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../database/prisma.js";
import { authRouter } from "../routes/auth.routes.js";
import adminRouter from "../routes/admin.routes.js";
import { authenticateToken } from "../middleware/auth.middleware.js";
import { getJwtSecret } from "../security/jwtSecrets.js";
import { resetLoginAttemptGuardForTests } from "../security/loginAttemptGuard.js";

// Fail-Closed: refuse to run unless explicitly in test environment AND
// the database name clearly indicates a test database.
function isSafeTestDatabase(): { safe: boolean; reason?: string } {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return { safe: false, reason: 'DATABASE_URL not set' };
  }
  if (process.env.NODE_ENV !== 'test' || process.env.CI !== 'true') {
    return { safe: false, reason: 'NODE_ENV is not "test" and CI is not "true"' };
  }
  let dbName: string;
  try {
    const parsed = new URL(url);
    dbName = parsed.pathname.replace(/^\//, '').split('?')[0] || '';
  } catch {
    return { safe: false, reason: 'DATABASE_URL is not a valid URL' };
  }
  const testIndicators = ['test', 'ci', 'pharmaflow_test', 'pharmaflow_ci'];
  const looksLikeTest = testIndicators.some(indicator =>
    dbName.toLowerCase().includes(indicator)
  );
  if (!looksLikeTest) {
    return { safe: false, reason: `Database name "${dbName}" does not contain a test indicator` };
  }
  return { safe: true };
}

const safety = isSafeTestDatabase();
const enabled = safety.safe;

if (!enabled) {
  console.warn(
    `[P0-02 Test] SKIPPED — unsafe environment: ${safety.reason}. ` +
    `This test refuses to run unless NODE_ENV=test AND the database name contains "test"/"ci".`
  );
}
const password = "P0-02-CI-Only-Password!";

describe.skipIf(!enabled)("P0-02 tenant Auto-Link removal and admin reassignment", () => {
  let server: Server;
  let baseUrl = "";
  let tenantId = "";
  let branchId = "";
  let validUserId = "";
  let unassignedUserId = "";
  let platformOwnerId = "";
  let ordinaryUserId = "";
  let targetUserId = "";
  let invalidTenantTargetId = "";
  let validUsername = "";
  let unassignedUsername = "";
  let tokenOwner = "";
  let tokenOrdinary = "";
  let fixtureUserIds: string[] = [];

  function tokenFor(userId: string, role: string): string {
    // authenticateToken currently requires a tenantId claim even for PLATFORM_OWNER.
    return jwt.sign(
      { userId, username: role.toLowerCase(), role, tenantId, branchId },
      getJwtSecret(),
      { expiresIn: "1h", algorithm: "HS256" }
    );
  }

  async function post(path: string, body: unknown, token?: string): Promise<{ status: number; body: any }> {
    const response = await fetch(baseUrl + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {})
      },
      body: JSON.stringify(body)
    });
    const raw = await response.text();
    return { status: response.status, body: raw ? JSON.parse(raw) : null };
  }

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;

    const tenant = await prisma.tenant.create({ data: { name: "P0-02 CI Tenant" } });
    tenantId = tenant.id;
    const branch = await prisma.branch.create({
      data: { tenantId, code: "P002-CI-" + Date.now(), name: "P0-02 CI Branch", isActive: true }
    });
    branchId = branch.id;

    const passwordHash = await bcrypt.hash(password, 4);
    const users = await Promise.all([
      prisma.user.create({ data: { username: "p002_valid_" + Date.now(), passwordHash, role: "CASHIER" } }),
      prisma.user.create({ data: { username: "p002_unassigned_" + Date.now(), passwordHash, role: "CASHIER" } }),
      prisma.user.create({ data: { username: "p002_owner_" + Date.now(), passwordHash, role: "PLATFORM_OWNER" } }),
      prisma.user.create({ data: { username: "p002_ordinary_" + Date.now(), passwordHash, role: "ADMIN" } }),
      prisma.user.create({ data: { username: "p002_target_" + Date.now(), passwordHash, role: "CASHIER" } }),
      prisma.user.create({ data: { username: "p002_invalid_target_" + Date.now(), passwordHash, role: "CASHIER" } })
    ]);
    [validUserId, unassignedUserId, platformOwnerId, ordinaryUserId, targetUserId, invalidTenantTargetId] = users.map((u) => u.id);
    [validUsername, unassignedUsername] = [users[0].username, users[1].username];
    fixtureUserIds = users.map((u) => u.id);

    await prisma.tenantUser.create({
      data: { tenantId, userId: validUserId, role: "STAFF" }
    });
    await prisma.branchUser.create({
      data: { tenantId, branchId, userId: validUserId, isDefault: true }
    });

    tokenOwner = tokenFor(platformOwnerId, "PLATFORM_OWNER");
    tokenOrdinary = tokenFor(ordinaryUserId, "ADMIN");

    const app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    app.use("/api", authenticateToken);
    // Match production placement: admin router is mounted after auth and before tenant context.
    app.use("/api/admin", adminRouter);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("P0-02 test server did not bind.");
    baseUrl = "http://127.0.0.1:" + address.port;
  });

  afterAll(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    resetLoginAttemptGuardForTests();
    if (tenantId) {
      await prisma.auditLog.deleteMany({ where: { OR: [{ tenantId }, { userId: { in: fixtureUserIds } }] } });
      await prisma.branchUser.deleteMany({ where: { tenantId } });
      await prisma.tenantUser.deleteMany({ where: { tenantId } });
      await prisma.branch.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
    if (fixtureUserIds.length) {
      await prisma.refreshToken.deleteMany({ where: { userId: { in: fixtureUserIds } } });
      await prisma.session.deleteMany({ where: { userId: { in: fixtureUserIds } } });
      await prisma.auditLog.deleteMany({ where: { userId: { in: fixtureUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: fixtureUserIds } } });
    }
  });

  it("1. rejects a tenant-less user with 403 and does not issue JWT or create membership", async () => {
    const before = await prisma.tenantUser.count({ where: { userId: unassignedUserId } });
    const response = await post("/api/auth/login", { username: unassignedUsername, password });
    const after = await prisma.tenantUser.count({ where: { userId: unassignedUserId } });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("TENANT_UNASSIGNED");
    expect(response.body.accessToken).toBeUndefined();
    expect(response.body.refreshToken).toBeUndefined();
    expect(after).toBe(before);
  });

  it("2. does not create a default tenant during rejected login", async () => {
    const before = await prisma.tenant.count();
    const response = await post("/api/auth/login", { username: unassignedUsername, password });
    expect(response.status).toBe(403);
    expect(await prisma.tenant.count()).toBe(before);
  });

  it("3. does not create a BranchUser during rejected login", async () => {
    const before = await prisma.branchUser.count({ where: { userId: unassignedUserId } });
    const response = await post("/api/auth/login", { username: unassignedUsername, password });
    expect(response.status).toBe(403);
    expect(await prisma.branchUser.count({ where: { userId: unassignedUserId } })).toBe(before);
  });

  it("4. permits a valid user with TenantUser to log in and receive JWT", async () => {
    const response = await post("/api/auth/login", { username: validUsername, password });
    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeTruthy();
    expect(response.body.refreshToken).toBeTruthy();
    expect(response.body.tenantId).toBe(tenantId);
  });

  it("5. writes the rejected-login audit event using the existing CREATE enum value", async () => {
    const response = await post("/api/auth/login", { username: unassignedUsername, password });
    expect(response.status).toBe(403);
    const audit = await prisma.auditLog.findFirst({
      where: { userId: unassignedUserId, action: "CREATE", entity: "LOGIN_REJECTED_NO_TENANT" },
      orderBy: { timestamp: "desc" }
    });
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit!.after || "{}").eventType).toBe("LOGIN_REJECTED_NO_TENANT");
  });

  it("6. allows PLATFORM_OWNER to assign a user to a tenant and writes audit", async () => {
    const response = await post("/api/admin/users/" + targetUserId + "/assign-tenant", { tenantId, branchId }, tokenOwner);
    expect(response.status).toBe(201);
    expect(response.body.created).toBe(true);
    const membership = await prisma.tenantUser.findFirst({ where: { tenantId, userId: targetUserId } });
    expect(membership).toBeTruthy();
    expect(await prisma.branchUser.findFirst({ where: { tenantId, branchId, userId: targetUserId } })).toBeTruthy();
    const audit = await prisma.auditLog.findFirst({
      where: { userId: platformOwnerId, action: "CREATE", entity: "TENANT_USER_MANUAL_ASSIGNMENT", entityId: membership!.id }
    });
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit!.after || "{}")).toMatchObject({
      eventType: "TENANT_USER_MANUAL_ASSIGNMENT",
      targetUserId,
      tenantId,
      branchId,
      assignedBy: platformOwnerId
    });
  });

  it("7. rejects a non-PLATFORM_OWNER on the admin endpoint", async () => {
    const response = await post("/api/admin/users/" + invalidTenantTargetId + "/assign-tenant", { tenantId }, tokenOrdinary);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("ACCESS_DENIED");
  });

  it("8. returns 404 TENANT_NOT_FOUND for an invalid tenantId", async () => {
    const response = await post("/api/admin/users/" + invalidTenantTargetId + "/assign-tenant", { tenantId: "missing-tenant-" + Date.now() }, tokenOwner);
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("TENANT_NOT_FOUND");
  });

  it("9. is idempotent and does not write a second AuditLog", async () => {
    const before = await prisma.auditLog.count({
      where: { userId: platformOwnerId, action: "CREATE", entity: "TENANT_USER_MANUAL_ASSIGNMENT" }
    });
    const response = await post("/api/admin/users/" + targetUserId + "/assign-tenant", { tenantId, branchId }, tokenOwner);
    expect(response.status).toBe(200);
    expect(response.body.created).toBe(false);
    const after = await prisma.auditLog.count({
      where: { userId: platformOwnerId, action: "CREATE", entity: "TENANT_USER_MANUAL_ASSIGNMENT" }
    });
    expect(after).toBe(before);
  });

  it("10. keeps secure bootstrap fail-safe on a non-empty database without changing records", async () => {
    const before = {
      users: await prisma.user.count(),
      tenants: await prisma.tenant.count()
    };
    const output = execFileSync("./node_modules/.bin/tsx", ["scripts/secure-admin-bootstrap.ts"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ADMIN_USERNAME: "p0_02_bootstrap_must_not_create",
        ADMIN_PASSWORD: "P0-02-CI-Only-Bootstrap-Password!",
        TENANT_NAME: "P0-02 Bootstrap Must Not Create"
      }
    });
    expect(output).toContain("Bootstrap aborted to prevent duplicate initialization");
    expect(await prisma.user.count()).toBe(before.users);
    expect(await prisma.tenant.count()).toBe(before.tenants);
  });
});
