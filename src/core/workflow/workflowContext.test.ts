import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowContextFactory } from './workflowContext';
import { authService } from '@features/auth/services/authService';
import { useAuthStore } from '@/store/authStore';

describe('WorkflowContextFactory local commit callback', () => {
  afterEach(() => vi.restoreAllMocks());

  it('preserves the callback for invocation after the local transaction commits', () => {
    vi.spyOn(authService, 'getCurrentUser').mockReturnValue({
      id: 'USER-1',
      tenantId: 'TEN-1',
      branchId: 'BR-1'
    } as any);
    vi.spyOn(useAuthStore, 'getState').mockReturnValue({
      branchId: 'BR-1'
    } as any);

    const onLocalCommit = vi.fn();
    const context = WorkflowContextFactory.create('PRODUCT_SAVE', { onLocalCommit });

    expect(context.onLocalCommit).toBe(onLocalCommit);
    context.onLocalCommit?.({ productId: 'PROD-1' });
    expect(onLocalCommit).toHaveBeenCalledWith({ productId: 'PROD-1' });
  });
});
