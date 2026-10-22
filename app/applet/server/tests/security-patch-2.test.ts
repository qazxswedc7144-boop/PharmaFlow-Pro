import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTenantScopedPrisma } from '../database/tenantPrisma.js';
import { ReplicationPublisher } from '../modules/replication/replication.publisher.js';
import { runWithTenantContext } from '../context/tenantContext.js';

vi.mock('../database/prisma.js', () => {
  const mockPrisma: any = {
    product: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async (args) => args),
    },
    syncEvent: {
      create: vi.fn(async () => ({})),
    },
    auditLog: {
      create: vi.fn(async () => ({})),
    },
    branch: {
      findFirst: vi.fn(async () => null),
    }
  };
  return { prisma: mockPrisma };
});

describe('Security Closure Patch 2 Regression Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. Rejects explicitTenantId override when it conflicts with active trusted tenant context', async () => {
    await expect(
      runWithTenantContext({ tenantId: 'tenant-A' }, async () => {
        const invalidScoped = getTenantScopedPrisma('tenant-B');
        return (invalidScoped as any).product.findMany();
      })
    ).rejects.toThrow(/SECURITY_VIOLATION/);
  });

  it('2. ReplicationPublisher rejects publishing with conflicting tenantId', async () => {
    await expect(
      runWithTenantContext({ tenantId: 'tenant-A' }, async () => {
        return ReplicationPublisher.publish({
          type: 'InventoryUpdated',
          branchId: 'BRH-01',
          tenantId: 'tenant-B', // conflict with trusted context
          payload: { productId: 'P-1', qty: 10 }
        });
      })
    ).rejects.toThrow(/SECURITY_VIOLATION/);
  });

  it('3. Rejects missing tenant context in production mode', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const scoped = getTenantScopedPrisma();
      await expect(
        (scoped as any).product.findMany()
      ).rejects.toThrow(/SECURITY_VIOLATION/);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
