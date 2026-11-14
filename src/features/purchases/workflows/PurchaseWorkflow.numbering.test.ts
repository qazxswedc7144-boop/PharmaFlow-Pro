import 'fake-indexeddb/auto';

const { getCurrentSession } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(() => ({
    isAuthenticated: true,
    token: 'purchase-numbering-test-token',
    tenantId: 'TENANT-PURCHASE-NUMBERING',
    branchId: 'BRANCH-PURCHASE-NUMBERING',
    user: {
      id: 'USER-PURCHASE-NUMBERING',
      tenantId: 'TENANT-PURCHASE-NUMBERING'
    }
  }))
}));

vi.mock('@/services/auth/tokenProvider', () => ({
  TokenProvider: { getCurrentSession }
}));

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/core/db';
import { TransactionBoundary } from '@/core/integrity/transactionBoundary';
import { purchaseWorkflow } from './PurchaseWorkflow';

const TENANT_ID = 'TENANT-PURCHASE-NUMBERING';
const BRANCH_ID = 'BRANCH-PURCHASE-NUMBERING';
let operationSequence = 0;

const context = () => ({
  workflowId: 'WF-PURCHASE-NUMBERING',
  correlationId: 'CORR-PURCHASE-NUMBERING',
  idempotencyKey: `PURCHASE-NUMBERING-${++operationSequence}`,
  tenantId: TENANT_ID,
  branchId: BRANCH_ID,
  userId: 'USER-PURCHASE-NUMBERING',
  deviceId: 'DEVICE-PURCHASE-NUMBERING',
  operationType: 'PURCHASE',
  startedAt: '2026-11-14T00:00:00.000Z'
});

const purchaseInput = (overrides: Record<string, unknown> = {}) => ({
  supplierId: 'SUP-NUMBERING-001',
  items: [{
    productId: 'SERVICE-NUMBERING-001',
    quantity: 1,
    unitPrice: 100,
    isService: true
  }] as any,
  total: 100,
  invoiceStatus: 'DRAFT' as const,
  ...overrides
});

async function executePurchase(overrides: Record<string, unknown> = {}) {
  const ctx = context();
  return TransactionBoundary.executeAtomic(
    purchaseWorkflow.tables!,
    tx => purchaseWorkflow.executeDomainSteps(
      purchaseInput(overrides) as any,
      ctx as any,
      tx
    )
  );
}

