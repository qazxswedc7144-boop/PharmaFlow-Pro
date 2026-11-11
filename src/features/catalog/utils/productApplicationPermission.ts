export type ProductApplicationPermission = 'inventory.product.create' | 'inventory.product.update';

/**
 * Uses the canonical permission keys defined by the central RBAC matrix.
 * Product creation and editing are distinct capabilities.
 */
export function getProductApplicationPermission(isNew?: boolean): ProductApplicationPermission {
  return isNew === false ? 'inventory.product.update' : 'inventory.product.create';
}
