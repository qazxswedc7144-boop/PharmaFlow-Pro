import { afterEach, describe, expect, it, vi } from 'vitest';
import { productApplicationWorkflow } from './ProductApplicationWorkflow';
import { InventoryService } from '@features/inventory/services/InventoryService';
import { AuditService } from '@/services/system/AuditService';
import { ProjectionEventBus } from '@/services/system/ProjectionEventBus';
import { DistributedSyncEngine } from '@features/sync/sync.engine';
import { useAuthStore } from '@/store/authStore';

describe('ProductApplicationWorkflow local commit boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires only the permission appropriate to the operation', async () => {
    vi.spyOn(useAuthStore, 'getState').mockReturnValue({
      hasPermission: (permission: string) => permission === 'inventory.product.create',
      user: { permissions: [] }
    } as any);

    await expect(productApplicationWorkflow.validateBusinessRules({
      product: { id: 'PROD-1', name: 'Panadol Extra' } as any,
      isNew: true
    })).resolves.toBeUndefined();

    await expect(productApplicationWorkflow.validateBusinessRules({
      product: { id: 'PROD-1', name: 'Panadol Extra' } as any,
      isNew: false
    })).rejects.toThrow('PRODUCT_PERMISSION_REQUIRED:');
  });

  it('owns product sync enqueue inside the same local transaction', () => {
    expect(productApplicationWorkflow.syncHandledInDomainTransaction).toBe(true);
    expect(typeof productApplicationWorkflow.localExecutionGuard).toBe('function');
    expect((productApplicationWorkflow.localExecutionGuard as Function)({ isNew: true })).toBe(true);
    expect((productApplicationWorkflow.localExecutionGuard as Function)({ isNew: false })).toBe(false);
    expect(productApplicationWorkflow.tables).toEqual(
      expect.arrayContaining(['products', 'syncQueue', 'outbox', 'auditLogs'])
    );
  });

  it('persists the product and writes a durable sync mutation before returning', async () => {
    vi.spyOn(InventoryService, 'saveProduct').mockResolvedValue('PROD-LOCAL-1');
    vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);
    vi.spyOn(ProjectionEventBus, 'publish').mockResolvedValue(undefined);
    const enqueue = vi.spyOn(
      DistributedSyncEngine.getInstance(),
      'enqueueWithinTransaction'
    ).mockResolvedValue({
      mutationId: 'MUT-LOCAL-1',
      idempotencyKey: 'IDEM-PRODUCT-1'
    });

    const result = await productApplicationWorkflow.executeDomainSteps(
      { product: { id: 'PROD-LOCAL-1', name: 'Panadol Extra' } as any, isNew: true },
      {
        workflowId: 'WF-1',
        correlationId: 'CORR-1',
        idempotencyKey: 'IDEM-PRODUCT-1',
        tenantId: 'TEN-1',
        branchId: 'BR-1',
        userId: 'USER-1',
        deviceId: 'DEVICE-1',
        operationType: 'PRODUCT_SAVE',
        startedAt: new Date().toISOString()
      },
      {}
    );

    expect(result).toEqual({ success: true, productId: 'PROD-LOCAL-1' });
    expect(enqueue).toHaveBeenCalledWith(
      'PRODUCT_SAVE',
      expect.objectContaining({ id: 'PROD-LOCAL-1', tenantId: 'TEN-1', branchId: 'BR-1' }),
      'PRODUCT',
      'IDEM-PRODUCT-1',
      { tenantId: 'TEN-1', branchId: 'BR-1' }
    );
  });
});
