export interface FailedPurchaseRecoveryState {
  quarantinePersisted: boolean;
  operationArtifactsCleaned: boolean;
  activeDraftCleanupComplete: boolean;
}

/**
 * The purchase form may be reset only after every durable recovery artifact
 * has been verified. A quarantine alone does not make a stale active draft safe.
 */
export function canResetAfterFailedPurchase(
  state: FailedPurchaseRecoveryState
): boolean {
  return state.quarantinePersisted &&
    state.operationArtifactsCleaned &&
    state.activeDraftCleanupComplete;
}

/**
 * Preserve the business-level duplicate reason instead of collapsing it into
 * ErrorManager's generic ERR_DUPLICATE_DOCUMENT Arabic message.
 */
export function getPurchaseSaveFailureMessage(error: unknown): string | null {
  const raw = [
    error instanceof Error ? error.message : String(error ?? ''),
    (error as any)?.name || ''
  ].join(' ');
  if (/DUPLICATE_INVOICE_NUMBER/i.test(raw)) {
    return 'رقم فاتورة المشتريات مستخدم مسبقاً في هذه المؤسسة. تحقق من رقم الفاتورة قبل إعادة الحفظ.';
  }
  if (/DUPLICATE_INVOICE_ID/i.test(raw)) {
    return 'معرّف فاتورة المشتريات موجود مسبقاً. لم يتم استبدال المستند الموجود.';
  }
  if (/ConstraintError|duplicate key/i.test(raw)) {
    return 'حدث تعارض في مفتاح سجل محلي أثناء الحفظ. لم يتم استبدال أي فاتورة موجودة؛ راجع تفاصيل الخطأ قبل إعادة المحاولة.';
  }
  return null;
}
