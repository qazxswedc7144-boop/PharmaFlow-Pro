
import { db } from '@/core/db';
import { Sale, Purchase, UnifiedInvoice } from '@/types';
import { WorkerClient } from '@features/workers/worker.client';

/**
 * Low-level FIFO primitives.
 *
 * ⚠️ DO NOT call directly for inventory mutations.
 * Use UnifiedInventoryMutationEngine as the single writer.
 *
 * This class is an internal subsystem of UnifiedInventoryMutationEngine,
 * providing discrete FIFO layer operations:
 *   - addPurchaseLayer   (inward stock → new layer)
 *   - consumeFIFO        (outward stock → consume oldest layer)
 *   - reverseFIFO        (reversal: restore consumed layers)
 *   - removePurchaseLayer (reversal: remove added layer)
 *
 * Direct usage bypasses transaction guarantees and Unified's 
 * canonical ledger updates.
 */
export class FIFOEngine {

  /**
   * ON PURCHASE: Create new layer directly in inventory_layers
   */
  static async addPurchaseLayer(item_id: string, quantity: number, unit_cost: number, reference_id: string, tenantId?: string): Promise<void> {
    const layerId = db.generateId('LYR');
    await db.inventory_layers.add({
      id: layerId,
      product_id: item_id,
      item_id: item_id,
      quantity_initial: Math.abs(quantity),
      quantity_remaining: Math.abs(quantity),
      unit_cost: unit_cost,
      reference_id: reference_id,
      purchase_id: reference_id,
      created_at: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      ...(tenantId ? { tenant_id: tenantId, tenantId } : {})
    });
  }

  /**
   * FIFO CONSUMPTION directly on inventory_layers and logging to fifo_consumption_log
   */
  static async consumeFIFO(sale_id: string, item_id: string, quantity: number, tenantId?: string): Promise<{ totalCost: number, unitCost: number }> {
    const absQty = Math.abs(quantity);
    const layers = await db.inventory_layers
      .filter((l: any) => {
        const match = (l.item_id === item_id || l.product_id === item_id) && Number(l.quantity_remaining || 0) > 0;
        if (!match) return false;
        if (tenantId && l.tenant_id && l.tenant_id !== tenantId) return false;
        if (tenantId && l.tenantId && l.tenantId !== tenantId) return false;
        return true;
      })
      .toArray();

    // Sort by creation date (FIFO)
    layers.sort((a, b) => new Date(a.created_at || a.createdAt || 0).getTime() - new Date(b.created_at || b.createdAt || 0).getTime());

    let remainingToConsume = absQty;
    let totalCost = 0;
    let totalConsumed = 0;
    const consumptionLogs: any[] = [];
    const updatedLayers: any[] = [];

    for (const layer of layers) {
      if (remainingToConsume <= 0) break;
      const available = Number(layer.quantity_remaining ?? layer.quantity_initial ?? 0);
      if (available <= 0) continue;

      const consumeQty = Math.min(available, remainingToConsume);
      const layerCost = Number(layer.unit_cost ?? layer.unitCost ?? 0);

      totalCost += consumeQty * layerCost;
      totalConsumed += consumeQty;
      remainingToConsume -= consumeQty;

      const newRemaining = available - consumeQty;
      updatedLayers.push({ id: layer.id, quantity_remaining: newRemaining });

      consumptionLogs.push({
        id: db.generateId('FCL'),
        sale_id: sale_id,
        invoice_id: sale_id,
        layer_id: layer.id,
        product_id: item_id,
        item_id: item_id,
        quantity_consumed: consumeQty,
        unit_cost: layerCost,
        created_at: new Date().toISOString(),
        ...(tenantId ? { tenant_id: tenantId, tenantId } : {})
      });
    }

    for (const ul of updatedLayers) {
      await db.inventory_layers.update(ul.id, {
        quantity_remaining: ul.quantity_remaining,
        lastModified: new Date().toISOString()
      });
    }

    if (consumptionLogs.length > 0) {
      await db.fifo_consumption_log.bulkAdd(consumptionLogs);
    }

    const unitCost = totalConsumed > 0 ? totalCost / totalConsumed : 0;
    return { totalCost, unitCost };
  }

