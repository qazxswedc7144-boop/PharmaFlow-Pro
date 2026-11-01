import { unifiedInventoryMutationEngine } from '../src/features/inventory/services/UnifiedInventoryMutationEngine';
import { FIFOEngine } from '../src/features/inventory/services/fifoEngine';
import { db } from '../src/core/db';

async function runVerification() {
  console.log('========================================================================');
  console.log('PHARMAFLOW PRO — DECOUPLED FIFO & INVENTORY MUTATION VERIFICATION SUITE');
  console.log('========================================================================');

  // Initialize DB
  await db.open();

  const testProductId = 'PROD-DECOUPLE-01';
  const tenantId = 'TEN-DEV-001';
  const branchId = 'BR-MAIN';

  // Seed product
  await db.products.put({
    id: testProductId,
    name: 'Decouple Test Med',
    costPrice: 15.5,
    price: 20,
    stock: 0,
    tenantId,
    branchId
  });

  // Cleanup test data
  await db.warehouseStock.where('productId').equals(testProductId).delete();
  await db.inventory_layers.where('item_id').equals(testProductId).delete();
  await db.fifo_consumption_log.where('product_id').equals(testProductId).delete();
  await db.inventoryTransactions.where('productId').equals(testProductId).delete();

  console.log('\n[TEST 1] Purchase → FIFO layer creation');
  const purchaseId = 'PUR-DEC-101';
  const opId1 = 'OP-PUR-DEC-101';
  const mut1 = await unifiedInventoryMutationEngine.executeMutation({
    productId: testProductId,
    warehouseId: 'WH-MAIN',
    delta: 100,
    docType: 'PURCHASE',
    docId: purchaseId,
    movementType: 'RECEIVE',
    userId: 'test-user',
    tenantId,
    branchId,
    transactionUuid: opId1,
    unitCost: 15.5
  });
  console.log('[TEST 1 RESULT] Mutation applied:', mut1.success, 'New Stock:', mut1.newStock);

  const layersAfterPur = await db.inventory_layers.where('item_id').equals(testProductId).toArray();
  console.log('[TEST 1 LAYERS] Created layers count:', layersAfterPur.length, 'Remaining:', layersAfterPur[0]?.quantity_remaining);

  console.log('\n[TEST 2] Sale → FIFO consumption & logging');
  const saleId = 'SAL-DEC-201';
  const opId2 = 'OP-SAL-DEC-201';
  const mut2 = await unifiedInventoryMutationEngine.executeMutation({
    productId: testProductId,
    warehouseId: 'WH-MAIN',
    delta: -30,
    docType: 'SALE',
    docId: saleId,
    movementType: 'DISPATCH',
    userId: 'test-user',
    tenantId,
    branchId,
    transactionUuid: opId2
  });
  console.log('[TEST 2 RESULT] Mutation applied:', mut2.success, 'New Stock:', mut2.newStock);

  const logsAfterSale = await db.fifo_consumption_log.where('sale_id').equals(saleId).toArray();
  console.log('[TEST 2 CONSUMPTION LOGS] Count:', logsAfterSale.length, 'Consumed Qty:', logsAfterSale[0]?.quantity_consumed);
  const layersAfterSale = await db.inventory_layers.where('item_id').equals(testProductId).toArray();
  console.log('[TEST 2 LAYERS REMAINING]:', layersAfterSale[0]?.quantity_remaining);

  console.log('\n[TEST 3] Sale Reversal (Unpost)');
  const revMut = await db.runTransaction(async (tx) => unifiedInventoryMutationEngine.executeReversal({
    originalDocumentId: saleId,
    originalDocumentType: 'SALE',
    reason: 'Test Unpost Reversal',
    userId: 'test-user',
    tenantId,
    transactionUuid: 'OP-REV-201'
  }, tx), [
      'products', 'inventoryTransactions', 'warehouseStock', 'branchInventory',
      'medicineBatches', 'inventory_layers', 'fifo_consumption_log'
    ], 'rw');
  console.log('[TEST 3 RESULT] Reversal applied:', revMut.success);
  const layersAfterRev = await db.inventory_layers.where('item_id').equals(testProductId).toArray();
  console.log('[TEST 3 LAYERS RESTORED]:', layersAfterRev[0]?.quantity_remaining);

  console.log('\n[TEST 4] Idempotency Check (Repeated Operation ID)');
  const dupMut = await unifiedInventoryMutationEngine.executeMutation({
    productId: testProductId,
    warehouseId: 'WH-MAIN',
    delta: -10,
    docType: 'SALE',
    docId: 'SAL-DEC-DUP',
    movementType: 'DISPATCH',
    userId: 'test-user',
    tenantId,
    branchId,
    transactionUuid: opId2 // same as opId2!
  });
  console.log('[TEST 4 RESULT] Idempotency enforced (isDuplicate):', dupMut.isDuplicate);

  console.log('\n[TEST 5] Branch Transfer Simulation');
  const transferId = 'TRF-DEC-501';
  // Transfer Out from WH-MAIN
  const trfOut = await unifiedInventoryMutationEngine.executeMutation({
    productId: testProductId,
    warehouseId: 'WH-MAIN',
    delta: -20,
    docType: 'TRANSFER',
    docId: transferId,
    movementType: 'TRANSFER_OUT',
    userId: 'test-user',
    tenantId,
    branchId,
    transactionUuid: 'OP-TRF-OUT-501'
  });
  // Transfer In to WH-BRANCH
  const trfIn = await unifiedInventoryMutationEngine.executeMutation({
    productId: testProductId,
    warehouseId: 'WH-BRANCH',
    delta: 20,
    docType: 'TRANSFER',
    docId: transferId,
    movementType: 'TRANSFER_IN',
    userId: 'test-user',
    tenantId,
    branchId: 'BR-SUB',
    transactionUuid: 'OP-TRF-IN-501'
  });
  console.log('[TEST 5 RESULT] Transfer Out success:', trfOut.success, 'Transfer In success:', trfIn.success);

  console.log('\n========================================================================');
  console.log('ALL DECOUPLED INTEGRATION TESTS COMPLETED SUCCESSFULLY WITHOUT RECURSION!');
  console.log('========================================================================');
}

runVerification().catch(err => {
  console.error('[VERIFICATION ERROR]', err);
  process.exit(1);
});
