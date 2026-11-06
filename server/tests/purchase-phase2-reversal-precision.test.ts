import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '@/core/db';
import { useAccountingStore } from '@/store/accountingStore';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';
import { configurationService } from '@/services/config/configurationService';

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

    // 🚨 SECURITY SETUP: Must set session BEFORE clearing tables to satisfy Dexie guards
    setupUserSession(tenant1, branchId);

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

  it('H: Triple Edit Chain generates exactly 7 records (1 Orig + 3 Rev + 3 New)', async () => {
    const res = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: { supplierId, items: [{ productId, quantity: 10, unitPrice: 10 }], total: 100, transactionUuid: 'TX-H-ORIG' }
    })) as { refId: string };
    const invoiceId = res.refId;

    // 3 Edits
    for (let i = 1; i <= 3; i++) {
      await useAccountingStore.getState().addInvoice({
        type: 'PURCHASE',
        payload: { id: invoiceId, supplierId, items: [{ productId, quantity: 10 * (i + 1), unitPrice: 10 }], total: 100 * (i + 1), transactionUuid: `TX-H-EDIT-${i}` },
        options: { isEdit: true }
      });
    }

    const entries = await db.journalEntries.where('sourceId').equals(invoiceId).toArray();
    const fts = await db.financialTransactions.where('Reference_ID').equals(invoiceId).toArray();

    // 1 Original + 3 Reversals + 3 New Versions = 7
    expect(entries.length).toBe(7);
    expect(fts.length).toBe(7);

    // Verify Net Accounting Effect: (100) + (-100 + 200) + (-200 + 300) + (-300 + 400) = 400
    const invAcc = await db.accounts.get('ACC-102');
    expect(invAcc?.balance).toBe(400);

    // Verify net Supplier Balance
    const supplier = await db.suppliers.get(supplierId);
    expect(supplier?.balance).toBe(400);

    // Check for orphaned reversals
    const entriesWithRevOf = entries.filter(e => (e as any).reversalOf);
    expect(entriesWithRevOf.length).toBe(3);
    for (const rev of entriesWithRevOf) {
      const orig = entries.find(e => e.id === (rev as any).reversalOf);
      expect(orig).toBeDefined();
      expect((orig as any).reversedBy).toBe(rev.id);
    }
  });

  it('I: Tenant Isolation - Reversal does not affect other tenants', async () => {
    const tenant2 = 'TENANT-OTHER';
    const supplierIdT2 = 'SUP-02';
    const productIdT2 = 'PROD-02';
    const branchIdT2 = 'BRH-02';

    setupUserSession(tenant2, branchIdT2);
    await db.branches.put({ id: branchIdT2, code: branchIdT2, name: 'Main Branch T2', tenantId: tenant2, isActive: true } as any);
    await db.suppliers.put({ id: supplierIdT2, Supplier_Name: 'Supplier 2', balance: 0, tenantId: tenant2, branchId: branchIdT2, is_active: true } as any);
    await db.products.put({ id: productIdT2, name: 'Med B', stock: 1000, price: 50, costPrice: 40, tenantId: tenant2, is_active: true } as any);
    await db.accounts.bulkPut([
      { id: 'ACC-101', code: '101', name: 'Cash', type: 'Asset', tenantId: tenant2, branchId: branchIdT2, balance: 100000 },
      { id: 'ACC-102', code: '102', name: 'Inventory', type: 'Asset', tenantId: tenant2, branchId: branchIdT2, balance: 0 },
      { id: 'ACC-201', code: '201', name: 'Payables', type: 'Liability', tenantId: tenant2, branchId: branchIdT2, balance: 0 }
    ] as any);

    // 1. Purchase in Tenant 2
    const res2 = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: { supplierId: supplierIdT2, items: [{ productId: productIdT2, quantity: 50, unitPrice: 10 }], total: 500, transactionUuid: 'TX-I-T2-ORIG' }
    })) as { refId: string };
    const invoiceIdT2 = res2.refId;

    // 2. Switch back to Tenant 1 (Tenant 1 setup already handled in beforeEach)
    setupUserSession(tenant1, branchId);
    const res1 = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: { supplierId, items: [{ productId, quantity: 10, unitPrice: 10 }], total: 100, transactionUuid: 'TX-I-T1-ORIG' }
    })) as { refId: string };
    const invoiceIdT1 = res1.refId;

    // 3. Edit Tenant 1 Purchase
    await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: { id: invoiceIdT1, supplierId, items: [{ productId, quantity: 20, unitPrice: 10 }], total: 200, transactionUuid: 'TX-I-T1-EDIT' },
      options: { isEdit: true }
    });

    // 4. Verify Tenant 2 is untouched
    setupUserSession(tenant2, branchIdT2);
    const entriesT2 = await db.journalEntries.where('sourceId').equals(invoiceIdT2).toArray();
    expect(entriesT2.length).toBe(1);
    expect((entriesT2[0] as any).reversedBy).toBeUndefined();

    const ftsT2 = await db.financialTransactions.where('Reference_ID').equals(invoiceIdT2).toArray();
    expect(ftsT2.length).toBe(1);
    expect(ftsT2[0].isDeleted).toBeFalsy();
  });

  it('J: Multi-Stage Failure Rollback Verification', async () => {
    const res = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: { supplierId, items: [{ productId, quantity: 10, unitPrice: 10 }], total: 100, transactionUuid: 'TX-J-ORIG' }
    })) as { refId: string };
    const invoiceId = res.refId;

    const stages = ['AFTER_PURCHASE_DOC', 'AFTER_INVENTORY', 'AFTER_SUPPLIER_BALANCE', 'AFTER_FT', 'AFTER_JOURNAL'];

    for (const stage of stages) {
      (globalThis as any).__FAIL_AT_STAGE__ = stage;
      const failUuid = `TX-J-FAIL-${stage}`;

      await expect(
        useAccountingStore.getState().addInvoice({
          type: 'PURCHASE',
          payload: { id: invoiceId, supplierId, items: [{ productId, quantity: 20, unitPrice: 10 }], total: 200, transactionUuid: failUuid },
          options: { isEdit: true }
        })
      ).rejects.toThrow();

      // Verify rollback: state must match res state (Total 100, 1 entry, 1 FT)
      const supplier = await db.suppliers.get(supplierId);
      expect(supplier?.balance).toBe(100, `Balance failed to rollback at stage ${stage}`);

      const entries = await db.journalEntries.where('sourceId').equals(invoiceId).toArray();
      expect(entries.length).toBe(1, `JournalEntries failed to rollback at stage ${stage}`);
      expect((entries[0] as any).reversedBy).toBeUndefined();

      const fts = await db.financialTransactions.where('Reference_ID').equals(invoiceId).toArray();
      expect(fts.length).toBe(1, `FinancialTransactions failed to rollback at stage ${stage}`);
      expect(fts[0].isDeleted).toBeFalsy();

      delete (globalThis as any).__FAIL_AT_STAGE__;
    }
  });

  it('K: Branch Isolation - Reversal does not affect other branches in same tenant', async () => {
    const branchA = 'BRH-A';
    const branchB = 'BRH-B';
    const sharedSupplier = 'SUP-SHARED';
    const sharedProduct = 'PROD-SHARED';

    // 1. Setup Branches
    await db.branches.bulkPut([
      { id: branchA, code: branchA, name: 'Branch A', tenantId: tenant1, isActive: true },
      { id: branchB, code: branchB, name: 'Branch B', tenantId: tenant1, isActive: true }
    ] as any);

    await db.suppliers.put({ id: sharedSupplier, Supplier_Name: 'Shared Supplier', balance: 0, tenantId: tenant1, is_active: true } as any);
    await db.products.put({ id: sharedProduct, name: 'Shared Med', stock: 1000, price: 50, costPrice: 40, tenantId: tenant1, is_active: true } as any);

    // 2. Setup Accounts for both branches
    await db.accounts.bulkPut([
      { id: 'ACC-A-102', code: '102-A', name: 'Inventory A', type: 'Asset', tenantId: tenant1, branchId: branchA, balance: 0 },
      { id: 'ACC-B-102', code: '102-B', name: 'Inventory B', type: 'Asset', tenantId: tenant1, branchId: branchB, balance: 0 }
    ] as any);

    // 3. Purchase in Branch B
    setupUserSession(tenant1, branchB);
    // Custom accounting setting for Branch B
    vi.spyOn(configurationService, 'getSync').mockImplementation((key: string) => {
      if (key === 'ACCOUNT_INVENTORY') return 'ACC-B-102';
      return null;
    });

    const resB = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: { supplierId: sharedSupplier, items: [{ productId: sharedProduct, quantity: 50, unitPrice: 10 }], total: 500, transactionUuid: 'TX-K-B-ORIG' }
    })) as { refId: string };
    const invoiceIdB = resB.refId;

    // 4. Purchase in Branch A (same invoice ID if manually set, or different)
    setupUserSession(tenant1, branchA);
    vi.spyOn(configurationService, 'getSync').mockImplementation((key: string) => {
      if (key === 'ACCOUNT_INVENTORY') return 'ACC-A-102';
      return null;
    });

    const resA = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: { supplierId: sharedSupplier, items: [{ productId: sharedProduct, quantity: 10, unitPrice: 10 }], total: 100, transactionUuid: 'TX-K-A-ORIG' }
    })) as { refId: string };
    const invoiceIdA = resA.refId;

    // 5. Edit Branch A Purchase
    await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: { id: invoiceIdA, supplierId: sharedSupplier, items: [{ productId: sharedProduct, quantity: 20, unitPrice: 10 }], total: 200, transactionUuid: 'TX-K-A-EDIT' },
      options: { isEdit: true }
    });

    // 6. Verify Branch B is untouched
    const entriesB = await db.journalEntries.where('sourceId').equals(invoiceIdB).toArray();
    expect(entriesB.length).toBe(1);
    expect((entriesB[0] as any).reversedBy).toBeUndefined();

    const ftsB = await db.financialTransactions.where('Reference_ID').equals(invoiceIdB).toArray();
    expect(ftsB.length).toBe(1);
    expect(ftsB[0].isDeleted).toBeFalsy();

    // 7. Verify Branch A has reversals
    const entriesA = await db.journalEntries.where('sourceId').equals(invoiceIdA).toArray();
    expect(entriesA.length).toBe(3); // Orig + Rev + New
    expect(entriesA.find(e => e.sourceType === 'AUTO_REVERSAL')).toBeDefined();

    const ftsA = await db.financialTransactions.where('Reference_ID').equals(invoiceIdA).toArray();
    expect(ftsA.length).toBe(3);
    expect(ftsA.find(f => (f as any).isReversal)).toBeDefined();
    
    vi.restoreAllMocks();
  });
});
