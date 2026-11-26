import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { definePostgresHttpSuite, request } from "./helpers/postgres-http.integration.helpers.js";

definePostgresHttpSuite("Real PostgreSQL HTTP — Sync", (getContext) => {
  it("registers a device and executes Sync Push/Pull over real HTTP with PostgreSQL persistence", async () => {
    const ctx = getContext();
    const logMemory = (stage: string) => {
      const memory = process.memoryUsage();
      console.info(`[PostgreSQL HTTP] Sync test ${stage} (MB):`, {
        rss: Math.round(memory.rss / 1024 / 1024),
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
      });
    };
    logMemory("started");
    const { prisma } = await import("../database/prisma.js");
    const deviceId = `ci-device-${ctx.suffix}`;
    logMemory("before device registration");
    const registration = await request(ctx, "/api/v1/sync/device/register", {
      method: "POST",
      token: ctx.tokenA,
      body: {
        deviceId,
        deviceName: "CI Integration Device",
        branchId: ctx.branchAId,
        appVersion: "ci",
        schemaVersion: 1,
      },
    });

    expect(registration.status, JSON.stringify(registration.body)).toBe(200);
    expect(registration.body.success).toBe(true);
    logMemory("after device registration");

    const persistedDevice = await prisma.deviceRegistration.findUnique({ where: { deviceId } });
    expect(persistedDevice?.tenantId).toBe(ctx.tenantAId);
    expect(persistedDevice?.branchId).toBe(ctx.branchAId);

    const customerId = randomUUID();
    const mutationId = randomUUID();
    const mutationKey = randomUUID();
    logMemory("before push request");
    const push = await request(ctx, "/api/v1/sync/push", {
      method: "POST",
      token: ctx.tokenA,
      body: {
        deviceId,
        branchId: ctx.branchAId,
        schemaVersion: 1,
        mutations: [{
          id: mutationId,
          entity: "CUSTOMER",
          entityId: customerId,
          operation: "CREATE",
          payload: { name: "CI Sync Customer", phone: "0000000000", balance: 0 },
          idempotencyKey: mutationKey,
          timestamp: Date.now(),
          version: 1,
        }],
      },
    });

    expect(push.status, JSON.stringify(push.body)).toBe(200);
    expect(push.body.results?.[0]?.status).toBe("SUCCESS");
    logMemory("after push request");

    const persistedCustomer = await prisma.customer.findUnique({ where: { id: customerId } });
    expect(persistedCustomer?.tenantId).toBe(ctx.tenantAId);
    expect(persistedCustomer?.name).toBe("CI Sync Customer");

    const persistedIdempotency = await prisma.idempotencyKey.findFirst({
      where: { tenantId: ctx.tenantAId, key: `${ctx.tenantAId}:${deviceId}:${mutationKey}` },
    });
    expect(persistedIdempotency).toBeTruthy();

    const persistedChange = await prisma.syncEvent.findFirst({
      where: {
        tenantId: ctx.tenantAId,
        deviceId,
        entityType: "CUSTOMER",
        entityId: customerId,
        eventType: "CREATE",
      },
    });
    expect(persistedChange?.userId).toBe(ctx.userAId);

    logMemory("before pull request");
    const pull = await request(ctx, "/api/v1/sync/pull", {
      method: "POST",
      token: ctx.tokenA,
      body: { cursor: 0, batchSize: 100 },
    });
    expect(pull.status, JSON.stringify(pull.body)).toBe(200);
    expect(pull.body.success).toBe(true);
    logMemory("after pull request");
    expect(pull.body.tenantId).toBe(ctx.tenantAId);
    expect(pull.body.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ entity: "CUSTOMER", entityId: customerId })])
    );
  });

  it("creates a POSTED PURCHASE and its inventory graph through SyncProcessorService, then deduplicates an exact replay", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const { DeviceService } = await import("../modules/sync/device.service.js");
    const { SyncProcessorService } = await import("../modules/sync/sync-processor.service.js");

    const deviceId = `ci-purchase-device-${ctx.suffix}`;
    await DeviceService.registerDevice({
      deviceId,
      deviceName: "CI Purchase Sync Device",
      tenantId: ctx.tenantAId,
      branchId: ctx.branchAId,
      userId: ctx.userAId,
      appVersion: "ci",
      schemaVersion: 1
    });

    const supplier = await prisma.supplier.create({
      data: { tenantId: ctx.tenantAId, name: `CI Purchase Supplier ${ctx.suffix}` }
    });
    const invoiceId = randomUUID();
    const partialInvoiceId = randomUUID();
    const partialMutationId = randomUUID();
    const partialIdempotencyKey = randomUUID();
    const mutationId = randomUUID();
    const idempotencyKey = randomUUID();
    const batchNumber = `PURCHASE-BATCH-${ctx.suffix}`;
    const expiryDate = new Date(Date.now() + 180 * 86400000).toISOString();
    const quantity = 3;
    const unitPrice = 5;
    const unitCost = 3;

    const envelope = {
      tenantId: ctx.tenantAId,
      branchId: ctx.branchAId,
      userId: ctx.userAId,
      deviceId,
      timestamp: Date.now(),
      schemaVersion: 1,
      clientVersion: "8.3.0",
      mutations: [{
        id: mutationId,
        entity: "PURCHASE",
        entityId: invoiceId,
        operation: "CREATE" as const,
        payload: {
          id: invoiceId,
          refId: invoiceId,
          tenantId: ctx.tenantAId,
          branchId: ctx.branchAId,
          purchase: {
            id: invoiceId,
            invoiceNumber: `PUR-${ctx.suffix}`,
            date: new Date().toISOString(),
            type: "PURCHASE",
            status: "CONFIRMED",
            documentStatus: "POSTED",
            partnerId: supplier.id,
            partnerType: "SUPPLIER",
            paymentStatus: "UNPAID",
            subtotal: quantity * unitPrice,
            totalAmount: quantity * unitPrice,
            isReturn: false,
            tenantId: ctx.tenantAId,
            branchId: ctx.branchAId,
            items: [{
              productId: ctx.productAId,
              quantity,
              qty: quantity,
              unitPrice,
              unitCost,
              total: quantity * unitPrice,
              batchNumber,
              expiryDate
            }]
          }
        },
        idempotencyKey,
        timestamp: Date.now(),
        version: 1
      }, {
        id: partialMutationId,
        entity: "PURCHASE",
        entityId: partialInvoiceId,
        operation: "CREATE" as const,
        payload: {
          id: partialInvoiceId,
          tenantId: ctx.tenantAId,
          branchId: ctx.branchAId,
          purchase: {
            id: partialInvoiceId,
            invoiceNumber: `PUR-PARTIAL-NO-METHOD-${ctx.suffix}`,
            date: new Date().toISOString(),
            type: "PURCHASE",
            status: "CONFIRMED",
            documentStatus: "POSTED",
            partnerId: supplier.id,
            partnerType: "SUPPLIER",
            paymentStatus: "PARTIALLY_PAID",
            paidAmount: 2,
            subtotal: 5,
            totalAmount: 5,
            isReturn: false,
            tenantId: ctx.tenantAId,
            branchId: ctx.branchAId,
            items: [{
              productId: ctx.productAId,
              quantity: 1,
              qty: 1,
              unitPrice: 5,
              unitCost: 3,
              total: 5,
              batchNumber: `PURCHASE-PARTIAL-${ctx.suffix}`,
              expiryDate
            }]
          }
        },
        idempotencyKey: partialIdempotencyKey,
        timestamp: Date.now(),
        version: 1
      }]
    };

    const beforeProduct = await prisma.product.findUnique({ where: { id: ctx.productAId } });
    const beforeBranchInventory = await prisma.branchInventory.findUnique({
      where: { branchId_productId: { branchId: ctx.branchAId, productId: ctx.productAId } }
    });
    const beforeStock = beforeProduct?.stockQuantity ?? 0;
    const beforeBranchStock = beforeBranchInventory?.stockQuantity ?? 0;

    const first = await SyncProcessorService.processBatch({
      envelope,
      authenticatedTenantId: ctx.tenantAId,
      authenticatedUserId: ctx.userAId,
      authenticatedUserRole: "ADMIN"
    });

    expect(first.results[0]?.status, JSON.stringify(first.results[0])).toBe("SUCCESS");
    expect(first.results[1]?.status, JSON.stringify(first.results[1])).toBe("REJECTED");
    expect(first.results[1]?.errorCode).toBe("PURCHASE_PAYMENT_METHOD_REQUIRED");
    expect(await prisma.invoice.count({
      where: { tenantId: ctx.tenantAId, invoiceNumber: `PUR-PARTIAL-NO-METHOD-${ctx.suffix}` }
    })).toBe(0);

    const persistedInvoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(persistedInvoice?.type).toBe("PURCHASE");
    expect(persistedInvoice?.documentStatus).toBe("POSTED");
    expect(persistedInvoice?.status).toBe("CONFIRMED");
    expect(persistedInvoice?.tenantId).toBe(ctx.tenantAId);
    expect(persistedInvoice?.branchId).toBe(ctx.branchAId);

    const persistedItems = await prisma.invoiceItem.findMany({ where: { invoiceId, tenantId: ctx.tenantAId } });
    expect(persistedItems).toHaveLength(1);
    expect(persistedItems[0].productId).toBe(ctx.productAId);
    expect(persistedItems[0].qty).toBe(quantity);
    expect(Number(persistedItems[0].cost)).toBe(unitCost);

    const movements = await prisma.inventoryMovement.findMany({
      where: { tenantId: ctx.tenantAId, referenceId: invoiceId }
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].qty).toBe(quantity);
    expect(movements[0].branchId).toBe(ctx.branchAId);

    const batches = await prisma.inventoryBatch.findMany({
      where: { tenantId: ctx.tenantAId, productId: ctx.productAId, batchNumber }
    });
    expect(batches).toHaveLength(1);
    expect(batches[0].stockQuantity).toBe(quantity);
    expect(Number(batches[0].cost)).toBe(unitCost);

    const journal = await prisma.journalEntry.findFirst({
      where: { tenantId: ctx.tenantAId, sourceId: invoiceId },
      include: { lines: true }
    });
    expect(journal).toBeTruthy();
    expect(Number(journal?.debitTotal)).toBe(Number(journal?.creditTotal));

    const afterProduct = await prisma.product.findUnique({ where: { id: ctx.productAId } });
    expect(afterProduct?.stockQuantity).toBe(beforeStock + quantity);
    const afterBranchInventory = await prisma.branchInventory.findUnique({
      where: { branchId_productId: { branchId: ctx.branchAId, productId: ctx.productAId } }
    });
    expect(afterBranchInventory?.stockQuantity).toBe(beforeBranchStock + quantity);

    const replay = await SyncProcessorService.processBatch({
      envelope,
      authenticatedTenantId: ctx.tenantAId,
      authenticatedUserId: ctx.userAId,
      authenticatedUserRole: "ADMIN"
    });
    expect(replay.results[0]?.status).toBe("DUPLICATE");

    expect(await prisma.invoice.count({ where: { id: invoiceId, tenantId: ctx.tenantAId } })).toBe(1);
    expect(await prisma.invoiceItem.count({ where: { invoiceId, tenantId: ctx.tenantAId } })).toBe(1);
    expect(await prisma.inventoryMovement.count({ where: { tenantId: ctx.tenantAId, referenceId: invoiceId } })).toBe(1);
    expect(await prisma.inventoryBatch.count({ where: { tenantId: ctx.tenantAId, productId: ctx.productAId, batchNumber } })).toBe(1);
    expect(await prisma.journalEntry.count({ where: { tenantId: ctx.tenantAId, sourceId: invoiceId } })).toBe(1);
    const replayProduct = await prisma.product.findUnique({ where: { id: ctx.productAId } });
    expect(replayProduct?.stockQuantity).toBe(beforeStock + quantity);
  });


  it("rejects TENANT_ADMIN sync to a branch without branchUser membership", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const { DeviceService } = await import("../modules/sync/device.service.js");
    const deviceId = `ci-v30s-membership-${ctx.suffix}`;
    const unassignedBranch = await prisma.branch.create({
      data: { tenantId: ctx.tenantAId, code: `V30S-${ctx.suffix}`, name: "V30S Unassigned Branch", isActive: true }
    });
    await DeviceService.registerDevice({
      deviceId, deviceName: "V30S Membership Test", tenantId: ctx.tenantAId,
      branchId: ctx.branchAId, userId: ctx.userAId, appVersion: "ci", schemaVersion: 1
    });
    const jwt = (await import("jsonwebtoken")).default;
    const { getJwtSecret } = await import("../security/jwtSecrets.js");
    const tenantAdminToken = jwt.sign({
      userId: ctx.userAId,
      username: ctx.usernameA,
      role: "TENANT_ADMIN",
      tenantId: ctx.tenantAId,
      branchId: ctx.branchAId,
      jti: randomUUID()
    }, getJwtSecret(), { algorithm: "HS256", expiresIn: "4h" });

    const response = await request(ctx, "/api/v1/sync/push", {
      method: "POST",
      token: tenantAdminToken,
      body: {
        deviceId,
        branchId: unassignedBranch.id,
        schemaVersion: 1,
        mutations: []
      }
    });
    expect(response.status).toBe(403);
    expect(response.body.errorCode).toBe("BRANCH_MEMBERSHIP_REQUIRED");
  });

  it("rejects an unknown DEVICE operation with UNKNOWN_SYNC_OPERATION", async () => {
    const ctx = getContext();
    const { DeviceService } = await import("../modules/sync/device.service.js");
    const deviceId = `ci-v30s-operation-${ctx.suffix}`;
    await DeviceService.registerDevice({
      deviceId, deviceName: "V30S Operation Test", tenantId: ctx.tenantAId,
      branchId: ctx.branchAId, userId: ctx.userAId, appVersion: "ci", schemaVersion: 1
    });
    const response = await request(ctx, "/api/v1/sync/push", {
      method: "POST",
      token: ctx.tokenA,
      body: {
        deviceId,
        branchId: ctx.branchAId,
        schemaVersion: 1,
        mutations: [{
          id: randomUUID(), entity: "DEVICE", entityId: randomUUID(), operation: "NUKE",
          payload: {}, idempotencyKey: randomUUID(), version: 1
        }]
      }
    });
    expect(response.status).toBe(400);
    expect(response.body.results[0]?.status).toBe("REJECTED");
    expect(response.body.results[0]?.errorCode).toBe("UNKNOWN_SYNC_OPERATION");
  });

  it("rejects known but unsupported entity operations with HTTP 400", async () => {
    const ctx = getContext();
    const { DeviceService } = await import("../modules/sync/device.service.js");
    const deviceId = `ci-v30s-unsupported-ops-${ctx.suffix}`;
    await DeviceService.registerDevice({
      deviceId, deviceName: "V30S Unsupported Operations Test", tenantId: ctx.tenantAId,
      branchId: ctx.branchAId, userId: ctx.userAId, appVersion: "ci", schemaVersion: 1
    });

    const unsupportedOperations = [
      ["INVOICE", "CANCEL"],
      ["PURCHASE", "POST"],
      ["JOURNAL_ENTRY", "POST"],
      ["VOUCHER", "POST"],
      ["BRANCH_TRANSFER", "POST"],
      ["STOCK_ADJUSTMENT", "POST"]
    ] as const;

    const response = await request(ctx, "/api/v1/sync/push", {
      method: "POST",
      token: ctx.tokenA,
      body: {
        deviceId,
        branchId: ctx.branchAId,
        schemaVersion: 1,
        mutations: unsupportedOperations.map(([entity, operation]) => ({
          id: randomUUID(),
          entity,
          entityId: randomUUID(),
          operation,
          payload: {},
          idempotencyKey: randomUUID(),
          version: 1
        }))
      }
    });

    expect(response.status).toBe(400);
    expect(response.body.results).toHaveLength(unsupportedOperations.length);
    for (const result of response.body.results) {
      expect(result.status).toBe("REJECTED");
      expect(result.errorCode).toBe("UNKNOWN_SYNC_OPERATION");
    }
  });

  it("rejects DELETE of a POSTED invoice through sync", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const { DeviceService } = await import("../modules/sync/device.service.js");
    const deviceId = `ci-v30s-delete-posted-${ctx.suffix}`;
    const invoiceId = randomUUID();
    await prisma.invoice.create({
      data: {
        id: invoiceId, tenantId: ctx.tenantAId, branchId: ctx.branchAId,
        invoiceNumber: `V30S-POSTED-${ctx.suffix}`, type: "SALE",
        status: "CONFIRMED", documentStatus: "POSTED", totalAmount: 100
      }
    });
    await DeviceService.registerDevice({
      deviceId, deviceName: "V30S Posted Delete Test", tenantId: ctx.tenantAId,
      branchId: ctx.branchAId, userId: ctx.userAId, appVersion: "ci", schemaVersion: 1
    });
    const response = await request(ctx, "/api/v1/sync/push", {
      method: "POST",
      token: ctx.tokenA,
      body: {
        deviceId,
        branchId: ctx.branchAId,
        schemaVersion: 1,
        mutations: [{
          id: randomUUID(), entity: "INVOICE", entityId: invoiceId, operation: "DELETE",
          payload: {}, idempotencyKey: randomUUID(), version: 1
        }]
      }
    });
    expect(response.status).toBe(403);
    expect(response.body.results[0]?.status).toBe("REJECTED");
    expect(response.body.results[0]?.errorCode).toBe("DELETION_OF_POSTED_DOCUMENT_FORBIDDEN");
    expect(await prisma.invoice.findUnique({ where: { id: invoiceId } })).toBeTruthy();
  });

  it("rolls back SALE:POST atomically on ACCOUNTING_PERIOD_LOCKED and succeeds without duplicates after period unlock", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const { DeviceService } = await import("../modules/sync/device.service.js");
    const deviceId = `ci-period-sale-post-${ctx.suffix}`;
    await DeviceService.registerDevice({
      deviceId,
      deviceName: "CI Period Sale Post Device",
      tenantId: ctx.tenantAId,
      branchId: ctx.branchAId,
      userId: ctx.userAId,
      appVersion: "ci",
      schemaVersion: 1
    });

    const invoiceNumber = `SYNC-SALE-LOCKED-${ctx.suffix}`;
    const mutationId = randomUUID();
    const idempotencyKey = randomUUID();
    const beforeProduct = await prisma.product.findUnique({ where: { id: ctx.productAId } });
    const beforeLayers = await prisma.inventoryLayer.findMany({
      where: { tenantId: ctx.tenantAId, productId: ctx.productAId }
    });
    const beforeRemaining = beforeLayers.reduce((sum, l) => sum + l.quantityRemaining, 0);

    const locked = await request(ctx, "/api/accounting/periods/CI-DEFAULT-A/lock", {
      method: "PATCH",
      token: ctx.tokenA
    });
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);

    const pushBody = {
      deviceId,
      branchId: ctx.branchAId,
      schemaVersion: 1,
      mutations: [{
        id: mutationId,
        entity: "SALE",
        entityId: mutationId,
        operation: "POST",
        payload: {
          invoiceNumber,
          type: "SALE",
          partnerType: "CUSTOMER",
          totalAmount: 10,
          paymentStatus: "UNPAID",
          items: [{ productId: ctx.productAId, qty: 1, price: 10 }]
        },
        idempotencyKey,
        timestamp: Date.now(),
        version: 1
      }]
    };

    try {
      const rejected = await request(ctx, "/api/v1/sync/push", {
        method: "POST",
        token: ctx.tokenA,
        body: pushBody
      });

      expect(rejected.status, JSON.stringify(rejected.body)).toBe(400);
      expect(rejected.body.success).toBe(false);
      expect(rejected.body.results?.[0]?.status).toBe("FAILED");
      expect(rejected.body.results?.[0]?.errorCode).toBe("ACCOUNTING_PERIOD_LOCKED");

      // Strict PostgreSQL atomicity: no leaked DRAFT invoice, items, journals, or FIFO mutations
      expect(await prisma.invoice.count({
        where: { tenantId: ctx.tenantAId, invoiceNumber }
      })).toBe(0);
      expect(await prisma.invoiceItem.count({
        where: { tenantId: ctx.tenantAId, invoice: { invoiceNumber } }
      })).toBe(0);
      const afterRejectProduct = await prisma.product.findUnique({ where: { id: ctx.productAId } });
      expect(afterRejectProduct?.stockQuantity).toBe(beforeProduct?.stockQuantity);
      const afterRejectLayers = await prisma.inventoryLayer.findMany({
        where: { tenantId: ctx.tenantAId, productId: ctx.productAId }
      });
      expect(afterRejectLayers.reduce((sum, l) => sum + l.quantityRemaining, 0)).toBe(beforeRemaining);
    } finally {
      const unlocked = await request(ctx, "/api/accounting/periods/CI-DEFAULT-A/unlock", {
        method: "PATCH",
        token: ctx.tokenA
      });
      expect(unlocked.status, JSON.stringify(unlocked.body)).toBe(200);
    }

    // Retry with the exact original mutationId and idempotencyKey after unlocking the period
    const retried = await request(ctx, "/api/v1/sync/push", {
      method: "POST",
      token: ctx.tokenA,
      body: pushBody
    });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.success).toBe(true);
    expect(retried.body.results?.[0]?.status).toBe("SUCCESS");

    const postedInvoice = await prisma.invoice.findFirst({
      where: { tenantId: ctx.tenantAId, invoiceNumber }
    });
    expect(postedInvoice).toBeTruthy();
    expect(postedInvoice?.status).toBe("CONFIRMED");
    expect(postedInvoice?.documentStatus).toBe("POSTED");

    expect(await prisma.journalEntry.count({
      where: { tenantId: ctx.tenantAId, sourceId: postedInvoice!.id }
    })).toBe(1);
    expect(await prisma.inventoryMovement.count({
      where: { tenantId: ctx.tenantAId, referenceId: postedInvoice!.id }
    })).toBe(1);
    expect(await prisma.fifoConsumption.count({
      where: { tenantId: ctx.tenantAId, saleId: postedInvoice!.id }
    })).toBe(1);

    const afterPostProduct = await prisma.product.findUnique({ where: { id: ctx.productAId } });
    expect(afterPostProduct?.stockQuantity).toBe((beforeProduct?.stockQuantity ?? 0) - 1);

    // Replaying the exact same mutation returns DUPLICATE and does not duplicate journals or FIFO
    const replay = await request(ctx, "/api/v1/sync/push", {
      method: "POST",
      token: ctx.tokenA,
      body: pushBody
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.results?.[0]?.status).toBe("DUPLICATE");
    expect(await prisma.invoice.count({ where: { tenantId: ctx.tenantAId, invoiceNumber } })).toBe(1);
    expect(await prisma.journalEntry.count({ where: { tenantId: ctx.tenantAId, sourceId: postedInvoice!.id } })).toBe(1);
    expect(await prisma.inventoryMovement.count({ where: { tenantId: ctx.tenantAId, referenceId: postedInvoice!.id } })).toBe(1);
    expect(await prisma.fifoConsumption.count({ where: { tenantId: ctx.tenantAId, saleId: postedInvoice!.id } })).toBe(1);
    const afterReplayProduct = await prisma.product.findUnique({ where: { id: ctx.productAId } });
    expect(afterReplayProduct?.stockQuantity).toBe((beforeProduct?.stockQuantity ?? 0) - 1);
  });

  it("preserves ACCOUNTING_PERIOD_LOCKED and rolls back PURCHASE:CREATE and VOUCHER:CREATE, then succeeds on retry after unlock", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const { DeviceService } = await import("../modules/sync/device.service.js");
    const deviceId = `ci-period-purchase-voucher-${ctx.suffix}`;
    await DeviceService.registerDevice({
      deviceId,
      deviceName: "CI Period Purchase Voucher Device",
      tenantId: ctx.tenantAId,
      branchId: ctx.branchAId,
      userId: ctx.userAId,
      appVersion: "ci",
      schemaVersion: 1
    });

    const supplier = await prisma.supplier.create({
      data: { tenantId: ctx.tenantAId, name: `CI Locked Period Supplier ${ctx.suffix}` }
    });
    const purchaseInvoiceId = randomUUID();
    const purchaseInvoiceNumber = `SYNC-PUR-LOCKED-${ctx.suffix}`;
    const purchaseMutationId = randomUUID();
    const purchaseIdemKey = randomUUID();
    const voucherId = randomUUID();
    const voucherMutationId = randomUUID();
    const voucherIdemKey = randomUUID();
    const batchNumber = `LOCKED-PUR-BATCH-${ctx.suffix}`;
    const expiryDate = new Date(Date.now() + 180 * 86400000).toISOString();

    const locked = await request(ctx, "/api/accounting/periods/CI-DEFAULT-A/lock", {
      method: "PATCH",
      token: ctx.tokenA
    });
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);

    const purchasePushBody = {
      deviceId,
      branchId: ctx.branchAId,
      schemaVersion: 1,
      mutations: [{
        id: purchaseMutationId,
        entity: "PURCHASE",
        entityId: purchaseInvoiceId,
        operation: "CREATE",
        payload: {
          id: purchaseInvoiceId,
          tenantId: ctx.tenantAId,
          branchId: ctx.branchAId,
          purchase: {
            id: purchaseInvoiceId,
            invoiceNumber: purchaseInvoiceNumber,
            date: new Date().toISOString(),
            type: "PURCHASE",
            status: "CONFIRMED",
            documentStatus: "POSTED",
            partnerId: supplier.id,
            partnerType: "SUPPLIER",
            paymentStatus: "UNPAID",
            subtotal: 12,
            totalAmount: 12,
            isReturn: false,
            tenantId: ctx.tenantAId,
            branchId: ctx.branchAId,
            items: [{
              productId: ctx.productAId,
              quantity: 2,
              qty: 2,
              unitPrice: 6,
              unitCost: 6,
              total: 12,
              batchNumber,
              expiryDate
            }]
          }
        },
        idempotencyKey: purchaseIdemKey,
        timestamp: Date.now(),
        version: 1
      }]
    };

    try {
      const purchaseRejected = await request(ctx, "/api/v1/sync/push", {
        method: "POST",
        token: ctx.tokenA,
        body: purchasePushBody
      });
      expect(purchaseRejected.status, JSON.stringify(purchaseRejected.body)).toBe(400);
      expect(purchaseRejected.body.results?.[0]?.status).toBe("REJECTED");
      expect(purchaseRejected.body.results?.[0]?.errorCode).toBe("ACCOUNTING_PERIOD_LOCKED");
      expect(await prisma.invoice.count({ where: { id: purchaseInvoiceId, tenantId: ctx.tenantAId } })).toBe(0);
      expect(await prisma.invoiceItem.count({ where: { invoiceId: purchaseInvoiceId, tenantId: ctx.tenantAId } })).toBe(0);
      expect(await prisma.journalEntry.count({ where: { sourceId: purchaseInvoiceId, tenantId: ctx.tenantAId } })).toBe(0);

      const voucherRejected = await request(ctx, "/api/v1/sync/push", {
        method: "POST",
        token: ctx.tokenA,
        body: {
          deviceId,
          branchId: ctx.branchAId,
          schemaVersion: 1,
          mutations: [{
            id: voucherMutationId,
            entity: "VOUCHER",
            entityId: voucherId,
            operation: "CREATE",
            payload: {
              id: voucherId,
              paymentNumber: `VCH-LOCKED-${ctx.suffix}`,
              date: new Date().toISOString(),
              amount: 10,
              type: "PAYMENT",
              partnerType: "SUPPLIER",
              partnerId: supplier.id,
              paymentMethod: "CASH",
              tenantId: ctx.tenantAId,
              branchId: ctx.branchAId
            },
            idempotencyKey: voucherIdemKey,
            timestamp: Date.now(),
            version: 1
          }]
        }
      });
      expect(voucherRejected.status, JSON.stringify(voucherRejected.body)).toBe(400);
      expect(voucherRejected.body.results?.[0]?.status).toBe("REJECTED");
      expect(voucherRejected.body.results?.[0]?.errorCode).toBe("ACCOUNTING_PERIOD_LOCKED");
      expect(await prisma.payment.count({ where: { id: voucherId, tenantId: ctx.tenantAId } })).toBe(0);
    } finally {
      const unlocked = await request(ctx, "/api/accounting/periods/CI-DEFAULT-A/unlock", {
        method: "PATCH",
        token: ctx.tokenA
      });
      expect(unlocked.status, JSON.stringify(unlocked.body)).toBe(200);
    }

    // Retry PURCHASE:CREATE with original mutationId and idempotencyKey after unlocking
    const purchaseRetried = await request(ctx, "/api/v1/sync/push", {
      method: "POST",
      token: ctx.tokenA,
      body: purchasePushBody
    });
    expect(purchaseRetried.status, JSON.stringify(purchaseRetried.body)).toBe(200);
    expect(purchaseRetried.body.results?.[0]?.status).toBe("SUCCESS");
    expect(await prisma.invoice.count({ where: { id: purchaseInvoiceId, tenantId: ctx.tenantAId } })).toBe(1);
    expect(await prisma.journalEntry.count({ where: { sourceId: purchaseInvoiceId, tenantId: ctx.tenantAId } })).toBe(1);

    const purchaseReplay = await request(ctx, "/api/v1/sync/push", {
      method: "POST",
      token: ctx.tokenA,
      body: purchasePushBody
    });
    expect(purchaseReplay.status, JSON.stringify(purchaseReplay.body)).toBe(200);
    expect(purchaseReplay.body.results?.[0]?.status).toBe("DUPLICATE");
    expect(await prisma.journalEntry.count({ where: { sourceId: purchaseInvoiceId, tenantId: ctx.tenantAId } })).toBe(1);
  });

}, { includeSyncRoutes: true, includeAccountingRoutes: true });

