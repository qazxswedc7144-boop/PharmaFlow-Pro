import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '@/core/db';
import { useAccountingStore } from '@/store/accountingStore';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';

describe('PURCHASE PHASE 2 — Accounting Reversal & Financial Transaction Integrity', () => {
  const tenant1 = 'TENANT-PHASE2-A';
  const branchId = 'BRH-PHASE2-01';
  const supplierId = 'SUP-PHASE2-01';
  const productId = 'PROD-PHASE2-01';

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

    await db.branches.put({ id: branchId, code: branchId, name: 'Main Branch', tenantId: tenant1, isActive: true } as any);
    await db.suppliers.put({ id: supplierId, Supplier_Name: 'Supplier 1', balance: 0, tenantId: tenant1, branchId, is_active: true } as any);
    await db.products.put({ id: productId, name: 'Med A', stock: 100, price: 50, costPrice: 40, tenantId: tenant1, is_active: true } as any);
    
    await db.accounts.bulkPut([
      { id: 'ACC-101', code: '101', name: 'Cash', type: 'Asset', tenantId: tenant1, branchId, balance: 10000 },
      { id: 'ACC-102', code: '102', name: 'Inventory', type: 'Asset', tenantId: tenant1, branchId, balance: 4000 },
      { id: 'ACC-201', code: '201', name: 'Payables', type: 'Liability', tenantId: tenant1, branchId, balance: 0 }
    ] as any);

    setupUserSession(tenant1, branchId);
    delete (globalThis as any).__FAIL_AT_STAGE__;
  });

  it('1. Purchase Edit creates a compensating reversal and a new entry (Traceability)', async () => {
    // 1. Create original purchase
    const createRes = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 10, unitPrice: 40 }],
        total: 400,
        invoiceNumber: 'INV-PH2-01',
        transactionUuid: 'TX-PH2-01-ORIG'
      },
      options: { isCash: false }
    })) as { success: boolean; refId: string };

    const internalId = createRes.refId;

    // 2. Edit the purchase
    const editRes = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        id: internalId,
        supplierId,
        items: [{ productId, quantity: 20, unitPrice: 40 }],
        total: 800,
        invoiceNumber: 'INV-PH2-01',
        transactionUuid: 'TX-PH2-01-EDIT'
      },
      options: { isEdit: true, isCash: false }
    })) as { success: boolean };

    expect(editRes.success).toBe(true);

    // 3. Verify Journal Entries
    const entries = await db.journalEntries.where('sourceId').equals(internalId).toArray();
    
    // Should have: Original (JE) + Reversal (REV) + New (JE)
    expect(entries.length).toBe(3);
    
    const original = entries.find(e => !e.id.includes('REV') && !e.id.includes('TX-PH2-01-EDIT'));
    const reversal = entries.find(e => e.sourceType === 'AUTO_REVERSAL');
    const newEntry = entries.find(e => e.id.includes('TX-PH2-01-EDIT'));

    expect(original).toBeDefined();
    expect(reversal).toBeDefined();
    expect(newEntry).toBeDefined();

    expect(reversal?.TotalAmount).toBe(original?.TotalAmount);
    expect(newEntry?.TotalAmount).toBe(800);
  });

  it('2. Reversal and New entries are balanced (Double Entry)', async () => {
    const createRes = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 5, unitPrice: 50 }],
        total: 250,
        transactionUuid: 'TX-PH2-02-ORIG'
      }
    })) as { success: boolean; refId: string };

    await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        id: createRes.refId,
        supplierId,
        items: [{ productId, quantity: 10, unitPrice: 50 }],
        total: 500,
        transactionUuid: 'TX-PH2-02-EDIT'
      },
      options: { isEdit: true }
    });

    const entries = await db.journalEntries.where('sourceId').equals(createRes.refId).toArray();
    for (const entry of entries) {
      const debit = entry.lines.reduce((sum, l) => sum + l.debit, 0);
      const credit = entry.lines.reduce((sum, l) => sum + l.credit, 0);
      expect(debit).toBe(credit);
      expect(debit).toBeGreaterThan(0);
    }
  });

  it('3. Financial Transactions are reversed non-destructively', async () => {
    const createRes = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 10, unitPrice: 10 }],
        total: 100,
        transactionUuid: 'TX-PH2-03-ORIG'
      }
    })) as { success: boolean; refId: string };

    await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        id: createRes.refId,
        supplierId,
        items: [{ productId, quantity: 20, unitPrice: 10 }],
        total: 200,
        transactionUuid: 'TX-PH2-03-EDIT'
      },
      options: { isEdit: true }
    });

    const transactions = await db.financialTransactions.where('Reference_ID').equals(createRes.refId).toArray();
    
    // Should have: Original (Deleted/Reversed) + Reversal + New
    expect(transactions.length).toBe(3);
    
    const original = transactions.find(t => !t.id.includes('REV') && !t.id.includes('TX-PH2-03-EDIT'));
    const reversal = transactions.find(t => (t as any).isReversal);
    const newTx = transactions.find(t => t.id.includes('TX-PH2-03-EDIT'));

    expect(original?.isDeleted).toBe(true);
    expect(reversal?.Direction).not.toBe(original?.Direction);
    expect(reversal?.Amount).toBe(original?.Amount);
    expect(newTx?.Amount).toBe(200);
  });

  it('4. Retrying Purchase Edit is idempotent (Retry Idempotency)', async () => {
    const createRes = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 1, unitPrice: 100 }],
        total: 100,
        transactionUuid: 'TX-PH2-04-ORIG'
      }
    })) as { success: boolean; refId: string };

    const editPayload = {
      id: createRes.refId,
      supplierId,
      items: [{ productId, quantity: 2, unitPrice: 100 }],
      total: 200,
      transactionUuid: 'TX-PH2-04-EDIT'
    };

    // First attempt
    await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: editPayload,
      options: { isEdit: true }
    });

    const entriesCount = await db.journalEntries.count();
    const ftCount = await db.financialTransactions.count();
    const supplier = await db.suppliers.get(supplierId);
    const initialBalance = supplier?.balance;

    // Retry with same payload and key
    await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: editPayload,
      options: { isEdit: true }
    });

    expect(await db.journalEntries.count()).toBe(entriesCount);
    expect(await db.financialTransactions.count()).toBe(ftCount);
    
    const supplierPostRetry = await db.suppliers.get(supplierId);
    expect(supplierPostRetry?.balance).toBe(initialBalance);
  });

  it('5. Failure during new state application rolls back everything (Rollback Safety)', async () => {
    const createRes = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 10, unitPrice: 10 }],
        total: 100,
        transactionUuid: 'TX-PH2-05-ORIG'
      }
    })) as { success: boolean; refId: string };

    const initialSupplier = await db.suppliers.get(supplierId);
    const initialBalance = initialSupplier?.balance; // 100

    // Inject failure at Journal Entry stage
    (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_FT';

    await expect(
      useAccountingStore.getState().addInvoice({
        type: 'PURCHASE',
        payload: {
          id: createRes.refId,
          supplierId,
          items: [{ productId, quantity: 30, unitPrice: 10 }],
          total: 300,
          transactionUuid: 'TX-PH2-05-FAIL'
        },
        options: { isEdit: true }
      })
    ).rejects.toThrow('SIMULATED_FT_FAILURE');

    delete (globalThis as any).__FAIL_AT_STAGE__;

    // Verify system state is as before the failed edit
    const supplierPostFail = await db.suppliers.get(supplierId);
    expect(supplierPostFail?.balance).toBe(initialBalance);

    const entries = await db.journalEntries.where('sourceId').equals(createRes.refId).toArray();
    // Should only have the original entry
    expect(entries.length).toBe(1);

    const fts = await db.financialTransactions.where('Reference_ID').equals(createRes.refId).toArray();
    // Should only have the original FT, and it should NOT be deleted
    expect(fts.length).toBe(1);
    expect(fts[0].isDeleted).toBeFalsy();
  });
});
