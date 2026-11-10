export interface FailedPurchaseDraftInput {
  operationId: string;
  header: Record<string, unknown>;
  items: any[];
  adjData: Record<string, unknown>;
  errorCode: string;
}

export function buildFailedPurchaseDraft(input: FailedPurchaseDraftInput) {
  const now = new Date().toISOString();
  return {
    id: `failed_purchase_${input.operationId}`,
    draftId: `failed_purchase_${input.operationId}`,
    invoiceType: 'PURCHASE' as const,
    status: 'FAILED_QUARANTINED' as const,
    header: JSON.parse(JSON.stringify(input.header)),
    items: JSON.parse(JSON.stringify(input.items)),
    totals: { adjData: JSON.parse(JSON.stringify(input.adjData)) },
    errorCode: input.errorCode,
    createdAt: now,
    updatedAt: now
  };
}
