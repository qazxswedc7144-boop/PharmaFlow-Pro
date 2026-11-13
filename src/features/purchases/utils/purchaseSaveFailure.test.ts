import { describe, expect, it } from 'vitest';
import {
  canResetAfterFailedPurchase,
  getPurchaseSaveFailureMessage
} from './purchaseSaveFailure';

describe('purchase save failure recovery regression', () => {
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
