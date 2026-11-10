import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { authService } from '@features/auth/services/authService';
import { WorkflowContextFactory } from './workflowContext';

describe('WorkflowContextFactory branch selection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState({
      user: null,
      tenantId: null,
      branchId: null,
      token: null,
      refreshToken: null,
      roles: [],
      permissions: [],
      subscriptionPlan: null,
      isAuthenticated: false
    } as any);
  });

  it('prefers the current selected branch in auth state over a stale branch on the user object', () => {
    useAuthStore.setState({
      user: { id: 'user-a', tenantId: 'tenant-a', branchId: 'branch-old' } as any,
      tenantId: 'tenant-a',
      branchId: 'branch-selected',
      isAuthenticated: true
    } as any);
    vi.spyOn(authService, 'getCurrentUser').mockReturnValue({
      id: 'user-a',
      tenantId: 'tenant-a',
      branchId: 'branch-old'
    } as any);

    const context = WorkflowContextFactory.create('PURCHASE');

    expect(context.tenantId).toBe('tenant-a');
    expect(context.branchId).toBe('branch-selected');
  });
});
