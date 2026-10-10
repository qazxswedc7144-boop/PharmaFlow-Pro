// src/utils/permissions.ts
import { Permission } from '@/types';

/**
 * PharmaFlow PRO ERP — Canonical Roles
 */
export type CanonicalRole = 
  | 'platform_owner'
  | 'owner'
  | 'tenant_admin'
  | 'admin'
  | 'accountant'
  | 'inventory_manager'
  | 'pharmacist'
  | 'cashier'
  | 'clerk'
  | 'auditor'
  | 'user';

/**
 * Normalizes any role variation into a canonical lowercase role string.
 * Supports: 'ADMIN', 'Admin', 'admin', 'Administrator', 'local-admin', etc.
 */
export function normalizeRole(role: string | null | undefined): string {
  if (!role || typeof role !== 'string') return 'user';
  const trimmed = role.trim().toLowerCase();
  
  switch (trimmed) {
    case 'platform_owner':
    case 'platformowner':
    case 'superadmin':
    case 'super_admin':
      return 'platform_owner';
    case 'owner':
      return 'owner';
    case 'tenant_admin':
    case 'tenantadmin':
      return 'tenant_admin';
    case 'admin':
    case 'administrator':
    case 'local-admin':
      return 'admin';
    case 'accountant':
      return 'accountant';
    case 'inventory_manager':
    case 'inventorymanager':
    case 'stock_manager':
      return 'inventory_manager';
    case 'pharmacist':
      return 'pharmacist';
    case 'cashier':
      return 'cashier';
    case 'clerk':
      return 'clerk';
    case 'auditor':
      return 'auditor';
    case 'user':
    default:
      return trimmed || 'user';
  }
}

/**
 * Legacy Permission Alias Mapping
 * Translates legacy uppercase & legacy package permissions into canonical domain.resource.action keys.
 */
export const LEGACY_PERMISSION_ALIASES: Record<string, string> = {
  // Legacy UI Uppercase Aliases
  'POS_ACCESS': 'sales.pos.access',
  'CREATE_INVOICE': 'sales.invoice.create',
  'EDIT_INVOICE': 'sales.invoice.update',
  'DELETE_INVOICE': 'sales.invoice.delete',
  'PURCHASE_ACCESS': 'purchases.invoice.view',
  'CREATE_VOUCHER': 'accounting.voucher.create',
  'EDIT_VOUCHER': 'accounting.voucher.update',
  'DELETE_VOUCHER': 'accounting.voucher.delete',
  'VIEW_REPORTS': 'reports.view',
  'FINANCIAL_ACCESS': 'accounting.journal.view',
  'MANAGE_SYSTEM': 'settings.system.manage',
  'FULL_ACCESS': '*',
  'INVENTORY_VIEW': 'inventory.product.view',
  'MANAGE_PARTNERS': 'partners.manage',
  'AUDIT_VIEW': 'settings.audit.view',
  'ARCHIVE_VIEW': 'archive.view',
  'BRANCH_VIEW': 'branches.view',
  'BRANCH_CREATE': 'branches.create',
  'BRANCH_EDIT': 'branches.update',
  'BRANCH_TRANSFER': 'branches.transfer',
  'BRANCH_REPORT': 'branches.report',

  // packages/auth legacy aliases
  'invoice.create': 'sales.invoice.create',
  'invoice.approve': 'sales.invoice.approve',
  'invoice.post': 'accounting.journal.post',
  'stock.adjust': 'inventory.stock.adjust',
  'journal.view': 'accounting.journal.view',
  'audit.view': 'settings.audit.view',
  'user.manage': 'users.manage',
  'branch.view': 'branches.view',
  'branch.create': 'branches.create',
  'branch.edit': 'branches.update',
  'branch.transfer': 'branches.transfer',
  'branch.report': 'branches.report',
  'inventory.adjust': 'inventory.stock.adjust',
  'vouchers.create': 'accounting.voucher.create',
  'vouchers.manage': 'accounting.voucher.create'
};

/**
 * Resolves a given permission key into its canonical representation.
 */
export function resolveCanonicalPermission(permission: string): string {
  if (!permission) return '';
  return LEGACY_PERMISSION_ALIASES[permission] || permission;
}

