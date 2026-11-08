import type { InvoiceItem } from '@/types';

type DraftSaleItem = Partial<InvoiceItem> & {
  product_id?: string;
  productId?: string;
  qty?: number | string;
  quantity?: number | string;
  price?: number | string;
  unitPrice?: number | string;
};

type CatalogProduct = {
  price?: number | string | null;
  [key: string]: unknown;
};

/**
 * Rehydrates legacy sale draft lines from the current tenant's Dexie catalog.
 * Deliberately does not read or return legacy totals/discount/tax/fee fields.
 */
export async function restoreSalesDraftItems(
  draft: unknown,
  getProduct: (productId: string) => Promise<CatalogProduct | undefined>
): Promise<InvoiceItem[]> {
  const source = draft as any;
  const data = source?.totals?.header
    ? source.totals
    : (source?.payload || source || {});
  const draftItems = source?.items || data?.items || [];

  if (!Array.isArray(draftItems)) throw new Error('DRAFT_ITEMS_INVALID');

  return Promise.all(draftItems.map(async (item: DraftSaleItem) => {
    const rawId = item.product_id || item.productId;
    const productId = typeof rawId === 'string' ? rawId.trim() : '';
    if (!productId || productId.startsWith('manual-')) {
      throw new Error('DRAFT_ITEM_PRODUCT_REFERENCE_MISSING');
    }

    const product = await getProduct(productId);
    if (!product || product.price === undefined || product.price === null || product.price === '') {
      throw new Error('DRAFT_ITEM_PRODUCT_PRICE_UNAVAILABLE');
    }

    const price = Number(product.price);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error('DRAFT_ITEM_PRODUCT_PRICE_INVALID');
    }

    const qty = Number(item.qty ?? item.quantity);
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      throw new Error('DRAFT_ITEM_QUANTITY_INVALID');
    }

    return {
      ...item,
      product_id: productId,
      price,
      unitPrice: price,
      qty,
      sum: price * qty
    } as InvoiceItem;
  }));
}
