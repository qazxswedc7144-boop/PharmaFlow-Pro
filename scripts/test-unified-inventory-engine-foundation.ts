// scripts/test-unified-inventory-engine-foundation.ts
/**
 * PharmaFlow PRO ERP — Sovereign Enterprise Edition
 * Phase 5 — Step 1: Unified Inventory Mutation Engine Foundation Test Suite
 * 
 * Verifies all 16 Core Invariants:
 * 1. Product stock projection matches warehouse stock after mutations.
 * 2. products.StockQuantity mirrors products.stock.
 * 3. Every mutation generates exactly one canonical inventoryTransactions record.
 * 4. No mutation generates stock_movements without legacy compatibility adapter.
 * 5. Idempotent command does not duplicate inventory movements.
 * 6. Reversal correctly creates opposite movement without physical delete.
 * 7. Negative stock rejection when allowNegativeStock=false.
 * 8. Controlled negative balance when allowNegativeStock=true (no clamping).
 * 9. InsufficientStockError contains exact shortfall metadata.
 * 10. ProductNotFoundError thrown for invalid product.
 * 11. ProductInactiveError thrown for inactive product.
 * 12. InvalidWarehouseError thrown for invalid warehouse.
 * 13. Period lock blocks mutation.
 * 14. Atomic rollback on failure leaves state untouched.
 * 15. Batch / expiry updates coordinate with medicineBatches.
 * 16. FIFO layer addition on purchase coordinates with inventory_layers.
 */

import 'fake-indexeddb/auto';
import { db } from '../src/core/db';
import { configurationService } from '../src/services/config/configurationService';
import { PeriodLockEngine } from '../src/services/transactions/PeriodLockEngine';
import {
  unifiedInventoryMutationEngine,
  ProductNotFoundError,
  ProductInactiveError,
  InvalidWarehouseError,
  InsufficientStockError,
  PeriodLockedInventoryError
} from '../src/features/inventory';

let passed = 0;
let failed = 0;
const results: { name: string; status: 'PASS' | 'FAIL'; error?: any }[] = [];

function assert(condition: boolean, testName: string, errorDetails?: any) {
  if (condition) {
    passed++;
    results.push({ name: testName, status: 'PASS' });
    console.log(`  ✅ [PASS] ${testName}`);
  } else {
    failed++;
    results.push({ name: testName, status: 'FAIL', error: errorDetails });
    console.error(`  ❌ [FAIL] ${testName}`, errorDetails || '');
  }
}

async function setupTestDb() {
  await db.open();
  await db.products.clear();
  await db.inventoryTransactions.clear();
  await db.warehouseStock.clear();
  await db.stock_movements.clear();
  await db.inventory_layers.clear();
  await db.fifo_consumption_log.clear();
  await db.medicineBatches.clear();
  await db.accountingPeriods.clear();

  // Create standard test products
  await db.products.add({
    id: 'PROD-PANADOL',
    name: 'Panadol Extra 500mg',
    stock: 50,
    StockQuantity: 50,
    costPrice: 15,
    CostPrice: 15,
    cost: 15,
    price: 25,
    is_active: true,
    isActive: true,
    category: 'Analgesics'
  } as any);

  await db.products.add({
    id: 'PROD-INACTIVE',
    name: 'Banned Syrup',
    stock: 20,
    StockQuantity: 20,
    costPrice: 5,
    is_active: false,
    isActive: false,
    category: 'Withdrawn'
  } as any);

  // Initialize warehouse stock
  await db.warehouseStock.add({
    id: 'WHS-PAN-01',
    warehouseId: 'WH-MAIN',
    productId: 'PROD-PANADOL',
    quantity: 50,
    lastUpdated: new Date().toISOString()
  } as any);

  // Set default config: disallow negative stock
  await configurationService.set('inventory.allowNegativeStock', false, { userId: 'admin' } as any);
}

