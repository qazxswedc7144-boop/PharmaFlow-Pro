import 'fake-indexeddb/auto';

const { getCurrentSession } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(() => ({
    isAuthenticated: true,
    token: 'purchase-invoice-number-test-token',
    tenantId: 'TENANT-PURCHASE-NUMBER',
    branchId: 'BRANCH-PURCHASE-NUMBER',
    user: { id: 'USER-PURCHASE-NUMBER', tenantId: 'TENANT-PURCHASE-NUMBER' }
  }))
}));

vi.mock('@/services/auth/tokenProvider', () => ({
  TokenProvider: { getCurrentSession }
}));

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/core/db';
import { purchaseWorkflow } from './PurchaseWorkflow';
import { salesWorkflow } from '@features/sales/workflows/SalesWorkflow';
import { productApplicationWorkflow } from '@features/catalog/workflows/ProductApplicationWorkflow';
import {
  getSavedPurchaseInvoiceNumber,
  getPurchaseAuditDetails
} from '../utils/purchaseInvoiceNumber';

const context = {
  workflowId: 'WF-PURCHASE-INVOICE-NUMBER',
  correlationId: 'CORR-PURCHASE-INVOICE-NUMBER',
  idempotencyKey: 'PURCHASE-INVOICE-NUMBER-IDEM',
  tenantId: 'TENANT-PURCHASE-NUMBER',
  branchId: 'BRANCH-PURCHASE-NUMBER',
  userId: 'USER-PURCHASE-NUMBER',
  deviceId: 'DEVICE-PURCHASE-NUMBER',
  operationType: 'PURCHASE',
  startedAt: '2026-11-13T00:00:00.000Z'
};

const draftInput = (overrides: Record<string, unknown> = {}) => ({
  supplierId: 'مورد نقدي',
  isCash: true,
  invoiceNumber: '',
  supplierInvoiceNumber: 'SUP-INV-100',
  date: '2026-11-13T00:00:00.000Z',
  items: [{ productId: 'SERVICE-PURCHASE-NUMBER', quantity: 1, unitPrice: 100, isService: true }] as any,
  total: 100,
  invoiceStatus: 'DRAFT' as const,
  ...overrides
});

describe('Purchase invoice number split — Phase 1 (TDD)', () => {
  beforeEach(async () => {
    await db.open();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.invoices.delete('PURCHASE-INVOICE-NUMBER-LOCAL');
    await db.purchases.delete('PURCHASE-INVOICE-NUMBER-LOCAL');
    await db.invoices.delete('PURCHASE-POSTED-LOCKED');
  });

  it('T1: persists the supplier invoice number with the purchase record', async () => {
    const input = draftInput({ id: 'PURCHASE-INVOICE-NUMBER-LOCAL', supplierInvoiceNumber: 'SUP-INV-100' });
    await purchaseWorkflow.validateInput(input as any);
    const result = await purchaseWorkflow.executeDomainSteps(input as any, context as any);

    expect(result.purchase.supplierInvoiceNumber).toBe('SUP-INV-100');
    await expect(db.invoices.get(result.refId)).resolves.toMatchObject({ supplierInvoiceNumber: 'SUP-INV-100' });
    await expect(db.purchases.get(result.refId)).resolves.toMatchObject({ supplierInvoiceNumber: 'SUP-INV-100' });
  });

  it('T2: rejects a new non-return purchase when the supplier invoice number is empty', async () => {
    await expect(
      purchaseWorkflow.validateInput(draftInput({ supplierInvoiceNumber: '   ' }) as any)
    ).rejects.toThrow('SUPPLIER_INVOICE_NUMBER_REQUIRED');
  });

  it('T2b: allows a missing supplier invoice number for a purchase return', async () => {
    await expect(
      purchaseWorkflow.validateInput(draftInput({ isReturn: true, supplierInvoiceNumber: '   ' }) as any)
    ).resolves.toBeUndefined();
  });

  it('T3: trims and uppercases the supplier invoice number before persistence', async () => {
    const input = draftInput({ id: 'PURCHASE-INVOICE-NUMBER-LOCAL', supplierInvoiceNumber: '  inv-ab-100  ' });
    await purchaseWorkflow.validateInput(input as any);
    const result = await purchaseWorkflow.executeDomainSteps(input as any, context as any);

    expect(input.supplierInvoiceNumber).toBe('INV-AB-100');
    expect(result.purchase.supplierInvoiceNumber).toBe('INV-AB-100');
    await expect(db.invoices.get(result.refId)).resolves.toMatchObject({ supplierInvoiceNumber: 'INV-AB-100' });
  });

  it('T4: rejects changing the internal invoice number of a POSTED purchase', async () => {
    await db.invoices.put({
      id: 'PURCHASE-POSTED-LOCKED',
      type: 'PURCHASE',
      tenantId: context.tenantId,
      branchId: context.branchId,
      invoiceNumber: 'PUR-ORIGINAL-100',
      document_status: 'POSTED',
      invoiceStatus: 'POSTED',
      totalAmount: 100
    } as any);

    const input = draftInput({
      id: 'PURCHASE-POSTED-LOCKED',
      isEdit: true,
      invoiceNumber: 'PUR-CHANGED-200'
    });

    await expect(
      purchaseWorkflow.validateBusinessRules(input as any, context as any)
    ).rejects.toThrow('POSTED_PURCHASE_INVOICE_NUMBER_IMMUTABLE');
  });

  it('T5: resolves the generated invoice number from the persisted invoice for the success dialog', () => {
    expect(
      getSavedPurchaseInvoiceNumber(
        { invoiceNumber: 'PURCH-GENERATED-100', invoice_number: '' },
        ''
      )
    ).toBe('PURCH-GENERATED-100');
  });

  it('T6: builds the audit detail with the actual persisted invoice number', () => {
    expect(getPurchaseAuditDetails('PURCH-GENERATED-100', false))
      .toContain('PURCH-GENERATED-100');
  });

  it('T7: sales and product workflows retain their existing operation identities', () => {
    expect(salesWorkflow.operationType).toBe('POST');
    expect(productApplicationWorkflow.operationType).toBe('PRODUCT_SAVE');
  });
});