  /**
   * ON UNPOST: Restore consumed quantities from fifo_consumption_log
   */
  static async reverseFIFO(sale_id: string): Promise<void> {
    const logs = await db.fifo_consumption_log
      .filter((log: any) => log.sale_id === sale_id || log.invoice_id === sale_id)
      .toArray();

    for (const log of logs) {
      const layer = await db.inventory_layers.get(log.layer_id);
      if (layer) {
        const currentRemaining = Number(layer.quantity_remaining ?? 0);
        const initial = Number(layer.quantity_initial ?? layer.quantity ?? currentRemaining);
        const restored = Math.min(initial, currentRemaining + Number(log.quantity_consumed || 0));
        await db.inventory_layers.update(layer.id, {
          quantity_remaining: restored,
          lastModified: new Date().toISOString()
        });
      }
    }
    const logIds = logs.map((l: any) => l.id).filter(Boolean);
    if (logIds.length > 0) {
      await db.fifo_consumption_log.bulkDelete(logIds);
    }
  }

  /**
   * ON PURCHASE UNPOST: Remove purchase layers
   */
  static async removePurchaseLayer(reference_id: string): Promise<void> {
    const layers = await db.inventory_layers
      .filter((l: any) => l.reference_id === reference_id || l.purchase_id === reference_id)
      .toArray();

    const layerIds = layers.map((l: any) => l.id).filter(Boolean);
    if (layerIds.length > 0) {
      await db.inventory_layers.bulkDelete(layerIds);
    }
  }

  /**
   * APPLY FIFO COSTING
   */
  static async apply(invoice: Sale | Purchase | UnifiedInvoice | { type?: string; customerId?: string; isReturn?: boolean; invoiceType?: string; items?: Array<{ product_id: string; qty: number; cost?: number; price: number }>; invoiceId?: string; id?: string }): Promise<{ totalCost: number, itemCosts: Record<string, number> }> {
    const invAny = invoice as Record<string, unknown>;
    const type = (invAny.type as string) || (invAny.customerId ? 'SALE' : 'PURCHASE');
    const isReturn = Boolean(invAny.isReturn) || invAny.invoiceType === 'مرتجع';
    const isConsumption = (type === 'SALE' && !isReturn) || (type === 'PURCHASE' && isReturn);

    if (isConsumption) {
      const items = (invAny.items as Array<any>) || [];
      const productIds = items.map(itm => itm.product_id || itm.productId || itm.id).filter(Boolean);
      
      const layers = productIds.length > 0
        ? await db.inventory_layers.where('item_id').anyOf(productIds).toArray()
        : [];

      const result = await WorkerClient.runFIFO(invoice, layers);

      if (result.updatedLayers.length > 0) {
        for (const layer of result.updatedLayers) {
          await db.inventory_layers.update(layer.id, { 
            quantity_remaining: layer.quantity_remaining, 
            lastModified: new Date().toISOString() 
          });
        }
      }
      
      if (result.consumptionLogs.length > 0) {
        await db.fifo_consumption_log.bulkAdd(result.consumptionLogs);
      }

      return {
        totalCost: result.totalCost,
        itemCosts: result.itemCosts
      };
    } else {
      let totalCost = 0;
      const itemCosts: Record<string, number> = {};
      const items = (invAny.items as Array<{ product_id: string; qty: number; cost?: number; price: number }>) || [];
      const invoiceId = (invAny.invoiceId as string) || (invAny.id as string) || '';

      for (const item of items) {
        const returnCost = type === 'SALE' ? (item.cost || item.price) : item.price;
        await this.addPurchaseLayer(item.product_id, item.qty, returnCost, invoiceId);
        itemCosts[item.product_id] = item.qty * returnCost;
        totalCost += itemCosts[item.product_id] ?? 0;
      }

      return { totalCost, itemCosts };
    }
  }
}
