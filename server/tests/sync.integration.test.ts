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
        },
        idempotencyKey,
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

}, { includeSyncRoutes: true });
