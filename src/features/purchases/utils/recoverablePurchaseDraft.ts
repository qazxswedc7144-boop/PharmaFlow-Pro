export { selectRecoverablePurchaseDraft } from '@/services/system/recoverablePurchaseDraft';

export interface PurchaseDraftSnapshot {
  header: Record<string, unknown> | null;
  items: any[];
  adjData: Record<string, unknown>;
  partner: Record<string, unknown> | null;
  pendingProducts: any[];
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
