import { expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { getJwtSecret } from "../security/jwtSecrets.js";
import { definePostgresHttpSuite, request } from "./helpers/postgres-http.integration.helpers.js";

definePostgresHttpSuite("Real PostgreSQL HTTP — Authentication", (getContext) => {
  it("authenticates both isolated tenant users through the real login HTTP route", async () => {
    const ctx = getContext();
    const meA = await request(ctx, "/api/v1/auth/me", { token: ctx.tokenA });
    const meB = await request(ctx, "/api/v1/auth/me", { token: ctx.tokenB });

    expect(meA.status).toBe(200);
    expect(meA.body.user.tenantId).toBe(ctx.tenantAId);
    expect(meB.status).toBe(200);
    expect(meB.body.user.tenantId).toBe(ctx.tenantBId);

    const sessions = await (await import("../database/prisma.js")).prisma.session.count({
      where: { userId: { in: [ctx.userAId, ctx.userBId] } },
    });
    expect(sessions).toBe(2);
  });

  it("recreates a missing branch membership during legacy login and returns that branch in the JWT payload", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");

    await prisma.branchUser.deleteMany({
      where: { userId: ctx.userAId, tenantId: ctx.tenantAId }
    });

    const login = await request(ctx, "/api/auth/login", {
      method: "POST",
      body: { username: ctx.usernameA, password: "Ci-Only-Password-2026!" }
    });

    expect(login.status).toBe(200);
    expect(login.body.branchId).toBe(ctx.branchAId);
    const membership = await prisma.branchUser.findFirst({
      where: { userId: ctx.userAId, tenantId: ctx.tenantAId, branchId: ctx.branchAId }
    });
    expect(membership).toBeTruthy();
  });

  it("resolves only the selected branch assigned to the authenticated tenant user", async () => {
    const ctx = getContext();

    const ownBranch = await request(ctx, "/api/auth/branch-context", { token: ctx.tokenA, branchId: ctx.branchAId });
    expect(ownBranch.status).toBe(200);
    expect(ownBranch.body.data.id).toBe(ctx.branchAId);
    expect(ownBranch.body.data.tenantId).toBe(ctx.tenantAId);

    const foreignBranch = await request(ctx, "/api/auth/branch-context", {
      token: ctx.tokenA,
      branchId: ctx.branchBId
    });
    expect(foreignBranch.status).toBe(403);
    expect(foreignBranch.body.error).toBe("BRANCH_MEMBERSHIP_REQUIRED");
  });

  it("recovers from a stale same-tenant branch selection when the user has one active membership", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const staleBranch = await prisma.branch.create({
      data: {
        tenantId: ctx.tenantAId,
        code: `STALE-${ctx.suffix}`,
        name: "Unassigned stale branch",
        isActive: true
      }
    });

    const recovered = await request(ctx, "/api/auth/branch-context", {
      token: ctx.tokenA,
      branchId: staleBranch.id
    });

    expect(recovered.status).toBe(200);
    expect(recovered.body.data.id).toBe(ctx.branchAId);
    expect(recovered.body.contextCorrected).toBe(true);
  });

  it("reconciles a missing stale branch ID only when exactly one active membership exists", async () => {
    const ctx = getContext();

    const recovered = await request(ctx, "/api/auth/branch-context", {
      token: ctx.tokenA,
      branchId: "deleted-stale-branch-id"
    });

    expect(recovered.status).toBe(200);
    expect(recovered.body.data.id).toBe(ctx.branchAId);
    expect(recovered.body.data.tenantId).toBe(ctx.tenantAId);
    expect(recovered.body.contextCorrected).toBe(true);
  });


  async function promoteFixtureUserToPlatformOwner(ctx: { userAId: string; usernameA: string; tenantAId: string }): Promise<string> {
    const { prisma } = await import("../database/prisma.js");
    await prisma.user.update({ where: { id: ctx.userAId }, data: { role: "PLATFORM_OWNER" } });
    return jwt.sign({
      userId: ctx.userAId,
      username: ctx.usernameA,
      role: "PLATFORM_OWNER",
      tenantId: ctx.tenantAId
    }, getJwtSecret(), { expiresIn: "5m" });
  }

  async function restoreFixtureAdmin(userId: string): Promise<void> {
    const { prisma } = await import("../database/prisma.js");
    await prisma.user.update({ where: { id: userId }, data: { role: "ADMIN" } });
  }

  function restoreResetKey(original: string | undefined): void {
    if (original === undefined) delete process.env.ADMIN_RESET_KEY;
    else process.env.ADMIN_RESET_KEY = original;
  }

  it("T-2: TENANT_ADMIN is denied with 403", async () => {
    const ctx = getContext();
    const response = await request(ctx, "/api/auth/admin-reset", {
      method: "POST",
      token: ctx.tokenA,
      headers: { "x-reset-key": "irrelevant-for-role-denial" },
      body: { userId: ctx.userAId, targetTenantId: ctx.tenantAId }
    });
    expect(response.status).toBe(403);
    const { prisma } = await import("../database/prisma.js");
    expect(await prisma.user.count({ where: { id: ctx.userAId } })).toBe(1);
  });

  it("T-3: missing ADMIN_RESET_KEY fails closed with 503", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const originalKey = process.env.ADMIN_RESET_KEY;
    const actorToken = await promoteFixtureUserToPlatformOwner(ctx);
    delete process.env.ADMIN_RESET_KEY;
    try {
      const response = await request(ctx, "/api/auth/admin-reset", {
        method: "POST",
        token: actorToken,
        body: { userId: ctx.userBId, targetTenantId: ctx.tenantBId }
      });
      expect(response.status).toBe(503);
      expect(await prisma.user.count({ where: { id: ctx.userBId } })).toBe(1);
    } finally {
      restoreResetKey(originalKey);
      await restoreFixtureAdmin(ctx.userAId);
    }
  });

  it("T-4: an incorrect reset key returns 401 and deletes nothing", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const originalKey = process.env.ADMIN_RESET_KEY;
    const actorToken = await promoteFixtureUserToPlatformOwner(ctx);
    process.env.ADMIN_RESET_KEY = "ci-admin-reset-key";
    try {
      const response = await request(ctx, "/api/auth/admin-reset", {
        method: "POST",
        token: actorToken,
        headers: { "x-reset-key": "incorrect-reset-key" },
        body: { userId: ctx.userBId, targetTenantId: ctx.tenantBId }
      });
      expect(response.status).toBe(401);
      expect(await prisma.user.count({ where: { id: ctx.userBId } })).toBe(1);
      expect(await prisma.auditLog.count({
        where: { userId: ctx.userAId, entity: "User", entityId: ctx.userBId }
      })).toBe(0);
    } finally {
      restoreResetKey(originalKey);
      await restoreFixtureAdmin(ctx.userAId);
    }
  });

  it("T-5: cross-tenant reset requires the exact explicit targetTenantId", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const originalKey = process.env.ADMIN_RESET_KEY;
    const actorToken = await promoteFixtureUserToPlatformOwner(ctx);
    process.env.ADMIN_RESET_KEY = "ci-admin-reset-key";
    try {
      const missingTenant = await request(ctx, "/api/auth/admin-reset", {
        method: "POST",
        token: actorToken,
        headers: { "x-reset-key": "ci-admin-reset-key" },
        body: { userId: ctx.userBId }
      });
      expect(missingTenant.status).toBe(400);
      const wrongTenant = await request(ctx, "/api/auth/admin-reset", {
        method: "POST",
        token: actorToken,
        headers: { "x-reset-key": "ci-admin-reset-key" },
        body: { userId: ctx.userBId, targetTenantId: ctx.tenantAId }
      });
      expect(wrongTenant.status).toBe(403);
      expect(await prisma.user.count({ where: { id: ctx.userBId } })).toBe(1);
      expect(await prisma.auditLog.count({
        where: { userId: ctx.userAId, entity: "User", entityId: ctx.userBId }
      })).toBe(0);
    } finally {
      restoreResetKey(originalKey);
      await restoreFixtureAdmin(ctx.userAId);
    }
  });

  it("T-6: a database failure rolls back RefreshToken deletion and leaves no AuditLog", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const originalKey = process.env.ADMIN_RESET_KEY;
    const actorToken = await promoteFixtureUserToPlatformOwner(ctx);
    process.env.ADMIN_RESET_KEY = "ci-admin-reset-key";
    const refreshToken = "ci-admin-reset-rollback-" + randomUUID();
    const safeUserId = ctx.userBId.replace(/[^0-9a-f-]/gi, "");
    try {
      await prisma.refreshToken.create({
        data: { userId: ctx.userBId, token: refreshToken, expiresAt: new Date(Date.now() + 3600000) }
      });
      await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS ci_fail_admin_reset_delete ON public.users");
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS public.ci_fail_admin_reset_delete()");
      await prisma.$executeRawUnsafe(
        "CREATE OR REPLACE FUNCTION public.ci_fail_admin_reset_delete() RETURNS trigger AS $$ " +
        "BEGIN IF OLD.id = '" + safeUserId + "' THEN RAISE EXCEPTION 'forced admin-reset regression failure'; END IF; " +
        "RETURN OLD; END; $$ LANGUAGE plpgsql"
      );
      await prisma.$executeRawUnsafe(
        "CREATE TRIGGER ci_fail_admin_reset_delete BEFORE DELETE ON public.users " +
        "FOR EACH ROW EXECUTE FUNCTION public.ci_fail_admin_reset_delete()"
      );
      const response = await request(ctx, "/api/auth/admin-reset", {
        method: "POST",
        token: actorToken,
        headers: { "x-reset-key": "ci-admin-reset-key" },
        body: { userId: ctx.userBId, targetTenantId: ctx.tenantBId }
      });
      expect(response.status).toBe(500);
      expect(await prisma.user.count({ where: { id: ctx.userBId } })).toBe(1);
      expect(await prisma.refreshToken.count({ where: { userId: ctx.userBId, token: refreshToken } })).toBe(1);
      expect(await prisma.auditLog.count({
        where: { userId: ctx.userAId, entity: "User", entityId: ctx.userBId }
      })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS ci_fail_admin_reset_delete ON public.users");
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS public.ci_fail_admin_reset_delete()");
      await prisma.refreshToken.deleteMany({ where: { userId: ctx.userBId, token: refreshToken } });
      restoreResetKey(originalKey);
      await restoreFixtureAdmin(ctx.userAId);
    }
  });

  it("T-1: PLATFORM_OWNER with the correct key deletes by userId and writes an AuditLog", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const originalKey = process.env.ADMIN_RESET_KEY;
    const actorToken = await promoteFixtureUserToPlatformOwner(ctx);
    process.env.ADMIN_RESET_KEY = "ci-admin-reset-key";
    try {
      await prisma.refreshToken.create({
        data: {
          userId: ctx.userBId,
          token: "ci-admin-reset-" + randomUUID(),
          expiresAt: new Date(Date.now() + 3600000)
        }
      });
      const response = await request(ctx, "/api/auth/admin-reset", {
        method: "POST",
        token: actorToken,
        headers: { "x-reset-key": "ci-admin-reset-key" },
        body: { userId: ctx.userBId, targetTenantId: ctx.tenantBId }
      });
      expect(response.status).toBe(200);
      expect(response.body.deletedCount).toBe(1);
      expect(response.body.userId).toBe(ctx.userBId);
      expect(await prisma.user.count({ where: { id: ctx.userBId } })).toBe(0);
      expect(await prisma.refreshToken.count({ where: { userId: ctx.userBId } })).toBe(0);
      const audit = await prisma.auditLog.findFirst({
        where: {
          userId: ctx.userAId,
          action: "DELETE",
          entity: "User",
          entityId: ctx.userBId,
          tenantId: ctx.tenantBId
        },
        orderBy: { timestamp: "desc" }
      });
      expect(audit).toBeTruthy();
      expect(audit?.ipAddress).toBeTruthy();
      expect(JSON.parse(audit!.before!)).toMatchObject({
        userId: ctx.userBId,
        tenantId: ctx.tenantBId
      });
      expect(JSON.parse(audit!.after!)).toMatchObject({
        deleted: true,
        targetTenantId: ctx.tenantBId,
        actorUserId: ctx.userAId
      });
    } finally {
      restoreResetKey(originalKey);
      await restoreFixtureAdmin(ctx.userAId);
    }
  });

});
