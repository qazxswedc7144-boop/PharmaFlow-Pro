import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockUserRecord {
  id: string;
  username: string;
  role: string;
  isActive: boolean;
  lastLoginAt: Date;
  createdAt: Date;
  tenantIds: string[];
}

const mocks = vi.hoisted(() => ({
  activeTenantId: "TENANT-A" as string | undefined,
  isConnected: vi.fn(),
  userFindMany: vi.fn(),
  userUpdateMany: vi.fn(),
  userUpdate: vi.fn(),
  getUserRoles: vi.fn(),
  getUserPermissionOverrides: vi.fn(),
  invalidateUserCache: vi.fn()
}));

vi.mock("../middleware/auth.middleware.js", () => ({
  authenticateToken: (req: any, _res: any, next: () => void) => {
    req.user = {
      userId: "admin-tenant-a",
      username: "admin_a",
      role: "TENANT_ADMIN",
      tenantId: mocks.activeTenantId
    };
    next();
  }
}));

vi.mock("../middleware/tenant.middleware.js", () => ({
  tenantContextMiddleware: (req: any, _res: any, next: () => void) => {
    req.tenantId = mocks.activeTenantId;
    next();
  }
}));

vi.mock("../middleware/permission.middleware.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: () => void) => next()
}));

vi.mock("../database/prisma.js", () => ({
  prisma: {
    isConnected: mocks.isConnected,
    user: {
      findMany: mocks.userFindMany,
      updateMany: mocks.userUpdateMany,
      update: mocks.userUpdate
    }
  }
}));

vi.mock("../services/rbac/role.service.js", () => ({
  RoleService: {
    getUserRoles: mocks.getUserRoles,
    getUserPermissionOverrides: mocks.getUserPermissionOverrides
  }
}));

vi.mock("../services/rbac/permission.service.js", () => ({
  PermissionService: {
    invalidateUserCache: mocks.invalidateUserCache
  }
}));

import organizationRouter from "../routes/organization.routes.js";

function matchesTenantUsersFilter(user: MockUserRecord, where: any): boolean {
  if (!where) return true;
  if (where.id !== undefined && user.id !== where.id) return false;
  if (where.tenantUsers) {
    const someTenantId = where.tenantUsers.some?.tenantId;
    if (someTenantId !== undefined && !user.tenantIds.includes(someTenantId)) {
      return false;
    }
    const everyTenantId = where.tenantUsers.every?.tenantId;
    if (everyTenantId !== undefined && !user.tenantIds.every((t) => t === everyTenantId)) {
      return false;
    }
  }
  return true;
}

