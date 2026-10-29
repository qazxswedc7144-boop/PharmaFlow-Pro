import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/core/db';
import { UnifiedBusinessWorkflowOrchestrator } from '../../src/services/orchestration/UnifiedBusinessWorkflowOrchestrator';
import { useAuthStore } from '@/store/authStore';
import { IdempotencyRegistry } from '../../src/core/integrity/idempotencyRegistry';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { configurationService } from '@/services/config/configurationService';
import { FIFOEngine } from '@/features/inventory/services/fifoEngine';

describe('Sales Lifecycle Integrity Audit & Verification Suite', () => {
  const tenantId = 'TENANT-SALES-PROD-01';
  const branchId = 'BRH-SALES-MAIN-01';
  const customerId = 'CUST-SALES-001';
  const productId = 'PROD-SALES-001';
  const warehouseId = 'WH-MAIN';

  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as any).__FAIL_AT_STAGE__ = undefined;
    IdempotencyRegistry.clearInMemory();

    // Clear tables
    await db.invoices.clear();
    await db.sales.clear();
    await db.products.clear();
    await db.customers.clear();
    await db.suppliers.clear();
    await db.warehouseStock.clear();
    await db.branchInventory.clear();
    await db.inventoryTransactions.clear();
    await db.inventory_layers.clear();
    await db.fifo_consumption_log.clear();
    await db.medicineBatches.clear();
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
      id: 'usr-sales-auditor',
      user_id: 'usr-sales-auditor',
      User_Name: 'Sales Auditor',
      User_Email: 'auditor@pharmaflow.test',
      Role: 'SuperAdmin',
      User_Role: 'SuperAdmin',
      tenantId,
      tenant_id: tenantId,
      branchId,
      branch_id: branchId,
      permissions: ['ALL', 'sales.create', 'sales.edit', 'sales.return', 'accounting.voucher.create', 'vouchers.create']
    };

    TokenProvider.setSession(userObj as any, 'mock-jwt-sales-audit', 'mock-refresh-sales-audit');
    useAuthStore.setState({
      user: userObj as any,
      token: 'mock-jwt-sales-audit',
      tenantId,
      branchId,
      roles: ['SuperAdmin'],
      permissions: ['ALL', 'sales.create', 'sales.edit', 'sales.return', 'accounting.voucher.create', 'vouchers.create'],
      isAuthenticated: true
    });

    // Seed Customer with initial balance of 0
    await db.customers.put({
      id: customerId,
      name: 'Dar Al-Shifa Pharmacy Client',
      balance: 0,
      currentBalance: 0,
      tenantId,
      branchId,
      is_active: true
    } as any);

    // Seed Product with initial stock of 100
    await db.products.put({
      id: productId,
      name: 'Augmentin 1g Tablets',
      stock: 100,
      StockQuantity: 100,
      price: 30,
      costPrice: 20,
      tenantId,
      is_active: true
    } as any);

    // Seed Warehouse Stock for initial stock of 100
    await db.warehouseStock.put({
      id: `${warehouseId}-${productId}`,
      warehouseId,
      productId,
      quantity: 100,
      tenantId
    } as any);

    // Seed Branch Inventory
    await db.branchInventory.put({
      id: `INV-${branchId}-${productId}`,
      branchId,
      productId,
      quantity: 100,
      tenantId
    } as any);

    // Seed FIFO layer (100 units @ 20 cost)
    await FIFOEngine.addPurchaseLayer(productId, 100, 20, 'INITIAL-PURCHASE-DOC');

    // Seed Chart of Accounts
    await db.accounts.bulkPut([
      { id: 'ACC-101', code: '1010', name: 'الصندوق الرئيسي', type: 'Asset', tenantId, branchId, balance: 100000 },
      { id: 'ACC-102', code: '1020', name: 'المخزون', type: 'Asset', tenantId, branchId, balance: 50000 },
      { id: 'ACC-103', code: '1030', name: 'العملاء - ذمم مدينة', type: 'Asset', tenantId, branchId, balance: 0 },
      { id: 'ACC-104', code: '1040', name: 'البنك', type: 'Asset', tenantId, branchId, balance: 200000 },
      { id: 'ACC-401', code: '4010', name: 'إيرادات المبيعات', type: 'Revenue', tenantId, branchId, balance: 0 },
      { id: 'ACC-501', code: '5010', name: 'تكلفة البضاعة المباعة', type: 'Expense', tenantId, branchId, balance: 0 }
    ] as any);

    // Configurations
    await configurationService.set('inventory.allowNegativeStock', false, { userId: 'admin' } as any);
    await configurationService.set('sales.allow_negative_stock', false, { userId: 'admin' } as any);
    await configurationService.set('inventory.defaultWarehouseId', warehouseId, { userId: 'admin' } as any);
  });

  // =========================================================================
  // 1. Sales Invoice Integrity
  // =========================================================================
  describe('1. Sales Invoice Integrity', () => {
    it('creates credit sales invoice with accurate fields, prices, totals, paid and remaining amounts', async () => {
      const res = await UnifiedBusinessWorkflowOrchestrator.processSale({
        customerId,
        items: [
          {
            productId,
            quantity: 10,
            unitPrice: 30,
            price: 30
          } as any
        ],
        total: 300,
        notes: 'مبيعات آجلة لعميل تجريبي'
      });

      expect(res.success).toBe(true);
      expect(res.refId).toBeDefined();

      const inv = await db.invoices.get(res.refId);
      expect(inv).toBeDefined();
      expect(inv?.partnerId).toBe(customerId);
      expect(inv?.type).toBe('SALE');
      expect(inv?.totalAmount).toBe(300);
      expect(inv?.finalTotal).toBe(300);
      expect(inv?.paidAmount).toBe(0);
      expect(inv?.remainingAmount).toBe(300);
      expect(inv?.paymentStatus).toBe('Credit');
      expect(inv?.tenantId).toBe(tenantId);
      expect(inv?.branchId).toBe(branchId);
      expect(inv?.items?.length).toBe(1);
      expect(inv?.items[0].productId).toBe(productId);
      expect(inv?.items[0].quantity).toBe(10);
    });

    it('creates cash sales invoice with paidAmount equal to total and remainingAmount equal to 0', async () => {
      const res = await UnifiedBusinessWorkflowOrchestrator.processSale(
        {
          customerId,
          items: [{ productId, quantity: 5, unitPrice: 30, price: 30 } as any],
          total: 150,
          notes: 'بيع نقدي مباشر'
        },
        { isCash: true }
      );

      expect(res.success).toBe(true);
      const inv = await db.invoices.get(res.refId);
      expect(inv?.paidAmount).toBe(150);
      expect(inv?.remainingAmount).toBe(0);
      expect(inv?.paymentStatus).toBe('Cash');
      expect(inv?.financialStatus).toBe('Paid');
    });
  });

  // =========================================================================
  // 2. Inventory Integrity (Deduction & FEFO/FIFO)
  // =========================================================================
  describe('2. Inventory Integrity', () => {
    it('deducts exact quantity from products.stock and warehouseStock with canonical inventory transaction & FIFO log', async () => {
      const initialStock = 100;
      const soldQty = 25;

      const res = await UnifiedBusinessWorkflowOrchestrator.processSale({
        customerId,
        items: [{ productId, quantity: soldQty, unitPrice: 30, price: 30 } as any],
        total: 750
      });

      expect(res.success).toBe(true);

      // Product stock reduced: 100 - 25 = 75
      const prod = await db.products.get(productId);
      expect(prod?.stock).toBe(initialStock - soldQty);
      expect(prod?.StockQuantity).toBe(initialStock - soldQty);

      // Warehouse stock reduced
      const ws = await db.warehouseStock.get(`${warehouseId}-${productId}`);
      expect(ws?.quantity).toBe(initialStock - soldQty);

      // Canonical inventoryTransactions created with negative change
      const txs = await db.inventoryTransactions.where('productId').equals(productId).toArray();
      const saleTx = txs.find(t => (t.QuantityChange || t.quantityChange) === -soldQty);
      expect(saleTx).toBeDefined();
      expect(saleTx?.SourceDocumentType || saleTx?.sourceDocType).toBe('SALE');
      expect(saleTx?.tenantId).toBe(tenantId);
      expect(saleTx?.branchId).toBe(branchId);

      // FIFO consumption log created
      const fifoLogs = await db.fifo_consumption_log.where('sale_id').equals(res.refId).toArray();
      expect(fifoLogs.length).toBe(1);
      expect(fifoLogs[0].quantity_consumed ?? fifoLogs[0].quantity).toBe(soldQty);
    });

    it('rejects overselling when requested quantity exceeds available stock', async () => {
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSale({
          customerId,
          items: [{ productId, quantity: 999, unitPrice: 30, price: 30 } as any],
          total: 29970
        })
      ).rejects.toThrow(/INSUFFICIENT_STOCK|الكمية غير متوفرة|Insufficient stock/i);

      // Stock remains unaffected
      const prod = await db.products.get(productId);
      expect(prod?.stock).toBe(100);
    });
  });

  // =========================================================================
  // 3. Customer Receivable
  // =========================================================================
  describe('3. Customer Receivable', () => {
    it('satisfies Total = Paid + Remaining and generates exact receivable on credit sale', async () => {
      const saleTotal = 1500;
      const res = await UnifiedBusinessWorkflowOrchestrator.processSale({
        customerId,
        items: [{ productId, quantity: 50, unitPrice: 30, price: 30 } as any],
        total: saleTotal
      });

      const inv = await db.invoices.get(res.refId);
      expect(inv?.totalAmount).toBe(inv?.paidAmount + inv?.remainingAmount);

      // Customer balance increases by exact credit sale amount: 0 + 1500 = 1500
      const cust = await db.customers.get(customerId);
      expect(cust?.balance).toBe(saleTotal);
    });
  });

  // =========================================================================
  // 4. Sales + Customer Receipt Consistency
  // =========================================================================
  describe('4. Sales + Customer Receipt Consistency', () => {
    it('Sale 1500 -> Receipt 500 (Remaining 1000) -> Receipt 300 (Remaining 700) with zero double mutation', async () => {
      // 1. Process Sale of 1500
      const saleRes = await UnifiedBusinessWorkflowOrchestrator.processSale({
        customerId,
        items: [{ productId, quantity: 50, unitPrice: 30, price: 30 } as any],
        total: 1500
      });

      const invoiceId = saleRes.refId;
      expect((await db.customers.get(customerId))?.balance).toBe(1500);

      // 2. Receipt 1: 500 allocated to invoice
      const rcptRes1 = await UnifiedBusinessWorkflowOrchestrator.processCustomerReceipt({
        partnerId: customerId,
        amount: 500,
        allocations: { [invoiceId]: 500 }
      });
      expect(rcptRes1.success).toBe(true);

      let inv = await db.invoices.get(invoiceId);
      expect(inv?.paidAmount).toBe(500);
      expect(inv?.remainingAmount).toBe(1000);
      expect(inv?.paymentStatus).toBe('PARTIAL');
      expect((await db.customers.get(customerId))?.balance).toBe(1000);

      // 3. Receipt 2: 300 additional receipt allocated to invoice
      const rcptRes2 = await UnifiedBusinessWorkflowOrchestrator.processCustomerReceipt({
        partnerId: customerId,
        amount: 300,
        allocations: { [invoiceId]: 300 }
      });
      expect(rcptRes2.success).toBe(true);

      inv = await db.invoices.get(invoiceId);
      expect(inv?.paidAmount).toBe(800);
      expect(inv?.remainingAmount).toBe(700);
      expect(inv?.paymentStatus).toBe('PARTIAL');
      expect((await db.customers.get(customerId))?.balance).toBe(700);

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
    it('creates exact single balanced journal entry (Debit AR/Cash = Credit Revenue) and single FinancialTransaction', async () => {
      const saleTotal = 900;
      const res = await UnifiedBusinessWorkflowOrchestrator.processSale({
        customerId,
        items: [{ productId, quantity: 30, unitPrice: 30, price: 30 } as any],
        total: saleTotal
      });

      // 1. Single FinancialTransaction
      const fts = await db.financialTransactions.where('Reference_ID').equals(res.refId).toArray();
      expect(fts.length).toBe(1);
      expect(fts[0].Amount).toBe(saleTotal);
      expect(fts[0].Direction).toBe('Debit');
      expect(fts[0].tenantId).toBe(tenantId);
      expect(fts[0].branchId).toBe(branchId);

      // 2. Single JournalEntry
      const entries = await db.journalEntries.where('sourceId').equals(res.refId).toArray();
      expect(entries.length).toBe(1);
      const entry = entries[0];
      expect(entry.TotalAmount).toBe(saleTotal);
      expect(entry.tenantId).toBe(tenantId);
      expect(entry.branchId).toBe(branchId);

      // 3. Journal Lines balance: Total Debit = Total Credit
      const lines = await db.journalLines.where('entryId').equals(entry.id).toArray();
      const totalDebit = lines.reduce((sum, l) => sum + (l.debit || 0), 0);
      const totalCredit = lines.reduce((sum, l) => sum + (l.credit || 0), 0);
      expect(totalDebit).toBe(totalCredit);

      // Check tenantId and branchId on all lines
      lines.forEach(line => {
        expect(line.tenantId).toBe(tenantId);
        expect(line.branchId).toBe(branchId);
      });
    });
  });

  // =========================================================================
  // 6. Atomicity & Failure Injection (Real Mutation Rollback)
  // =========================================================================
  describe('6. Atomicity & Real Mutation Rollback', () => {
    const assertFullRollback = async (initialStock: number, initialBalance: number) => {
      await new Promise(r => setTimeout(r, 15));
      expect((await db.invoices.toArray()).length).toBe(0);
      expect((await db.sales.toArray()).length).toBe(0);
      expect((await db.products.get(productId))?.stock).toBe(initialStock);
      expect((await db.customers.get(customerId))?.balance).toBe(initialBalance);
      expect((await db.inventoryTransactions.toArray()).length).toBe(0);
      expect((await db.fifo_consumption_log.toArray()).length).toBe(0);
      expect((await db.financialTransactions.toArray()).length).toBe(0);
      expect((await db.journalEntries.toArray()).length).toBe(0);
      expect((await db.journalLines.toArray()).length).toBe(0);
    };

    it('Stage 1: AFTER_SALES_DOC failure rolls back sales document', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_SALES_DOC';
      try {
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processSale({
            customerId,
            items: [{ productId, quantity: 10, unitPrice: 30, price: 30 } as any],
            total: 300
          })
        ).rejects.toThrow(/SIMULATED_SALES_DOC_FAILURE/i);

        await assertFullRollback(100, 0);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
    });

    it('Stage 2: AFTER_INVENTORY failure rolls back stock deduction and all records', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_INVENTORY';
      try {
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processSale({
            customerId,
            items: [{ productId, quantity: 10, unitPrice: 30, price: 30 } as any],
            total: 300
          })
        ).rejects.toThrow(/SIMULATED_INVENTORY_FAILURE/i);

        await assertFullRollback(100, 0);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
    });

    it('Stage 3: AFTER_CUSTOMER_BALANCE failure rolls back customer balance and all records', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_CUSTOMER_BALANCE';
      try {
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processSale({
            customerId,
            items: [{ productId, quantity: 10, unitPrice: 30, price: 30 } as any],
            total: 300
          })
        ).rejects.toThrow(/SIMULATED_CUSTOMER_BALANCE_FAILURE/i);

        await assertFullRollback(100, 0);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
    });

    it('Stage 4: AFTER_FT failure rolls back FinancialTransaction and all records', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_FT';
      try {
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processSale({
            customerId,
            items: [{ productId, quantity: 10, unitPrice: 30, price: 30 } as any],
            total: 300
          })
        ).rejects.toThrow(/SIMULATED_FT_FAILURE/i);

        await assertFullRollback(100, 0);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
    });

    it('Stage 5: AFTER_JOURNAL failure rolls back JournalEntry, lines, and all records', async () => {
      (globalThis as any).__FAIL_AT_STAGE__ = 'AFTER_JOURNAL';
      try {
        await expect(
          UnifiedBusinessWorkflowOrchestrator.processSale({
            customerId,
            items: [{ productId, quantity: 10, unitPrice: 30, price: 30 } as any],
            total: 300
          })
        ).rejects.toThrow(/SIMULATED_JOURNAL_FAILURE/i);

        await assertFullRollback(100, 0);
      } finally {
        (globalThis as any).__FAIL_AT_STAGE__ = undefined;
      }
    });
  });

  // =========================================================================
  // 7. Idempotency & Duplicate Request Protection
  // =========================================================================
  describe('7. Idempotency', () => {
    it('replaying sale with same transactionUuid returns cached result with zero duplicate mutations', async () => {
      const fixedKey = 'IDEMP-SALE-FIXED-001';
      const payload = {
        transactionUuid: fixedKey,
        customerId,
        items: [{ productId, quantity: 15, unitPrice: 20, price: 20 } as any],
        total: 300
      };

      const firstRes = await UnifiedBusinessWorkflowOrchestrator.processSale(payload);
      expect(firstRes.success).toBe(true);
      expect((await db.products.get(productId))?.stock).toBe(85); // 100 - 15 = 85
      expect((await db.customers.get(customerId))?.balance).toBe(300);

      // Replay with identical key & payload
      const secondRes = await UnifiedBusinessWorkflowOrchestrator.processSale(payload);
      expect(secondRes.success).toBe(true);
      expect(secondRes.refId).toBe(firstRes.refId);

      // Invariants remain unchanged (zero duplicate mutations)
      expect((await db.invoices.toArray()).length).toBe(1);
      expect((await db.products.get(productId))?.stock).toBe(85);
      expect((await db.customers.get(customerId))?.balance).toBe(300);
      expect((await db.financialTransactions.toArray()).length).toBe(1);
      expect((await db.journalEntries.toArray()).length).toBe(1);
    });

    it('replaying sale with same transactionUuid but DIFFERENT payload throws IDEMPOTENCY_PAYLOAD_MISMATCH', async () => {
      const fixedKey = 'IDEMP-SALE-DIFF-001';
      await UnifiedBusinessWorkflowOrchestrator.processSale({
        transactionUuid: fixedKey,
        customerId,
        items: [{ productId, quantity: 10, unitPrice: 20, price: 20 } as any],
        total: 200
      });

      // Different payload with same key
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSale({
          transactionUuid: fixedKey,
          customerId,
          items: [{ productId, quantity: 20, unitPrice: 20, price: 20 } as any],
          total: 400
        })
      ).rejects.toThrow(/IDEMPOTENCY_PAYLOAD_MISMATCH|تم استخدام مفتاح التكرار/i);
    });
  });

  // =========================================================================
  // 8. Tenant Isolation
  // =========================================================================
  describe('8. Tenant Isolation', () => {
    const foreignTenantId = 'TENANT-FOREIGN-SALE-99';

    it('rejects sale using customer from another tenant', async () => {
      const foreignCustId = 'CUST-FOREIGN-99';
      await db.customers.put({
        id: foreignCustId,
        name: 'Foreign Customer',
        balance: 0,
        tenantId: foreignTenantId
      } as any);

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSale({
          customerId: foreignCustId,
          items: [{ productId, quantity: 5, unitPrice: 20, price: 20 } as any],
          total: 100
        })
      ).rejects.toThrow(/CROSS_TENANT_CUSTOMER_FORBIDDEN|تابع لمؤسسة أخرى/i);
    });

    it('rejects sale using product from another tenant', async () => {
      const foreignProductId = 'PROD-FOREIGN-SALE-99';
      await db.products.put({
        id: foreignProductId,
        name: 'Foreign Product',
        stock: 50,
        StockQuantity: 50,
        price: 30,
        costPrice: 20,
        tenantId: foreignTenantId
      } as any);

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSale({
          customerId,
          items: [{ productId: foreignProductId, quantity: 5, unitPrice: 20, price: 20 } as any],
          total: 100
        })
      ).rejects.toThrow(/CROSS_TENANT_PRODUCT_FORBIDDEN|تابع لمؤسسة أخرى/i);
    });

    it('prevents allocating a customer receipt to a sales invoice belonging to another tenant', async () => {
      const foreignSaleId = 'SALE-FOREIGN-INV-99';
      await db.invoices.put({
        id: foreignSaleId,
        tenantId: foreignTenantId,
        partnerId: customerId,
        totalAmount: 1000,
        paidAmount: 0,
        type: 'SALE'
      } as any);

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processCustomerReceipt({
          partnerId: customerId,
          amount: 200,
          allocations: { [foreignSaleId]: 200 }
        })
      ).rejects.toThrow(/CROSS_TENANT_INVOICE_FORBIDDEN|مؤسسة أخرى/i);
    });
  });

  // =========================================================================
  // 9. Branch Isolation
  // =========================================================================
  describe('9. Branch Isolation', () => {
    it('propagates branchId consistently across invoice, inventory movement, financial transaction, and journal entries', async () => {
      const res = await UnifiedBusinessWorkflowOrchestrator.processSale({
        customerId,
        items: [{ productId, quantity: 10, unitPrice: 20, price: 20 } as any],
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

  // =========================================================================
  // 10. Overpayment / Over-allocation Rejections
  // =========================================================================
  describe('10. Overpayment & Over-allocation', () => {
    it('rejects receipt allocation exceeding invoice remaining amount', async () => {
      const saleRes = await UnifiedBusinessWorkflowOrchestrator.processSale({
        customerId,
        items: [{ productId, quantity: 10, unitPrice: 20, price: 20 } as any],
        total: 200
      });

      // Invoice remaining is 200; attempt allocating 250
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processCustomerReceipt({
          partnerId: customerId,
          amount: 250,
          allocations: { [saleRes.refId]: 250 }
        })
      ).rejects.toThrow(/OVER_ALLOCATION|يتجاوز المبلغ المتبقي/i);
    });

    it('rejects receipt allocation on an already fully paid sales invoice', async () => {
      const saleRes = await UnifiedBusinessWorkflowOrchestrator.processSale(
        {
          customerId,
          items: [{ productId, quantity: 5, unitPrice: 20, price: 20 } as any],
          total: 100
        },
        { isCash: true }
      );

      // Cash sale is already fully paid
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processCustomerReceipt({
          partnerId: customerId,
          amount: 50,
          allocations: { [saleRes.refId]: 50 }
        })
      ).rejects.toThrow(/INVOICE_ALREADY_PAID|مدفوعة بالكامل/i);
    });

    it('rejects receipt allocated to invoice belonging to a different customer', async () => {
      const otherCustomerId = 'CUST-OTHER-777';
      await db.customers.put({
        id: otherCustomerId,
        name: 'Other Customer',
        balance: 0,
        tenantId,
        branchId,
        is_active: true
      } as any);

      const saleRes = await UnifiedBusinessWorkflowOrchestrator.processSale({
        customerId: otherCustomerId,
        items: [{ productId, quantity: 5, unitPrice: 20, price: 20 } as any],
        total: 100
      });

      // Attempt allocating from customerId to otherCustomerId's invoice
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processCustomerReceipt({
          partnerId: customerId,
          amount: 50,
          allocations: { [saleRes.refId]: 50 }
        })
      ).rejects.toThrow(/CUSTOMER_INVOICE_MISMATCH|لا تنتمي إلى العميل/i);
    });
  });
});
