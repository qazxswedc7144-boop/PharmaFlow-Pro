import { describe, expect, it, vi } from 'vitest';
import { ExecutionGuard } from './executionGuard';
import { LockService } from '@features/locking/lock.service';

describe('ExecutionGuard local-only guard', () => {
  it('runs a local catalog operation without contacting the distributed lock API', async () => {
    const distributedLock = vi.spyOn(LockService, 'withLock')
      .mockRejectedValue(new Error('DISTRIBUTED_LOCK_SHOULD_NOT_BE_CALLED'));

    await expect(ExecutionGuard.executeWithLocalGuard(
      {
        tenantId: 'TEN-1',
        branchId: 'BR-1',
        operation: 'PRODUCT_SAVE',
        entityId: 'PROD-1'
      },
      async () => 'LOCAL_COMMIT'
    )).resolves.toBe('LOCAL_COMMIT');

    expect(distributedLock).not.toHaveBeenCalled();
    distributedLock.mockRestore();
  });

  it('still rejects concurrent duplicate operations in the same tab', async () => {
    let releaseFirst!: () => void;
    const first = ExecutionGuard.executeWithLocalGuard(
      {
        tenantId: 'TEN-1',
        branchId: 'BR-1',
        operation: 'PRODUCT_SAVE',
        entityId: 'PROD-2'
      },
      () => new Promise<string>(resolve => {
        releaseFirst = () => resolve('DONE');
      })
    );

    await expect(ExecutionGuard.executeWithLocalGuard(
      {
        tenantId: 'TEN-1',
        branchId: 'BR-1',
        operation: 'PRODUCT_SAVE',
        entityId: 'PROD-2'
      },
      async () => 'DUPLICATE'
    )).rejects.toThrow('قيد التنفيذ');

    releaseFirst();
    await expect(first).resolves.toBe('DONE');
  });
});
