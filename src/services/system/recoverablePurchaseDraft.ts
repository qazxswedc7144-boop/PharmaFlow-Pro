/**
 * Select the most reliable purchase draft for recovery.
 * A failed quarantine is an exact save-boundary snapshot and outranks a
 * potentially stale debounced autosave, regardless of the autosave timestamp.
 */
export function selectRecoverablePurchaseDraft<T extends Record<string, any>>(drafts: T[]): T | undefined {
  const eligible = (drafts || []).filter(draft =>
    draft?.invoiceType === 'PURCHASE' &&
    (draft.status !== 'FAILED_QUARANTINED' || !draft.recoveredAt)
  );
  const failed = eligible.filter(draft => draft.status === 'FAILED_QUARANTINED');
  const candidates = failed.length > 0
    ? failed
    : eligible.filter(draft => draft.status !== 'FAILED_QUARANTINED');

  return [...candidates].sort((a, b) =>
    new Date(b.updatedAt || b.createdAt || 0).getTime() -
    new Date(a.updatedAt || a.createdAt || 0).getTime()
  )[0];
}
