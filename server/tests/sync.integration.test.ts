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
}, { includeSyncRoutes: true });
