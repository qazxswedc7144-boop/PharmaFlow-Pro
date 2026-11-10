type InvoiceStockLine = {
  productId?: string;
  product_id?: string;
  qty?: number | string;
  quantity?: number | string;
};

type StockProduct = {
  id: string;
  stock?: number;
  StockQuantity?: number;
};

export function getProjectedAutocompleteStock(
  product: StockProduct,
  mode: 'purchase' | 'sale',
  invoiceItems: InvoiceStockLine[] = []
): number {
  const currentStock = Number(product.StockQuantity ?? product.stock ?? 0);
  const pendingQuantity = invoiceItems.reduce((total, item) => {
    const itemProductId = item.productId || item.product_id;
    if (itemProductId !== product.id) return total;

    const quantity = Number(item.quantity ?? item.qty ?? 0);
    return total + (Number.isFinite(quantity) ? quantity : 0);
  }, 0);

  return mode === 'purchase'
    ? currentStock + pendingQuantity
    : currentStock - pendingQuantity;
}
