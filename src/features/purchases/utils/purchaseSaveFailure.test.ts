import { describe, expect, it, vi } from 'vitest';
import {
  canResetAfterFailedPurchase,
  cleanupFailedPurchaseDrafts,
  getPurchaseSaveFailureMessage
} from './purchaseSaveFailure';

describe('purchase save failure recovery regression', () => {
  it('does not block safe reset when optional configuration cleanup fails', async () => {
    const clearInvoiceDraft = vi.fn().mockResolvedValue(undefined);
    const clearDraft = vi.fn().mockResolvedValue(undefined);
    const clearOptionalConfig = vi.fn().mockRejectedValue(new Error('unregistered config key'));

    const result = await cleanupFailedPurchaseDrafts({
      clearInvoiceDraft,
      clearDraft,
      clearOptionalConfig
    });

    expect(clearInvoiceDraft).toHaveBeenCalledTimes(1);
    expect(clearDraft).toHaveBeenCalledTimes(1);
    expect(clearOptionalConfig).toHaveBeenCalledTimes(1);
    expect(result.activeDraftCleanupComplete).toBe(true);
    expect(result.optionalConfigCleanup).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'unregistered config key' })
    });
    expect(canResetAfterFailedPurchase({
      quarantinePersisted: true,
      operationArtifactsCleaned: true,
      activeDraftCleanupComplete: result.activeDraftCleanupComplete
    })).toBe(true);
  });

  it('still blocks reset when a required active draft cleanup fails', async () => {
    const result = await cleanupFailedPurchaseDrafts({
      clearInvoiceDraft: () => Promise.reject(new Error('invoice draft delete failed')),
      clearDraft: async () => undefined,
      clearOptionalConfig: async () => undefined
    });

    expect(result.activeDraftCleanupComplete).toBe(false);
    expect(result.requiredCleanupResults[0].status).toBe('rejected');
    expect(canResetAfterFailedPurchase({
      quarantinePersisted: true,
      operationArtifactsCleaned: true,
      activeDraftCleanupComplete: result.activeDraftCleanupComplete
    })).toBe(false);
  });

  it('T-01 keeps the form when the active draft could not be cleared', () => {
    expect(canResetAfterFailedPurchase({
      quarantinePersisted: true,
      operationArtifactsCleaned: true,
      activeDraftCleanupComplete: false
    })).toBe(false);
  });

  it('T-01 resets only after quarantine, operation cleanup and active draft cleanup all succeed', () => {
    expect(canResetAfterFailedPurchase({
      quarantinePersisted: true,
      operationArtifactsCleaned: true,
      activeDraftCleanupComplete: true
    })).toBe(true);
    expect(canResetAfterFailedPurchase({
      quarantinePersisted: false,
      operationArtifactsCleaned: true,
      activeDraftCleanupComplete: true
    })).toBe(false);
    expect(canResetAfterFailedPurchase({
      quarantinePersisted: true,
      operationArtifactsCleaned: false,
      activeDraftCleanupComplete: true
    })).toBe(false);
  });

  it('T-02 reports duplicate invoice number and ID distinctly without converting them to upserts', () => {
    expect(getPurchaseSaveFailureMessage(new Error('DUPLICATE_INVOICE_NUMBER: PUR-55')))
      .toContain('رقم فاتورة المشتريات مستخدم مسبقاً');
    expect(getPurchaseSaveFailureMessage(new Error('DUPLICATE_INVOICE_ID: PUR-55')))
      .toContain('معرّف فاتورة المشتريات موجود مسبقاً');
  });

  it('T-02 turns a raw IndexedDB ConstraintError into a clear non-destructive message', () => {
    expect(getPurchaseSaveFailureMessage(new DOMException('Key exists', 'ConstraintError')))
      .toContain('لم يتم استبدال أي فاتورة موجودة');
  });

  it('T-03 leaves non-duplicate failures to the existing error handler', () => {
    expect(getPurchaseSaveFailureMessage(new Error('SIMULATED_PURCHASE_DOC_FAILURE'))).toBeNull();
  });
});
