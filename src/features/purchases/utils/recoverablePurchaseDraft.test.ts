import { describe, expect, it } from 'vitest';
import { getPurchaseDraftSnapshot, selectRecoverablePurchaseDraft } from './recoverablePurchaseDraft';

describe('selectRecoverablePurchaseDraft', () => {
  it('prefers the failed quarantined invoice over a newer stale autosave draft', () => {
    const staleDraft = {
      draftId: 'purchases_draft_current',
      invoiceType: 'PURCHASE',
      status: 'DRAFT',
      updatedAt: '2026-11-10T23:00:00.000Z',
      items: []
    };
    const failedDraft = {
      draftId: 'failed_purchase_1',
      invoiceType: 'PURCHASE',
      status: 'FAILED_QUARANTINED',
      updatedAt: '2026-11-10T22:59:00.000Z',
      items: [{ name: 'Panadol Extra' }]
    };

    expect(selectRecoverablePurchaseDraft([staleDraft, failedDraft])).toBe(failedDraft);
  });

  it('does not offer a quarantined draft that was already recovered', () => {
    const recoveredDraft = {
      draftId: 'failed_purchase_1',
      invoiceType: 'PURCHASE',
      status: 'FAILED_QUARANTINED',
      recoveredAt: '2026-11-10T23:10:00.000Z',
      updatedAt: '2026-11-10T23:00:00.000Z'
    };
    const activeDraft = {
      draftId: 'active_1',
      invoiceType: 'PURCHASE',
      status: 'DRAFT',
      updatedAt: '2026-11-10T22:00:00.000Z'
    };

    expect(selectRecoverablePurchaseDraft([recoveredDraft, activeDraft])).toBe(activeDraft);
  });
});

describe('getPurchaseDraftSnapshot', () => {
  it('restores header, every invoice line, adjustments, partner and pending products from quarantine', () => {
    const draft = {
      draftId: 'failed_purchase_1',
      invoiceType: 'PURCHASE',
      status: 'FAILED_QUARANTINED',
      header: { invoice_number: 'PUR-100', supplier_id: 'SUP-1' },
      items: [{ name: 'Panadol Extra', qty: 2, price: 10 }],
      totals: { adjData: { discountPercent: 5, otherFees: 0, tax: 0 } },
      partner: { partnerName: 'Test Supplier' },
      pendingProducts: [{ id: 'PROD-1', Name: 'Panadol Extra' }]
    };

    expect(getPurchaseDraftSnapshot(draft)).toEqual({
      header: draft.header,
      items: draft.items,
      adjData: draft.totals.adjData,
      partner: draft.partner,
      pendingProducts: draft.pendingProducts
    });
  });
});