async function runTests() {
  console.log('\n================================================================');
  console.log('🧪 UNIFIED INVENTORY MUTATION ENGINE — FOUNDATION TEST SUITE');
  console.log('================================================================\n');

  await setupTestDb();

  // -------------------------------------------------------------------------
  // TEST 1 & 2: Sale Issue -> stock deduction + projection parity
  // -------------------------------------------------------------------------
  console.log('🔹 Group A: Standard Mutation & Projection Invariants');
  const saleRes = await unifiedInventoryMutationEngine.executeIssueSale({
    tenantId: 'TEN-DEV-001',
    userId: 'USR-001',
    branchId: 'BR-MAIN',
    transactionUuid: 'TX-UUID-SALE-01',
    invoiceId: 'INV-SALE-001',
    warehouseId: 'WH-MAIN',
    items: [
      { productId: 'PROD-PANADOL', quantity: 10, unitPrice: 25 }
    ]
  });

  const updatedProd1 = await db.products.get('PROD-PANADOL');
  const updatedWhs1 = await db.warehouseStock.where('[warehouseId+productId]').equals(['WH-MAIN', 'PROD-PANADOL']).first();

  assert(
    saleRes[0]?.newStock === 40 && updatedProd1?.stock === 40 && updatedWhs1?.quantity === 40,
    '1. Product stock projection matches warehouse stock after mutations (50 - 10 = 40)'
  );

  assert(
    updatedProd1?.stock === 40 && updatedProd1?.StockQuantity === 40,
    '2. products.StockQuantity mirrors products.stock strictly'
  );

  // -------------------------------------------------------------------------
  // TEST 3 & 4: Canonical Ledger Exclusivity & Legacy Table Isolation
  // -------------------------------------------------------------------------
  console.log('🔹 Group B: Canonical Ledger Exclusivity');
  const itxCount = await db.inventoryTransactions.count();
  const smCount = await db.stock_movements.count();

  assert(
    itxCount === 1,
    '3. Every mutation generates exactly one canonical inventoryTransactions record'
  );

  assert(
    smCount === 0,
    '4. No mutation generates stock_movements without legacy compatibility adapter'
  );

  // -------------------------------------------------------------------------
  // TEST 5: Idempotency Protection
  // -------------------------------------------------------------------------
  console.log('🔹 Group C: Idempotency Protection');
  const duplicateSaleRes = await unifiedInventoryMutationEngine.executeIssueSale({
    tenantId: 'TEN-DEV-001',
    userId: 'USR-001',
    branchId: 'BR-MAIN',
    transactionUuid: 'TX-UUID-SALE-01', // Same UUID
    invoiceId: 'INV-SALE-001',
    warehouseId: 'WH-MAIN',
    items: [
      { productId: 'PROD-PANADOL', quantity: 10, unitPrice: 25 }
    ]
  });

  const itxCountAfterDup = await db.inventoryTransactions.count();
  const prodAfterDup = await db.products.get('PROD-PANADOL');

  assert(
    itxCountAfterDup === 1 && prodAfterDup?.stock === 40 && duplicateSaleRes[0]?.newStock === 40,
    '5. Idempotent command does not duplicate inventory movements or mutate balances twice'
  );

  // -------------------------------------------------------------------------
  // TEST 6: Non-Destructive Reversal via Compensating Movement
  // -------------------------------------------------------------------------
  console.log('🔹 Group D: Reversal Integrity');
  const revRes = await db.runTransaction(async (tx) => unifiedInventoryMutationEngine.executeReversal({
    tenantId: 'TEN-DEV-001',
    userId: 'USR-001',
    transactionUuid: 'TX-UUID-REV-01',
    originalDocumentId: 'INV-SALE-001',
    originalDocumentType: 'SALE',
    reason: 'Customer cancelled transaction'
  }, tx), [
      'products', 'inventoryTransactions', 'warehouseStock', 'branchInventory',
      'medicineBatches', 'inventory_layers', 'fifo_consumption_log'
    ], 'rw');

  const itxRecords = await db.inventoryTransactions.toArray();
  const prodAfterRev = await db.products.get('PROD-PANADOL');
  const whsAfterRev = await db.warehouseStock.where('[warehouseId+productId]').equals(['WH-MAIN', 'PROD-PANADOL']).first();

  assert(
    itxRecords.length === 2 && 
    prodAfterRev?.stock === 50 && 
    whsAfterRev?.quantity === 50 &&
    itxRecords.some(r => r.TransactionType === 'REVERSAL' && r.QuantityChange === 10),
    '6. Reversal correctly creates opposite movement (+10) without physical delete'
  );

  // -------------------------------------------------------------------------
  // TEST 7 & 9: Negative Stock Rejection & Detailed Error Shortfall
  // -------------------------------------------------------------------------
  console.log('🔹 Group E: Negative Stock Policy & Shortfall Metadata');
  let threwInsufficient = false;
  let errorMetadata: any = null;

  try {
    // Current stock is 50. Request 60 -> should fail when allowNegativeStock = false
    await unifiedInventoryMutationEngine.executeIssueSale({
      tenantId: 'TEN-DEV-001',
      userId: 'USR-001',
      transactionUuid: 'TX-UUID-SALE-EXCEED',
      invoiceId: 'INV-SALE-EXCEED',
      warehouseId: 'WH-MAIN',
      items: [
        { productId: 'PROD-PANADOL', quantity: 60 }
      ]
    });
  } catch (err: any) {
    if (err instanceof InsufficientStockError || err.name === 'InsufficientStockError') {
      threwInsufficient = true;
      errorMetadata = err.metadata;
    }
  }

  assert(
    threwInsufficient,
    '7. Negative stock rejection when allowNegativeStock=false'
  );

  assert(
    errorMetadata && errorMetadata.beforeWarehouseQty === 50 && errorMetadata.requested === 60,
    '9. InsufficientStockError contains exact shortfall metadata (available: 50, requested: 60)'
  );

  // -------------------------------------------------------------------------
  // TEST 8: Controlled Negative Balance When Explicitly Enabled (No Clamping)
  // -------------------------------------------------------------------------
  console.log('🔹 Group F: Controlled Negative Balance (No Clamping)');
  await configurationService.set('inventory.allowNegativeStock', true, { userId: 'admin' } as any);

  const negSaleRes = await unifiedInventoryMutationEngine.executeIssueSale({
    tenantId: 'TEN-DEV-001',
    userId: 'USR-001',
    transactionUuid: 'TX-UUID-SALE-NEG',
    invoiceId: 'INV-SALE-NEG',
    warehouseId: 'WH-MAIN',
    items: [
      { productId: 'PROD-PANADOL', quantity: 60 } // 50 - 60 = -10
    ]
  });

  const prodNeg = await db.products.get('PROD-PANADOL');
  const whsNeg = await db.warehouseStock.where('[warehouseId+productId]').equals(['WH-MAIN', 'PROD-PANADOL']).first();

  assert(
    negSaleRes[0]?.newStock === -10 && prodNeg?.stock === -10 && whsNeg?.quantity === -10,
    '8. Controlled negative balance when allowNegativeStock=true (stock correctly reaches -10, no clamping)'
  );

  // Reset allowNegativeStock to false for remaining tests
  await configurationService.set('inventory.allowNegativeStock', false, { userId: 'admin' } as any);

  // Reset Panadol stock back to 50 for clean testing
  await unifiedInventoryMutationEngine.executeReceivePurchase({
    tenantId: 'TEN-DEV-001',
    userId: 'USR-001',
    transactionUuid: 'TX-UUID-RESET-50',
    invoiceId: 'INV-PURCH-RESET',
    warehouseId: 'WH-MAIN',
    items: [
      { productId: 'PROD-PANADOL', quantity: 60, unitCost: 15 } // -10 + 60 = 50
    ]
  });

  // -------------------------------------------------------------------------
  // TEST 10: ProductNotFoundError
  // -------------------------------------------------------------------------
  console.log('🔹 Group G: Product & Warehouse Validation Errors');
  let threwNotFound = false;
  try {
    await unifiedInventoryMutationEngine.executeIssueSale({
      tenantId: 'TEN-DEV-001',
      userId: 'USR-001',
      transactionUuid: 'TX-UUID-NOTFOUND',
      invoiceId: 'INV-NF',
      warehouseId: 'WH-MAIN',
      items: [
        { productId: 'NON_EXISTENT_PRODUCT_XYZ', quantity: 5 }
      ]
    });
  } catch (err: any) {
    if (err instanceof ProductNotFoundError || err.name === 'ProductNotFoundError') {
      threwNotFound = true;
    }
  }

  assert(
    threwNotFound,
    '10. ProductNotFoundError thrown for invalid product'
  );

  // -------------------------------------------------------------------------
  // TEST 11: ProductInactiveError
  // -------------------------------------------------------------------------
  let threwInactive = false;
  try {
    await unifiedInventoryMutationEngine.executeIssueSale({
      tenantId: 'TEN-DEV-001',
      userId: 'USR-001',
      transactionUuid: 'TX-UUID-INACTIVE',
      invoiceId: 'INV-INACT',
      warehouseId: 'WH-MAIN',
      items: [
        { productId: 'PROD-INACTIVE', quantity: 5 }
      ]
    });
  } catch (err: any) {
    if (err instanceof ProductInactiveError || err.name === 'ProductInactiveError') {
      threwInactive = true;
    }
  }

  assert(
    threwInactive,
    '11. ProductInactiveError thrown for inactive product'
  );

  // -------------------------------------------------------------------------
  // TEST 12: InvalidWarehouseError
  // -------------------------------------------------------------------------
  let threwInvalidWhs = false;
  try {
    await unifiedInventoryMutationEngine.executeIssueSale({
      tenantId: 'TEN-DEV-001',
      userId: 'USR-001',
      transactionUuid: 'TX-UUID-INV-WHS',
      invoiceId: 'INV-WHS-ERR',
      warehouseId: '   ', // blank
      items: [
        { productId: 'PROD-PANADOL', quantity: 5 }
      ]
    });
  } catch (err: any) {
    if (err instanceof InvalidWarehouseError || err.name === 'InvalidWarehouseError') {
      threwInvalidWhs = true;
    }
  }

  assert(
    threwInvalidWhs,
    '12. InvalidWarehouseError thrown for invalid warehouse'
  );

  // -------------------------------------------------------------------------
  // TEST 13: Accounting Period Lock Blocks Mutation
  // -------------------------------------------------------------------------
  console.log('🔹 Group H: Governance & Period Locks');
  const lockedDate = '2025-01-15T00:00:00.000Z';
  await db.accountingPeriods.add({
    id: 'PERIOD-2025-01',
    Name: 'January 2025',
    Start_Date: '2025-01-01T00:00:00.000Z',
    End_Date: '2025-01-31T23:59:59.999Z',
    Is_Locked: true,
    Locked_At: new Date().toISOString()
  } as any);

  let threwPeriodLock = false;
  try {
    await unifiedInventoryMutationEngine.executeIssueSale({
      tenantId: 'TEN-DEV-001',
      userId: 'USR-001',
      transactionUuid: 'TX-UUID-LOCKED-PERIOD',
      invoiceId: 'INV-LOCKED',
      warehouseId: 'WH-MAIN',
      timestamp: lockedDate,
      items: [
        { productId: 'PROD-PANADOL', quantity: 5 }
      ]
    });
  } catch (err: any) {
    if (err instanceof PeriodLockedInventoryError || err.name === 'PeriodLockedInventoryError') {
      threwPeriodLock = true;
    }
  }

  assert(
    threwPeriodLock,
    '13. Period lock blocks mutation and throws PeriodLockedInventoryError'
  );

  // -------------------------------------------------------------------------
  // TEST 14: Atomic Rollback on Failure Leaves State Untouched
  // -------------------------------------------------------------------------
  console.log('🔹 Group I: Transaction Atomicity');
  const prodBeforeAtomic = (await db.products.get('PROD-PANADOL'))?.stock;
  const itxBeforeAtomic = await db.inventoryTransactions.count();

  // Multi-item transaction where 1st item is valid, but 2nd item fails (inactive or non-existent)
  let threwAtomicErr = false;
  try {
    await unifiedInventoryMutationEngine.executeIssueSale({
      tenantId: 'TEN-DEV-001',
      userId: 'USR-001',
      transactionUuid: 'TX-UUID-ATOMIC-FAIL',
      invoiceId: 'INV-ATOMIC',
      warehouseId: 'WH-MAIN',
      items: [
        { productId: 'PROD-PANADOL', quantity: 5 }, // Valid item
        { productId: 'NON_EXISTENT_PROD', quantity: 5 } // Invalid item -> fails!
      ]
    });
  } catch {
    threwAtomicErr = true;
  }

  const prodAfterAtomic = (await db.products.get('PROD-PANADOL'))?.stock;
  const itxAfterAtomic = await db.inventoryTransactions.count();

  assert(
    threwAtomicErr && prodBeforeAtomic === prodAfterAtomic && itxBeforeAtomic === itxAfterAtomic,
    '14. Atomic rollback on failure leaves state untouched (no partial updates)'
  );

  // -------------------------------------------------------------------------
  // TEST 15: Batch & Expiry Subsystem Coordination
  // -------------------------------------------------------------------------
  console.log('🔹 Group J: Pharmaceutical Batch & FIFO Subsystems');
  await unifiedInventoryMutationEngine.executeReceivePurchase({
    tenantId: 'TEN-DEV-001',
    userId: 'USR-001',
    transactionUuid: 'TX-UUID-PURCH-BATCH',
    invoiceId: 'INV-PURCH-BATCH-001',
    warehouseId: 'WH-MAIN',
    items: [
      {
        productId: 'PROD-PANADOL',
        quantity: 100,
        unitCost: 12,
        batchNumber: 'BATCH-PAN-999',
        expiryDate: '2027-12-31'
      }
    ]
  });

  const batches = await db.medicineBatches.where('productId').equals('PROD-PANADOL').toArray();
  const createdBatch = batches.find(b => b.batchNumber === 'BATCH-PAN-999');

  assert(
    createdBatch !== undefined && createdBatch.quantity === 100 && createdBatch.expiryDate === '2027-12-31',
    '15. Batch / expiry updates coordinate with medicineBatches accurately'
  );

  // -------------------------------------------------------------------------
  // TEST 16: FIFO Layer Addition Coordination
  // -------------------------------------------------------------------------
  const layers = await db.inventory_layers.where('item_id').equals('PROD-PANADOL').toArray();
  const fifoLayer = layers.find(l => l.reference_id === 'INV-PURCH-BATCH-001');

  assert(
    fifoLayer !== undefined && fifoLayer.quantity_remaining === 100 && fifoLayer.unit_cost === 12,
    '16. FIFO layer addition on purchase coordinates with inventory_layers'
  );

  // -------------------------------------------------------------------------
  // FINAL SCORECARD
  // -------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log(`🏁 TEST SUITE FINISHED: ${passed} / ${passed + failed} PASSED`);
  if (failed === 0) {
    console.log('🏆 ALL 16 INVENTORY FOUNDATION GATES PASSED PERFECTLY!');
  } else {
    console.error(`💥 ${failed} TESTS FAILED! Review details above.`);
  }
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Unhandled test suite error:', err);
  process.exit(1);
});
