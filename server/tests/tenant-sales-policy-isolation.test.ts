import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    tenantSalesPolicy: {
      findFirst: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("../database/prisma.js", () => ({ prisma: mockPrisma }));

import { tenantPrisma, isTenantOwnedModel } from "../database/tenantPrisma.js";
import { runWithTenantContext } from "../context/tenantContext.js";

describe("TenantSalesPolicy Prisma isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.tenantSalesPolicy.findFirst.mockResolvedValue({ tenantId: "tenant-A" });
    mockPrisma.tenantSalesPolicy.upsert.mockResolvedValue({ tenantId: "tenant-A" });
  });

  it("registers TenantSalesPolicy as a tenant-owned model", () => {
    expect(isTenantOwnedModel("tenantSalesPolicy")).toBe(true);
  });

  it("scopes policy reads to the trusted tenant context", async () => {
    await runWithTenantContext({ tenantId: "tenant-A" }, async () => {
      await tenantPrisma.tenantSalesPolicy.findFirst({ where: { tenantId: "tenant-A" } });
    });

    expect(mockPrisma.tenantSalesPolicy.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-A" } }),
    );
  });

  it("rejects a policy lookup attempting to cross tenant boundaries", async () => {
    await runWithTenantContext({ tenantId: "tenant-A" }, async () => {
      await expect(
        tenantPrisma.tenantSalesPolicy.findFirst({ where: { tenantId: "tenant-B" } }),
      ).rejects.toThrow(/SECURITY_VIOLATION/);
    });

    expect(mockPrisma.tenantSalesPolicy.findFirst).not.toHaveBeenCalled();
  });

  it("injects the trusted tenant on policy upsert create and update payloads", async () => {
    await runWithTenantContext({ tenantId: "tenant-A" }, async () => {
      await tenantPrisma.tenantSalesPolicy.upsert({
        where: { tenantId: "tenant-A" },
        create: { tenantId: "tenant-A", maxDiscountPercent: 5 },
        update: { maxDiscountPercent: 10 },
      });
    });

    expect(mockPrisma.tenantSalesPolicy.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-A" },
      create: expect.objectContaining({ tenantId: "tenant-A", maxDiscountPercent: 5 }),
      update: expect.objectContaining({ tenantId: "tenant-A", maxDiscountPercent: 10 }),
    }));
  });
});