describe("Organization user routes tenant isolation", () => {
  let server: ReturnType<typeof appListen> | undefined;
  let baseUrl = "";
  let usersStore: MockUserRecord[] = [];

  function appListen() {
    const app = express();
    app.use(express.json());
    app.use("/api/organization", organizationRouter);
    return app.listen(0);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.activeTenantId = "TENANT-A";
    mocks.isConnected.mockReturnValue(true);

    const now = new Date("2026-01-15T10:00:00.000Z");
    usersStore = [
      {
        id: "user-a-1",
        username: "admin_a",
        role: "TENANT_ADMIN",
        isActive: true,
        lastLoginAt: now,
        createdAt: now,
        tenantIds: ["TENANT-A"]
      },
      {
        id: "user-a-2",
        username: "cashier_a",
        role: "CASHIER",
        isActive: true,
        lastLoginAt: now,
        createdAt: now,
        tenantIds: ["TENANT-A"]
      },
      {
        id: "user-b-1",
        username: "admin_b",
        role: "TENANT_ADMIN",
        isActive: true,
        lastLoginAt: now,
        createdAt: now,
        tenantIds: ["TENANT-B"]
      },
      {
        id: "user-shared-ab",
        username: "shared_consultant",
        role: "AUDITOR",
        isActive: true,
        lastLoginAt: now,
        createdAt: now,
        tenantIds: ["TENANT-A", "TENANT-B"]
      }
    ];

    mocks.userFindMany.mockImplementation(async (args?: any) => {
      return usersStore
        .filter((u) => matchesTenantUsersFilter(u, args?.where))
        .map(({ tenantIds: _tenantIds, ...publicFields }) => ({ ...publicFields }));
    });

    mocks.userUpdateMany.mockImplementation(async (args?: any) => {
      let count = 0;
      for (const user of usersStore) {
        if (matchesTenantUsersFilter(user, args?.where)) {
          if (typeof args?.data?.isActive === "boolean") {
            user.isActive = args.data.isActive;
          }
          count += 1;
        }
      }
      return { count };
    });

    mocks.getUserRoles.mockResolvedValue([{ roleId: "role-1", roleName: "CASHIER" }]);
    mocks.getUserPermissionOverrides.mockResolvedValue([]);

    server = appListen();
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server!.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind to a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
      server = undefined;
    }
  });

  describe("GET /api/organization/users", () => {
    it("returns only users belonging to the authenticated tenant", async () => {
      const response = await fetch(`${baseUrl}/api/organization/users`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mocks.userFindMany).toHaveBeenCalledWith({
        where: {
          tenantUsers: {
            some: { tenantId: "TENANT-A" }
          }
        },
        select: {
          id: true,
          username: true,
          role: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true
        }
      });

      const returnedIds = body.data.map((u: any) => u.id);
      expect(returnedIds).toContain("user-a-1");
      expect(returnedIds).toContain("user-a-2");
      expect(returnedIds).not.toContain("user-b-1");
      expect(body.data[0].assignedRoles).toEqual(["CASHIER"]);
      expect(body.data[0].overridesCount).toBe(0);
    });

    it("fails closed with 403 when tenant context is missing", async () => {
      mocks.activeTenantId = undefined;

      const response = await fetch(`${baseUrl}/api/organization/users`);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.success).toBe(false);
      expect(mocks.userFindMany).not.toHaveBeenCalled();
    });
  });

  describe("PUT /api/organization/users/:id/status", () => {
    it("updates status and invalidates cache for a user in the same tenant", async () => {
      const response = await fetch(`${baseUrl}/api/organization/users/user-a-2/status`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: false })
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        success: true,
        message: "تم تعطيل حساب المستخدم وإلغاء جلساته الفعالة",
        data: { id: "user-a-2", isActive: false }
      });
      expect(mocks.userUpdate).not.toHaveBeenCalled();
      expect(mocks.userUpdateMany).toHaveBeenCalledWith({
        where: {
          id: "user-a-2",
          tenantUsers: {
            some: { tenantId: "TENANT-A" },
            every: { tenantId: "TENANT-A" }
          }
        },
        data: { isActive: false }
      });
      expect(usersStore.find((u) => u.id === "user-a-2")?.isActive).toBe(false);
      expect(mocks.invalidateUserCache).toHaveBeenCalledWith("TENANT-A", "user-a-2");
    });

    it("rejects updating a user from another tenant without mutating or revealing existence", async () => {
      const crossTenantResponse = await fetch(`${baseUrl}/api/organization/users/user-b-1/status`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: false })
      });
      const crossTenantBody = await crossTenantResponse.json();

      const missingUserResponse = await fetch(`${baseUrl}/api/organization/users/nonexistent-id/status`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: false })
      });
      const missingUserBody = await missingUserResponse.json();

      expect(crossTenantResponse.status).toBe(404);
      expect(crossTenantBody).toEqual(missingUserBody);
      expect(crossTenantBody.success).toBe(false);
      expect(usersStore.find((u) => u.id === "user-b-1")?.isActive).toBe(true);
      expect(mocks.invalidateUserCache).not.toHaveBeenCalled();
    });

    it("rejects updating a multi-tenant user shared with another tenant", async () => {
      const response = await fetch(`${baseUrl}/api/organization/users/user-shared-ab/status`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: false })
      });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
      expect(usersStore.find((u) => u.id === "user-shared-ab")?.isActive).toBe(true);
      expect(mocks.invalidateUserCache).not.toHaveBeenCalled();
    });

    it("fails closed with 503 when database is disconnected", async () => {
      mocks.isConnected.mockReturnValue(false);

      const response = await fetch(`${baseUrl}/api/organization/users/user-a-2/status`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: false })
      });
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.success).toBe(false);
      expect(mocks.userUpdateMany).not.toHaveBeenCalled();
      expect(usersStore.find((u) => u.id === "user-a-2")?.isActive).toBe(true);
      expect(mocks.invalidateUserCache).not.toHaveBeenCalled();
    });

    it("fails closed with 403 when tenant context is missing", async () => {
      mocks.activeTenantId = undefined;

      const response = await fetch(`${baseUrl}/api/organization/users/user-a-2/status`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: false })
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.success).toBe(false);
      expect(mocks.userUpdateMany).not.toHaveBeenCalled();
      expect(mocks.invalidateUserCache).not.toHaveBeenCalled();
    });
  });
});
