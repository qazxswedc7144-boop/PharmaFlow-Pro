import { db } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { selectRecoverablePurchaseDraft } from './recoverablePurchaseDraft';

export interface DraftData {
  id: string;
  moduleName: 'Sales Invoice' | 'Purchase Invoice' | 'Supplier Payment' | 'Customer Receipt';
  header: any;
  items: any[];
  totals: any;
  notes?: string;
  paymentType?: string;
  partner?: any;
  tenantId?: string;
  branchId?: string | null;
  updatedAt: string;
}

interface DraftScope {
  tenantId: string;
  branchId: string | null;
}

function getDraftScope(): DraftScope {
  const session = TokenProvider.getCurrentSession();
  const user = session.user as any;
  const tenantId = String(session.tenantId || user?.tenantId || user?.tenant_id || '').trim();
  const branchValue = session.branchId || user?.branchId || user?.branch_id;
  const branchId = typeof branchValue === 'string' && branchValue.trim() ? branchValue.trim() : null;

  if (!session.isAuthenticated || !tenantId) {
    throw new Error('DRAFT_SCOPE_REQUIRED: an authenticated tenant context is required.');
  }
  return { tenantId, branchId };
}

function scopedDraftId(id: string, scope: DraftScope): string {
  if (!id) throw new Error('DRAFT_ID_REQUIRED');
  // Failed quarantine IDs are globally unique operation snapshots and retain
  // their FAILED-* prefix; ownership is enforced by their explicit scope fields.
  if (id.startsWith('FAILED-')) return id;

  const prefix = `tenant:${encodeURIComponent(scope.tenantId)}:branch:${encodeURIComponent(scope.branchId || '')}:`;
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

function belongsToScope(draft: any, scope: DraftScope): boolean {
  return !!draft &&
    draft.tenantId === scope.tenantId &&
    (draft.branchId ?? null) === scope.branchId;
}

function assertDraftScope(draft: any, scope: DraftScope, action: string): void {
  if (!belongsToScope(draft, scope)) {
    throw new Error(`DRAFT_TENANT_MISMATCH: refusing to ${action} a draft outside the active tenant/branch.`);
  }
}

export const DraftService = {
  saveDraft: async (
    id: string,
    moduleName: DraftData['moduleName'],
    data: Omit<DraftData, 'id' | 'moduleName' | 'updatedAt'>
  ): Promise<void> => {
    const scope = getDraftScope();
    const storageId = scopedDraftId(id, scope);
    const existing = await db.drafts.get(storageId);
    if (existing) assertDraftScope(existing, scope, 'overwrite');
    const draft: DraftData = {
      id: storageId,
      moduleName,
      header: data.header,
      items: data.items,
      totals: data.totals,
      notes: data.notes || '',
      paymentType: data.paymentType || '',
      partner: data.partner || null,
      tenantId: scope.tenantId,
      branchId: scope.branchId,
      updatedAt: new Date().toISOString()
    };
    await db.drafts.put(draft);
  },

  getDraft: async (id: string): Promise<DraftData | undefined> => {
    const scope = getDraftScope();
    const draft = await db.drafts.get(scopedDraftId(id, scope));
    return belongsToScope(draft, scope) ? draft : undefined;
  },

  clearDraft: async (id: string): Promise<void> => {
    const scope = getDraftScope();
    const storageId = scopedDraftId(id, scope);
    const draft = await db.drafts.get(storageId);
    if (!draft) return;
    assertDraftScope(draft, scope, 'delete');
    await db.drafts.delete(storageId);
  },

  hasDraft: async (id: string): Promise<boolean> => {
    return !!(await DraftService.getDraft(id));
  },

  saveInvoiceDraft: async (
    draftId: string,
    invoiceType: 'SALE' | 'PURCHASE',
    items: any[],
    totals: any,
    createdAt?: string
  ): Promise<void> => {
    const scope = getDraftScope();
    const storageId = scopedDraftId(draftId, scope);
    const existing = await db.draft_invoices.get(storageId);
    if (existing) assertDraftScope(existing, scope, 'overwrite');
    const now = new Date().toISOString();
    const draft = {
      id: storageId,
      draftId: storageId,
      invoiceType,
      items,
      totals,
      tenantId: scope.tenantId,
      branchId: scope.branchId,
      createdAt: existing?.createdAt || createdAt || now,
      updatedAt: now
    };
    await db.draft_invoices.put(draft);
  },

  quarantineInvoiceDraft: async (draft: any): Promise<void> => {
    const scope = getDraftScope();
    if (
      !draft?.draftId ||
      !String(draft.draftId).startsWith('FAILED-') ||
      draft.status !== 'FAILED_QUARANTINED' ||
      draft.invoiceType !== 'PURCHASE'
    ) {
      throw new Error('INVALID_FAILED_PURCHASE_DRAFT: a FAILED-* draftId, PURCHASE type and FAILED_QUARANTINED status are required.');
    }
    assertDraftScope(draft, scope, 'save');
    await db.transaction('rw', db.draft_invoices, async () => {
      const existing = await db.draft_invoices.get(draft.draftId);
      if (existing && !belongsToScope(existing, scope)) {
        throw new Error('DRAFT_TENANT_MISMATCH: quarantine ID already belongs to another tenant/branch.');
      }
      await db.draft_invoices.put(draft);
      const persisted = await db.draft_invoices.get(draft.draftId);
      if (
        !persisted ||
        persisted.status !== 'FAILED_QUARANTINED' ||
        persisted.invoiceType !== 'PURCHASE' ||
        !belongsToScope(persisted, scope)
      ) {
        throw new Error('FAILED_PURCHASE_QUARANTINE_VERIFY_FAILED');
      }
    });
  },

  getInvoiceDraft: async (draftId: string): Promise<any | undefined> => {
    const scope = getDraftScope();
    const draft = await db.draft_invoices.get(scopedDraftId(draftId, scope));
    return belongsToScope(draft, scope) ? draft : undefined;
  },

  getRecoverablePurchaseDraft: async (): Promise<any | undefined> => {
    const scope = getDraftScope();
    const drafts = await db.draft_invoices
      .where('invoiceType')
      .equals('PURCHASE')
      .filter((draft: any) => belongsToScope(draft, scope))
      .toArray();
    return selectRecoverablePurchaseDraft(drafts as any[]);
  },

  markInvoiceDraftRecovered: async (draftId: string): Promise<void> => {
    if (!draftId) return;
    const scope = getDraftScope();
    const storageId = scopedDraftId(draftId, scope);
    const draft = await db.draft_invoices.get(storageId);
    if (!draft) return;
    assertDraftScope(draft, scope, 'update');
    if (draft.status !== 'FAILED_QUARANTINED') return;
    await db.draft_invoices.update(storageId, {
      recoveredAt: new Date().toISOString()
    });
  },

  getUnfinishedInvoiceDraft: async (invoiceType: 'SALE' | 'PURCHASE'): Promise<any | undefined> => {
    const scope = getDraftScope();
    const drafts = await db.draft_invoices
      .where('invoiceType')
      .equals(invoiceType)
      .filter((draft: any) => draft.status !== 'FAILED_QUARANTINED' && belongsToScope(draft, scope))
      .toArray();
    if (!drafts.length) return undefined;
    return drafts.sort((a: any, b: any) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )[0];
  },

  clearInvoiceDraft: async (draftId: string): Promise<void> => {
    const scope = getDraftScope();
    const storageId = scopedDraftId(draftId, scope);
    const draft = await db.draft_invoices.get(storageId);
    if (!draft) return;
    assertDraftScope(draft, scope, 'delete');
    await db.draft_invoices.delete(storageId);
  },

  hasInvoiceDraft: async (invoiceType: 'SALE' | 'PURCHASE'): Promise<boolean> => {
    const scope = getDraftScope();
    const count = await db.draft_invoices
      .where('invoiceType')
      .equals(invoiceType)
      .filter((draft: any) => draft.status !== 'FAILED_QUARANTINED' && belongsToScope(draft, scope))
      .count();
    return count > 0;
  }
};
