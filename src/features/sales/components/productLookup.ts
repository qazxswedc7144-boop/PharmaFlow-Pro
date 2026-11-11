export interface ProductNameIndexTable<T> {
  where(index: 'Name' | 'name'): {
    equalsIgnoreCase(value: string): {
      first(): Promise<T | undefined>;
    };
  };
}

/**
 * Exact case-insensitive lookup through the Dexie Name/name indexes.
 * The schema declares both fields as indexes to support legacy casing.
 */
export async function findExistingProductByName<T>(
  products: ProductNameIndexTable<T>,
  value: string
): Promise<T | null> {
  const name = String(value || '').trim();
  if (!name) return null;

  const pascalCaseMatch = await products.where('Name').equalsIgnoreCase(name).first();
  if (pascalCaseMatch) return pascalCaseMatch;

  return (await products.where('name').equalsIgnoreCase(name).first()) || null;
}
