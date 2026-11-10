import { describe, expect, it } from 'vitest';
import { getPurchaseFailureDisposition } from './purchaseFailureDisposition';

describe('purchase failure disposition', () => {
  it('never quarantines a transaction already committed', () => {
    expect(getPurchaseFailureDisposition('COMMITTED')).toBe('COMMITTED');
  });

  it('keeps an unresolved processing operation attached to the current form', () => {
    expect(getPurchaseFailureDisposition('PROCESSING')).toBe('PENDING');
  });

  it('quarantines only operations that are failed or have no idempotency record', () => {
    expect(getPurchaseFailureDisposition('FAILED')).toBe('QUARANTINE');
    expect(getPurchaseFailureDisposition(null)).toBe('QUARANTINE');
  });
});
