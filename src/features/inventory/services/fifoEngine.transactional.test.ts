import { describe, expect, it, vi } from 'vitest';
import { db } from '@/core/db';
import { FIFOEngine } from './fifoEngine';

function makeTable(initial: any[] = []) {
  const rows = [...initial];
  return {
    rows,
    add: vi.fn(async (row: any) => { rows.push(row); return row.id; }),
    bulkAdd: vi.fn(async (items: any[]) => { rows.push(...items); }),
    get: vi.fn(async (id: string) => rows.find(row => row.id === id)),
    update: vi.fn(async (id: string, patch: any) => {
      const row = rows.find(item => item.id === id);
      if (!row) return 0;
      Object.assign(row, patch);
      return 1;
    }),
    filter: vi.fn((predicate: (row: any) => boolean) => ({
      toArray: async () => rows.filter(predicate)
    })),
    bulkDelete: vi.fn(async (ids: string[]) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (ids.includes(rows[i].id)) rows.splice(i, 1);
      }
    })
  };
}

describe('FIFOEngine caller transaction support', () => {
  it('writes a purchase layer only through the supplied transaction', async () => {
    const layers = makeTable();
    const tx = { table: vi.fn((name: string) => name === 'inventory_layers' ? layers : undefined) };
    const dbAdd = vi.spyOn(db.inventory_layers, 'add');

    await FIFOEngine.addPurchaseLayer('PROD-TX', 5, 12.5, 'PUR-TX', 'TEN-TX', tx);

    expect(tx.table).toHaveBeenCalledWith('inventory_layers');
    expect(layers.add).toHaveBeenCalledWith(expect.objectContaining({
      item_id: 'PROD-TX',
      quantity_remaining: 5,
      unit_cost: 12.5,
      reference_id: 'PUR-TX',
      tenantId: 'TEN-TX'
    }));
    expect(dbAdd).not.toHaveBeenCalled();
    dbAdd.mockRestore();
  });

  it('consumes FIFO layers and records consumption in the supplied transaction', async () => {
    const layers = makeTable([
      { id: 'L1', item_id: 'PROD-TX', quantity_remaining: 2, quantity_initial: 2, unit_cost: 10, created_at: '2026-01-01', tenantId: 'TEN-TX' },
      { id: 'L2', item_id: 'PROD-TX', quantity_remaining: 5, quantity_initial: 5, unit_cost: 20, created_at: '2026-01-02', tenantId: 'TEN-TX' }
    ]);
    const logs = makeTable();
    const tx = { table: vi.fn((name: string) => name === 'inventory_layers' ? layers : name === 'fifo_consumption_log' ? logs : undefined) };
    const dbLayerUpdate = vi.spyOn(db.inventory_layers, 'update');
    const dbLogAdd = vi.spyOn(db.fifo_consumption_log, 'bulkAdd');

    const result = await FIFOEngine.consumeFIFO('SALE-TX', 'PROD-TX', 4, 'TEN-TX', tx);

    expect(result).toEqual({ totalCost: 60, unitCost: 15 });
    expect(layers.rows.find(row => row.id === 'L1')?.quantity_remaining).toBe(0);
    expect(layers.rows.find(row => row.id === 'L2')?.quantity_remaining).toBe(3);
    expect(logs.rows).toHaveLength(2);
    expect(dbLayerUpdate).not.toHaveBeenCalled();
    expect(dbLogAdd).not.toHaveBeenCalled();
    dbLayerUpdate.mockRestore();
    dbLogAdd.mockRestore();
  });

  it('reverses and removes FIFO records only through the supplied transaction', async () => {
    const layers = makeTable([
      { id: 'L1', reference_id: 'PUR-TX', purchase_id: 'PUR-TX', quantity_initial: 5, quantity_remaining: 1 },
      { id: 'L2', reference_id: 'OTHER', purchase_id: 'OTHER', quantity_initial: 5, quantity_remaining: 5 }
    ]);
    const logs = makeTable([
      { id: 'LOG1', sale_id: 'SALE-TX', layer_id: 'L1', quantity_consumed: 2 }
    ]);
    const tx = { table: vi.fn((name: string) => name === 'inventory_layers' ? layers : name === 'fifo_consumption_log' ? logs : undefined) };
    const dbLayerUpdate = vi.spyOn(db.inventory_layers, 'update');
    const dbLayerDelete = vi.spyOn(db.inventory_layers, 'bulkDelete');
    const dbLogDelete = vi.spyOn(db.fifo_consumption_log, 'bulkDelete');

    await FIFOEngine.reverseFIFO('SALE-TX', tx);
    expect(layers.rows.find(row => row.id === 'L1')?.quantity_remaining).toBe(3);
    expect(logs.rows).toHaveLength(0);

    await FIFOEngine.removePurchaseLayer('PUR-TX', tx);
    expect(layers.rows.map(row => row.id)).toEqual(['L2']);
    expect(dbLayerUpdate).not.toHaveBeenCalled();
    expect(dbLayerDelete).not.toHaveBeenCalled();
    expect(dbLogDelete).not.toHaveBeenCalled();
    dbLayerUpdate.mockRestore();
    dbLayerDelete.mockRestore();
    dbLogDelete.mockRestore();
  });
});
