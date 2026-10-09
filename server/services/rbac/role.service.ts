// server/services/rbac/role.service.ts
import { RoleDefinition, UserRoleBinding, UserPermissionOverrideItem } from './types.js';
import { PermissionService, SYSTEM_ROLE_PERMISSIONS } from './permission.service.js';
import { prisma } from '../../database/prisma.js';

export class RoleService {
  // In-memory backing store for local/fast fallback or preview environments
  private static inMemoryRoles = new Map<string, RoleDefinition>();
  private static inMemoryUserRoles = new Map<string, UserRoleBinding[]>();
  private static inMemoryUserOverrides = new Map<string, UserPermissionOverrideItem[]>();

  static {
    // Seed initial system roles in memory
    const systemRoleNames = Object.keys(SYSTEM_ROLE_PERMISSIONS);
    for (const name of systemRoleNames) {
      const id = `sys-role-${name.toLowerCase().replace(/_/g, '-')}`;
      this.inMemoryRoles.set(id, {
        id,
        tenantId: null,
        name,
        description: `دور نظامي قياسي: ${name}`,
        isSystemRole: true,
        permissions: SYSTEM_ROLE_PERMISSIONS[name] || [],
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }
  }

  static async getRoles(tenantId?: string | null): Promise<RoleDefinition[]> {
    const isDbReady = prisma.isConnected && prisma.isConnected();

    if (isDbReady && (prisma as any).role) {
      try {
        const dbRoles = await (prisma as any).role.findMany({
          where: {
            OR: [
              { isSystemRole: true },
              { tenantId: tenantId || null }
            ]
          },
          include: {
            permissions: {
              include: { permission: true }
            }
          }
        });

        if (dbRoles && dbRoles.length > 0) {
          return dbRoles.map((r: any) => ({
            id: r.id,
            tenantId: r.tenantId,
            name: r.name,
            description: r.description,
            isSystemRole: r.isSystemRole,
            permissions: r.permissions?.map((rp: any) => rp.permission?.key).filter(Boolean) || [],
            createdAt: r.createdAt,
            updatedAt: r.updatedAt
          }));
        }
      } catch (err) {
        console.warn('[RoleService] DB fetch failed, falling back to memory store:', (err as Error).message);
      }
    }

    // Return in-memory roles
    return Array.from(this.inMemoryRoles.values()).filter(r => 
      r.isSystemRole || (tenantId && r.tenantId === tenantId)
    );
  }

  static async getRoleById(roleId: string, tenantId?: string | null): Promise<RoleDefinition | null> {
    const all = await this.getRoles(tenantId);
    return all.find(r => r.id === roleId) || null;
  }

  static async createRole(
    tenantId: string,
    data: { name: string; description?: string; permissions: string[] }
  ): Promise<RoleDefinition> {
    const isDbReady = prisma.isConnected && prisma.isConnected();
    const cleanName = data.name.trim();

    if (isDbReady && (prisma as any).role) {
      try {
        const created = await (prisma as any).role.create({
          data: {
            name: cleanName,
            description: data.description || null,
            tenantId,
            isSystemRole: false
          }
        });

        // Link permissions if any
        if (data.permissions && data.permissions.length > 0 && (prisma as any).permission && (prisma as any).rolePermission) {
          for (const key of data.permissions) {
            let perm = await (prisma as any).permission.findUnique({ where: { key } });
            if (!perm) {
              perm = await (prisma as any).permission.create({
                data: { key, module: key.split('.')[0] || 'general', action: key.split('.')[2] || 'manage' }
              });
            }
            await (prisma as any).rolePermission.create({
              data: { roleId: created.id, permissionId: perm.id }
            });
          }
        }

        PermissionService.invalidateTenantCache(tenantId);
        return {
          id: created.id,
          tenantId: created.tenantId,
          name: created.name,
          description: created.description,
          isSystemRole: false,
          permissions: data.permissions || [],
          createdAt: created.createdAt,
          updatedAt: created.updatedAt
        };
      } catch (err) {
        console.warn('[RoleService] DB create failed, fallback to memory:', (err as Error).message);
      }
    }

    // Memory storage
    const id = `custom-role-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const newRole: RoleDefinition = {
      id,
      tenantId,
      name: cleanName,
      description: data.description || null,
      isSystemRole: false,
      permissions: data.permissions || [],
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.inMemoryRoles.set(id, newRole);
    PermissionService.invalidateTenantCache(tenantId);
    return newRole;
  }

  static async updateRole(
    tenantId: string,
    roleId: string,
    data: { name?: string; description?: string; permissions?: string[] }
  ): Promise<RoleDefinition> {
    const existing = await this.getRoleById(roleId, tenantId);
    if (!existing) {
      throw new Error(`الدور برقم ${roleId} غير موجود.`);
    }
    if (existing.isSystemRole) {
      throw new Error('لا يمكن تعديل أو إعادة كتابة أدوار النظام المحمية.');
    }

    const isDbReady = prisma.isConnected && prisma.isConnected();
    if (isDbReady && (prisma as any).role) {
      try {
        await (prisma as any).role.update({
          where: { id: roleId },
          data: {
            name: data.name ?? existing.name,
            description: data.description !== undefined ? data.description : existing.description
          }
        });

        if (data.permissions && (prisma as any).rolePermission) {
          // Delete old
          await (prisma as any).rolePermission.deleteMany({ where: { roleId } });
          // Insert new
          for (const key of data.permissions) {
            let perm = await (prisma as any).permission.findUnique({ where: { key } });
            if (!perm) {
              perm = await (prisma as any).permission.create({
                data: { key, module: key.split('.')[0] || 'general', action: key.split('.')[2] || 'manage' }
              });
            }
            await (prisma as any).rolePermission.create({
              data: { roleId, permissionId: perm.id }
            });
          }
        }
      } catch (err) {
        console.warn('[RoleService] DB update failed, using memory:', (err as Error).message);
      }
    }

    const updated: RoleDefinition = {
      ...existing,
      name: data.name ?? existing.name,
      description: data.description !== undefined ? data.description : existing.description,
      permissions: data.permissions ?? existing.permissions,
      updatedAt: new Date()
    };
    this.inMemoryRoles.set(roleId, updated);
    PermissionService.invalidateTenantCache(tenantId);
    return updated;
  }

  static async duplicateRole(tenantId: string, roleId: string, newName: string): Promise<RoleDefinition> {
    const existing = await this.getRoleById(roleId, tenantId);
    if (!existing) {
      throw new Error('الدور المطلوب استنساخه غير موجود.');
    }
    return this.createRole(tenantId, {
      name: newName,
      description: `نسخة مستنسخة من: ${existing.name}`,
      permissions: [...existing.permissions]
    });
  }

  static async deleteRole(tenantId: string, roleId: string): Promise<boolean> {
    const existing = await this.getRoleById(roleId, tenantId);
    if (!existing) return false;
    if (existing.isSystemRole) {
      throw new Error('أدوار النظام القياسية محمية ولا يمكن حذفها نهائياً.');
    }

    const isDbReady = prisma.isConnected && prisma.isConnected();
    if (isDbReady && (prisma as any).role) {
      try {
        await (prisma as any).role.delete({ where: { id: roleId } });
      } catch (err) {
        console.warn('[RoleService] DB delete error:', (err as Error).message);
      }
    }

    this.inMemoryRoles.delete(roleId);
    PermissionService.invalidateTenantCache(tenantId);
    return true;
  }

  static async assignUserRoles(
    tenantId: string,
    userId: string,
    roleIds: string[],
    branchId?: string | null
  ): Promise<void> {
    const bindings: UserRoleBinding[] = roleIds.map(roleId => {
      const role = this.inMemoryRoles.get(roleId);
      return {
        userId,
        tenantId,
        roleId,
        roleName: role?.name || roleId,
        branchId: branchId || null
      };
    });

    const isDbReady = prisma.isConnected && prisma.isConnected();
    if (isDbReady && (prisma as any).userRole) {
      try {
        await (prisma as any).userRole.deleteMany({
          where: { userId, tenantId }
        });
        for (const b of bindings) {
          await (prisma as any).userRole.create({
            data: {
              userId: b.userId,
              tenantId: b.tenantId,
              roleId: b.roleId,
              branchId: b.branchId
            }
          });
        }
      } catch (err) {
        console.warn('[RoleService] DB assignUserRoles failed:', (err as Error).message);
      }
    }

    this.inMemoryUserRoles.set(`${tenantId}:${userId}`, bindings);
    PermissionService.invalidateUserCache(tenantId, userId);
  }

  static async getUserRoles(tenantId: string, userId: string): Promise<UserRoleBinding[]> {
    const isDbReady = prisma.isConnected && prisma.isConnected();
    if (isDbReady && (prisma as any).userRole) {
      try {
        const records = await (prisma as any).userRole.findMany({
          where: { userId, tenantId },
          include: { role: true }
        });
        if (records && records.length > 0) {
          return records.map((r: any) => ({
            id: r.id,
            userId: r.userId,
            tenantId: r.tenantId,
            roleId: r.roleId,
            roleName: r.role?.name,
            branchId: r.branchId
          }));
        }
      } catch (err) {
        console.warn('[RoleService] DB getUserRoles fallback:', (err as Error).message);
      }
    }

    return this.inMemoryUserRoles.get(`${tenantId}:${userId}`) || [];
  }

  static async setUserPermissionOverride(
    tenantId: string,
    userId: string,
    permissionKey: string,
    effect: 'ALLOW' | 'DENY'
  ): Promise<void> {
    if (!tenantId) {
      throw new Error("FATAL: tenantId is mandatory for UserPermissionOverride operations.");
    }
    const isDbReady = prisma.isConnected && prisma.isConnected();
    if (isDbReady && (prisma as any).userPermissionOverride && (prisma as any).permission) {
      try {
        let perm = await (prisma as any).permission.findUnique({ where: { key: permissionKey } });
        if (!perm) {
          perm = await (prisma as any).permission.create({
            data: { key: permissionKey, module: permissionKey.split('.')[0] || 'general', action: permissionKey.split('.')[2] || 'custom' }
          });
        }
        await (prisma as any).userPermissionOverride.upsert({
          where: { userId_permissionId_tenantId: { userId, permissionId: perm.id, tenantId } },
          create: { userId, permissionId: perm.id, tenantId, effect },
          update: { effect }
        });
      } catch (err) {
        console.warn('[RoleService] DB setUserPermissionOverride fallback:', (err as Error).message);
      }
    }

    const key = `${tenantId}:${userId}`;
    const current = this.inMemoryUserOverrides.get(key) || [];
    const filtered = current.filter(o => o.permissionKey !== permissionKey);
    filtered.push({ userId, permissionKey, effect });
    this.inMemoryUserOverrides.set(key, filtered);
    PermissionService.invalidateUserCache(tenantId, userId);
  }

  static async removeUserPermissionOverride(
    tenantId: string,
    userId: string,
    permissionKey: string
  ): Promise<void> {
    if (!tenantId) {
      throw new Error("FATAL: tenantId is mandatory for UserPermissionOverride operations.");
    }
    const isDbReady = prisma.isConnected && prisma.isConnected();
    if (isDbReady && (prisma as any).userPermissionOverride && (prisma as any).permission) {
      try {
        const perm = await (prisma as any).permission.findUnique({ where: { key: permissionKey } });
        if (perm) {
          await (prisma as any).userPermissionOverride.deleteMany({
            where: { userId, permissionId: perm.id, tenantId }
          });
        }
      } catch (err) {
        console.warn('[RoleService] DB removeUserPermissionOverride error:', (err as Error).message);
      }
    }

    const key = `${tenantId}:${userId}`;
    const current = this.inMemoryUserOverrides.get(key) || [];
    this.inMemoryUserOverrides.set(key, current.filter(o => o.permissionKey !== permissionKey));
    PermissionService.invalidateUserCache(tenantId, userId);
  }

  static async getUserPermissionOverrides(tenantId: string, userId: string): Promise<UserPermissionOverrideItem[]> {
    if (!tenantId) {
      throw new Error("FATAL: tenantId is mandatory for UserPermissionOverride operations.");
    }
    const isDbReady = prisma.isConnected && prisma.isConnected();
    if (isDbReady && (prisma as any).userPermissionOverride) {
      try {
        const records = await (prisma as any).userPermissionOverride.findMany({
          where: { userId, tenantId },
          include: { permission: true }
        });
        if (records && records.length > 0) {
          return records.map((r: any) => ({
            id: r.id,
            userId: r.userId,
            permissionKey: r.permission?.key,
            effect: r.effect
          })).filter((o: any) => Boolean(o.permissionKey));
        }
      } catch (err) {
        console.warn('[RoleService] DB getUserPermissionOverrides fallback:', (err as Error).message);
      }
    }

    return this.inMemoryUserOverrides.get(`${tenantId}:${userId}`) || [];
  }
}
