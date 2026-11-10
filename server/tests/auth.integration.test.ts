import { expect, it } from "vitest";
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
});
