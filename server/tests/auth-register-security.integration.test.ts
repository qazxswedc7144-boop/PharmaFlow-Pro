import { expect, it } from "vitest";
import { definePostgresHttpSuite, request } from "./helpers/postgres-http.integration.helpers.js";

definePostgresHttpSuite("Real PostgreSQL HTTP — /api/auth/register security", (getContext) => {
  it("rejects ADMIN privilege escalation to PLATFORM_OWNER without creating a user", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const username = `ci_escalate_${ctx.suffix}`;

    const response = await request(ctx, "/api/auth/register", {
      method: "POST",
      token: ctx.tokenA,
      body: {
        username,
        password: "Register-Test-Password-2026!",
        role: "PLATFORM_OWNER",
        tenantId: ctx.tenantAId,
        branchId: ctx.branchAId
      }
    });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toBe("PRIVILEGE_ESCALATION_FORBIDDEN");
    expect(await prisma.user.findUnique({ where: { username } })).toBeNull();
  });

  it("ignores a client-supplied tenantId and creates the user only in the ADMIN's tenant", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const username = `ci_tenant_spoof_${ctx.suffix}`;

    const response = await request(ctx, "/api/auth/register", {
      method: "POST",
      token: ctx.tokenA,
      body: {
        username,
        password: "Register-Test-Password-2026!",
        role: "CASHIER",
        tenantId: ctx.tenantBId,
        branchId: ctx.branchAId
      }
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = await prisma.user.findUnique({ where: { username } });
    expect(created).toBeTruthy();
    expect(await prisma.tenantUser.findFirst({
      where: { userId: created!.id, tenantId: ctx.tenantAId }
    })).toBeTruthy();
    expect(await prisma.tenantUser.findFirst({
      where: { userId: created!.id, tenantId: ctx.tenantBId }
    })).toBeNull();
    expect(await prisma.branchUser.findFirst({
      where: { userId: created!.id, tenantId: ctx.tenantAId, branchId: ctx.branchAId }
    })).toBeTruthy();
  });

  it("rejects a branch belonging to a different tenant even when that tenantId is supplied", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const username = `ci_foreign_branch_${ctx.suffix}`;

    const response = await request(ctx, "/api/auth/register", {
      method: "POST",
      token: ctx.tokenA,
      body: {
        username,
        password: "Register-Test-Password-2026!",
        role: "CASHIER",
        tenantId: ctx.tenantBId,
        branchId: ctx.branchBId
      }
    });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(await prisma.user.findUnique({ where: { username } })).toBeNull();
  });
});
