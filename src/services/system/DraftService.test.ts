import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { DraftService } from './DraftService';
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
});
