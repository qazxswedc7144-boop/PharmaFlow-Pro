import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/core/db';
import { UnifiedBusinessWorkflowOrchestrator } from '../../src/services/orchestration/UnifiedBusinessWorkflowOrchestrator';
import { ValidationService } from '@/services/integrity/ValidationService';
import { WorkerClient } from '@/features/workers/worker.client';
import { FIFOEngine } from '@/features/inventory/services/fifoEngine';
import { IdempotencyRegistry } from '../../src/core/integrity/idempotencyRegistry';
import { TokenProvider } from '@/services/auth/tokenProvider';

describe('P0 Hotfix: Validation Enforcement, FIFO Stock Integrity & Tenant Safety Suite', () => {
  const tenantId = 'TENANT-HOTFIX-P0-01';
  const branchId = 'BRH-HOTFIX-MAIN-01';
  const customerId = 'CUST-HOTFIX-001';
  const supplierId = 'SUPP-HOTFIX-001';
  const productId = 'PROD-HOTFIX-001';
  const warehouseId = 'WH-MAIN';

  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as any).__FAIL_AT_STAGE__ = undefined;
    IdempotencyRegistry.clearInMemory();

    // Reset database tables
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
    await db.auditLogs.clear();

    // Authenticated session
    const userSession = {
      id: 'usr-p0-auditor',
      user_id: 'usr-p0-auditor',
      User_Name: 'P0 Security Auditor',
      User_Email: 'auditor@pharmaflow.test',
      Role: 'SuperAdmin',
      User_Role: 'SuperAdmin',
      tenantId,
      tenant_id: tenantId,
      branchId,
      branch_id: branchId,
      permissions: ['ALL', 'sales.create', 'sales.edit', 'purchases.create', 'purchases.edit']
    };

    TokenProvider.setSession(userSession as any, 'mock-jwt-p0-audit', 'mock-refresh-p0-audit');

    // Seed test master records
    await db.customers.add({
      id: customerId,
      CustomerID: customerId,
      name: 'عميل تدقيق الأمان P0',
      phone: '0501112233',
      balance: 0,
      tenantId,
      branchId
    } as any);

    await db.suppliers.add({
      id: supplierId,
      SupplierID: supplierId,
      name: 'مورد تدقيق الأمان P0',
      phone: '0509998877',
      balance: 0,
      tenantId,
      branchId
    } as any);

    await db.products.add({
      id: productId,
      productId,
      name: 'Panadol Extra 500mg (P0 Audit)',
      code: 'PAN-EXT-500',
      stock: 100,
      costPrice: 20,
      sellingPrice: 30,
      isActive: true,
      tenantId,
      branchId
    } as any);

    await db.warehouseStock.add({
      id: `WHS-${warehouseId}-${productId}`,
      warehouseId,
      productId,
      quantity: 100,
      lastUpdated: new Date().toISOString(),
      tenantId,
      branchId
    } as any);
  });

  // =========================================================================
  // 1. Invalid invoice rejected (Validation Enforcement)
  // =========================================================================
  describe('1. Validation Enforcement: Invalid Invoice Rejection', () => {
    it('rejects sales invoice with non-positive integer quantity and stops before mutations', async () => {
      const invalidPayload = {
        customerId,
        items: [
          {
            productId,
            quantity: 0, // Invalid: quantity must be positive
            unitPrice: 30,
            price: 30
          } as any
        ],
        total: 0
      };

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSale(invalidPayload)
      ).rejects.toThrow(/INVOICE_VALIDATION_FAILED|Quantity must be a positive integer/i);

      // Verify ZERO database persistence
      expect(await db.invoices.count()).toBe(0);
      expect(await db.inventoryTransactions.count()).toBe(0);
      expect(await db.financialTransactions.count()).toBe(0);
      expect(await db.journalEntries.count()).toBe(0);
    });

    it('rejects sales invoice with negative unit price and halts execution', async () => {
      const invalidPayload = {
        customerId,
        items: [
          {
            productId,
            quantity: 5,
            unitPrice: -15, // Invalid: price must be non-negative
            price: -15
          } as any
        ],
        total: -75
      };

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSale(invalidPayload)
      ).rejects.toThrow();

      expect(await db.invoices.count()).toBe(0);
      expect(await db.inventoryTransactions.count()).toBe(0);
    });

    it('rejects sales invoice when declared total does not match item totals', async () => {
      const mismatchPayload = {
        customerId,
        items: [
          {
            productId,
            quantity: 2,
            unitPrice: 50,
            price: 50
          } as any
        ],
        total: 500 // Declared 500 but items total 100
      };

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSale(mismatchPayload)
      ).rejects.toThrow(/INVOICE_VALIDATION_FAILED|Total mismatch/i);

      expect(await db.invoices.count()).toBe(0);
    });

    it('rejects purchase invoice with empty or invalid items array', async () => {
      const invalidPurchase = {
        supplierId,
        items: [],
        total: 100
      };

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processPurchase(invalidPurchase as any)
      ).rejects.toThrow();

      expect(await db.invoices.count()).toBe(0);
      expect(await db.inventoryTransactions.count()).toBe(0);
    });
  });

  // =========================================================================
  // 2. Duplicate invoice ID rejected
  // =========================================================================
  describe('2. Uniqueness Enforcement: Duplicate Invoice ID Rejection', () => {
    it('rejects sales invoice when id is already registered in invoices table', async () => {
      const duplicateId = 'SALE-DUP-TEST-001';

      // Pre-seed an existing invoice with duplicateId
      await db.invoices.add({
        id: duplicateId,
        invoiceNumber: duplicateId,
        type: 'SALE',
        partnerId: customerId,
        totalAmount: 100,
        finalTotal: 100,
        date: new Date().toISOString(),
        tenantId,
        branchId
      } as any);

      const payload = {
        id: duplicateId,
        customerId,
        items: [
          {
            productId,
            quantity: 5,
            unitPrice: 30,
            price: 30
          } as any
        ],
        total: 150
      };

      // Attempt to save a NEW sale with the already existing id
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSale(payload)
      ).rejects.toThrow(/DUPLICATE_INVOICE_ID/i);

      // Verify that no extra inventory mutation or journal entries occurred
      expect(await db.inventoryTransactions.count()).toBe(0);
      expect(await db.financialTransactions.count()).toBe(0);
    });

    it('rejects purchase invoice when id is already registered in invoices table', async () => {
      const duplicateId = 'PUR-DUP-TEST-001';

      await db.invoices.add({
        id: duplicateId,
        invoiceNumber: duplicateId,
        type: 'PURCHASE',
        partnerId: supplierId,
        totalAmount: 200,
        finalTotal: 200,
        date: new Date().toISOString(),
        tenantId,
        branchId
      } as any);

      const payload = {
        id: duplicateId,
        supplierId,
        items: [
          {
            productId,
            quantity: 10,
            unitPrice: 20,
            price: 20
          } as any
        ],
        total: 200
      };

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processPurchase(payload)
      ).rejects.toThrow(/DUPLICATE_INVOICE_ID/i);

      expect(await db.inventoryTransactions.count()).toBe(0);
    });
  });

  // =========================================================================
  // 3. Validation / Database failure rejected (Fail Closed)
  // =========================================================================
  describe('3. Database Failure: Fail-Closed Uniqueness Check', () => {
    it('fails closed and throws error when database queries throw', async () => {
      const failingDb = {
        invoices: {
          get: vi.fn().mockRejectedValue(new Error('FATAL_DB_DISCONNECTION')),
          where: vi.fn().mockReturnValue({
            equals: vi.fn().mockReturnValue({
              count: vi.fn().mockRejectedValue(new Error('FATAL_DB_DISCONNECTION'))
            })
          }),
          schema: { indexes: [] }
        }
      };

      await expect(
        ValidationService.validateInvoiceIdUniqueness('ANY-ID-001', 'SALE', failingDb)
      ).rejects.toThrow(/DATABASE_CHECK_FAILED/i);
    });

    it('fails closed when invoices table is missing from db instance', async () => {
      const emptyDb = {};

      await expect(
        ValidationService.validateInvoiceIdUniqueness('ANY-ID-002', 'SALE', emptyDb)
      ).rejects.toThrow(/DATABASE_CHECK_FAILED/i);
    });
  });

  // =========================================================================
  // 4. Insufficient FIFO stock rejected
  // =========================================================================
  describe('4. FIFO Inventory: Insufficient Stock Rejection', () => {
    it('rejects FIFO allocation when available layers are insufficient', async () => {
      const invoicePayload = {
        id: 'SALE-FIFO-AUDIT-001',
        type: 'SALE',
        tenantId: 'TENANT-HOTFIX-P0-01',
        items: [
          {
            product_id: productId,
            qty: 50,
            price: 30
          }
        ]
      };

      // Only 20 units available in layers (deficit of 30)
      const layers = [
        {
          id: 'LAY-001',
          item_id: productId,
          quantity_remaining: 20,
          unit_cost: 15,
          created_at: new Date().toISOString()
        }
      ];

      await expect(
        WorkerClient.runFIFO(invoicePayload, layers)
      ).rejects.toThrow(/INSUFFICIENT_FIFO_STOCK/i);
    });
  });

  // =========================================================================
  // 5 & 6. No synthetic layers and no fake consumption logs created
  // =========================================================================
  describe('5 & 6. Elimination of Synthetic Layers and Fake Logs', () => {
    it('guarantees zero synthetic layers and zero fake consumption logs on deficit', async () => {
      const invoicePayload = {
        id: 'SALE-FIFO-AUDIT-002',
        type: 'SALE',
        tenantId: 'TENANT-HOTFIX-P0-01',
        items: [
          {
            product_id: productId,
            qty: 100,
            price: 30
          }
        ]
      };

      // Empty layers: stock is 0
      const emptyLayers: any[] = [];

      try {
        await WorkerClient.runFIFO(invoicePayload, emptyLayers);
      } catch (err: any) {
        expect(err.message).toMatch(/INSUFFICIENT_FIFO_STOCK/i);
      }

      // Check database to ensure no synthetic layer exists
      const allLayers = await db.inventory_layers.toArray();
      const syntheticLayers = allLayers.filter(l => 
        (l.id && String(l.id).includes('synthetic')) || 
        (l.reference_id === invoicePayload.id && l.quantity_remaining === 0)
      );
      expect(syntheticLayers.length).toBe(0);

      // Check database to ensure no fake consumption logs exist
      const allLogs = await db.fifo_consumption_log.toArray();
      const fakeLogs = allLogs.filter(log => 
        (log.id && String(log.id).includes('synthetic')) ||
        (log.layer_id && String(log.layer_id).includes('synthetic'))
      );
      expect(fakeLogs.length).toBe(0);
    });
  });

  // =========================================================================
  // 7. Tenant safety inside FIFO: Never fallback to TEN-DEV-001
  // =========================================================================
  describe('7. FIFO Tenant Safety: Strict Tenant Enforcement', () => {
    it('rejects FIFO execution when tenantId is missing from invoice', async () => {
      const noTenantInvoice = {
        id: 'SALE-NO-TENANT-001',
        type: 'SALE',
        items: [{ product_id: productId, qty: 10, price: 30 }]
      };

      const layers = [
        {
          id: 'LAY-001',
          item_id: productId,
          quantity_remaining: 50,
          unit_cost: 15,
          created_at: new Date().toISOString()
        }
      ];

      await expect(
        WorkerClient.runFIFO(noTenantInvoice, layers)
      ).rejects.toThrow(/TENANT_ID_REQUIRED|FAIL_CLOSED/i);
    });

    it('rejects FIFO execution when tenantId is TEN-DEV-001 or default fallback', async () => {
      const devTenantInvoice = {
        id: 'SALE-DEV-TENANT-001',
        type: 'SALE',
        tenantId: 'TEN-DEV-001', // Forbidden default
        items: [{ product_id: productId, qty: 10, price: 30 }]
      };

      const layers = [
        {
          id: 'LAY-001',
          item_id: productId,
          quantity_remaining: 50,
          unit_cost: 15,
          created_at: new Date().toISOString()
        }
      ];

      await expect(
        WorkerClient.runFIFO(devTenantInvoice, layers)
      ).rejects.toThrow(/TENANT_ID_REQUIRED|FAIL_CLOSED/i);
    });

    it('stamps valid trusted tenantId on all created FIFO layers and consumption logs', async () => {
      const trustedTenant = 'TENANT-AUTHENTICATED-REAL-099';
      const validInvoice = {
        id: 'SALE-TRUSTED-TENANT-001',
        type: 'SALE',
        tenantId: trustedTenant,
        items: [{ product_id: productId, qty: 10, price: 30 }]
      };

      const layers = [
        {
          id: 'LAY-TRUSTED-001',
          item_id: productId,
          quantity_remaining: 20,
          unit_cost: 15,
          created_at: new Date().toISOString()
        }
      ];

      const result = await WorkerClient.runFIFO(validInvoice, layers);
      expect(result.consumptionLogs.length).toBeGreaterThan(0);

      // Verify EVERY consumption log has the trusted tenantId and NOT TEN-DEV-001
      for (const log of result.consumptionLogs) {
        expect(log.tenant_id).toBe(trustedTenant);
        expect(log.tenant_id).not.toBe('TEN-DEV-001');
      }
    });

    it('preserves trusted tenantId in FIFOEngine layer additions', async () => {
      const testTenant = 'TENANT-ENGINE-TEST-777';
      await FIFOEngine.addPurchaseLayer(productId, 25, 18, 'PUR-REF-777', testTenant);

      const addedLayers = await db.inventory_layers.where('reference_id').equals('PUR-REF-777').toArray();
      expect(addedLayers.length).toBe(1);
      expect(addedLayers[0].tenant_id).toBe(testTenant);
      expect(addedLayers[0].tenant_id).not.toBe('TEN-DEV-001');
    });
  });
});
