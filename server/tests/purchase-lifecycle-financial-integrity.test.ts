import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/core/db';
import { UnifiedBusinessWorkflowOrchestrator } from '../../src/services/orchestration/UnifiedBusinessWorkflowOrchestrator';
import { PurchaseRepository } from '../../src/database/repositories/PurchaseRepository';
import { useAuthStore } from '@/store/authStore';
import { IdempotencyRegistry } from '../../src/core/integrity/idempotencyRegistry';
import { TokenProvider } from '@/services/auth/tokenProvider';

describe('Purchase Lifecycle Integrity Audit & Verification Suite', () => {
  const tenantId = 'TENANT-PUR-PROD-01';
  const branchId = 'BRH-PUR-MAIN-01';
  const supplierId = 'SUP-PUR-001';
  const productId = 'PROD-PUR-001';
  const warehouseId = 'WH-MAIN';

  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as any).__FAIL_AT_STAGE__ = undefined;
    IdempotencyRegistry.clearInMemory();

    // Clear tables
    await db.invoices.clear();
    await db.purchases.clear();
    await db.products.clear();
    await db.suppliers.clear();
    await db.warehouseStock.clear();
    await db.branchInventory.clear();
    await db.inventoryTransactions.clear();
    await db.inventory_layers.clear();
    await db.fifo_consumption_log.clear();
    await db.financialTransactions.clear();
    await db.journalEntries.clear();
    await db.journalLines.clear();
    await db.accounts.clear();
    await db.idempotencyRecords.clear();
    await db.idempotencyKeys.clear();
    await db.voucherInvoiceLinks.clear();
    await db.vouchers.clear();
    await db.auditLogs.clear();

    // Setup authenticated user
    const userObj = {
      id: 'usr-pur-auditor',
      user_id: 'usr-pur-auditor',
      User_Name: 'Purchase Auditor',
      User_Email: 'auditor@pharmaflow.test',
      Role: 'SuperAdmin',
      User_Role: 'SuperAdmin',
      tenantId,
      tenant_id: tenantId,
      branchId,
      branch_id: branchId,
      permissions: ['ALL', 'purchases.create', 'purchases.edit', 'accounting.voucher.create', 'vouchers.create']
    };

    TokenProvider.setSession(userObj as any, 'mock-jwt-pur-audit', 'mock-refresh-pur-audit');
    useAuthStore.setState({
      user: userObj as any,
      token: 'mock-jwt-pur-audit',
      tenantId,
      branchId,
      roles: ['SuperAdmin'],
      permissions: ['ALL', 'purchases.create', 'purchases.edit', 'accounting.voucher.create', 'vouchers.create'],
      isAuthenticated: true
    });

    // Seed Supplier with initial balance of 0
    await db.suppliers.put({
      id: supplierId,
      Supplier_Name: 'Al-Hekma Medical Suppliers',
      balance: 0,
      tenantId,
      branchId,
      is_active: true
    } as any);

    // Seed Product with initial stock of 10
    await db.products.put({
      id: productId,
      name: 'Amoxicillin 500mg',
      stock: 10,
      StockQuantity: 10,
      price: 15,
      costPrice: 10,
      tenantId,
      is_active: true
    } as any);

    // Seed Warehouse Stock for initial stock of 10
    await db.warehouseStock.put({
      id: `${warehouseId}-${productId}`,
      warehouseId,
      productId,
      quantity: 10,
      tenantId
    } as any);

    // Seed Chart of Accounts
    await db.accounts.bulkPut([
      { id: 'ACC-101', code: '1010', name: 'الصندوق الرئيسي', type: 'Asset', tenantId, branchId, balance: 100000 },
      { id: 'ACC-102', code: '1020', name: 'المخزون', type: 'Asset', tenantId, branchId, balance: 50000 },
      { id: 'ACC-104', code: '1040', name: 'البنك', type: 'Asset', tenantId, branchId, balance: 200000 },
      { id: 'ACC-201', code: '2010', name: 'الموردين - ذمم دائنة', type: 'Liability', tenantId, branchId, balance: 0 }
    ] as any);
  });

  // =========================================================================
  // 1. Purchase Invoice Integrity
  // =========================================================================
  describe('1. Purchase Invoice Integrity', () => {
    it('creates purchase invoice with accurate fields, prices, totals, paid and remaining amounts', async () => {
      const res = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
        supplierId,
        items: [
          {
            productId,
            quantity: 50,
            unitCost: 20,
            unitPrice: 20
          } as any
        ],
        total: 1000,
        notes: 'توريد دفعة تجريبية'
      });

      expect(res.success).toBe(true);
      expect(res.refId).toBeDefined();

      const inv = await db.invoices.get(res.refId);
      expect(inv).toBeDefined();
      expect(inv?.partnerId).toBe(supplierId);
      expect(inv?.type).toBe('PURCHASE');
      expect(inv?.totalAmount).toBe(1000);
      expect(inv?.finalTotal).toBe(1000);
      expect(inv?.paidAmount).toBe(0);
      expect(inv?.remainingAmount).toBe(1000);
      expect(inv?.paymentStatus).toBe('Credit');
      expect(inv?.tenantId).toBe(tenantId);
      expect(inv?.branchId).toBe(branchId);
      expect(inv?.items?.length).toBe(1);
      expect(inv?.items[0].productId).toBe(productId);
      expect(inv?.items[0].quantity).toBe(50);
    });

    it('cash purchase invoice sets paidAmount equal to total and remainingAmount to 0', async () => {
      const res = await UnifiedBusinessWorkflowOrchestrator.processPurchase(
        {
          supplierId,
          items: [{ productId, quantity: 20, unitCost: 15, unitPrice: 15 } as any],
          total: 300,
          notes: 'شراء نقدي'
        },
        { isCash: true }
      );

      expect(res.success).toBe(true);
      const inv = await db.invoices.get(res.refId);
      expect(inv?.paidAmount).toBe(300);
      expect(inv?.remainingAmount).toBe(0);
      expect(inv?.paymentStatus).toBe('Cash');
      expect(inv?.financialStatus).toBe('Paid');
    });
  });

  // =========================================================================
  // 2. Inventory Integrity
  // =========================================================================
  describe('2. Inventory Integrity', () => {
    it('increases product stock and warehouse stock by exact purchased quantity with canonical ledger record', async () => {
      const initialStock = 10;
      const purchasedQty = 40;

      await UnifiedBusinessWorkflowOrchestrator.processPurchase({
        supplierId,
        items: [{ productId, quantity: purchasedQty, unitCost: 25, unitPrice: 25 } as any],
        total: 1000
      });

      // Product stock incremented accurately: 10 + 40 = 50
      const prod = await db.products.get(productId);
      expect(prod?.stock).toBe(initialStock + purchasedQty);
      expect(prod?.StockQuantity).toBe(initialStock + purchasedQty);

      // Warehouse stock updated accurately
      const ws = await db.warehouseStock.get(`${warehouseId}-${productId}`);
      expect(ws?.quantity).toBe(initialStock + purchasedQty);

      // Canonical inventoryTransactions created
      const txs = await db.inventoryTransactions.where('productId').equals(productId).toArray();
      expect(txs.length).toBe(1);
      expect(txs[0].QuantityChange || txs[0].quantityChange).toBe(purchasedQty);
      expect(txs[0].SourceDocumentType || txs[0].sourceDocType).toBe('PURCHASE');
      expect(txs[0].tenantId).toBe(tenantId);
      expect(txs[0].branchId).toBe(branchId);

      // FIFO layer created with exact cost
      const layers = await db.inventory_layers.where('item_id').equals(productId).toArray();
      expect(layers.length).toBe(1);
      expect(Number(layers[0].quantity_remaining ?? layers[0].remaining_qty ?? layers[0].remainingQty)).toBe(purchasedQty);
      expect(Number(layers[0].unit_cost ?? layers[0].unitCost)).toBe(25);
    });
  });

  // =========================================================================
  // 3. Supplier Payable
  // =========================================================================
  describe('3. Supplier Payable', () => {
    it('satisfies Total = Paid + Remaining and generates exact payable liability on credit purchase', async () => {
      const billAmount = 1500;
      const res = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
        supplierId,
        items: [{ productId, quantity: 30, unitCost: 50, unitPrice: 50 } as any],
        total: billAmount
      });

      const inv = await db.invoices.get(res.refId);
      expect(inv?.totalAmount).toBe(inv?.paidAmount + inv?.remainingAmount);

      // Supplier balance increases by exact credit purchase amount: 0 + 1500 = 1500
      const supp = await db.suppliers.get(supplierId);
      expect(supp?.balance).toBe(billAmount);
    });
  });

  // =========================================================================
  // 4. Purchase + Supplier Payment Consistency
  // =========================================================================
  describe('4. Purchase + Supplier Payment Consistency', () => {
    it('Purchase 1500 -> Pay 500 (Remaining 1000) -> Pay 300 (Remaining 700) with zero double mutation', async () => {
      // 1. Process Purchase of 1500
      const purchaseRes = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
        supplierId,
        items: [{ productId, quantity: 30, unitCost: 50, unitPrice: 50 } as any],
        total: 1500
      });

      const invoiceId = purchaseRes.refId;
      expect((await db.suppliers.get(supplierId))?.balance).toBe(1500);

      // 2. Payment 1: 500 allocated to invoice
      const payRes1 = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: supplierId,
        amount: 500,
        allocations: { [invoiceId]: 500 }
      });
      expect(payRes1.success).toBe(true);

      let inv = await db.invoices.get(invoiceId);
      expect(inv?.paidAmount).toBe(500);
      expect(inv?.remainingAmount).toBe(1000);
      expect(inv?.paymentStatus).toBe('PARTIAL');
      expect((await db.suppliers.get(supplierId))?.balance).toBe(1000);

      // 3. Payment 2: 300 additional payment allocated to invoice
      const payRes2 = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: supplierId,
        amount: 300,
        allocations: { [invoiceId]: 300 }
      });
      expect(payRes2.success).toBe(true);

      inv = await db.invoices.get(invoiceId);
      expect(inv?.paidAmount).toBe(800);
      expect(inv?.remainingAmount).toBe(700);
      expect(inv?.paymentStatus).toBe('PARTIAL');
      expect((await db.suppliers.get(supplierId))?.balance).toBe(700);

      // Verify Links
      const links = await db.voucherInvoiceLinks.where('invoiceId').equals(invoiceId).toArray();
      expect(links.length).toBe(2);
      const totalLinkedPaid = links.reduce((sum, l) => sum + l.Paid_Amount, 0);
      expect(totalLinkedPaid).toBe(800);
    });
  });

  // =========================================================================
  // 5. Accounting Correctness
  // =========================================================================
  describe('5. Accounting Correctness', () => {
    it('creates exact single balanced journal entry (Debit Inventory = Credit AP) and single FinancialTransaction', async () => {
      const purchaseTotal = 800;
      const res = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
        supplierId,
        items: [{ productId, quantity: 40, unitCost: 20, unitPrice: 20 } as any],
        total: purchaseTotal
      });

      // 1. Single FinancialTransaction
      const fts = await db.financialTransactions.where('Reference_ID').equals(res.refId).toArray();
      expect(fts.length).toBe(1);
      expect(fts[0].Amount).toBe(purchaseTotal);
      expect(fts[0].Direction).toBe('Credit');
      expect(fts[0].tenantId).toBe(tenantId);
      expect(fts[0].branchId).toBe(branchId);

      // 2. Single JournalEntry
      const entries = await db.journalEntries.where('sourceId').equals(res.refId).toArray();
      expect(entries.length).toBe(1);
      const entry = entries[0];
      expect(entry.TotalAmount).toBe(purchaseTotal);
      expect(entry.tenantId).toBe(tenantId);
      expect(entry.branchId).toBe(branchId);

      // 3. Journal Lines: Debit Inventory (ACC-102) = Credit Payable (ACC-201)
      const lines = await db.journalLines.where('entryId').equals(entry.id).toArray();
      expect(lines.length).toBe(2);

      const debitLine = lines.find(l => l.debit > 0);
      const creditLine = lines.find(l => l.credit > 0);
      expect(debitLine).toBeDefined();
      expect(creditLine).toBeDefined();
      expect(debitLine?.debit).toBe(purchaseTotal);
      expect(creditLine?.credit).toBe(purchaseTotal);
      expect(debitLine?.accountId).toBe('ACC-102');
      expect(creditLine?.accountId).toBe('ACC-201');
      expect(debitLine?.tenantId).toBe(tenantId);
      expect(creditLine?.tenantId).toBe(tenantId);
      expect(debitLine?.branchId).toBe(branchId);
      expect(creditLine?.branchId).toBe(branchId);
    });
  });

  // =========================================================================
  // 6. Atomicity (Failure Injection at all Critical Stages)
  // =========================================================================
  describe('6. Atomicity & Real Mutation Rollback', () => {
    const assertFullRollback = async (initialStock: number, initialBalance: number) => {
      await new Promise(r => setTimeout(r, 15));
      expect((await db.invoices.toArray()).length).toBe(0);
      expect((await db.purchases.toArray()).length).toBe(0);
      expect((await db.products.get(productId))?.stock).toBe(initialStock);
      expect((await db.suppliers.get(supplierId))?.balance).toBe(initialBalance);
      expect((await db.inventoryTransactions.toArray()).length).toBe(0);
      expect((await db.inventory_layers.toArray()).length).toBe(0);
      expect((await db.financialTransactions.toArray()).length).toBe(0);
      expect((await db.journalEntries.toArray()).length).toBe(0);
      expect((await db.journalLines.toArray()).length).toBe(0);
    };

    it('Stage 1: AFTER_PURCHASE_DOC failure rolls back purchase document', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_PURCHASE_DOC';
      try {
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processPurchase({
            supplierId,
            items: [{ productId, quantity: 20, unitCost: 10, unitPrice: 10 } as any],
            total: 200
          })
        ).rejects.toThrow(/SIMULATED_PURCHASE_DOC_FAILURE/i);

        await assertFullRollback(10, 0);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
    });

    it('Stage 2: AFTER_INVENTORY failure rolls back stock mutation and all records', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_INVENTORY';
      try {
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processPurchase({
            supplierId,
            items: [{ productId, quantity: 20, unitCost: 10, unitPrice: 10 } as any],
            total: 200
          })
        ).rejects.toThrow(/SIMULATED_INVENTORY_FAILURE/i);

        await assertFullRollback(10, 0);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
    });

    it('Stage 3: AFTER_SUPPLIER_BALANCE failure rolls back supplier payable and all records', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_SUPPLIER_BALANCE';
      try {
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processPurchase({
            supplierId,
            items: [{ productId, quantity: 20, unitCost: 10, unitPrice: 10 } as any],
            total: 200
          })
        ).rejects.toThrow(/SIMULATED_SUPPLIER_BALANCE_FAILURE/i);

        await assertFullRollback(10, 0);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
    });

    it('Stage 4: AFTER_FT failure rolls back FinancialTransaction and all records', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_FT';
      try {
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processPurchase({
            supplierId,
            items: [{ productId, quantity: 20, unitCost: 10, unitPrice: 10 } as any],
            total: 200
          })
        ).rejects.toThrow(/SIMULATED_FT_FAILURE/i);

        await assertFullRollback(10, 0);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
    });

    it('Stage 5: AFTER_JOURNAL failure rolls back JournalEntry, lines and all records', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_JOURNAL';
      try {
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processPurchase({
            supplierId,
            items: [{ productId, quantity: 20, unitCost: 10, unitPrice: 10 } as any],
            total: 200
          })
        ).rejects.toThrow(/SIMULATED_JOURNAL_FAILURE/i);

        await assertFullRollback(10, 0);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
    });
  });

  // =========================================================================
  // 7. Idempotency
  // =========================================================================
  describe('7. Idempotency & Duplicate Request Protection', () => {
    it('replaying purchase with same transactionUuid returns cached result with zero duplicate mutations', async () => {
      const fixedKey = 'IDEMP-PURCHASE-FIXED-001';
      const payload = {
        transactionUuid: fixedKey,
        supplierId,
        items: [{ productId, quantity: 15, unitCost: 20, unitPrice: 20 } as any],
        total: 300
      };

      const firstRes = await UnifiedBusinessWorkflowOrchestrator.processPurchase(payload);
      expect(firstRes.success).toBe(true);
      expect((await db.products.get(productId))?.stock).toBe(25); // 10 + 15 = 25
      expect((await db.suppliers.get(supplierId))?.balance).toBe(300);

      // Replay with identical key & payload
      const secondRes = await UnifiedBusinessWorkflowOrchestrator.processPurchase(payload);
      expect(secondRes.success).toBe(true);
      expect(secondRes.refId).toBe(firstRes.refId);

      // Invariants remain unchanged (zero duplicate mutations)
      expect((await db.invoices.toArray()).length).toBe(1);
      expect((await db.products.get(productId))?.stock).toBe(25);
      expect((await db.suppliers.get(supplierId))?.balance).toBe(300);
      expect((await db.financialTransactions.toArray()).length).toBe(1);
      expect((await db.journalEntries.toArray()).length).toBe(1);
    });

    it('replaying purchase with same transactionUuid but DIFFERENT payload throws IDEMPOTENCY_PAYLOAD_MISMATCH', async () => {
      const fixedKey = 'IDEMP-PURCHASE-DIFF-001';
      await UnifiedBusinessWorkflowOrchestrator.processPurchase({
        transactionUuid: fixedKey,
        supplierId,
        items: [{ productId, quantity: 10, unitCost: 20, unitPrice: 20 } as any],
        total: 200
      });

      // Different payload with same key
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processPurchase({
          transactionUuid: fixedKey,
          supplierId,
          items: [{ productId, quantity: 20, unitCost: 20, unitPrice: 20 } as any],
          total: 400
        })
      ).rejects.toThrow(/IDEMPOTENCY_PAYLOAD_MISMATCH|تم استخدام مفتاح التكرار/i);
    });
  });

  // =========================================================================
  // 8. Tenant Isolation
  // =========================================================================
  describe('8. Tenant Isolation', () => {
    const foreignTenantId = 'TENANT-FOREIGN-99';

    it('rejects purchase using supplier from another tenant', async () => {
      const foreignSupplierId = 'SUP-FOREIGN-99';
      await db.suppliers.put({
        id: foreignSupplierId,
        Supplier_Name: 'Foreign Supplier',
        balance: 0,
        tenantId: foreignTenantId
      } as any);

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processPurchase({
          supplierId: foreignSupplierId,
          items: [{ productId, quantity: 10, unitCost: 10, unitPrice: 10 } as any],
          total: 100
        })
      ).rejects.toThrow(/CROSS_TENANT_SUPPLIER_FORBIDDEN|تابع لمؤسسة أخرى/i);
    });

    it('rejects purchase using product from another tenant', async () => {
      const foreignProductId = 'PROD-FOREIGN-99';
      await db.products.put({
        id: foreignProductId,
        name: 'Foreign Drug',
        stock: 5,
        StockQuantity: 5,
        price: 20,
        costPrice: 15,
        tenantId: foreignTenantId
      } as any);

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processPurchase({
          supplierId,
          items: [{ productId: foreignProductId, quantity: 10, unitCost: 10, unitPrice: 10 } as any],
          total: 100
        })
      ).rejects.toThrow(/CROSS_TENANT_PRODUCT_FORBIDDEN|تابع لمؤسسة أخرى/i);
    });

    it('prevents modifying or allocating a purchase invoice belonging to another tenant', async () => {
      const foreignInvId = 'PUR-FOREIGN-INV-99';
      await db.invoices.put({
        id: foreignInvId,
        tenantId: foreignTenantId,
        partnerId: supplierId,
        totalAmount: 1000,
        paidAmount: 0,
        type: 'PURCHASE'
      } as any);

      // Attempt payment allocation to foreign invoice
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: supplierId,
          amount: 200,
          allocations: { [foreignInvId]: 200 }
        })
      ).rejects.toThrow(/CROSS_TENANT_INVOICE_FORBIDDEN|مؤسسة أخرى/i);
    });
  });

  // =========================================================================
  // 9. Branch Isolation
  // =========================================================================
  describe('9. Branch Isolation', () => {
    it('propagates branchId consistently across invoice, inventory, financial transactions, and journal entries', async () => {
      const res = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
        supplierId,
        items: [{ productId, quantity: 10, unitCost: 20, unitPrice: 20 } as any],
        total: 200
      });

      const inv = await db.invoices.get(res.refId);
      expect(inv?.branchId).toBe(branchId);

      const invTx = await db.inventoryTransactions.where('source_doc_id').equals(res.refId).first();
      expect(invTx?.branchId).toBe(branchId);

      const ft = await db.financialTransactions.where('Reference_ID').equals(res.refId).first();
      expect(ft?.branchId).toBe(branchId);

      const je = await db.journalEntries.where('sourceId').equals(res.refId).first();
      expect(je?.branchId).toBe(branchId);

      const lines = await db.journalLines.where('entryId').equals(je!.id).toArray();
      lines.forEach(line => expect(line.branchId).toBe(branchId));
    });
  });
});
