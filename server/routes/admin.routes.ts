import { Router, Response } from "express";
import { Role } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { authenticateToken, AuthenticatedRequest, requireRoles } from "../middleware/auth.middleware.js";

const router = Router();

router.use(authenticateToken, requireRoles([Role.PLATFORM_OWNER]));

router.post("/users/:userId/assign-tenant", async (req: AuthenticatedRequest, res: Response) => {
  const userId = String(req.params.userId || "").trim();
  const tenantId = typeof req.body?.tenantId === "string" ? req.body.tenantId.trim() : "";
  const branchId = typeof req.body?.branchId === "string" ? req.body.branchId.trim() : undefined;
  const assignedBy = req.user?.userId;

  if (!userId || !tenantId || !assignedBy) {
    return res.status(400).json({ error: "INVALID_ASSIGNMENT_REQUEST" });
  }
  if (req.body?.branchId !== undefined && !branchId) {
    return res.status(400).json({ error: "INVALID_BRANCH_ID" });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const [tenant, targetUser] = await Promise.all([
        tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }),
        tx.user.findUnique({ where: { id: userId }, select: { id: true } })
      ]);

      if (!tenant) return { status: 404 as const, error: "TENANT_NOT_FOUND" };
      if (!targetUser) return { status: 404 as const, error: "USER_NOT_FOUND" };

      if (branchId) {
        const branch = await tx.branch.findFirst({
          where: { id: branchId, tenantId },
          select: { id: true }
        });
        if (!branch) return { status: 404 as const, error: "BRANCH_NOT_FOUND" };
      }

      const existing = await tx.tenantUser.findFirst({ where: { userId, tenantId } });
      if (existing) {
        // Idempotent no-op: never duplicate membership or emit repeated audit events.
        return { status: 200 as const, created: false as const, tenantUser: existing };
      }

      const tenantUser = await tx.tenantUser.create({
        data: { userId, tenantId, role: "STAFF" }
      });

      if (branchId) {
        await tx.branchUser.create({
          data: { userId, tenantId, branchId, isDefault: true }
        });
      }

      await tx.auditLog.create({
        data: {
          userId: assignedBy,
          action: "CREATE",
          entity: "TENANT_USER_MANUAL_ASSIGNMENT",
          entityId: tenantUser.id,
          after: JSON.stringify({
            eventType: "TENANT_USER_MANUAL_ASSIGNMENT",
            targetUserId: userId,
            tenantId,
            branchId: branchId || null,
            assignedBy
          }),
          ipAddress: req.ip,
          tenantId,
          branchId: branchId || null
        }
      });

      return { status: 201 as const, created: true as const, tenantUser };
    });

    if ("error" in result) return res.status(result.status).json({ error: result.error });
    return res.status(result.status).json({ created: result.created, tenantUser: result.tenantUser });
  } catch (error: any) {
    // A concurrent request may win the unique (userId, tenantId) insert.
    if (error?.code === "P2002") {
      const existing = await prisma.tenantUser.findFirst({ where: { userId, tenantId } }).catch(() => null);
      if (existing) return res.status(200).json({ created: false, tenantUser: existing });
    }
    console.error("[AdminRoutes] Tenant assignment failed:", error?.message || error);
    return res.status(500).json({ error: "TENANT_ASSIGNMENT_FAILED" });
  }
});

export default router;
