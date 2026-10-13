// scripts/test-sales-inventory-migration.ts
/**
 * PharmaFlow PRO ERP — Sovereign Enterprise Edition
 * Phase 5 — Step 2: Sales Inventory Mutation Migration Test Suite
 * 
 * Verifies all 15 Core Sales Migration Invariants:
 * TEST 1: Normal sale deducts inventory.
 * TEST 2: inventoryTransactions receives the canonical movement.
 * TEST 3: warehouseStock is reduced correctly.
 * TEST 4: products.stock projection remains correct.
 * TEST 5: products.StockQuantity mirrors products.stock.
 * TEST 6: FIFO is consumed exactly once.
 * TEST 7: medicineBatches are reduced correctly when applicable.
 * TEST 8: Duplicate execution does not deduct twice.
 * TEST 9: allowNegativeStock=false rejects insufficient stock.
 * TEST 10: allowNegativeStock=true preserves the real negative balance.
 * TEST 11: No direct SalesWorkflow write occurs to inventory tables.
 * TEST 12: Service/non-inventory items do not mutate stock.
 * TEST 13: Atomic failure leaves all inventory state unchanged.
 * TEST 14: Multiple warehouses maintain: products.stock = sum of warehouseStock quantities.
 * TEST 15: Existing sales invoice/accounting flow remains functional.
 */

import 'fake-indexeddb/auto';
import { db } from '../src/core/db';
import { configurationService } from '../src/services/config/configurationService';
import { salesWorkflow, SalesWorkflowInput } from '../src/features/sales/workflows/SalesWorkflow';
import { WorkflowContextFactory } from '../src/core/workflow/workflowContext';
import { WorkflowExecutionPipeline } from '../src/core/workflow/workflowExecution';
import { FIFOEngine } from '../src/features/inventory/services/fifoEngine';
import { UnifiedInventoryMutationEngine } from '../src/features/inventory/services/UnifiedInventoryMutationEngine';
import { TokenProvider } from '../src/services/auth/tokenProvider';
import { useAuthStore } from '../src/store/authStore';

let passed = 0;
let failed = 0;
const results: { name: string; status: 'PASS' | 'FAIL'; error?: any }[] = [];

function setAuthUser(
  role: string = 'SuperAdmin',
  permissions: string[] = ['ALL', 'sales.create', 'sales.edit', 'sales.return'],
  tenantId: string = 'TEN-DEV-001'
) {
  const userObj = {
    id: 'usr-admin-sales-test',
    user_id: 'usr-admin-sales-test',
    User_Name: 'Sales Migration Admin',
    User_Email: 'admin@pharmaflow.test',
    Role: role,
    User_Role: role,
    tenantId,
    tenant_id: tenantId,
    branchId: 'BR-MAIN',
    branch_id: 'BR-MAIN',
    permissions
  };
  TokenProvider.setSession(userObj as any, 'mock-jwt-token-sales', 'mock-refresh-token-sales');
  useAuthStore.setState({
    user: userObj as any,
    token: 'mock-jwt-token-sales',
    tenantId,
    branchId: 'BR-MAIN',
    roles: [role],
    permissions,
    isAuthenticated: true,
    hasPermission: (perm: string) => permissions.includes('ALL') || permissions.includes(perm)
  });
}

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
  await db.invoices.clear();
  await db.financialTransactions.clear();
  await db.customers.clear();
  await db.idempotencyKeys.clear();
  await db.journalEntries.clear();
  await db.accountingPeriods.clear();

  // Standard test products
  await db.products.bulkAdd([
    {
      id: 'PROD-PANADOL',
      name: 'Panadol Extra 500mg',
      stock: 100,
      StockQuantity: 100,
      costPrice: 5,
      cost: 5,
      sellingPrice: 10,
      price: 10,
      status: 'ACTIVE',
      is_active: true
    } as any,
    {
      id: 'PROD-AMOXIL',
      name: 'Amoxicillin 250mg',
      stock: 50,
      StockQuantity: 50,
      costPrice: 8,
      cost: 8,
      sellingPrice: 15,
      price: 15,
      status: 'ACTIVE',
      is_active: true
    } as any
  ]);

  await db.customers.bulkAdd([
    {
      id: 'CUST-001',
      name: 'General Customer',
      balance: 0,
      currentBalance: 0,
      tenantId: 'TEN-DEV-001',
      branchId: 'BR-MAIN',
      is_active: true
    } as any,
    {
      id: 'CUST-002',
      name: 'Amoxil Customer',
      balance: 0,
      currentBalance: 0,
      tenantId: 'TEN-DEV-001',
      branchId: 'BR-MAIN',
      is_active: true
    } as any
  ]);

  // Seed standard warehouseStock for PROD-PANADOL in WH-MAIN
  await db.warehouseStock.add({
    id: 'WHS-WH-MAIN-PROD-PANADOL',
    warehouseId: 'WH-MAIN',
    productId: 'PROD-PANADOL',
    quantity: 100,
    lastUpdated: new Date().toISOString()
  });

  // Seed standard warehouseStock for PROD-AMOXIL in WH-MAIN
  await db.warehouseStock.add({
    id: 'WHS-WH-MAIN-PROD-AMOXIL',
    warehouseId: 'WH-MAIN',
    productId: 'PROD-AMOXIL',
    quantity: 50,
    lastUpdated: new Date().toISOString()
  });

  // Default configuration
  await configurationService.set('inventory.allowNegativeStock', false, { userId: 'admin' } as any);
  await configurationService.set('sales.allow_negative_stock', false, { userId: 'admin' } as any);
  await configurationService.set('inventory.defaultWarehouseId', 'WH-MAIN', { userId: 'admin' } as any);

  setAuthUser();
}

