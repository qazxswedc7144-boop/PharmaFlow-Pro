export interface PurchaseDraftSnapshot {
  header: Record<string, unknown> | null;
  items: any[];
  adjData: Record<string, unknown>;
  partner: Record<string, unknown> | null;
  pendingProducts: any[];
}

/**
 * Failed quarantines contain the exact invoice snapshot from the failed save.
 * Prefer them over debounced autosaves, which may predate the last item entry.
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

export function getPurchaseDraftSnapshot(draft: any): PurchaseDraftSnapshot {
  const payload = draft?.payload || {};
  const totals = draft?.totals || {};
  const nestedData = totals.header ? totals : payload;
  const header = draft?.header || nestedData.header || payload.header || null;
  const items = Array.isArray(draft?.items)
    ? draft.items
    : Array.isArray(nestedData.items)
      ? nestedData.items
      : Array.isArray(payload.items)
        ? payload.items
        : [];
  const adjData = totals.adjData || nestedData.adjData || payload.adjData || {};
  const partner = draft?.partner || nestedData.partner || payload.partner || null;
  const pendingProducts = draft?.pendingProducts || nestedData.pendingProducts || payload.pendingProducts || [];

  return { header, items, adjData, partner, pendingProducts };
}
