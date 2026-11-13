export function normalizeSupplierInvoiceNumber(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLocaleUpperCase('en-US');
}

export function getSavedPurchaseInvoiceNumber(
  savedInvoice: Record<string, unknown> | null | undefined,
  fallback = ''
): string {
  const candidates = [
    savedInvoice?.invoiceNumber,
    savedInvoice?.invoice_number,
    savedInvoice?.invoiceId,
    fallback
  ];
  const value = candidates.find(candidate =>
    typeof candidate === 'string' && candidate.trim().length > 0
  );
  return typeof value === 'string' ? value.trim() : '';
}

export function getPurchaseAuditDetails(invoiceNumber: string, isReturn: boolean): string {
  const documentLabel = isReturn ? 'Purchase Return' : 'Purchase';
  return `${documentLabel}: ${invoiceNumber}`;
}
