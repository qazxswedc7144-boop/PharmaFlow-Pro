import { describe, it, expect, afterEach } from "vitest";
import { getTenantScopedPrisma } from "../../../../server/database/tenantPrisma.js";
import { tenantStorage } from "../../../../server/context/tenantContext.js";
import { ReplicationPublisher } from "../../../../server/modules/replication/replication.publisher.js";

describe("Security Closure Patch 2 Regression Tests", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("1. Rejects explicitTenantId override when it conflicts with active trusted tenant context", async () => {
    const scopedPrisma = getTenantScopedPrisma("tenant-attacker");

    await expect(
      tenantStorage.run({ tenantId: "tenant-trusted" }, async () => {
        await scopedPrisma.product.findMany({});
      })
    ).rejects.toThrow(/SECURITY_VIOLATION/i);
  });

  it("2. ReplicationPublisher rejects publishing with conflicting tenantId", async () => {
    await expect(
      tenantStorage.run({ tenantId: "tenant-trusted" }, async () => {
        await ReplicationPublisher.publish({
          type: "INVENTORY_UPDATED" as any,
          branchId: "branch-1",
          tenantId: "tenant-attacker",
          payload: { id: "evt-1" },
        });
      })
    ).rejects.toThrow(/SECURITY_VIOLATION/i);
  });

  it("3. Rejects missing tenant context in production mode", async () => {
    process.env.NODE_ENV = "production";
    const scopedPrisma = getTenantScopedPrisma("tenant-untrusted");

    await expect(scopedPrisma.product.findMany({})).rejects.toThrow(/SECURITY_VIOLATION/i);

    await expect(
      ReplicationPublisher.publish({
        type: "INVENTORY_UPDATED" as any,
        branchId: "branch-1",
        tenantId: "tenant-untrusted",
        payload: { id: "evt-prod-1" },
      })
    ).rejects.toThrow(/SECURITY_VIOLATION/i);
  });
});
