export interface PendingManualProduct {
  id: string;
  ProductID: string;
  Name: string;
  name: string;
  categoryName: string;
  UnitPrice: number;
  price: number;
  Is_Active: number;
}

type PurchaseItemWithProductReference = {
  id?: string;
  productId?: string;
  product_id?: string;
  name?: string;
  price?: number;
  category?: string;
};

export function normalizePendingProductId(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase('en-US');
}

/**
 * Reconciles every manual item in the current invoice against the pending
 * products retained from earlier save attempts. The caller owns persistence
 * and must keep the returned pending list when a save attempt fails.
 */
export function collectPendingProductsForInvoice<
  T extends PurchaseItemWithProductReference
>(
  items: T[],
  existingPendingProducts: PendingManualProduct[] = []
): { items: T[]; pendingProducts: PendingManualProduct[] } {
  const pendingProducts = [...existingPendingProducts];
  const pendingByNormalizedId = new Map<string, PendingManualProduct>();

  for (const product of pendingProducts) {
    const normalizedId = normalizePendingProductId(product?.id);
    if (normalizedId && !pendingByNormalizedId.has(normalizedId)) {
      pendingByNormalizedId.set(normalizedId, product);
    }
  }

  const finalizedItems = items.map(item => {
    const rawProductId = item.productId || item.product_id;
    const productId = String(rawProductId ?? '').trim();
    const normalizedId = normalizePendingProductId(productId);

    if (!normalizedId) return item;

    const existingPendingProduct = pendingByNormalizedId.get(normalizedId);
    if (existingPendingProduct) {
      const canonicalId = String(existingPendingProduct.id).trim();
      return {
        ...item,
        productId: canonicalId,
        product_id: canonicalId
      } as T;
    }

    if (!normalizedId.startsWith('manual-')) {
      return productId === rawProductId ? item : ({
        ...item,
        productId,
        product_id: productId
      } as T);
    }

    const newProductId =
      'PROD-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
    const newProduct: PendingManualProduct = {
      id: newProductId,
      ProductID: newProductId,
      Name: item.name || 'صنف غير مسمى',
      name: item.name || 'صنف غير مسمى',
      categoryName: item.category || 'عام',
      UnitPrice: Number(item.price || 0),
      price: Number(item.price || 0),
      Is_Active: 1
    };

    pendingProducts.push(newProduct);
    pendingByNormalizedId.set(normalizePendingProductId(newProductId), newProduct);

    return {
      ...item,
      productId: newProductId,
      product_id: newProductId,
      id: item.id || newProductId
    } as T;
  });

  return { items: finalizedItems, pendingProducts };
}