/**
 * SaaS Role-Based Access Control (RBAC) definitions
 * Maps canonical roles to canonical permissions.
 */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  platform_owner: ['*'],
  owner: ['*'],
  tenant_admin: ['*'],
  admin: [
    'sales.invoice.view', 'sales.invoice.create', 'sales.invoice.update', 'sales.invoice.delete', 'sales.invoice.approve', 'sales.invoice.export', 'sales.pos.access',
    'purchases.invoice.view', 'purchases.invoice.create', 'purchases.invoice.update', 'purchases.invoice.delete', 'purchases.invoice.export',
    'inventory.product.view', 'inventory.product.create', 'inventory.product.update', 'inventory.product.delete', 'inventory.stock.adjust', 'inventory.batch.view', 'inventory.batch.manage', 'inventory.audit.view', 'inventory.transfer.create', 'inventory.transfer.approve',
    'accounting.journal.view', 'accounting.journal.create', 'accounting.journal.post', 'accounting.account.view', 'accounting.voucher.create', 'accounting.voucher.view', 'accounting.voucher.update', 'accounting.reconcile',
    'reports.view', 'reports.export', 'reports.financial.view', 'reports.financial.export', 'reports.aging.view', 'reports.branch.view',
    'branches.view', 'branches.create', 'branches.update', 'branches.transfer', 'branches.report',
    'partners.view', 'partners.create', 'partners.update', 'partners.manage',
    'settings.view', 'settings.update', 'settings.system.manage', 'settings.security.view', 'settings.audit.view',
    'users.view', 'users.create', 'users.update', 'users.manage',
    'archive.view'
  ],
  accountant: [
    'accounting.journal.view', 'accounting.journal.create', 'accounting.journal.post', 'accounting.account.view', 'accounting.voucher.create', 'accounting.voucher.view', 'accounting.voucher.update', 'accounting.reconcile',
    'reports.view', 'reports.export', 'reports.financial.view', 'reports.financial.export', 'reports.aging.view', 'reports.branch.view',
    'sales.invoice.view', 'sales.invoice.export',
    'purchases.invoice.view', 'purchases.invoice.export',
    'branches.view', 'branches.report',
    'archive.view'
  ],
  inventory_manager: [
    'inventory.product.view', 'inventory.product.create', 'inventory.product.update', 'inventory.product.delete', 'inventory.stock.adjust', 'inventory.batch.view', 'inventory.batch.manage', 'inventory.audit.view', 'inventory.audit.perform', 'inventory.transfer.create', 'inventory.transfer.approve',
    'purchases.invoice.view', 'purchases.invoice.create', 'purchases.invoice.update',
    'reports.view', 'reports.export',
    'branches.view', 'branches.transfer', 'branches.report'
  ],
  pharmacist: [
    'sales.invoice.view', 'sales.invoice.create', 'sales.invoice.update', 'sales.invoice.export', 'sales.refund', 'sales.pos.access',
    'purchases.invoice.view', 'purchases.invoice.create',
    'inventory.product.view', 'inventory.batch.view', 'inventory.transfer.create',
    'reports.view',
    'branches.view', 'branches.transfer', 'branches.report',
    'partners.manage', 'archive.view'
  ],
  cashier: [
    'sales.pos.access', 'sales.invoice.create', 'sales.invoice.view',
    'inventory.product.view',
    'branches.view'
  ],
  clerk: [
    'sales.pos.access', 'sales.invoice.create', 'sales.invoice.view',
    'inventory.product.view',
    'branches.view'
  ],
  auditor: [
    'sales.invoice.view', 'sales.invoice.export',
    'purchases.invoice.view', 'purchases.invoice.export',
    'inventory.product.view', 'inventory.batch.view', 'inventory.audit.view',
    'accounting.journal.view', 'accounting.account.view', 'accounting.voucher.view',
    'reports.view', 'reports.export', 'reports.financial.view', 'reports.financial.export', 'reports.branch.view', 'reports.aging.view',
    'branches.view', 'branches.report',
    'settings.audit.view', 'settings.security.view',
    'archive.view'
  ],
  user: [
    'reports.view', 'branches.view'
  ]
};

/**
 * Universal Permission Helper
 * Examines if the given role has the requested permission (resolving aliases and normalization).
 */
export function can(role: string | null | undefined, permission: Permission | string, customPermissions?: string[]): boolean {
  if (!role || role.trim() === '') return false;
  
  const normalizedRole = normalizeRole(role);
  
  // Super admin / Owner bypass
  if (['admin', 'owner', 'platform_owner', 'tenant_admin'].includes(normalizedRole)) {
    return true;
  }
  
  const canonicalPerm = resolveCanonicalPermission(permission);

  // Check user custom permissions override if present
  if (customPermissions && Array.isArray(customPermissions)) {
    if (customPermissions.includes('*') || 
        customPermissions.includes(permission) || 
        customPermissions.includes(canonicalPerm) ||
        customPermissions.some(cp => resolveCanonicalPermission(cp) === canonicalPerm)) {
      return true;
    }
  }

  const permissions = ROLE_PERMISSIONS[normalizedRole];
  if (!permissions) return false;
  
  if (permissions.includes('*')) return true;
  return permissions.includes(canonicalPerm) || permissions.includes(permission);
}

/**
 * Checks if a role has a specific permission (Alias of can)
 */
export function hasPermission(role: string | null | undefined, permission: Permission | string, customPermissions?: string[]): boolean {
  return can(role, permission, customPermissions);
}

/**
 * Checks if a role has ANY of the specified permissions.
 */
export function canAny(role: string | null | undefined, permissions: (Permission | string)[], customPermissions?: string[]): boolean {
  return permissions.some(p => can(role, p, customPermissions));
}

/**
 * Alias for canAny
 */
export function hasAnyPermission(role: string | null | undefined, permissions: (Permission | string)[], customPermissions?: string[]): boolean {
  return canAny(role, permissions, customPermissions);
}

/**
 * Checks if a role has ALL of the specified permissions.
 */
export function canAll(role: string | null | undefined, permissions: (Permission | string)[], customPermissions?: string[]): boolean {
  return permissions.every(p => can(role, p, customPermissions));
}

/**
 * Alias for canAll
 */
export function hasAllPermissions(role: string | null | undefined, permissions: (Permission | string)[], customPermissions?: string[]): boolean {
  return canAll(role, permissions, customPermissions);
}

/**
 * Checks if a user's role matches any of the target roles (case-insensitive & normalization aware).
 */
export function hasRole(userRole: string | null | undefined, targetRoles: string | string[]): boolean {
  if (!userRole) return false;
  const normalizedUserRole = normalizeRole(userRole);
  const targets = Array.isArray(targetRoles) ? targetRoles : [targetRoles];
  return targets.some(target => normalizeRole(target) === normalizedUserRole);
}

