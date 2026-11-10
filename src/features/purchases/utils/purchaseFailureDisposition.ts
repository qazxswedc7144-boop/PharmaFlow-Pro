type IdempotencyState = 'PROCESSING' | 'COMMITTED' | 'FAILED' | null | undefined;

export type PurchaseFailureDisposition = 'COMMITTED' | 'PENDING' | 'QUARANTINE';

export function getPurchaseFailureDisposition(
  status: IdempotencyState
): PurchaseFailureDisposition {
  if (status === 'COMMITTED') return 'COMMITTED';
  if (status === 'PROCESSING') return 'PENDING';
  return 'QUARANTINE';
}
