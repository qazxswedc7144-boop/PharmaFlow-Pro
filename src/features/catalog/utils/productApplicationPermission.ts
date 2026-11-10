export type ProductApplicationPermission = 'products.manage' | 'products.edit';

/**
 * Product creation and editing are separate capabilities. A user must not
 * need both permissions to register a new catalog product.
 */
export function getProductApplicationPermission(isNew?: boolean): ProductApplicationPermission {
  return isNew === false ? 'products.edit' : 'products.manage';
}
