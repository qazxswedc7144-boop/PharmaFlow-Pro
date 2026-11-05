import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/auth/services/authService', () => ({
  authService: {
    getCurrentUser: vi.fn(),
    isSignedIn: vi.fn()
  }
}));

import { authService } from '@features/auth/services/authService';
import { ConfigurationService } from './configurationService';

describe('ConfigurationService mutation authorization', () => {
  const service = new ConfigurationService() as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authService.isSignedIn).mockReturnValue(true);
    vi.mocked(authService.getCurrentUser).mockReturnValue({
      id: 'user-a',
      Role: 'مدير نظام',
      tenantId: 'tenant-a'
    } as any);
  });

  it('rejects mutations when the auth facade has a user but no valid signed-in session', () => {
    vi.mocked(authService.isSignedIn).mockReturnValue(false);

    expect(() => service.assertMutationAuthorized('TENANT', {
      tenantId: 'tenant-a'
    }, 'تعديل')).toThrow(/جلسة صالحة/);
  });

  it('rejects tenant context that differs from the authenticated user tenant', () => {
    expect(() => service.assertMutationAuthorized('TENANT', {
      tenantId: 'tenant-b'
    }, 'تعديل')).toThrow(/لا يطابق المؤسسة/);
  });

  it('allows the existing Arabic tenant-admin role to mutate tenant settings', () => {
    expect(() => service.assertMutationAuthorized('TENANT', {
      tenantId: 'tenant-a'
    }, 'تعديل')).not.toThrow();
  });

  it('does not grant platform SYSTEM settings to a tenant administrator', () => {
    expect(() => service.assertMutationAuthorized('SYSTEM', {}, 'تعديل'))
      .toThrow(/SuperAdmin/);
  });

  it('allows USER settings only for the authenticated user', () => {
    expect(() => service.assertMutationAuthorized('USER', {
      tenantId: 'tenant-a',
      userId: 'user-b'
    }, 'تعديل')).toThrow(/مستخدم آخر/);

    expect(() => service.assertMutationAuthorized('USER', {
      tenantId: 'tenant-a',
      userId: 'user-a'
    }, 'تعديل')).not.toThrow();
  });

  it('rejects a non-admin role from mutating tenant settings', () => {
    vi.mocked(authService.getCurrentUser).mockReturnValue({
      id: 'user-a',
      Role: 'CASHIER',
      tenantId: 'tenant-a'
    } as any);

    expect(() => service.assertMutationAuthorized('TENANT', {
      tenantId: 'tenant-a'
    }, 'تعديل')).toThrow(/صلاحيات مدير/);
  });
});