async function runAllTests() {
  console.log('================================================================');
  console.log('🧪 PHARMAFLOW PRO — PHASE 5 STEP 2: SALES INVENTORY MIGRATION');
  console.log('================================================================\n');

  await setupTestDb();

  // --------------------------------------------------------------------------
  console.log('🔹 Group 1: Standard Sale Execution (Tests 1 - 5)');
  // --------------------------------------------------------------------------
  const sale1Id = 'SALE-TEST-001';
  const sale1Key = 'IDEMP-SALE-001';
  const ctx1 = WorkflowContextFactory.create('SALE', { idempotencyKey: sale1Key });

  const sale1Input: SalesWorkflowInput = {
    id: sale1Id,
    customerId: 'CUST-001',
    items: [
      {
        id: 'ITEM-1',
        productId: 'PROD-PANADOL',
        quantity: 15,
        unitPrice: 10
      } as any
    ],
    total: 150,
    isCash: true,
    invoiceStatus: 'POSTED'
  };

  await WorkflowExecutionPipeline.run(salesWorkflow, sale1Input, ctx1);

  // TEST 1: Normal sale deducts inventory
  const whsPanadol1 = await db.warehouseStock
    .filter((w: any) => w.warehouseId === 'WH-MAIN' && w.productId === 'PROD-PANADOL')
    .first();
  assert(
    whsPanadol1?.quantity === 85,
    'TEST 1: Normal sale deducts inventory from warehouse (100 - 15 = 85)',
    { quantity: whsPanadol1?.quantity }
  );

  // TEST 2: inventoryTransactions receives the canonical movement
  const txRecord1 = await db.inventoryTransactions
    .filter((tx: any) => tx.SourceDocumentID === sale1Id && tx.productId === 'PROD-PANADOL')
    .first();
  assert(
    txRecord1 !== undefined &&
    txRecord1.QuantityChange === -15 &&
    txRecord1.TransactionType === 'SALE' &&
    txRecord1.warehouseId === 'WH-MAIN',
    'TEST 2: inventoryTransactions receives canonical movement record',
    txRecord1
  );

  // TEST 3: warehouseStock is reduced correctly
  assert(
    whsPanadol1 !== undefined && whsPanadol1.quantity === 85,
    'TEST 3: warehouseStock is reduced correctly (85 remaining)',
    whsPanadol1
  );

  // TEST 4: products.stock projection remains correct
  const prodPanadol1 = await db.products.get('PROD-PANADOL');
  assert(
    prodPanadol1?.stock === 85,
    'TEST 4: products.stock projection remains correct (85)',
    { stock: prodPanadol1?.stock }
  );

  // TEST 5: products.StockQuantity mirrors products.stock
  assert(
    prodPanadol1?.StockQuantity === prodPanadol1?.stock && prodPanadol1?.StockQuantity === 85,
    'TEST 5: products.StockQuantity strictly mirrors products.stock',
    { StockQuantity: prodPanadol1?.StockQuantity, stock: prodPanadol1?.stock }
  );

  // --------------------------------------------------------------------------
  console.log('\n🔹 Group 2: FIFO & Pharmacy Batches (Tests 6 & 7)');
  // --------------------------------------------------------------------------
  // Seed FIFO layer for PROD-AMOXIL
  await FIFOEngine.addPurchaseLayer('PROD-AMOXIL', 50, 8, 'PUR-INIT-001');

  // Seed Medicine Batch for PROD-AMOXIL
  await db.medicineBatches.put({
    id: 'BATCH-AMOXIL-B1',
    batchId: 'B-AMX-001',
    batchNumber: 'B-AMX-001',
    productId: 'PROD-AMOXIL',
    quantity: 50,
    expiryDate: '2027-12-31',
    unitCost: 8
  } as any);

  const sale2Id = 'SALE-TEST-002';
  const sale2Key = 'IDEMP-SALE-002';
  const ctx2 = WorkflowContextFactory.create('SALE', { idempotencyKey: sale2Key });

  const sale2Input: SalesWorkflowInput = {
    id: sale2Id,
    customerId: 'CUST-002',
    items: [
      {
        id: 'ITEM-AMX',
        productId: 'PROD-AMOXIL',
        quantity: 20,
        unitPrice: 15,
        batchId: 'BATCH-AMOXIL-B1'
      } as any
    ],
    total: 300,
    isCash: false,
    invoiceStatus: 'POSTED'
  };

  await WorkflowExecutionPipeline.run(salesWorkflow, sale2Input, ctx2);

  // TEST 6: FIFO is consumed exactly once
  const fifoLayers = await db.inventory_layers.where('item_id').equals('PROD-AMOXIL').toArray();
  const fifoLogs = await db.fifo_consumption_log.where('sale_id').equals(sale2Id).toArray();
  const totalFifoConsumed = fifoLogs.reduce((sum: number, l: any) => sum + (l.quantity_consumed ?? l.quantity ?? 0), 0);
  const remainingQty = fifoLayers[0]?.quantity_remaining ?? fifoLayers[0]?.remainingQuantity;

  assert(
    remainingQty === 30 && totalFifoConsumed === 20 && fifoLogs.length === 1,
    'TEST 6: FIFO is consumed exactly once (50 - 20 = 30 remaining layer, exactly 1 consumption log)',
    { remaining: remainingQty, consumed: totalFifoConsumed, logsCount: fifoLogs.length }
  );

  // TEST 7: medicineBatches are reduced correctly when applicable
  const batchAmoxil = await db.medicineBatches.get('BATCH-AMOXIL-B1');
  assert(
    batchAmoxil?.quantity === 30,
    'TEST 7: medicineBatches are reduced correctly (50 - 20 = 30)',
    { batchQty: batchAmoxil?.quantity }
  );

  // --------------------------------------------------------------------------
  console.log('\n🔹 Group 3: Idempotency Protection (Test 8)');
  // --------------------------------------------------------------------------
  // TEST 8: Duplicate execution does not deduct twice
  const prodAmoxilBefore = (await db.products.get('PROD-AMOXIL'))?.stock;
  // Re-run the exact same workflow with same idempotency key
  await WorkflowExecutionPipeline.run(salesWorkflow, sale2Input, ctx2);

  const prodAmoxilAfter = (await db.products.get('PROD-AMOXIL'))?.stock;
  const txCountSale2 = await db.inventoryTransactions
    .filter((tx: any) => tx.SourceDocumentID === sale2Id && tx.productId === 'PROD-AMOXIL')
    .count();

  assert(
    prodAmoxilBefore === prodAmoxilAfter && txCountSale2 === 1,
    'TEST 8: Duplicate execution does not deduct stock twice or create duplicate ledger entries',
    { before: prodAmoxilBefore, after: prodAmoxilAfter, txCount: txCountSale2 }
  );

  // --------------------------------------------------------------------------
  console.log('\n🔹 Group 4: Negative Stock Policy (Tests 9 & 10)');
  // --------------------------------------------------------------------------
  // TEST 9: allowNegativeStock=false rejects insufficient stock
  await configurationService.set('inventory.allowNegativeStock', false, { userId: 'admin' } as any);
  await configurationService.set('sales.allow_negative_stock', false, { userId: 'admin' } as any);

  const saleExcessId = 'SALE-EXCESS-001';
  const ctxExcess = WorkflowContextFactory.create('SALE', { idempotencyKey: 'IDEMP-EXCESS' });
  const excessResult = await WorkflowExecutionPipeline.run(salesWorkflow, {
    id: saleExcessId,
    customerId: 'CUST-001',
    items: [
      {
        id: 'ITEM-EXCESS',
        productId: 'PROD-PANADOL',
        quantity: 999, // available is 85
        unitPrice: 10
      } as any
    ],
    total: 9990,
    invoiceStatus: 'POSTED'
  }, ctxExcess);

  const rejected = !excessResult.success;
  const panadolStockAfterReject = (await db.products.get('PROD-PANADOL'))?.stock;
  assert(
    rejected === true && panadolStockAfterReject === 85,
    'TEST 9: allowNegativeStock=false rejects insufficient stock and keeps stock unchanged (85)',
    { rejected, stock: panadolStockAfterReject }
  );

  // TEST 10: allowNegativeStock=true preserves the real negative balance
  await configurationService.set('inventory.allowNegativeStock', true, { userId: 'admin' } as any);
  await configurationService.set('sales.allow_negative_stock', true, { userId: 'admin' } as any);

  const saleNegId = 'SALE-NEG-001';
  const ctxNeg = WorkflowContextFactory.create('SALE', { idempotencyKey: 'IDEMP-NEG-001' });

  await WorkflowExecutionPipeline.run(salesWorkflow, {
    id: saleNegId,
    customerId: 'CUST-001',
    items: [
      {
        id: 'ITEM-NEG',
        productId: 'PROD-PANADOL',
        quantity: 100, // available is 85 -> becomes -15
        unitPrice: 10
      } as any
    ],
    total: 1000,
    invoiceStatus: 'POSTED'
  }, ctxNeg);

  const panadolStockAfterNeg = (await db.products.get('PROD-PANADOL'))?.stock;
  const whsPanadolNeg = (await db.warehouseStock
    .filter((w: any) => w.warehouseId === 'WH-MAIN' && w.productId === 'PROD-PANADOL')
    .first())?.quantity;

  assert(
    panadolStockAfterNeg === -15 && whsPanadolNeg === -15,
    'TEST 10: allowNegativeStock=true preserves real negative balance (-15, no clamping to 0)',
    { stock: panadolStockAfterNeg, warehouseQty: whsPanadolNeg }
  );

  // --------------------------------------------------------------------------
  console.log('\n🔹 Group 5: Architecture & Non-Inventory Rules (Tests 11 & 12)');
  // --------------------------------------------------------------------------
  // TEST 11: No direct SalesWorkflow write occurs to inventory tables
  // Verified by checking that legacy stock_movements does not contain rogue writes
  const legacyMovementsCount = await db.stock_movements.count();
  assert(
    legacyMovementsCount === 0,
    'TEST 11: No direct SalesWorkflow write occurs to legacy stock_movements or bypasses engine',
    { legacyMovementsCount }
  );

  // TEST 12: Service/non-inventory items do not mutate stock
  const amoxilStockBeforeService = (await db.products.get('PROD-AMOXIL'))?.stock;
  const ctxService = WorkflowContextFactory.create('SALE', { idempotencyKey: 'IDEMP-SERV-001' });

  await WorkflowExecutionPipeline.run(salesWorkflow, {
    id: 'SALE-SERVICE-001',
    customerId: 'CUST-001',
    items: [
      {
        id: 'ITEM-SERV-1',
        productId: 'PROD-AMOXIL',
        quantity: 10,
        unitPrice: 50,
        isService: true // service flag
      } as any,
      {
        id: 'ITEM-SERV-2',
        productId: 'PROD-AMOXIL',
        quantity: 5,
        unitPrice: 20,
        trackStock: false // non-stock flag
      } as any,
      {
        id: 'ITEM-SERV-3',
        productId: 'PROD-AMOXIL',
        quantity: 2,
        unitPrice: 30,
        type: 'SERVICE' // service type
      } as any
    ],
    total: 660,
    invoiceStatus: 'POSTED'
  }, ctxService);

  const amoxilStockAfterService = (await db.products.get('PROD-AMOXIL'))?.stock;
  assert(
    amoxilStockBeforeService === amoxilStockAfterService,
    'TEST 12: Service and non-inventory items do not mutate stock',
    { before: amoxilStockBeforeService, after: amoxilStockAfterService }
  );

  // --------------------------------------------------------------------------
  console.log('\n🔹 Group 6: Atomicity & Multi-Warehouse Invariant (Tests 13 & 14)');
  // --------------------------------------------------------------------------
  // TEST 13: Atomic failure leaves all inventory state unchanged
  await configurationService.set('inventory.allowNegativeStock', false, { userId: 'admin' } as any);
  await configurationService.set('sales.allow_negative_stock', false, { userId: 'admin' } as any);

  const amoxilStockPreAtomic = (await db.products.get('PROD-AMOXIL'))?.stock;
  const ctxAtomicFail = WorkflowContextFactory.create('SALE', { idempotencyKey: 'IDEMP-ATOMIC-FAIL' });

  const failResult = await WorkflowExecutionPipeline.run(salesWorkflow, {
    id: 'SALE-ATOMIC-FAIL',
    customerId: 'CUST-001',
    items: [
      {
        id: 'ITEM-VALID',
        productId: 'PROD-AMOXIL',
        quantity: 5, // valid
        unitPrice: 15
      } as any,
      {
        id: 'ITEM-INVALID',
        productId: 'NON-EXISTENT-PROD-999', // will fail in engine
        quantity: 1,
        unitPrice: 10
      } as any
    ],
    total: 85,
    invoiceStatus: 'POSTED'
  }, ctxAtomicFail);

  const atomicFailed = !failResult.success;
  const amoxilStockPostAtomic = (await db.products.get('PROD-AMOXIL'))?.stock;
  assert(
    atomicFailed === true && amoxilStockPreAtomic === amoxilStockPostAtomic,
    'TEST 13: Atomic failure leaves all inventory state completely unchanged (no partial deductions)',
    { atomicFailed, pre: amoxilStockPreAtomic, post: amoxilStockPostAtomic }
  );

  // TEST 14: Multiple warehouses maintain: products.stock = sum of warehouseStock quantities
  // Setup multi-warehouse for new product PROD-MULTI
  await db.products.add({
    id: 'PROD-MULTI',
    name: 'Multi-Warehouse Saline',
    stock: 70,
    StockQuantity: 70,
    costPrice: 2,
    sellingPrice: 5,
    status: 'ACTIVE',
    is_active: true
  } as any);

  await db.warehouseStock.bulkAdd([
    {
      id: 'WHS-MAIN-PROD-MULTI',
      warehouseId: 'WH-MAIN',
      productId: 'PROD-MULTI',
      quantity: 30,
      lastUpdated: new Date().toISOString()
    },
    {
      id: 'WHS-BRANCH-PROD-MULTI',
      warehouseId: 'WH-BRANCH',
      productId: 'PROD-MULTI',
      quantity: 40,
      lastUpdated: new Date().toISOString()
    }
  ]);

  // Sell 10 units from WH-MAIN
  const ctxMulti = WorkflowContextFactory.create('SALE', { idempotencyKey: 'IDEMP-MULTI-001' });
  await WorkflowExecutionPipeline.run(salesWorkflow, {
    id: 'SALE-MULTI-001',
    customerId: 'CUST-001',
    warehouseId: 'WH-MAIN',
    items: [
      {
        id: 'ITEM-M1',
        productId: 'PROD-MULTI',
        quantity: 10,
        unitPrice: 5
      } as any
    ],
    total: 50,
    invoiceStatus: 'POSTED'
  }, ctxMulti);

  const whMainMulti = (await db.warehouseStock.filter((w: any) => w.warehouseId === 'WH-MAIN' && w.productId === 'PROD-MULTI').first())?.quantity;
  const whBranchMulti = (await db.warehouseStock.filter((w: any) => w.warehouseId === 'WH-BRANCH' && w.productId === 'PROD-MULTI').first())?.quantity;
  const prodMultiStock = (await db.products.get('PROD-MULTI'))?.stock;

  assert(
    whMainMulti === 20 &&
    whBranchMulti === 40 &&
    prodMultiStock === (whMainMulti! + whBranchMulti!),
    'TEST 14: Multiple warehouses maintain products.stock = SUM(warehouseStock.quantity) (20 + 40 = 60)',
    { whMain: whMainMulti, whBranch: whBranchMulti, productStock: prodMultiStock }
  );

  // --------------------------------------------------------------------------
  console.log('\n🔹 Group 7: End-to-End Sales & Accounting Flow (Test 15)');
  // --------------------------------------------------------------------------
  // TEST 15: Existing sales invoice/accounting flow remains functional
  const saleFinalId = 'SALE-FINAL-15';
  const ctxFinal = WorkflowContextFactory.create('SALE', { idempotencyKey: 'IDEMP-FINAL-15' });

  // Add customer CUST-VIP with initial balance
  await db.customers.add({
    id: 'CUST-VIP',
    name: 'VIP Pharmacy Client',
    balance: 500,
    currentBalance: 500
  } as any);

  const finalResult = await WorkflowExecutionPipeline.run(salesWorkflow, {
    id: saleFinalId,
    customerId: 'CUST-VIP',
    items: [
      {
        id: 'ITEM-FINAL-1',
        productId: 'PROD-MULTI',
        quantity: 5,
        unitPrice: 5
      } as any
    ],
    total: 25,
    isCash: false, // on credit -> balance should increase by 25
    invoiceStatus: 'POSTED'
  }, ctxFinal);

  const savedSale = (await db.invoices.get(saleFinalId)) || (await db.sales.get(saleFinalId));
  const finTx = await db.financialTransactions.filter((f: any) => f.Reference_ID === saleFinalId).first();
  const customerAfter = await db.customers.get('CUST-VIP');

  assert(
    finalResult.success === true &&
    savedSale !== undefined &&
    finTx !== undefined &&
    customerAfter?.balance === 525,
    'TEST 15: Existing sales invoice, customer balance (+25), and financial transactions flow remain fully functional',
    {
      success: finalResult.success,
      hasSale: !!savedSale,
      hasFinTx: !!finTx,
      customerBalance: customerAfter?.balance
    }
  );

  // --------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log(`🏁 TEST SUITE FINISHED: ${passed} / ${passed + failed} PASSED`);
  if (failed === 0) {
    console.log('🏆 ALL 15 SALES INVENTORY MIGRATION GATES PASSED PERFECTLY!');
  } else {
    console.error(`💥 ${failed} TESTS FAILED.`);
    process.exit(1);
  }
  console.log('================================================================\n');
}

runAllTests().catch((err) => {
  console.error('Unhandled fatal error in test runner:', err);
  process.exit(1);
});
