import { db } from '@/core/db';
import { unifiedTransport } from '@/shared/network/transport/unifiedTransport';

export interface ActiveBranchContext {
  tenantId: string;
  branchId: string;
}

export function validateActiveBranchRecord(
  record: any,
  expected: ActiveBranchContext
): any {
  if (!record || String(record.id || '') !== expected.branchId) {
    throw new Error('BRANCH_CONTEXT_MISMATCH: The registered branch does not match the active session branch.');
  }

  const recordTenantId = record.tenantId || record.tenant_id;
  if (!recordTenantId || recordTenantId !== expected.tenantId) {
    throw new Error('CROSS_TENANT_VIOLATION: Active branch is not bound to the authenticated tenant.');
  }

  if (record.isActive === false || record.is_active === false) {
    throw new Error('BRANCH_INACTIVE: The authenticated branch is inactive.');
  }

  return {
    ...record,
    id: expected.branchId,
    tenantId: expected.tenantId,
    tenant_id: expected.tenantId,
    isActive: true
  };
}

/**
 * Ensures the JWT-selected branch exists in the local branch registry before
 * the purchase transaction starts. Missing records are hydrated only from the
 * authenticated server endpoint; no branch is synthesized from client state.
 */
export async function ensureActiveBranchRegistered(
  expected: ActiveBranchContext
): Promise<any> {
  if (!expected.tenantId || !expected.branchId) {
    throw new Error('TRUSTED_BRANCH_CONTEXT_REQUIRED: Tenant and branch are required.');
  }

  const localBranch = await db.branches.get(expected.branchId).catch(() => null);
  if (localBranch) {
    const localTenantId = (localBranch as any).tenantId || (localBranch as any).tenant_id;
    if (localTenantId && localTenantId !== expected.tenantId) {
      throw new Error('CROSS_TENANT_VIOLATION: Local branch belongs to another tenant.');
    }
    if (localTenantId === expected.tenantId && localBranch.isActive !== false) {
      return validateActiveBranchRecord(localBranch, expected);
    }
  }

  const response = await unifiedTransport.get<any>('/api/auth/branch-context');
  const serverBranch = response?.data?.branch || response?.data;
  const trustedBranch = validateActiveBranchRecord(serverBranch, expected);

  await db.branches.put(trustedBranch);

  const persistedBranch = await db.branches.get(expected.branchId);
  return validateActiveBranchRecord(persistedBranch, expected);
}
