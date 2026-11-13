export interface DiscardPurchaseDraftTasks {
  clearAllFailedPurchaseDrafts: () => Promise<number>;
  clearRecoveryInvoiceDraft: () => Promise<void>;
  clearDraft: () => Promise<void>;
  getUnfinishedInvoiceDraft: () => Promise<{ draftId?: string } | undefined>;
  clearInvoiceDraft: (draftId: string) => Promise<void>;
  onSuccess: () => void;
  onFailure: (error: unknown) => void | Promise<void>;
}

/**
 * Delete purchase recovery artifacts in a strict sequence. The caller may close
 * the recovery UI only from onSuccess, after every delete has been verified.\n * Failed cleanup is fail-closed: the caller retains its current recovery state.
 */
export async function discardPurchaseDrafts(
  tasks: DiscardPurchaseDraftTasks
): Promise<boolean> {
  try {
    await tasks.clearAllFailedPurchaseDrafts();
    await tasks.clearRecoveryInvoiceDraft();
    await tasks.clearDraft();

    const unfinished = await tasks.getUnfinishedInvoiceDraft();
    if (unfinished?.draftId) {
      await tasks.clearInvoiceDraft(unfinished.draftId);
    }

    tasks.onSuccess();
    return true;
  } catch (error) {
    await tasks.onFailure(error);
    return false;
  }
}
