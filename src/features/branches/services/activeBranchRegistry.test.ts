import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { useAuthStore } from '@/store/authStore';
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

  it('updates auth context and refreshes the token when the server safely corrects a stale branch', async () => {
    const refreshSpy = vi.spyOn(TokenProvider, 'refreshAccessToken').mockResolvedValue('refreshed-access-token');
    vi.spyOn(unifiedTransport, 'get').mockResolvedValue({
      success: true,
      data: {
        id: 'branch-a',
        code: 'BR-A',
        name: 'Branch A',
        tenantId: 'tenant-a',
        isActive: true
      },
      contextCorrected: true
    } as any);

    const branch = await ensureActiveBranchRegistered({
      tenantId: 'tenant-a',
      branchId: 'deleted-stale-branch'
    });

    expect(branch).toMatchObject({ id: 'branch-a', tenantId: 'tenant-a' });
    expect(useAuthStore.getState().branchId).toBe('branch-a');
    expect(refreshSpy).toHaveBeenCalledOnce();
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

  it('revalidates a cached branch membership with the server while online', async () => {
    await db.branches.put({
      id: 'branch-a',
      tenantId: 'tenant-a',
      isActive: true
    } as any);
    vi.spyOn(unifiedTransport, 'get').mockResolvedValue({
      success: true,
      data: {
        id: 'branch-b',
        tenantId: 'tenant-a',
        isActive: true
      }
    } as any);

    await expect(ensureActiveBranchRegistered(expected)).rejects.toThrow(/BRANCH_CONTEXT_MISMATCH/);
    expect(unifiedTransport.get).toHaveBeenCalledWith('/api/auth/branch-context');
  });

  it('uses a tenant-bound active cached branch only when the browser is offline', async () => {
    await db.branches.put({
      id: 'branch-a',
      tenantId: 'tenant-a',
      isActive: true
    } as any);
    const getSpy = vi.spyOn(unifiedTransport, 'get');
    vi.stubGlobal('navigator', { onLine: false });

    const branch = await ensureActiveBranchRegistered(expected);

    expect(branch).toMatchObject({ id: 'branch-a', tenantId: 'tenant-a' });
    expect(getSpy).not.toHaveBeenCalled();
  });
});
