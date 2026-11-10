import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/core/db';
import { DraftService } from './DraftService';

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
      id: 'failed_purchase_operation-1',
      draftId: 'failed_purchase_operation-1',
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
      id: 'failed_purchase_missing-key',
      invoiceType: 'PURCHASE',
      status: 'FAILED_QUARANTINED'
    })).rejects.toThrow(/INVALID_FAILED_PURCHASE_DRAFT/);
  });
});
