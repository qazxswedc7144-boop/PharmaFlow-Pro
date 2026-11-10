export interface NewPurchaseProductInput {
  id: string;
  name: string;
  price: number;
  category: string;
  createdAt?: string;
}

/**
 * A product created from a purchase line is a catalog record only.
 * Its stock remains zero until the purchase workflow posts the receipt.
 */
export function createNewPurchaseProductRecord(input: NewPurchaseProductInput) {
  return {
    id: input.id,
    ProductID: input.id,
    Name: input.name,
    name: input.name,
    categoryName: input.category || 'عام',
    UnitPrice: Number(input.price) || 0,
    price: Number(input.price) || 0,
    StockQuantity: 0,
    stock: 0,
    Is_Active: 1,
    created_at: input.createdAt || new Date().toISOString()
  };
}
