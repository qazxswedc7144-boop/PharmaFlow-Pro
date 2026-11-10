import { describe, expect, it } from 'vitest';
import { buildFailedPurchaseDraft } from './failedPurchaseDraft';

describe('failed purchase draft quarantine', () => {
  it('stores failed invoice data under a separate non-recoverable-as-active draft key', () => {
    const failed = buildFailedPurchaseDraft({
      operationId: 'op-123',
      header: { invoice_number: 'PUR-10', supplier_id: 'supplier-a' },
      items: [{ productId: 'product-a', qty: 3, price: 10 }],
      adjData: { discountPercent: 0, otherFees: 0, tax: 0 },
      errorCode: 'CROSS_TENANT_VIOLATION'
    });

    expect(failed.id).toBe('failed_purchase_op-123');
    expect(failed.invoiceType).toBe('PURCHASE');
    expect(failed.status).toBe('FAILED_QUARANTINED');
    expect(failed.items).toHaveLength(1);
    expect(failed.errorCode).toBe('CROSS_TENANT_VIOLATION');
  });

  it('does not share mutable invoice objects with the active form state', () => {
    const items = [{ productId: 'product-a', qty: 3, price: 10 }];
    const failed = buildFailedPurchaseDraft({
      operationId: 'op-456',
      header: { invoice_number: 'PUR-11' },
      items,
      adjData: { discountPercent: 0, otherFees: 0, tax: 0 },
      errorCode: 'SAVE_FAILED'
    });

    failed.items[0].qty = 99;
    expect(items[0].qty).toBe(3);
  });
});
