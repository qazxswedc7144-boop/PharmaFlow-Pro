import { getExpiryStatus } from '@/utils/expiryUtils';

type InventoryLayerLike = {
  item_id?: string;
  product_id?: string;
  productId?: string;
  remaining_qty?: number | string | null;
  remainingQty?: number | string | null;
  quantity_remaining?: number | string | null;
  quantityRemaining?: number | string | null;
  expiry_date?: string | null;
  expiryDate?: string | null;
};

type MedicineBatchLike = {
  quantity?: number | string | null;
  remaining_qty?: number | string | null;
  remainingQty?: number | string | null;
  expiry_date?: string | null;
  expiryDate?: string | null;
};

/**
 * Computes saleable stock using FIFO layer balance as the stock ceiling and
 * medicineBatches as the source of batch expiry/remaining quantities.
 *
 * If no batch records exist, the product is treated as non-batched and its
 * layer balance is used. If batch records exist but none are valid for the
 * current tenant, the result is zero (fail closed).
 */
export function getSellableLayerQuantity(
  layers: InventoryLayerLike[],
  batches: MedicineBatchLike[] = [],
  hasBatchRecords = batches.length > 0
): number {
  const layerQuantity = layers.reduce((total, layer) => {
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

  if (!hasBatchRecords) return layerQuantity;

  const validBatchQuantity = batches.reduce((total, batch) => {
    const quantity = Number(
      batch.quantity ?? batch.remaining_qty ?? batch.remainingQty ?? 0
    );
    if (!Number.isFinite(quantity) || quantity <= 0) return total;

    const expiry = batch.expiry_date ?? batch.expiryDate;
    if (expiry && getExpiryStatus(expiry).isExpired) return total;

    return total + quantity;
  }, 0);

  return Math.min(layerQuantity, validBatchQuantity);
}
