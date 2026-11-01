import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '@/core/db';
import { useAccountingStore } from '@/store/accountingStore';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';

describe('PURCHASE PHASE 1 — Financial Total Enforcement', () => {
  const tenant1 = 'TENANT-TOTAL-ENFORCE';
  const branchId = 'BRH-01';
  const supplierId = 'SUP-01';
  const productId = 'PROD-01';

  const setupUserSession = (tId: string = tenant1, bId: string = branchId) => {
    const userObj = {
      id: `usr-${tId}`,
      User_Email: `user@${tId}.test`,
      Role: 'SuperAdmin',
      tenantId: tId,
      branchId: bId,
      permissions: ['ALL']
    };
    TokenProvider.setSession(userObj as any, 'mock-jwt', 'mock-refresh');
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    if (!db.isOpen()) await db.open();

    await db.invoices.clear();
    await db.purchases.clear();
    await db.products.clear();
    await db.suppliers.clear();
    await db.financialTransactions.clear();
    await db.journalEntries.clear();
    await db.journalLines.clear();
    await db.accounts.clear();
    await db.branches.clear();
    await db.idempotency_records.clear();
    await db.idempotencyKeys.clear();
    IdempotencyRegistry.clearInMemory();

    // Seed branches for the tenant
    await db.branches.bulkPut([
      { id: branchId, code: branchId, name: 'Main Branch', tenantId: tenant1, isActive: true },
      { id: 'WH-MAIN', code: 'WH-MAIN', name: 'Main Warehouse', tenantId: tenant1, isActive: true }
    ] as any);

    await db.suppliers.put({ id: supplierId, Supplier_Name: 'Supplier 1', balance: 0, tenantId: tenant1, branchId, is_active: true } as any);
    await db.products.put({ id: productId, name: 'Med A', stock: 100, price: 50, costPrice: 40, tenantId: tenant1, is_active: true } as any);
    
    // Seed standard chart of accounts (required for accounting post)
    await db.accounts.bulkPut([
      { id: 'acc-cash', code: '101', name: 'Cash', type: 'Asset', tenantId: tenant1, branchId, balance: 10000 },
      { id: 'acc-inv', code: '102', name: 'Inventory', type: 'Asset', tenantId: tenant1, branchId, balance: 4000 },
      { id: 'acc-ap', code: '201', name: 'Payables', type: 'Liability', tenantId: tenant1, branchId, balance: 0 }
    ] as any);

    setupUserSession(tenant1, branchId);
  });

  // Test A: Subtotal mismatch with adjustments (declared = subtotal) -> Should fail.
  it('Test A: Rejects purchase if declared total equals subtotal but ignores adjustments', async () => {
    // subtotal = 500
    // discountPercent = 10 (50)
    // otherFees = 25
    // tax = 35
    // expected = 510
    // declared = 500 (WRONG)
    
    await expect(
      useAccountingStore.getState().addInvoice({
        type: 'PURCHASE',
        payload: {
          supplierId,
          items: [{ productId, quantity: 10, unitPrice: 50 }],
          total: 500, // Matching raw subtotal instead of adjusted total
          invoiceNumber: 'INV-TOTAL-A',
          discountPercent: 10,
          otherFees: 25,
          tax: 35,
          transactionUuid: 'TX-TOTAL-A'
        },
        options: { isCash: false }
      })
    ).rejects.toThrow(/Total mismatch/);
  });

  // Test B: Subtotal mismatch with adjustments (declared = adjusted) -> Should succeed.
  it('Test B: Accepts purchase if declared total matches adjusted total', async () => {
    const result = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 10, unitPrice: 50 }],
        total: 510, // Matching adjusted total
        invoiceNumber: 'INV-TOTAL-B',
        discountPercent: 10,
        otherFees: 25,
        tax: 35,
        transactionUuid: 'TX-TOTAL-B'
      },
      options: { isCash: false }
    })) as { success: boolean };

    expect(result.success).toBe(true);
  });

  // Test C: Verify saved fields match (subtotal, discount, fees, tax, finalTotal).
  it('Test C: Verifies saved invoice fields match the calculation', async () => {
    const result = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 10, unitPrice: 50 }],
        total: 510,
        invoiceNumber: 'INV-TOTAL-C',
        discountPercent: 10,
        otherFees: 25,
        tax: 35,
        transactionUuid: 'TX-TOTAL-C'
      },
      options: { isCash: false }
    })) as { success: boolean; refId: string };

    const saved = await db.invoices.get(result.refId);
    expect(saved?.subtotal).toBe(500);
    expect(saved?.discount).toBe(50);
    expect(saved?.otherFees).toBe(25);
    expect(saved?.tax).toBe(35);
    expect(saved?.finalTotal).toBe(510);
    expect(saved?.totalAmount).toBe(510);
  });

  // Test D: Verify Supplier Balance uses adjusted total.
  it('Test D: Verifies Supplier Balance is updated with the adjusted total', async () => {
    await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 10, unitPrice: 50 }],
        total: 510,
        invoiceNumber: 'INV-TOTAL-D',
        discountPercent: 10,
        otherFees: 25,
        tax: 35,
        transactionUuid: 'TX-TOTAL-D'
      },
      options: { isCash: false }
    });

    const supplier = await db.suppliers.get(supplierId);
    expect(supplier?.balance).toBe(510);
  });

  // Test E: Verify Financial Transaction uses adjusted total.
  it('Test E: Verifies Financial Transaction amount uses the adjusted total', async () => {
    const result = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 10, unitPrice: 50 }],
        total: 510,
        invoiceNumber: 'INV-TOTAL-E',
        discountPercent: 10,
        otherFees: 25,
        tax: 35,
        transactionUuid: 'TX-TOTAL-E'
      },
      options: { isCash: false }
    })) as { success: boolean; refId: string };

    const ft = await db.financialTransactions.where('Reference_ID').equals(result.refId).first();
    expect(ft?.Amount).toBe(510);
  });

  // Test F: Verify Edit re-applies correct total.
  it('Test F: Purchase Edit re-applies the correct total to supplier balance and FT', async () => {
    // 1. Initial creation (total 510)
    const createRes = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 10, unitPrice: 50 }],
        total: 510,
        invoiceNumber: 'INV-EDIT-F',
        discountPercent: 10,
        otherFees: 25,
        tax: 35,
        transactionUuid: 'TX-EDIT-F-1'
      },
      options: { isCash: false }
    })) as { success: boolean; refId: string };

    const internalId = createRes.refId;

    // 2. Edit with new adjustments
    // subtotal = 1000
    // discountPercent = 20 (200)
    // otherFees = 50
    // tax = 100
    // expected = 1000 - 200 + 50 + 100 = 950
    const editRes = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        id: internalId,
        supplierId,
        items: [{ productId, quantity: 20, unitPrice: 50 }],
        total: 950,
        invoiceNumber: 'INV-EDIT-F',
        discountPercent: 20,
        otherFees: 50,
        tax: 100,
        transactionUuid: 'TX-EDIT-F-2'
      },
      options: { isEdit: true, isCash: false }
    })) as { success: boolean };

    expect(editRes.success).toBe(true);

    const supplier = await db.suppliers.get(supplierId);
    // Initial 510 was reversed, then 950 added. Net should be 950.
    expect(supplier?.balance).toBe(950);

    const fts = await db.financialTransactions.where('Reference_ID').equals(internalId).toArray();
    // FT should reflect 950
    expect(fts.some(ft => ft.Amount === 950)).toBe(true);
    
    const saved = await db.invoices.get(internalId);
    expect(saved?.finalTotal).toBe(950);
  });
});
