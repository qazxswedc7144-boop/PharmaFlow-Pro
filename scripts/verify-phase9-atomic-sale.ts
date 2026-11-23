
// scripts/verify-phase9-atomic-sale.ts
import { AtomicPostSaleService } from "../server/modules/accounting/services/atomicPostSale.service";
import { SyncProcessorService } from "../server/modules/sync/sync-processor.service";
import { SyncIdempotencyService } from "../server/modules/sync/sync-idempotency.service";
import { SyncChangelogService } from "../server/modules/sync/sync-changelog.service";
import { prisma } from "../server/database/prisma";
import { SYNC_PROTOCOL_VERSION } from "../server/modules/sync/sync.types";

async function runVerification() {
  console.log("🚀 STARTING PHASE 9: POST_SALE ATOMIC COMMAND VERIFICATION\n");
  if (typeof prisma.enable === 'function') {
    prisma.enable();
  }

  const tenantId = "TENANT_VERIFY_9";
  const userId = "USR_VERIFY_9";
  const deviceId = "DEV_VERIFY_9";
  const branchId = "BR_VERIFY_9";

  // 1. SETUP: Ensure the verified branch and product exist
  console.log("Step 1: Setting up environment...");
  await prisma.branch.upsert({
    where: { id: branchId },
    update: {},
    create: {
      id: branchId,
      tenantId,
      code: "VERIFY-PHASE9",
      name: "Phase 9 Verification Branch",
      isActive: true
    }
  });
  const productId = "550e8400-e29b-41d4-a716-446655440000"; // Valid UUID
  const partnerId = "550e8400-e29b-41d4-a716-446655440001"; // Valid UUID
  await prisma.product.create({
    data: {
      id: productId,
      name: "Verify Product",
      sku: `SKU-${Date.now()}`,
      basePrice: 100,
      costPrice: 60,
      stockQuantity: 100,
      tenantId
    }
  });

  // Create an initial aggregate batch and its matching durable FIFO layer.
  const initialBatch = await prisma.inventoryBatch.create({
    data: {
      productId,
      batchNumber: "B999",
      initialQty: 100,
      stockQuantity: 100,
      cost: 60,
      expiryDate: new Date("2030-01-01"),
      tenantId
    }
  });
  await prisma.inventoryLayer.create({
    data: {
      tenantId,
      productId,
      batchId: initialBatch.id,
      batchNumber: initialBatch.batchNumber,
      sourceReferenceId: "VERIFY-PHASE9-BASELINE",
      sourceReferenceType: "TEST_FIXTURE",
      sourceKey: "verify-phase9:initial-batch",
      quantityInitial: 100,
      quantityRemaining: 100,
      unitCost: 60,
      expiryDate: initialBatch.expiryDate,
      isLegacyBaseline: true,
      branchId
    }
  });

  // 2. TEST: SUCCESSFUL POST_SALE
  console.log("\nStep 2: Testing Successful POST_SALE...");
  const invoiceNumber = `INV-POST-${Date.now()}`;
  const payload = {
    invoiceNumber,
    type: "SALE",
    partnerId,
    partnerType: "CUSTOMER",
    totalAmount: 200,
    status: "CONFIRMED",
    paymentStatus: "PAID",
    documentStatus: "POSTED",
    items: [
      {
        productId,
        qty: 2,
        price: 100,
        note: "Verification sale"
      }
    ]
  };

  const result = await AtomicPostSaleService.executePostSaleCommand({
    payload,
    tenantId,
    branchId,
    userId,
    ipAddress: "127.0.0.1"
  });

  if (result.success) {
    console.log("✅ POST_SALE execution success.");
    console.log(`   Invoice ID: ${result.invoiceId}`);
    console.log(`   Journal ID: ${result.journalId}`);
    console.log(`   COGS: ${result.cogs}`);
    console.log(`   Sync Effects: ${result.effects.length}`);
  } else {
    throw new Error("POST_SALE execution failed.");
  }

  // 3. TEST: IDEMPOTENCY (In-memory)
  console.log("\nStep 3: Testing Idempotency (SyncProcessor level)...");
  const idempotencyKey = `idem-verify-${Date.now()}`;
  const envelope = {
    tenantId,
    branchId,
    userId,
    deviceId,
    schemaVersion: SYNC_PROTOCOL_VERSION,
    mutations: [
      {
        id: "mut-1",
        entity: "SALE",
        operation: "POST",
        payload: { ...payload, invoiceNumber: `${invoiceNumber}-DUP` },
        idempotencyKey,
        version: 1
      }
    ]
  };

  const syncRes1 = await SyncProcessorService.processBatch({
    envelope: envelope as any,
    authenticatedTenantId: tenantId,
    authenticatedUserId: userId,
    authenticatedUserRole: "ADMIN"
  });
  console.log(`   Push 1 Status: ${syncRes1.results[0].status}`);

  const syncRes2 = await SyncProcessorService.processBatch({
    envelope: envelope as any,
    authenticatedTenantId: tenantId,
    authenticatedUserId: userId,
    authenticatedUserRole: "ADMIN"
  });
  console.log(`   Push 2 Status: ${syncRes2.results[0].status}`);

  if (syncRes2.results[0].status === "DUPLICATE") {
    console.log("✅ Idempotency check PASSED (Sequential same-process).");
  } else {
    console.error("❌ Idempotency check FAILED (Sequential same-process).");
  }

  // 4. TEST: IMMUTABILITY VIOLATION (Raw INVOICE sync path)
  console.log("\nStep 4: Testing Immutability Violation (Raw INVOICE sync path)...");
  const updatePayload = {
    id: result.invoiceId,
    invoiceNumber: `${invoiceNumber}-TAMPERED`,
    totalAmount: 1 // Malicious update
  };

  const syncRes3 = await SyncProcessorService.processBatch({
    envelope: {
      ...envelope,
      mutations: [
        {
          id: "mut-tamper",
          entity: "INVOICE",
          operation: "UPDATE",
          payload: updatePayload,
          idempotencyKey: `idem-tamper-${Date.now()}`,
          version: 2
        }
      ]
    } as any,
    authenticatedTenantId: tenantId,
    authenticatedUserId: userId,
    authenticatedUserRole: "ADMIN"
  });

  const reFetchedInvoice = await prisma.invoice.findUnique({ where: { id: result.invoiceId } });
  if (reFetchedInvoice?.totalAmount === 1) {
    console.error("❌ IMMUTABILITY FAILURE: POSTED invoice was overwritten by raw sync update.");
  } else {
    console.log("✅ Immutability check PASSED.");
  }

  // 5. TEST: PRICE TAMPERING (Command level)
  console.log("\nStep 5: Testing Price Tampering in POST_SALE...");
  const tamperedPayload = {
    ...payload,
    invoiceNumber: `INV-TAMPER-${Date.now()}`,
    totalAmount: 2,
    items: [
      {
        productId,
        qty: 2,
        price: 1, // Tampered price
        note: "Tampered sale"
      }
    ]
  };

  try {
    await AtomicPostSaleService.executePostSaleCommand({
      payload: tamperedPayload,
      tenantId,
      branchId,
      userId,
      ipAddress: "127.0.0.1"
    });
    console.error("❌ PRICE TAMPERING VULNERABILITY: Server accepted tampered line price.");
  } catch (err: any) {
    console.log(`✅ Price tampering blocked or detected? Error: ${err.message}`);
  }

  console.log("\n🏁 VERIFICATION COMPLETE.");
}

runVerification()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("\n💥 VERIFICATION CRASHED:", err);
    process.exit(1);
  });
