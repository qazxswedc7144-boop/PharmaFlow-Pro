// server/routes/rbac.routes.ts
import { Router, Response } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { tenantContextMiddleware } from "../middleware/tenant.middleware.js";
import { requirePermission } from "../middleware/permission.middleware.js";
import { PermissionService } from "../services/rbac/permission.service.js";
import { RoleService } from "../services/rbac/role.service.js";
import { AuthorizationService } from "../services/rbac/authorization.service.js";

const router = Router();

router.use(authenticateToken);
router.use(tenantContextMiddleware);

/**
 * GET /api/rbac/permissions
 * List all available enterprise permissions
 */
router.get("/permissions", async (_req, res: Response) => {
  try {
    const permissions = PermissionService.getAllPermissions();
    const byModule = PermissionService.getPermissionsByModule();
    res.json({
      success: true,
      data: {
        permissions,
        byModule
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/rbac/roles
 * List system & tenant-custom roles
 */
router.get("/roles", requirePermission("users.roles.manage"), async (req, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const tenantId = (authReq.user?.tenantId || (req as any).tenantId || 'default-tenant') as string;
    const roles = await RoleService.getRoles(tenantId);
    res.json({ success: true, data: roles });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/rbac/roles
 * Create custom role
 */
router.post("/roles", requirePermission("users.roles.manage"), async (req, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const tenantId = (authReq.user?.tenantId || (req as any).tenantId || 'default-tenant') as string;
    const { name, description, permissions = [] } = req.body;

    if (!name || !name.trim()) {
      res.status(400).json({ success: false, error: "اسم الدور مطلوب" });
      return;
    }

    const created = await RoleService.createRole(tenantId, {
      name,
      description,
      permissions
    });

    res.status(201).json({
      success: true,
      message: "تم إنشاء الدور المخصص بنجاح",
      data: created
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/rbac/roles/:id
 * Update custom role
 */
router.put("/roles/:id", requirePermission("users.roles.manage"), async (req, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const tenantId = (authReq.user?.tenantId || (req as any).tenantId || 'default-tenant') as string;
    const { id } = req.params;
    const { name, description, permissions } = req.body;

    if (!id) {
      res.status(400).json({ success: false, error: "معرف الدور مطلوب" });
      return;
    }

    const updated = await RoleService.updateRole(tenantId, id, {
      name,
      description,
      permissions
    });

    res.json({
      success: true,
      message: "تم تحديث الدور وصلاحياته بنجاح",
      data: updated
    });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/rbac/roles/:id/duplicate
 * Clone an existing role
 */
router.post("/roles/:id/duplicate", requirePermission("users.roles.manage"), async (req, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const tenantId = (authReq.user?.tenantId || (req as any).tenantId || 'default-tenant') as string;
    const { id } = req.params;
    const { name } = req.body;

    if (!id) {
      res.status(400).json({ success: false, error: "معرف الدور مطلوب" });
      return;
    }

    if (!name || !name.trim()) {
      res.status(400).json({ success: false, error: "اسم الدور الجديد مطلوب" });
      return;
    }

    const duplicated = await RoleService.duplicateRole(tenantId, id, name.trim());
    res.status(201).json({
      success: true,
      message: "تم استنساخ الدور بنجاح",
      data: duplicated
    });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/rbac/roles/:id
 * Delete custom role
 */
router.delete("/roles/:id", requirePermission("users.roles.manage"), async (req, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const tenantId = (authReq.user?.tenantId || (req as any).tenantId || 'default-tenant') as string;
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ success: false, error: "معرف الدور مطلوب" });
      return;
    }

    const ok = await RoleService.deleteRole(tenantId, id);
    if (!ok) {
      res.status(404).json({ success: false, error: "الدور غير موجود" });
      return;
    }

    res.json({
      success: true,
      message: "تم حذف الدور المخصص بنجاح"
    });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/rbac/matrix
 * Get matrix of all roles and permissions
 */
router.get("/matrix", requirePermission("users.roles.manage"), async (req, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const tenantId = (authReq.user?.tenantId || (req as any).tenantId || 'default-tenant') as string;

    const permissions = PermissionService.getAllPermissions();
    const roles = await RoleService.getRoles(tenantId);

    const matrix: Record<string, Record<string, boolean>> = {};
    for (const role of roles) {
      const roleMap: Record<string, boolean> = {};
      const isWildcard = role.permissions.includes("*");
      for (const p of permissions) {
        roleMap[p.key] = isWildcard || role.permissions.includes(p.key);
      }
      matrix[role.name] = roleMap;
    }

    res.json({
      success: true,
      data: {
        permissions,
        roles: roles.map(r => ({ id: r.id, name: r.name, isSystemRole: r.isSystemRole })),
        matrix
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/rbac/users/:id/overrides
 * Set custom permission override
 */
router.post("/users/:id/overrides", requirePermission("users.permissions.override"), async (req, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const tenantId = (authReq.user?.tenantId || (req as any).tenantId || 'default-tenant') as string;
    const { id } = req.params;
    const { permissionKey, effect } = req.body;

    if (!id || !permissionKey || !["ALLOW", "DENY"].includes(effect)) {
      res.status(400).json({ success: false, error: "بيانات الاستثناء غير صالحة" });
      return;
    }

    await RoleService.setUserPermissionOverride(tenantId, id, permissionKey, effect);

    res.json({
      success: true,
      message: `تم ضبط استثناء الصلاحية (${permissionKey}) إلى ${effect} بنجاح`
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/rbac/users/:id/overrides/:permissionKey
 * Remove permission override
 */
router.delete("/users/:id/overrides/:permissionKey", requirePermission("users.permissions.override"), async (req, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const tenantId = (authReq.user?.tenantId || (req as any).tenantId || 'default-tenant') as string;
    const { id, permissionKey } = req.params;

    if (!id || !permissionKey) {
      res.status(400).json({ success: false, error: "المعطيات غير مكتملة" });
      return;
    }

    await RoleService.removeUserPermissionOverride(tenantId, id, permissionKey);

    res.json({
      success: true,
      message: "تم إلغاء الاستثناء واستعادة الصلاحية الافتراضية للدور"
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/rbac/users/:id/effective-permissions
 * Get user computed effective permissions
 */
router.get("/users/:id/effective-permissions", async (req, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const tenantId = (authReq.user?.tenantId || (req as any).tenantId || 'default-tenant') as string;
    const { id } = req.params;

    const permissions = await AuthorizationService.getUserEffectivePermissions(
      tenantId,
      id,
      authReq.user?.role
    );

    res.json({
      success: true,
      data: {
        userId: id,
        effectivePermissions: Array.from(permissions)
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
