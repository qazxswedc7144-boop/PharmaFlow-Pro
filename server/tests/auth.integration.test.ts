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
});