describe('PurchaseWorkflow Phase 1 invoice numbering (TDD)', () => {
  beforeEach(async () => {
    operationSequence = 0;
    await db.open();
    await db.invoices.clear();
    await db.purchases.clear();
    await db.sales.clear();
  });

  afterEach(async () => {
    await db.invoices.clear();
    await db.purchases.clear();
    await db.sales.clear();
    vi.restoreAllMocks();
  });

  it('T1: keeps a manually entered supplier number and generates PUR-1 internally', async () => {
    const result = await executePurchase({ supplierInvoiceNumber: 'A1' });

    expect(result.purchase.supplierInvoiceNumber).toBe('A1');
    expect(result.purchase.invoiceNumber).toBe('PUR-1');
  });

  it('T2: generates P-0001 when the supplier number is blank', async () => {
    const result = await executePurchase({ supplierInvoiceNumber: '' });

    expect(result.purchase.supplierInvoiceNumber).toBe('P-0001');
    expect(result.purchase.invoiceNumber).toBe('PUR-1');
  });

  it('T3: generates R-0001 and RET-1 for a purchase return', async () => {
    const result = await executePurchase({
      isReturn: true,
      supplierInvoiceNumber: ''
    });

    expect(result.purchase.supplierInvoiceNumber).toBe('R-0001');
    expect(result.purchase.invoiceNumber).toBe('RET-1');
    expect(result.purchase.type).toBe('RETURN_PURCHASE');
  });

  it('T4: increments blank purchase supplier numbers sequentially', async () => {
    const first = await executePurchase({ supplierInvoiceNumber: '' });
    const second = await executePurchase({ supplierInvoiceNumber: '' });

    expect(first.purchase.supplierInvoiceNumber).toBe('P-0001');
    expect(second.purchase.supplierInvoiceNumber).toBe('P-0002');
  });

  it('T5: increments blank purchase-return supplier numbers sequentially', async () => {
    const first = await executePurchase({ isReturn: true, supplierInvoiceNumber: '' });
    const second = await executePurchase({ isReturn: true, supplierInvoiceNumber: '' });

    expect(first.purchase.supplierInvoiceNumber).toBe('R-0001');
    expect(second.purchase.supplierInvoiceNumber).toBe('R-0002');
  });

  it('T6: pads the first ten generated purchase supplier numbers to four digits', async () => {
    const results: Array<{ purchase: any }> = [];
    for (let index = 0; index < 10; index += 1) {
      results.push(await executePurchase({ supplierInvoiceNumber: '' }));
    }

    expect(results.map(result => result.purchase.supplierInvoiceNumber)).toEqual([
      'P-0001', 'P-0002', 'P-0003', 'P-0004', 'P-0005',
      'P-0006', 'P-0007', 'P-0008', 'P-0009', 'P-0010'
    ]);
  });

  it('T7: keeps internal purchase and return sequences independent', async () => {
    const purchase = await executePurchase({ supplierInvoiceNumber: '' });
    const purchaseReturn = await executePurchase({
      isReturn: true,
      supplierInvoiceNumber: ''
    });

    expect(purchase.purchase.invoiceNumber).toBe('PUR-1');
    expect(purchaseReturn.purchase.invoiceNumber).toBe('RET-1');
  });

  it('T8: trims and uppercases a manually entered supplier number', async () => {
    const result = await executePurchase({ supplierInvoiceNumber: '  a1  ' });

    expect(result.purchase.supplierInvoiceNumber).toBe('A1');
  });

  it('T9: processPurchase stores RETURN_PURCHASE when isReturn is true', async () => {
    const result = await db.processPurchase(
      'SUP-NUMBERING-RETURN-DB',
      [],
      0,
      'PUR-RETURN-DB-001',
      false,
      'YER',
      'DRAFT',
      0,
      'LOW',
      'RET-DB-1',
      '',
      true,
      '2026-11-14T00:00:00.000Z',
      'PURCHASE-RETURN-DB-001',
      TENANT_ID,
      BRANCH_ID
    );

    expect(result.type).toBe('RETURN_PURCHASE');
    expect(result.isReturn).toBe(true);
  });

  it('T10: leaves sales numbering and product records unchanged', async () => {
    const product = {
      id: 'PRODUCT-NUMBERING-REGRESSION',
      tenantId: TENANT_ID,
      branchId: BRANCH_ID,
      Name: 'Regression Product',
      stock: 7,
      StockQuantity: 7
    };
    await db.products.put(product as any);

    const sale = await db.processSale(
      'CUSTOMER-NUMBERING-REGRESSION',
      [{
        productId: product.id,
        product_id: product.id,
        quantity: 1,
        qty: 1,
        unitPrice: 10,
        price: 10
      }] as any,
      10,
      'SALE-NUMBERING-REGRESSION',
      true,
      'YER',
      'DRAFT',
      0,
      'LOW',
      'INV-REGRESSION-001',
      '',
      false,
      '2026-11-14T00:00:00.000Z',
      'SALE-NUMBERING-REGRESSION-UUID',
      TENANT_ID,
      BRANCH_ID
    );

    expect(sale.type).toBe('SALE');
    expect((await db.products.get(product.id))?.stock).toBe(7);
  });

  it('T11: keeps the Phase 1 supplier number out of the pre-Phase-2 sync payload', () => {
    const payload = purchaseWorkflow.syncContract.buildPayload({
      refId: 'PUR-NUMBERING-SYNC-001',
      purchase: {
        invoiceNumber: 'PUR-1',
        supplierInvoiceNumber: 'P-0001'
      }
    } as any) as any;

    expect(payload.purchase.invoiceNumber).toBe('PUR-1');
    expect(payload.purchase.supplierInvoiceNumber).toBeUndefined();
  });

});
