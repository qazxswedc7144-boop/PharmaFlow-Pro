import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/core/db';
import { DraftService } from '@/services/system/DraftService';
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

    expect(failed.id).toMatch(/^FAILED-\d+-op-123$/);
    expect(failed.draftId).not.toBe('purchases_draft_current');
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

    failed.items[0]!.qty = 99;
    expect(items[0]!.qty).toBe(3);
  });
});


describe('DraftService failed purchase quarantine persistence', () => {
  beforeEach(async () => {
    await db.open();
    await db.draft_invoices.clear();
  });

  afterEach(async () => {
    await db.draft_invoices.clear();
  });

  it('persists and reads back the failed draft using draftId, the Dexie primary key', async () => {
    const draft = {
      id: 'FAILED-1700000000000-operation-1',
      draftId: 'FAILED-1700000000000-operation-1',
      invoiceType: 'PURCHASE' as const,
      status: 'FAILED_QUARANTINED' as const,
      header: { invoice_number: 'PUR-100' },
      items: [{ productId: 'product-1', qty: 2, price: 10 }],
      totals: { adjData: { discountPercent: 0 } },
      errorCode: 'BRANCH_MEMBERSHIP_REQUIRED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await DraftService.quarantineInvoiceDraft(draft);

    await expect(DraftService.getInvoiceDraft(draft.draftId)).resolves.toMatchObject({
      draftId: draft.draftId,
      status: 'FAILED_QUARANTINED',
      invoiceType: 'PURCHASE'
    });
  });

  it('rejects a quarantine record missing the draftId primary key', async () => {
    await expect(DraftService.quarantineInvoiceDraft({
      id: 'FAILED-missing-key',
      invoiceType: 'PURCHASE',
      status: 'FAILED_QUARANTINED'
    })).rejects.toThrow(/INVALID_FAILED_PURCHASE_DRAFT/);
  });
});
