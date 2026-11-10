import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { unifiedTransport } from '@/shared/network/transport/unifiedTransport';
import { ensureActiveBranchRegistered, validateActiveBranchRecord } from './activeBranchRegistry';

describe('active branch registration', () => {
  const expected = { tenantId: 'tenant-a', branchId: 'branch-a' };

  beforeEach(async () => {
    TokenProvider.setSession({
      tenantId: expected.tenantId,
      branchId: expected.branchId
    } as any, 'access-token', 'refresh-token');
    await db.branches.clear();
    vi.restoreAllMocks();
  });

  it('accepts only the requested active branch bound to the current tenant', () => {
    expect(validateActiveBranchRecord({
      id: 'branch-a',
      code: 'BR-A',
      name: 'Branch A',
      tenantId: 'tenant-a',
      isActive: true
    }, expected)).toMatchObject({ id: 'branch-a', tenantId: 'tenant-a' });
  });

  it('rejects a branch belonging to another tenant', () => {
    expect(() => validateActiveBranchRecord({
      id: 'branch-a',
      tenantId: 'tenant-b',
      isActive: true
    }, expected)).toThrow(/CROSS_TENANT_VIOLATION/);
  });

  it('rejects a different branch even when tenant matches', () => {
    expect(() => validateActiveBranchRecord({
      id: 'branch-b',
      tenantId: 'tenant-a',
      isActive: true
    }, expected)).toThrow(/BRANCH_CONTEXT_MISMATCH/);
  });

  it('rejects inactive or unbound branch records', () => {
    expect(() => validateActiveBranchRecord({
      id: 'branch-a',
      tenantId: 'tenant-a',
      isActive: false
    }, expected)).toThrow(/BRANCH_INACTIVE/);

    expect(() => validateActiveBranchRecord({
      id: 'branch-a',
      isActive: true
    }, expected)).toThrow(/CROSS_TENANT_VIOLATION/);
  });

  it('hydrates a missing branch only from the authenticated server response and persists its tenant binding', async () => {
    vi.spyOn(unifiedTransport, 'get').mockResolvedValue({
      success: true,
      data: {
        id: 'branch-a',
        code: 'BR-A',
        name: 'Branch A',
        tenantId: 'tenant-a',
        isActive: true
      }
    } as any);

    const branch = await ensureActiveBranchRegistered(expected);

    expect(branch).toMatchObject({ id: 'branch-a', tenantId: 'tenant-a', isActive: true });
    expect(await db.branches.get('branch-a')).toMatchObject({ tenantId: 'tenant-a' });
    expect(unifiedTransport.get).toHaveBeenCalledWith('/api/auth/branch-context');
  });

  it('does not persist a server branch belonging to another tenant', async () => {
    vi.spyOn(unifiedTransport, 'get').mockResolvedValue({
      success: true,
      data: {
        id: 'branch-a',
        tenantId: 'tenant-b',
        isActive: true
      }
    } as any);

    await expect(ensureActiveBranchRegistered(expected)).rejects.toThrow(/CROSS_TENANT_VIOLATION/);
    expect(await db.branches.get('branch-a')).toBeUndefined();
  });
});
