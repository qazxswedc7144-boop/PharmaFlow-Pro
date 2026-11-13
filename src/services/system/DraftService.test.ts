import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, dbInstance } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { DraftService } from './DraftService';
import { discardPurchaseDrafts } from '@/features/purchases/utils/discardPurchaseDrafts';
import { readDiagnosticLogs } from './diagnosticLogger';

const setTenantSession = (tenantId: string, branchId: string) => {
  TokenProvider.setSession(
    { id: 'user-' + tenantId, tenantId, branchId } as any,
    'access-' + tenantId,
    'refresh-' + tenantId
  );
};

const uniqueId = () => 'draft-test-' + Date.now() + '-' + Math.random().toString(36).slice(2);

describe('DraftService tenant isolation and persistence errors', () => {
  beforeEach(async () => {
    await db.open();
    setTenantSession('tenant-a', 'branch-a');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    TokenProvider.clearSession();
  });

  it('scopes invoice drafts by tenant and branch and only returns the active owner draft', async () => {
    const logicalId = uniqueId();
    const tenantA = uniqueId();
    const tenantB = uniqueId();
    setTenantSession(tenantA, 'branch-a');
    await DraftService.saveInvoiceDraft(logicalId, 'PURCHASE', [{ productId: 'p-a' }], { total: 10 });

    setTenantSession(tenantA, 'branch-b');
    expect(await DraftService.getInvoiceDraft(logicalId)).toBeUndefined();
    expect(await DraftService.getRecoverablePurchaseDraft()).toBeUndefined();
    await DraftService.saveInvoiceDraft(logicalId, 'PURCHASE', [{ productId: 'p-branch-b' }], { total: 15 });
    expect((await DraftService.getRecoverablePurchaseDraft())?.items).toEqual([{ productId: 'p-branch-b' }]);

    setTenantSession(tenantB, 'branch-b');
    expect(await DraftService.getInvoiceDraft(logicalId)).toBeUndefined();
    expect(await DraftService.getRecoverablePurchaseDraft()).toBeUndefined();
    await DraftService.saveInvoiceDraft(logicalId, 'PURCHASE', [{ productId: 'p-b' }], { total: 20 });
    expect((await DraftService.getRecoverablePurchaseDraft())?.items).toEqual([{ productId: 'p-b' }]);

    setTenantSession(tenantA, 'branch-a');
    expect((await DraftService.getInvoiceDraft(logicalId))?.items).toEqual([{ productId: 'p-a' }]);
    await DraftService.clearInvoiceDraft(logicalId);

    setTenantSession(tenantA, 'branch-b');
    await DraftService.clearInvoiceDraft(logicalId);
    setTenantSession(tenantB, 'branch-b');
    await DraftService.clearInvoiceDraft(logicalId);
  });

  it('rejects draft save and delete failures instead of swallowing them', async () => {
    const logicalId = uniqueId();
    vi.spyOn(db.drafts, 'put').mockRejectedValueOnce(new Error('draft write failed'));
    await expect(
      DraftService.saveDraft(logicalId, 'Purchase Invoice', {
        header: {}, items: [], totals: {}
      })
    ).rejects.toThrow('draft write failed');

    await DraftService.saveDraft(logicalId, 'Purchase Invoice', {
      header: {}, items: [], totals: {}
    });
    vi.spyOn(db.drafts, 'delete').mockRejectedValueOnce(new Error('draft delete failed'));
    await expect(DraftService.clearDraft(logicalId)).rejects.toThrow('draft delete failed');
    const draftLogs = await readDiagnosticLogs(db, 'tenant-a');
    expect(draftLogs[0]).toMatchObject({
      operation: 'DRAFT_CLEAR',
      errorMessage: 'draft delete failed',
      context: { draftId: logicalId }
    });
    vi.restoreAllMocks();
    await DraftService.clearDraft(logicalId);
  });

  it('verifies active invoice draft removal instead of silently accepting a no-op delete', async () => {
    const logicalId = uniqueId();
    await DraftService.saveInvoiceDraft(logicalId, 'PURCHASE', [{ productId: 'p-1' }], { total: 10 });
    vi.spyOn(db.draft_invoices, 'delete').mockResolvedValue(undefined as any);

    await expect(DraftService.clearInvoiceDraft(logicalId))
      .rejects.toThrow('INVOICE_DRAFT_DELETE_VERIFY_FAILED');

    vi.restoreAllMocks();
    await DraftService.clearInvoiceDraft(logicalId);
    expect(await DraftService.getInvoiceDraft(logicalId)).toBeUndefined();
  });

  it('propagates invoice draft save and cleanup failures', async () => {
    const logicalId = uniqueId();
    vi.spyOn(db.draft_invoices, 'put').mockRejectedValueOnce(new Error('invoice draft write failed'));
    await expect(
      DraftService.saveInvoiceDraft(logicalId, 'PURCHASE', [], {})
    ).rejects.toThrow('invoice draft write failed');

    await DraftService.saveInvoiceDraft(logicalId, 'PURCHASE', [], {});
    vi.spyOn(db.draft_invoices, 'delete').mockRejectedValueOnce(new Error('invoice draft delete failed'));
    await expect(DraftService.clearInvoiceDraft(logicalId)).rejects.toThrow('invoice draft delete failed');
    const invoiceDraftLogs = await readDiagnosticLogs(db, 'tenant-a');
    expect(invoiceDraftLogs[0]).toMatchObject({
      operation: 'INVOICE_DRAFT_CLEAR',
      errorMessage: 'invoice draft delete failed',
      context: { draftId: logicalId }
    });
    vi.restoreAllMocks();
    await DraftService.clearInvoiceDraft(logicalId);
  });

  it('T-B-01 discardDraft.deletesAllFailedQuarantinedForCurrentBranch', async () => {
    const prefix = uniqueId();
    const failedIds = [1, 2, 3].map(index => `FAILED-${prefix}-${index}`);
    for (const id of failedIds) {
      await db.draft_invoices.put({
        draftId: id, id, invoiceType: 'PURCHASE', status: 'FAILED_QUARANTINED',
        tenantId: 'tenant-a', branchId: 'branch-a', items: [], totals: {}
      });
    }
    await db.draft_invoices.put({
      draftId: `${prefix}-active`, id: `${prefix}-active`, invoiceType: 'PURCHASE',
      status: 'DRAFT', tenantId: 'tenant-a', branchId: 'branch-a', items: [], totals: {}
    });

    await expect(DraftService.clearAllFailedPurchaseDrafts()).resolves.toBe(3);
    for (const id of failedIds) expect(await db.draft_invoices.get(id)).toBeUndefined();
    expect(await db.draft_invoices.get(`${prefix}-active`)).toBeDefined();
    await db.draft_invoices.delete(`${prefix}-active`);
  });

  it('T-B-02 discardDraft.preservesOtherBranchesAndTenants', async () => {
    const prefix = uniqueId();
    const currentId = `FAILED-${prefix}-current`;
    const otherBranchId = `FAILED-${prefix}-other-branch`;
    const otherTenantId = `FAILED-${prefix}-other-tenant`;
    const legacyUnassignedId = `FAILED-${prefix}-legacy`;

    await db.draft_invoices.put({
      draftId: currentId, id: currentId, invoiceType: 'PURCHASE', status: 'FAILED_QUARANTINED',
      tenantId: 'tenant-a', branchId: 'branch-a', items: [], totals: {}
    });
    await db.draft_invoices.put({
      draftId: legacyUnassignedId, id: legacyUnassignedId, invoiceType: 'PURCHASE',
      status: 'FAILED_QUARANTINED', tenantId: 'tenant-a', items: [], totals: {}
    });

    setTenantSession('tenant-a', 'branch-b');
    await db.draft_invoices.put({
      draftId: otherBranchId, id: otherBranchId, invoiceType: 'PURCHASE', status: 'FAILED_QUARANTINED',
      tenantId: 'tenant-a', branchId: 'branch-b', items: [], totals: {}
    });
    setTenantSession('tenant-b', 'branch-a');
    await db.draft_invoices.put({
      draftId: otherTenantId, id: otherTenantId, invoiceType: 'PURCHASE', status: 'FAILED_QUARANTINED',
      tenantId: 'tenant-b', branchId: 'branch-a', items: [], totals: {}
    });

    setTenantSession('tenant-a', 'branch-a');
    await expect(DraftService.clearAllFailedPurchaseDrafts()).resolves.toBe(1);
    expect(await db.draft_invoices.get(currentId)).toBeUndefined();
    expect(await db.draft_invoices.get(otherBranchId)).toBeDefined();
    expect(await db.draft_invoices.get(legacyUnassignedId)).toBeDefined();

    setTenantSession('tenant-a', 'branch-b');
    expect(await db.draft_invoices.get(otherBranchId)).toBeDefined();
    await db.draft_invoices.delete(otherBranchId);
    setTenantSession('tenant-b', 'branch-a');
    expect(await db.draft_invoices.get(otherTenantId)).toBeDefined();
    await db.draft_invoices.delete(otherTenantId);
    setTenantSession('tenant-a', 'branch-a');
    await db.draft_invoices.delete(legacyUnassignedId);
  });

  it('T-B-05 discardDraft.purchaseCleanupDoesNotDeleteSalesDraftsOrProducts', async () => {
    const prefix = uniqueId();
    const failedPurchaseId = `FAILED-${prefix}-purchase`;
    const failedSaleId = `FAILED-${prefix}-sale`;
    const productId = `product-${prefix}`;
    await db.draft_invoices.put({
      draftId: failedPurchaseId, id: failedPurchaseId, invoiceType: 'PURCHASE',
      status: 'FAILED_QUARANTINED', tenantId: 'tenant-a', branchId: 'branch-a', items: [], totals: {}
    });
    await db.draft_invoices.put({
      draftId: failedSaleId, id: failedSaleId, invoiceType: 'SALE',
      status: 'FAILED_QUARANTINED', tenantId: 'tenant-a', branchId: 'branch-a', items: [], totals: {}
    });
    await db.products.put({ id: productId, Name: 'Regression product', tenantId: 'tenant-a', branchId: 'branch-a' } as any);

    await expect(DraftService.clearAllFailedPurchaseDrafts()).resolves.toBe(1);
    expect(await db.draft_invoices.get(failedPurchaseId)).toBeUndefined();
    expect(await db.draft_invoices.get(failedSaleId)).toBeDefined();
    expect(await db.products.get(productId)).toBeDefined();

    await db.draft_invoices.delete(failedSaleId);
    await db.products.delete(productId);
  });

  it('T-B-03 discardDraft.failureKeepsRecoveryModalOpen', async () => {
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    const result = await discardPurchaseDrafts({
      clearAllFailedPurchaseDrafts: vi.fn().mockRejectedValue(new Error('bulk delete failed')),
      clearRecoveryInvoiceDraft: vi.fn().mockResolvedValue(undefined),
      clearDraft: vi.fn().mockResolvedValue(undefined),
      getUnfinishedInvoiceDraft: vi.fn().mockResolvedValue(undefined),
      clearInvoiceDraft: vi.fn().mockResolvedValue(undefined),
      onSuccess,
      onFailure
    });

    expect(result).toBe(false);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: 'bulk delete failed' }));
  });

  it('T-B-04 discardDraft.requiresPostDeleteVerification', async () => {
    const onSuccess = vi.fn();
    const clearRecoveryInvoiceDraft = vi.fn().mockResolvedValue(undefined);
    const clearDraft = vi.fn().mockResolvedValue(undefined);
    const result = await discardPurchaseDrafts({
      clearAllFailedPurchaseDrafts: vi.fn().mockRejectedValue(new Error('DRAFT_DELETE_VERIFY_FAILED')),
      clearRecoveryInvoiceDraft,
      clearDraft,
      getUnfinishedInvoiceDraft: vi.fn().mockResolvedValue(undefined),
      clearInvoiceDraft: vi.fn().mockResolvedValue(undefined),
      onSuccess,
      onFailure: vi.fn()
    });

    expect(result).toBe(false);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(clearRecoveryInvoiceDraft).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
  });

  it('discardDraft signals success only after all cleanup steps finish', async () => {
    const events: string[] = [];
    const result = await discardPurchaseDrafts({
      clearAllFailedPurchaseDrafts: async () => { events.push('failed'); return 2; },
      clearRecoveryInvoiceDraft: async () => { events.push('recovery'); },
      clearDraft: async () => { events.push('general'); },
      getUnfinishedInvoiceDraft: async () => { events.push('lookup'); return { draftId: 'active' }; },
      clearInvoiceDraft: async () => { events.push('active'); },
      onSuccess: () => { events.push('success'); },
      onFailure: () => { events.push('failure'); }
    });

    expect(result).toBe(true);
    expect(events).toEqual(['failed', 'recovery', 'general', 'lookup', 'active', 'success']);
  });

  it('clears legacy branchless failed purchases only when the active scope has no branch', async () => {
    const id = `FAILED-${uniqueId()}-legacy-no-branch`;
    await db.draft_invoices.put({
      draftId: id, id, invoiceType: 'PURCHASE', status: 'FAILED_QUARANTINED',
      tenantId: 'tenant-a', items: [], totals: {}
    });
    setTenantSession('tenant-a', '');
    await expect(DraftService.clearAllFailedPurchaseDrafts()).resolves.toBe(1);
    expect(await db.draft_invoices.get(id)).toBeUndefined();
    setTenantSession('tenant-a', 'branch-a');
  });

  it('rejects a bulk delete that leaves matching failed purchase drafts behind', async () => {
    const id = `FAILED-${uniqueId()}-verify`;
    await db.draft_invoices.put({
      draftId: id, id, invoiceType: 'PURCHASE', status: 'FAILED_QUARANTINED',
      tenantId: 'tenant-a', branchId: 'branch-a', items: [], totals: {}
    });
    vi.spyOn(dbInstance.draft_invoices, 'delete').mockResolvedValue(undefined as any);

    await expect(DraftService.clearAllFailedPurchaseDrafts())
      .rejects.toThrow('DRAFT_DELETE_VERIFY_FAILED');

    vi.restoreAllMocks();
    expect(await db.draft_invoices.get(id)).toBeDefined();
    await DraftService.clearInvoiceDraft(id);
  });

});
