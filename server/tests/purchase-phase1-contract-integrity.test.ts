import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '@/core/db';
import { UnifiedBusinessWorkflowOrchestrator } from '@/services/orchestration/UnifiedBusinessWorkflowOrchestrator';
import { useAccountingStore } from '@/store/accountingStore';
import { useAuthStore } from '@/store/authStore';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';
import { configurationService } from '@/services/config/configurationService';

describe('PURCHASE PHASE 1 — Contract, Identity & Financial Integrity', () => {
  const tenant1 = 'TENANT-PHASE1-A';
  const tenant2 = 'TENANT-PHASE1-B';
  const branchId = 'BRH-PHASE1-01';
  const supplierId = 'SUP-PHASE1-01';
  const supplier2Id = 'SUP-PHASE1-02';
  const productId = 'PROD-PHASE1-01';
  const warehouseId = 'WH-MAIN';

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
    useAuthStore.setState({
      user: userObj as any,
      tenantId: tId,
      branchId: bId,
      isAuthenticated: true
    });
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
    await db.warehouseStock.clear();
    await db.branchInventory.clear();
    await db.inventoryTransactions.clear();
    await db.financialTransactions.clear();
    await db.journalEntries.clear();
    await db.journalLines.clear();
    await db.accounts.clear();
    await db.branches.clear();
    await db.idempotencyKeys.clear();
    IdempotencyRegistry.clearInMemory();
    delete (globalThis as any).__FAIL_AT_STAGE__;

    // Seed each tenant's fixtures only while that tenant is the active session.
    await db.branches.bulkPut([
      { id: branchId, code: branchId, name: 'Main Branch', tenantId: tenant1, isActive: true },
      { id: 'WH-MAIN', code: 'WH-MAIN', name: 'Main Warehouse', tenantId: tenant1, isActive: true }
    ] as any);
    await db.suppliers.put({
      id: supplierId, Supplier_Name: 'Supplier Phase1', balance: 0,
      tenantId: tenant1, branchId, is_active: true
    } as any);
    await db.products.put({
      id: productId, name: 'Med A', stock: 100, price: 50, costPrice: 40,
      tenantId: tenant1, is_active: true
    } as any);
    await db.warehouseStock.put({
      id: `${warehouseId}-${productId}`, warehouseId, productId,
      quantity: 100, tenantId: tenant1
    } as any);
    await db.accounts.bulkPut([
      { id: 'ACC-101', code: '101', name: 'Cash', type: 'Asset', tenantId: tenant1, branchId, balance: 10000 },
      { id: 'ACC-102', code: '102', name: 'Inventory', type: 'Asset', tenantId: tenant1, branchId, balance: 4000 },
      { id: 'ACC-201', code: '201', name: 'Payables', type: 'Liability', tenantId: tenant1, branchId, balance: 0 }
    ] as any);

    setupUserSession(tenant2, 'BRH-PHASE1-02');
    await db.branches.bulkPut([
      { id: 'BRH-PHASE1-02', code: 'BRH-PHASE1-02', name: 'Branch 2', tenantId: tenant2, isActive: true },
      { id: 'WH-MAIN-T2', code: 'WH-MAIN-T2', name: 'Warehouse T2', tenantId: tenant2, isActive: true }
    ] as any);
    await db.suppliers.put({
      id: supplier2Id, Supplier_Name: 'Supplier Tenant2', balance: 0,
      tenantId: tenant2, branchId: 'BRH-PHASE1-02', is_active: true
    } as any);
    await db.products.put({
      id: 'PROD-PHASE1-T2', name: 'Med T2', stock: 100, price: 50, costPrice: 40,
      tenantId: tenant2, is_active: true
    } as any);
    await db.warehouseStock.put({
      id: 'WH-MAIN-T2-PROD-PHASE1-T2', warehouseId: 'WH-MAIN-T2',
      productId: 'PROD-PHASE1-T2', quantity: 100, tenantId: tenant2
    } as any);
    await db.accounts.bulkPut([
      { id: 'ACC-101-T2', code: '101', name: 'Cash', type: 'Asset', tenantId: tenant2, branchId: 'BRH-PHASE1-02', balance: 10000 },
      { id: 'ACC-102-T2', code: '102', name: 'Inventory', type: 'Asset', tenantId: tenant2, branchId: 'BRH-PHASE1-02', balance: 4000 },
      { id: 'ACC-201-T2', code: '201', name: 'Payables', type: 'Liability', tenantId: tenant2, branchId: 'BRH-PHASE1-02', balance: 0 }
    ] as any);

    setupUserSession(tenant1, branchId);
    vi.spyOn(configurationService, 'getSync').mockImplementation((key: string) => {
      const suffix = TokenProvider.getCurrentSession().tenantId === tenant2 ? '-T2' : '';
      const accounts: Record<string, string> = {
        ACCOUNT_CASH: `ACC-101${suffix}`,
        ACCOUNT_INVENTORY: `ACC-102${suffix}`,
        ACCOUNT_PAYABLE: `ACC-201${suffix}`
      };
      return accounts[key] || null;
    });
  });

  // 1. The system number is generated; the supplier's document number is user-provided.
  it('1. Generates the internal purchase number and preserves the manual supplier number', async () => {
    const manualSupplierNumber = 'INV-PUR-2026-9901';
    const txUuid = 'TX-MANUAL-001';

    const result = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 10, unitPrice: 40 }],
        total: 400,
        supplierInvoiceNumber: manualSupplierNumber,
        transactionUuid: txUuid
      },
      options: { isCash: false }
    })) as { success: boolean; refId: string };

    expect(result.success).toBe(true);

    const invoice = await db.invoices.get(result.refId);
    expect(invoice).toBeDefined();
    expect(invoice?.invoiceNumber).toBe('PUR-1');
    expect(invoice?.invoice_number).toBe('PUR-1');
    expect(invoice?.supplierInvoiceNumber).toBe(manualSupplierNumber);
  });

  // 2. Internal record ID, system invoice number, and supplier number are distinct fields.
  it('2. Keeps the internal ID separate from the generated system and supplier numbers', async () => {
    const manualSupplierNumber = 'INV-MANUAL-7788';
    const txUuid = 'TX-IDENTITY-002';

    const result = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 5, unitPrice: 40 }],
        total: 200,
        supplierInvoiceNumber: manualSupplierNumber,
        transactionUuid: txUuid
      },
      options: { isCash: false }
    })) as { success: boolean; refId: string };

    const invoice = await db.invoices.get(result.refId);
    expect(invoice).toBeDefined();
    expect(invoice?.id).toBe(result.refId);
    expect(invoice?.id).not.toBe(invoice?.invoiceNumber);
    expect(invoice?.invoiceNumber).toBe('PUR-1');
    expect(invoice?.supplierInvoiceNumber).toBe(manualSupplierNumber);
  });

  // 3. Internal purchase numbers are generated sequentially within the active tenant.
  it('3. Generates distinct internal invoice numbers for consecutive purchases in one tenant', async () => {
    const first = await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 2, unitPrice: 40 }],
        total: 80,
        transactionUuid: 'TX-NUMBER-001'
      },
      options: { isCash: false }
    }) as { success: boolean; refId: string };

    const second = await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 3, unitPrice: 40 }],
        total: 120,
        transactionUuid: 'TX-NUMBER-002'
      },
      options: { isCash: false }
    }) as { success: boolean; refId: string };

    const firstInvoice = await db.invoices.get(first.refId);
    const secondInvoice = await db.invoices.get(second.refId);
    expect(firstInvoice?.invoiceNumber).toBe('PUR-1');
    expect(secondInvoice?.invoiceNumber).toBe('PUR-2');
    expect(firstInvoice?.invoiceNumber).not.toBe(secondInvoice?.invoiceNumber);
  });

  // 4. Supplier document numbers remain tenant-local and may coincide across tenants.
  it('4. Allows the same supplier invoice number in different tenants', async () => {
    const sharedSupplierNumber = 'SUPPLIER-INV-SHARED-001';

    setupUserSession(tenant1, branchId);
    const res1 = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 2, unitPrice: 40 }],
        total: 80,
        supplierInvoiceNumber: sharedSupplierNumber,
        transactionUuid: 'TX-SHARED-T1'
      },
      options: { isCash: false }
    })) as { success: boolean; refId: string };
    expect(res1.success).toBe(true);

    setupUserSession(tenant2, 'BRH-PHASE1-02');
    const res2 = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId: supplier2Id,
        items: [{ productId: 'PROD-PHASE1-T2', quantity: 2, unitPrice: 40 }],
        total: 80,
        supplierInvoiceNumber: sharedSupplierNumber,
        warehouseId: 'WH-MAIN-T2',
        transactionUuid: 'TX-SHARED-T2'
      },
      options: { isCash: false, warehouseId: 'WH-MAIN-T2' }
    })) as { success: boolean; refId: string };
    expect(res2.success).toBe(true);

    setupUserSession(tenant1, branchId);
    expect((await db.invoices.get(res1.refId))?.supplierInvoiceNumber).toBe(sharedSupplierNumber);
    setupUserSession(tenant2, 'BRH-PHASE1-02');
    expect((await db.invoices.get(res2.refId))?.supplierInvoiceNumber).toBe(sharedSupplierNumber);
  });

  // 5. Edits preserve both the system number and supplier number when omitted.
  it('5. Edit preserves both purchase numbers when supplierInvoiceNumber is omitted', async () => {
    setupUserSession(tenant1, branchId);
    const originalSupplierNumber = 'INV-ORIGINAL-TO-PRESERVE';

    const createRes = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 2, unitPrice: 40 }],
        total: 80,
        supplierInvoiceNumber: originalSupplierNumber,
        transactionUuid: 'TX-EDIT-ORIG'
      },
      options: { isCash: false }
    })) as { success: boolean; refId: string };

    const internalId = createRes.refId;
    const original = await db.invoices.get(internalId);
    expect(original?.invoiceNumber).toBe('PUR-1');
    expect(original?.supplierInvoiceNumber).toBe(originalSupplierNumber);

    const editRes = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        id: internalId,
        supplierId,
        items: [{ productId, quantity: 4, unitPrice: 40 }],
        total: 160,
        transactionUuid: 'TX-EDIT-UPDATE'
      },
      options: { isEdit: true, isCash: false }
    })) as { success: boolean; refId: string };

    expect(editRes.success).toBe(true);

    const updated = await db.invoices.get(internalId);
    expect(updated?.id).toBe(internalId);
    expect(updated?.invoiceNumber).toBe('PUR-1');
    expect(updated?.supplierInvoiceNumber).toBe(originalSupplierNumber);
  });

  // 6 & 7. discount + fees + tax تصل حتى workflow والقيم المحفوظة تطابق العملية
  it('6 & 7. Financial adjustments (discountPercent, otherFees, tax) reach workflow and persist accurately', async () => {
    setupUserSession(tenant1, branchId);

    // 10 items @ 50 = 500 subtotal
    // 10% discount = 50
    // otherFees = 25
    // tax = 35
    // finalTotal = 500 - 50 + 25 + 35 = 510
    const subtotal = 500;
    const discountPercent = 10;
    const otherFees = 25;
    const tax = 35;
    const finalTotal = 510;

    const result = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 10, unitPrice: 50 }],
        total: finalTotal,
        discountPercent,
        otherFees,
        tax,
        transactionUuid: 'TX-FIN-007'
      },
      options: { isCash: false }
    })) as { success: boolean; refId: string };

    expect(result.success).toBe(true);

    const saved = await db.invoices.get(result.refId);
    expect(saved).toBeDefined();
    expect(saved?.subtotal).toBe(subtotal);
    expect(saved?.discountPercent).toBe(discountPercent);
    expect(saved?.discount).toBe(50);
    expect(saved?.otherFees).toBe(otherFees);
    expect(saved?.tax).toBe(tax);
    expect(saved?.finalTotal).toBe(finalTotal);
    expect(saved?.totalAmount).toBe(finalTotal);
  });

  // 8. manual product rollback عند فشل العملية
  it('8. Rolls back manual product creation atomically if transaction fails', async () => {
    setupUserSession(tenant1, branchId);
    const manualProdId = 'PROD-MANUAL-FAIL-TEST';

    (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_PURCHASE_DOC';

    await expect(
      useAccountingStore.getState().addInvoice({
        type: 'PURCHASE',
        payload: {
          supplierId,
          items: [{ productId: manualProdId, quantity: 2, unitPrice: 100 }],
          total: 200,
          pendingProducts: [
            { id: manualProdId, name: 'Orphan Candidate', UnitPrice: 100 }
          ],
          transactionUuid: 'TX-FAIL-ROLLBACK'
        },
        options: { isCash: false }
      })
    ).rejects.toThrow('SIMULATED_PURCHASE_DOC_FAILURE');

    delete (globalThis as any).__FAIL_AT_STAGE__;

    // Verify atomic rollback: no orphan product created!
    const product = await db.products.get(manualProdId);
    expect(product).toBeUndefined();

    // Verify no invoice committed
    const invoices = await db.invoices.where('transactionUuid').equals('TX-FAIL-ROLLBACK').toArray();
    expect(invoices.length).toBe(0);
  });

  // 9. retry بنفس idempotency key لا ينشئ invoice/product/mutation ثانية
  it('9. Replaying with same idempotency key is idempotent and creates no duplicate records', async () => {
    setupUserSession(tenant1, branchId);
    const stableKey = 'TX-IDEMPOTENT-STABLE-009';

    const payload = {
      supplierId,
      items: [{ productId, quantity: 2, unitPrice: 40 }],
      total: 80,
      transactionUuid: stableKey
    };

    // First attempt
    const res1 = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload,
      options: { isCash: false }
    })) as { success: boolean; refId: string };
    expect(res1.success).toBe(true);

    const initialInvoicesCount = await db.invoices.count();
    const initialMutationsCount = await db.inventoryTransactions.count();

    // Retry attempt with identical idempotency key and payload
    const res2 = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload,
      options: { isCash: false }
    })) as { success: boolean; refId: string };
    expect(res2.success).toBe(true);
    expect(res2.refId).toBe(res1.refId);

    // Verify count did not increase
    const postInvoicesCount = await db.invoices.count();
    const postMutationsCount = await db.inventoryTransactions.count();
    expect(postInvoicesCount).toBe(initialInvoicesCount);
    expect(postMutationsCount).toBe(initialMutationsCount);
  });

  // 10. payload mismatch بنفس idempotency key يتم رفضه
  it('10. Rejects execution if same idempotency key is submitted with a mismatched payload', async () => {
    setupUserSession(tenant1, branchId);
    const stableKey = 'TX-IDEMPOTENT-MISMATCH-010';

    // First call with payload A
    const res1 = (await useAccountingStore.getState().addInvoice({
      type: 'PURCHASE',
      payload: {
        supplierId,
        items: [{ productId, quantity: 2, unitPrice: 40 }],
        total: 80,
        transactionUuid: stableKey
      },
      options: { isCash: false }
    })) as { success: boolean };
    expect(res1.success).toBe(true);

    // Second call with different payload (total: 1000 instead of 80)
    await expect(
      useAccountingStore.getState().addInvoice({
        type: 'PURCHASE',
        payload: {
          supplierId,
          items: [{ productId, quantity: 25, unitPrice: 40 }],
          total: 1000,
          transactionUuid: stableKey
        },
        options: { isCash: false }
      })
    ).rejects.toThrow(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
  });
});
