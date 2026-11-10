import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnifiedInventoryMutationEngine } from './UnifiedInventoryMutationEngine';

describe('UnifiedInventoryMutationEngine purchase transaction propagation', () => {
  afterEach(() => vi.restoreAllMocks());

  const command = {
    invoiceId: 'PUR-TX',
    returnInvoiceId: 'PUR-RETURN-TX',
    warehouseId: 'WH-TX',
    items: [{ productId: 'PROD-TX', quantity: 2, unitCost: 10 }],
    transactionUuid: 'IDEMPOTENCY-TX',
    userId: 'USER-TX',
    tenantId: 'TENANT-TX',
    branchId: 'BRANCH-TX'
  };

  it('uses the caller transaction for purchase receipt without opening a nested transaction', async () => {
    const engine = UnifiedInventoryMutationEngine.getInstance();
    const tx = { table: vi.fn() };
    const validate = vi.spyOn(engine as any, 'validateCommandBasics').mockResolvedValue(undefined);
    const mutate = vi.spyOn(engine as any, 'mutateSingleItem').mockResolvedValue({ success: true, productId: 'PROD-TX' });
    const atomic = vi.spyOn(engine as any, 'executeAtomicTransaction');

    await engine.executeReceivePurchase(command as any, tx);

    expect(validate).toHaveBeenCalledWith(command, 'ReceivePurchase');
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ productId: 'PROD-TX', delta: 2 }), tx);
    expect(atomic).not.toHaveBeenCalled();
  });

  it('uses the caller transaction for purchase returns without opening a nested transaction', async () => {
    const engine = UnifiedInventoryMutationEngine.getInstance();
    const tx = { table: vi.fn() };
    const validate = vi.spyOn(engine as any, 'validateCommandBasics').mockResolvedValue(undefined);
    const mutate = vi.spyOn(engine as any, 'mutateSingleItem').mockResolvedValue({ success: true, productId: 'PROD-TX' });
    const atomic = vi.spyOn(engine as any, 'executeAtomicTransaction');

    await engine.executePurchaseReturn(command as any, tx);

    expect(validate).toHaveBeenCalledWith(command, 'ProcessPurchaseReturn');
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ productId: 'PROD-TX', delta: -2 }), tx);
    expect(atomic).not.toHaveBeenCalled();
  });

  it('passes the Dexie transaction into item mutations when it owns the transaction', async () => {
    const engine = UnifiedInventoryMutationEngine.getInstance();
    const internalTx = { table: vi.fn() };
    vi.spyOn(engine as any, 'validateCommandBasics').mockResolvedValue(undefined);
    const mutate = vi.spyOn(engine as any, 'mutateSingleItem').mockResolvedValue({ success: true, productId: 'PROD-TX' });
    vi.spyOn(engine as any, 'executeAtomicTransaction').mockImplementation((...args: any[]) => (args[0] as (tx: any) => Promise<any>)(internalTx));

    await engine.executeReceivePurchase(command as any);

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ productId: 'PROD-TX' }), internalTx);
  });
});
