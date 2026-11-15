import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { authService } from '@features/auth/services/authService';
import { WorkflowContextFactory } from './workflowContext';
import { WorkflowOrchestrator } from './workflowOrchestrator';

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

  it('returns a structured failure instead of rejecting when tenant hydration is incomplete', async () => {
    useAuthStore.setState({
      user: null,
      tenantId: null,
      branchId: null,
      isAuthenticated: false
    } as any);
    vi.spyOn(authService, 'getCurrentUser').mockReturnValue(null);
    const executeDomainSteps = vi.fn();
    const workflow = {
      id: 'test.missing-tenant-context',
      operationType: 'PURCHASE',
      executeDomainSteps
    } as any;

    const result = await WorkflowOrchestrator.execute(workflow, {});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AUTHORIZATION_DENIED');
    expect(result.error?.message).toContain('Trusted Tenant Context Required');
    expect(result.idempotencyKey).toBeTruthy();
    expect(executeDomainSteps).not.toHaveBeenCalled();
  });

  it('returns a structured failure instead of rejecting when branch hydration is incomplete', async () => {
    const user = { id: 'user-a', tenantId: 'tenant-a' } as any;
    useAuthStore.setState({
      user,
      tenantId: 'tenant-a',
      branchId: null,
      isAuthenticated: true
    } as any);
    vi.spyOn(authService, 'getCurrentUser').mockReturnValue(user);
    const executeDomainSteps = vi.fn();
    const workflow = {
      id: 'test.missing-branch-context',
      operationType: 'PURCHASE',
      executeDomainSteps
    } as any;

    const result = await WorkflowOrchestrator.execute(workflow, {});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AUTHORIZATION_DENIED');
    expect(result.error?.message).toContain('Trusted Branch Context Required');
    expect(executeDomainSteps).not.toHaveBeenCalled();
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
