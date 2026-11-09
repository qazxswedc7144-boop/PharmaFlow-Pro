import { InvoiceSchema, type InvoiceDTO } from '@/shared/validation/invoice.schema';

/**
 * Converts the local workflow envelope into the strict, flat SALE command
 * accepted by the server's InvoiceSchema. Tenant and branch identity are
 * deliberately omitted: the server derives those from the authenticated session.
 */
export function toSaleSyncDTO(result: unknown): InvoiceDTO {
  if (!result || typeof result !== 'object') {
    throw new Error('SALE_SYNC_DTO_INVALID_RESULT');
  }

  const workflowResult = result as Record<string, any>;
  const sale = workflowResult.sale;
  if (!sale || typeof sale !== 'object') {
    throw new Error('SALE_SYNC_DTO_MISSING_SALE');
  }
  if (sale.isReturn === true || String(sale.type || '').toUpperCase() === 'RETURN_SALE') {
    throw new Error('SALE_SYNC_DTO_UNSUPPORTED_RETURN: Return documents must use the dedicated return sync command.');
  }

  const invoiceNumber = sale.invoiceNumber ?? sale.SaleID ?? sale.invoice_number ?? sale.invoiceId;
  const rawItems = Array.isArray(sale.items) ? sale.items : [];
  const items = rawItems.map((item: Record<string, any>) => {
    const productId = item.productId ?? item.product_id;
    const qty = Number(item.qty ?? item.quantity);
    const price = Number(item.price ?? item.unitPrice ?? item.unit_price);
    return {
      productId,
      qty,
      price,
      ...(item.expiryDate !== undefined ? { expiryDate: item.expiryDate } : {}),
      ...(item.note !== undefined ? { note: item.note } : {}),
    };
  });

  const rawPartnerId = sale.partnerId ?? sale.partner_id ?? sale.customerId ?? sale.customer_id;
  const partnerId = !rawPartnerId || rawPartnerId === 'CUST-GEN' || rawPartnerId === 'عميل نقدي'
    ? null
    : rawPartnerId;

  const rawPaymentStatus = String(sale.paymentStatus ?? sale.payment_status ?? sale.financialStatus ?? '').toUpperCase();
  const paymentStatus =
    ['CASH', 'PAID'].includes(rawPaymentStatus) ? 'PAID' :
    ['CREDIT', 'UNPAID'].includes(rawPaymentStatus) ? 'UNPAID' :
    ['PARTIALLY_PAID', 'PARTIAL', 'PARTIALLY PAID'].includes(rawPaymentStatus) ? 'PARTIALLY_PAID' :
    rawPaymentStatus || 'UNPAID';

  const dto = {
    invoiceNumber,
    type: 'SALE' as const,
    ...(partnerId !== null || rawPartnerId !== undefined
      ? { partnerId }
      : {}),
    partnerType: 'CUSTOMER' as const,
    totalAmount: Number(sale.totalAmount ?? sale.grandTotal ?? sale.finalTotal ?? sale.total),
    paymentStatus,
    items,
  };

  // Zod strict parsing both validates the server contract and strips no unknown
  // business fields silently: any accidental extra field is a programming error.
  return InvoiceSchema.parse(dto);
}
