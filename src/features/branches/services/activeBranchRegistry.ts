import { db } from '@/core/db';
import { unifiedTransport } from '@/shared/network/transport/unifiedTransport';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { useAuthStore } from '@/store/authStore';

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

  if (record.isActive !== true && record.is_active !== true) {
    throw new Error('BRANCH_INACTIVE: The authenticated branch is not confirmed active.');
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

  const localBranch = await db.branches.get(expected.branchId);
  let trustedLocalBranch: any = null;

  if (localBranch) {
    const localTenantId = (localBranch as any).tenantId || (localBranch as any).tenant_id;
    if (localTenantId && localTenantId !== expected.tenantId) {
      throw new Error('CROSS_TENANT_VIOLATION: Local branch belongs to another tenant.');
    }
    if (localBranch.isActive === false || (localBranch as any).is_active === false) {
      throw new Error('BRANCH_INACTIVE: The local branch is inactive.');
    }
    if (localTenantId === expected.tenantId && (localBranch.isActive === true || (localBranch as any).is_active === true)) {
      trustedLocalBranch = validateActiveBranchRecord(localBranch, expected);
    }
  }

  // Online posting revalidates that the selected branch is still assigned to
  // this user. Offline posting may use only a previously trusted local record.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (trustedLocalBranch) return trustedLocalBranch;
    throw new Error('BRANCH_CONTEXT_UNAVAILABLE_OFFLINE: No trusted local branch is registered for this tenant.');
  }

  const response = await unifiedTransport.get<any>('/api/auth/branch-context');
  const responseBody = response?.data ?? response;
  const serverBranch = responseBody?.branch || responseBody?.data || responseBody;
  const contextCorrected = response?.contextCorrected === true || responseBody?.contextCorrected === true;
  const resolvedBranchId = String(serverBranch?.id || '').trim();

  let resolvedContext = expected;
  if (resolvedBranchId && resolvedBranchId !== expected.branchId) {
    if (!contextCorrected) {
      validateActiveBranchRecord(serverBranch, expected);
    }

    // The server may correct a stale client branch only after proving that the
    // user has exactly one active membership. Persist that authoritative choice
    // in auth state and rotate the JWT before the purchase workflow continues.
    useAuthStore.getState().setTenantContext({
      tenantId: expected.tenantId,
      branchId: resolvedBranchId
    });
    await TokenProvider.refreshAccessToken();
    resolvedContext = { tenantId: expected.tenantId, branchId: resolvedBranchId };
  }

  const trustedBranch = validateActiveBranchRecord(serverBranch, resolvedContext);
  await db.branches.put(trustedBranch);

  const persistedBranch = await db.branches.get(resolvedContext.branchId);
  return validateActiveBranchRecord(persistedBranch, resolvedContext);
}
