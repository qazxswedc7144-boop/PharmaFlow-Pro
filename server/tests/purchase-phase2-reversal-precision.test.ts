import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '@/core/db';
import { useAccountingStore } from '@/store/accountingStore';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';

describe('PURCHASE PHASE 2 — Reversal Precision & Financial Integrity', () => {
  const tenant1 = 'TENANT-PRECISION';
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

    await db.branches.put({ id: branchId, code: branchId, name: 'Main Branch', tenantId: tenant1, isActive: true } as any);
    await db.suppliers.put({ id: supplierId, Supplier_Name: 'Supplier 1', balance: 0, tenantId: tenant1, branchId, is_active: true } as any);
    await db.products.put({ id: productId, name: 'Med A', stock: 1000, price: 50, costPrice: 40, tenantId: tenant1, is_active: true } as any);
    
    await db.accounts.bulkPut([
      { id: 'ACC-101', code: '101', name: 'Cash', type: 'Asset', tenantId: tenant1, branchId, balance: 100000 },
      { id: 'ACC-102', code: '102', name: 'Inventory', type: 'Asset', tenantId: tenant1, branchId, balance: 0 },
      { id: 'ACC-201', code: '201', name: 'Payables', type: 'Liability', tenantId: tenant1, branchId, balance: 0 }
    ] as any);

    setupUserSession(tenant1, branchId);
    delete (globalThis as any).__FAIL_AT_STAGE__;
  });

  it('A & B & C & E: Sequential Edits maintain precise history and balances', async () => {
    // 1. Initial Purchase (100 qty @ 40 = 4000)
    const res1 = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 100, unitPrice: 40 }],
        total: 4000,
        transactionUuid: 'TX-P-ORIG'
      }
    })) as { refId: string };
    const invoiceId = res1.refId;

    // Verify balances after initial
    let supplier = await db.suppliers.get(supplierId);
    expect(supplier?.balance).toBe(4000);
    let invAcc = await db.accounts.get('ACC-102');
    expect(invAcc?.balance).toBe(4000);

    // 2. First Edit (200 qty @ 40 = 8000)
    await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        id: invoiceId,
        supplierId,
        items: [{ productId, quantity: 200, unitPrice: 40 }],
        total: 8000,
        transactionUuid: 'TX-P-EDIT-1'
      },
      options: { isEdit: true }
    });

    // Check Journal Entries: Orig + Rev-Orig + New-1
    let entries = await db.journalEntries.where('sourceId').equals(invoiceId).toArray();
    expect(entries.length).toBe(3);
    
    const origJE = entries.find(e => e.id.endsWith('TX-P-ORIG'));
    const revOrigJE = entries.find(e => e.sourceType === 'AUTO_REVERSAL' && (e as any).reversalOf === origJE?.id);
    const newJE1 = entries.find(e => e.id.includes('TX-P-EDIT-1'));
    
    expect(origJE).toBeDefined();
    expect(revOrigJE).toBeDefined();
    expect(newJE1).toBeDefined();
    expect((origJE as any).reversedBy).toBe(revOrigJE?.id);

    // Verify balances after edit 1
    supplier = await db.suppliers.get(supplierId);
    expect(supplier?.balance).toBe(8000);
    invAcc = await db.accounts.get('ACC-102');
    expect(invAcc?.balance).toBe(8000);

    // 3. Second Edit (300 qty @ 40 = 12000)
    await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        id: invoiceId,
        supplierId,
        items: [{ productId, quantity: 300, unitPrice: 40 }],
        total: 12000,
        transactionUuid: 'TX-P-EDIT-2'
      },
      options: { isEdit: true }
    });

    // Check Journal Entries: Orig + Rev-Orig + New-1 + Rev-New-1 + New-2
    entries = await db.journalEntries.where('sourceId').equals(invoiceId).toArray();
    expect(entries.length).toBe(5);
    
    const freshNewJE1 = entries.find(e => e.id === newJE1?.id);
    const revNewJE1 = entries.find(e => e.sourceType === 'AUTO_REVERSAL' && (e as any).reversalOf === newJE1?.id);
    const newJE2 = entries.find(e => e.id.includes('TX-P-EDIT-2'));
    
    expect(revNewJE1).toBeDefined();
    expect(newJE2).toBeDefined();
    expect((freshNewJE1 as any).reversedBy).toBe(revNewJE1?.id);
    // CRITICAL: OrigJE should NOT have been reversed again!
    const origReversals = entries.filter(e => (e as any).reversalOf === origJE?.id);
    expect(origReversals.length).toBe(1);

    // Verify final balances
    supplier = await db.suppliers.get(supplierId);
    expect(supplier?.balance).toBe(12000);
    invAcc = await db.accounts.get('ACC-102');
    expect(invAcc?.balance).toBe(12000);
    
    // Check Double Entry balance for every JE
    for (const entry of entries) {
      const debit = entry.lines.reduce((sum, l) => sum + l.debit, 0);
      const credit = entry.lines.reduce((sum, l) => sum + l.credit, 0);
      expect(debit).toBe(credit);
    }
  });

  it('D: Retry same Edit does not create duplicate entries', async () => {
    const res1 = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 10, unitPrice: 10 }],
        total: 100,
        transactionUuid: 'TX-R-ORIG'
      }
    })) as { refId: string };
    const invoiceId = res1.refId;

    const editPayload = {
      id: invoiceId,
      supplierId,
      items: [{ productId, quantity: 20, unitPrice: 10 }],
      total: 200,
      transactionUuid: 'TX-R-EDIT'
    };

    // First attempt
    await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: editPayload,
      options: { isEdit: true }
    });

    const entriesCount = await db.journalEntries.count();
    const ftCount = await db.financialTransactions.count();

    // Retry
    await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: editPayload,
      options: { isEdit: true }
    });

    expect(await db.journalEntries.count()).toBe(entriesCount);
    expect(await db.financialTransactions.count()).toBe(ftCount);
  });

  it('F: Rollback safety during multi-step Edit', async () => {
    const res1 = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 50, unitPrice: 10 }],
        total: 500,
        transactionUuid: 'TX-F-ORIG'
      }
    })) as { refId: string };
    const invoiceId = res1.refId;

    // Failure after FT but before new Journal Entry
    (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_FT';

    await expect(
      useAccountingStore.getState().addInvoice({
        type: 'PURCHASE',
        payload: {
          id: invoiceId,
          supplierId,
          items: [{ productId, quantity: 100, unitPrice: 10 }],
          total: 1000,
          transactionUuid: 'TX-F-FAIL'
        },
        options: { isEdit: true }
      })
    ).rejects.toThrow('SIMULATED_FT_FAILURE');

    delete (globalThis as any).__FAIL_AT_STAGE__;

    // Verify state is completely restored to res1 state
    const supplier = await db.suppliers.get(supplierId);
    expect(supplier?.balance).toBe(500);

    const entries = await db.journalEntries.where('sourceId').equals(invoiceId).toArray();
    expect(entries.length).toBe(1);
    expect((entries[0] as any).reversedBy).toBeUndefined();

    const fts = await db.financialTransactions.where('Reference_ID').equals(invoiceId).toArray();
    expect(fts.length).toBe(1);
    expect(fts[0].isDeleted).toBeFalsy();
  });

  it('G: Sequential FinancialTransaction cycles', async () => {
    const res1 = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 10, unitPrice: 100 }],
        total: 1000, // Fixed: 10 * 100 = 1000
        transactionUuid: 'TX-FT-ORIG'
      }
    })) as { refId: string };
    const invoiceId = res1.refId;

    // Edit 1
    await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        id: invoiceId,
        supplierId,
        items: [{ productId, quantity: 20, unitPrice: 100 }],
        total: 2000,
        transactionUuid: 'TX-FT-EDIT-1'
      },
      options: { isEdit: true }
    });

    // Check FTs: Orig + Rev-Orig + New-1
    let fts = await db.financialTransactions.where('Reference_ID').equals(invoiceId).toArray();
    console.log('[Test] All FTs:', fts.map(f => ({ id: f.id, type: (f as any).Transaction_Type, isRev: (f as any).isReversal, revOf: (f as any).reversalOf, revBy: (f as any).reversedBy, del: f.isDeleted })));
    expect(fts.length).toBe(3);
    const origFT = fts.find(f => !f.id.includes('REV') && !f.id.includes('EDIT-1'));
    const revOrigFT = fts.find(f => (f as any).isReversal && (f as any).reversalOf === origFT?.id);
    const newFT1 = fts.find(f => f.id.includes('EDIT-1'));
    
    expect(origFT?.isDeleted).toBe(true);
    expect((origFT as any).reversedBy).toBe(revOrigFT?.id);
    expect(revOrigFT).toBeDefined();
    expect(newFT1).toBeDefined();

    // Edit 2
    await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        id: invoiceId,
        supplierId,
        items: [{ productId, quantity: 30, unitPrice: 100 }],
        total: 3000,
        transactionUuid: 'TX-FT-EDIT-2'
      },
      options: { isEdit: true }
    });

    fts = await db.financialTransactions.where('Reference_ID').equals(invoiceId).toArray();
    expect(fts.length).toBe(5);
    const freshNewFT1 = fts.find(f => f.id === newFT1?.id);
    const revNewFT1 = fts.find(f => (f as any).isReversal && (f as any).reversalOf === newFT1?.id);
    expect(revNewFT1).toBeDefined();
    expect(freshNewFT1?.isDeleted).toBe(true);
    expect((freshNewFT1 as any).reversedBy).toBe(revNewFT1?.id);
    
    // Ensure OrigFT was not reversed again
    const origReversals = fts.filter(f => (f as any).isReversal && (f as any).reversalOf === origFT?.id);
    expect(origReversals.length).toBe(1);
  });
});
