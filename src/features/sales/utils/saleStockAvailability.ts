import { getExpiryStatus } from '@/utils/expiryUtils';

type InventoryLayerLike = {
  remaining_qty?: number | string | null;
  remainingQty?: number | string | null;
  quantity_remaining?: number | string | null;
  quantityRemaining?: number | string | null;
  expiry_date?: string | null;
  expiryDate?: string | null;
};

/**
 * Returns stock that can actually be sold from FIFO layers.
 * Product master stock is intentionally not used as a fallback: missing layers
 * or expired batches must not make an item appear available for sale.
 */
export function getSellableLayerQuantity(layers: InventoryLayerLike[]): number {
  return layers.reduce((total, layer) => {
    const rawQuantity = layer.quantity_remaining
      ?? layer.quantityRemaining
      ?? layer.remaining_qty
      ?? layer.remainingQty
      ?? 0;
    const quantity = Number(rawQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return total;

    const expiry = layer.expiry_date ?? layer.expiryDate;
    if (expiry && getExpiryStatus(expiry).isExpired) return total;

    return total + quantity;
  }, 0);
}
