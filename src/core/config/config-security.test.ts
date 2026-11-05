import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationRecord } from './types';

vi.mock('@/services/auth/tokenProvider', () => ({
  TokenProvider: {
    getCurrentSession: vi.fn()
  }
}));

import { TokenProvider } from '@/services/auth/tokenProvider';
import { assertScopedContext, buildScopedStorageKey, getCurrentContext } from './configScopes';
import { resolveConfigValue } from './configResolver';

const session = {
  user: {
    id: 'user-a',
    tenantId: 'tenant-a',
    branchId: 'branch-a'
  },
  tenantId: 'tenant-a',
  branchId: 'branch-a',
  deviceId: 'device-a',
  token: 'token',
  refreshToken: null,
  roles: ['ADMIN'],
  permissions: [],
  subscriptionPlan: 'ENTERPRISE',
  isAuthenticated: true
};

const record = (
  scope: ConfigurationRecord<any>['scope'],
  context: ConfigurationRecord<any>['context'],
  value: unknown
): ConfigurationRecord<any> => ({
  key: 'system.name',
  scope,
  context,
  value,
  version: 1,
  updatedAt: '2026-11-05T00:00:00.000Z'
});

describe('Settings tenant isolation', () => {
  beforeEach(() => {
    vi.mocked(TokenProvider.getCurrentSession).mockReturnValue(session as any);
  });

  it('rejects tenant records without an explicit matching tenant id', () => {
    const records = [
      record('TENANT', {}, 'legacy-global'),
      record('TENANT', { tenantId: 'tenant-a' }, 'tenant-a-value')
    ];

    expect(resolveConfigValue('system.name', records, { tenantId: 'tenant-a' })).toBe('tenant-a-value');
    expect(resolveConfigValue('system.name', records, { tenantId: 'tenant-b' })).toBe('PharmaFlow Pro');

    const legacyRecord = records[0];
    if (!legacyRecord) {
      throw new Error('Expected the legacy record fixture to exist.');
    }
    expect(resolveConfigValue('system.name', [legacyRecord], { tenantId: 'tenant-a' })).toBe('PharmaFlow Pro');
  });

  it('requires both tenant and branch identifiers for branch-scoped records', () => {
    const records = [
      record('BRANCH', { tenantId: 'tenant-a' }, 'missing-branch'),
      record('BRANCH', { tenantId: 'tenant-a', branchId: 'branch-a' }, 'branch-a-value')
    ];

    expect(resolveConfigValue('system.name', records, {
      tenantId: 'tenant-a',
      branchId: 'branch-a'
    })).toBe('branch-a-value');

    expect(resolveConfigValue('system.name', records, {
      tenantId: 'tenant-a',
      branchId: 'branch-b'
    })).toBe('PharmaFlow Pro');
  });

  it('rejects context overrides that do not match the authenticated session', () => {
    expect(getCurrentContext()).toEqual({
      tenantId: 'tenant-a',
      branchId: 'branch-a',
      userId: 'user-a',
      deviceId: 'device-a'
    });

    expect(() => getCurrentContext({ tenantId: 'tenant-b' })).toThrow(/does not match the authenticated session/i);
    expect(() => getCurrentContext({ branchId: 'branch-b' })).toThrow(/does not match the authenticated session/i);
  });

  it('requires tenant ownership metadata before building tenant-scoped storage keys', () => {
    expect(() => assertScopedContext('TENANT', {})).toThrow(/Missing required tenantId/i);
    expect(() => buildScopedStorageKey('system.name', 'TENANT', {})).toThrow(/Missing required tenantId/i);
    expect(buildScopedStorageKey('system.name', 'TENANT', { tenantId: 'tenant-a' }))
      .toBe('tenant:tenant-a:system.name');
  });

  it('does not assign a shared fallback device identity when none is registered', () => {
    vi.mocked(TokenProvider.getCurrentSession).mockReturnValue({
      ...session,
      deviceId: null
    } as any);
    vi.stubGlobal('localStorage', { getItem: () => null });

    try {
      expect(getCurrentContext().deviceId).toBeUndefined();
      expect(() => assertScopedContext('DEVICE', getCurrentContext())).toThrow(/Missing required deviceId/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the persistent DeviceManager identity when the auth session omits deviceId', () => {
    vi.mocked(TokenProvider.getCurrentSession).mockReturnValue({
      ...session,
      deviceId: null
    } as any);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'pharmaflow_device_identity'
        ? JSON.stringify({ deviceId: 'DEV-PERSISTED-01' })
        : null
    });

    try {
      expect(getCurrentContext().deviceId).toBe('DEV-PERSISTED-01');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('requires tenant and user identity for user-scoped records', () => {
    expect(() => assertScopedContext('USER', { userId: 'user-a' })).toThrow(/Missing required tenantId/i);
    expect(() => assertScopedContext('USER', { tenantId: 'tenant-a' })).toThrow(/Missing required userId/i);
  });
});
