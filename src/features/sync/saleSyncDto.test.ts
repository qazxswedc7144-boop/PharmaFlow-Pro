import { describe, expect, it } from 'vitest';
import { InvoiceSchema } from '@/shared/validation/invoice.schema';
import { toSaleSyncDTO } from './saleSyncDto';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';

describe('toSaleSyncDTO', () => {
  it('maps SalesWorkflowResult into the strict flat server invoice contract', () => {
    const result = {
      refId: 'local-sale-001',
      sale: {
        id: 'local-sale-001',
        invoiceNumber: 'INV-1001',
        type: 'SALE',
        partnerId: CUSTOMER_ID,
        partnerType: 'CUSTOMER',
        totalAmount: 200,
        items: [
          {
            productId: PRODUCT_ID,
            quantity: 2,
            unitPrice: 100,
            note: 'test item',
          },
        ],
        paymentStatus: 'Cash',
        documentStatus: 'POSTED',
        tenantId: 'tenant-local-only',
        branchId: 'branch-local-only',
        transactionUuid: 'local-idempotency-only',
      },
    };

    const dto = toSaleSyncDTO(result);

    expect(dto).toEqual({
      invoiceNumber: 'INV-1001',
      type: 'SALE',
      partnerId: CUSTOMER_ID,
      partnerType: 'CUSTOMER',
      totalAmount: 200,
      status: 'DRAFT',
      paymentStatus: 'PAID',
      documentStatus: 'ACTIVE',
      items: [
        {
          productId: PRODUCT_ID,
          qty: 2,
          price: 100,
          note: 'test item',
        },
      ],
    });
    expect(InvoiceSchema.parse(dto)).toEqual(dto);
    expect(dto).not.toHaveProperty('tenantId');
    expect(dto).not.toHaveProperty('branchId');
    expect(dto).not.toHaveProperty('transactionUuid');
    expect(dto).not.toHaveProperty('sale');
    expect(dto).not.toHaveProperty('refId');
  });

  it('maps the canonical SalesInvoice fields returned by the local repository', () => {
    const dto = toSaleSyncDTO({
      refId: 'local-sale-canonical',
      sale: {
        id: 'local-sale-canonical',
        SaleID: 'INV-1005',
        customerId: CUSTOMER_ID,
        grandTotal: 125,
        financialStatus: 'Partially Paid',
        items: [{ productId: PRODUCT_ID, qty: 1, price: 125 }],
      },
    });

    expect(dto.invoiceNumber).toBe('INV-1005');
    expect(dto.partnerId).toBe(CUSTOMER_ID);
    expect(dto.totalAmount).toBe(125);
    expect(dto.paymentStatus).toBe('PARTIALLY_PAID');
    expect(InvoiceSchema.parse(dto)).toEqual(dto);
  });

  it('maps cash placeholder partners to null instead of sending a non-UUID local sentinel', () => {
    const dto = toSaleSyncDTO({
      refId: 'local-sale-002',
      sale: {
        invoiceNumber: 'INV-1002',
        totalAmount: 50,
        partnerId: 'CUST-GEN',
        partnerType: 'CUSTOMER',
        paymentStatus: 'Cash',
        items: [{ productId: PRODUCT_ID, qty: 1, price: 50 }],
      },
    });

    expect(dto.partnerId).toBeNull();
    expect(InvoiceSchema.parse(dto)).toEqual(dto);
  });

  it('does not silently coerce an invalid product identifier into an accepted DTO', () => {
    expect(() => toSaleSyncDTO({
      refId: 'local-sale-003',
      sale: {
        invoiceNumber: 'INV-1003',
        totalAmount: 50,
        items: [{ productId: 'PRODUCT-1', qty: 1, price: 50 }],
      },
    })).toThrow();
  });

  it('rejects return documents instead of syncing them as stock-depleting sales', () => {
    expect(() => toSaleSyncDTO({
      refId: 'local-return-001',
      sale: {
        invoiceNumber: 'RET-1001',
        type: 'RETURN_SALE',
        isReturn: true,
        totalAmount: 50,
        items: [{ productId: PRODUCT_ID, qty: 1, price: 50 }],
      },
    })).toThrow('SALE_SYNC_DTO_UNSUPPORTED_RETURN');
  });

  it('documents that the previous nested workflow envelope is not an InvoiceSchema payload', () => {
    const legacyEnvelope = {
      id: 'local-sale-004',
      refId: 'local-sale-004',
      sale: {
        invoiceNumber: 'INV-1004',
        type: 'SALE',
        totalAmount: 50,
        items: [{ productId: PRODUCT_ID, qty: 1, price: 50 }],
      },
      workflowId: 'workflow-004',
      operationType: 'POST',
    };

    expect(InvoiceSchema.safeParse(legacyEnvelope).success).toBe(false);
  });
});
