import { expect, it } from "vitest";
import { definePostgresHttpSuite, request } from "./helpers/postgres-http.integration.helpers.js";

definePostgresHttpSuite("Real PostgreSQL HTTP — Tenant Isolation + Invoice Posting", (getContext) => {
  it("prevents tenant A from reading tenant B invoice through the authenticated HTTP API", async () => {
    const ctx = getContext();
    const denied = await request(ctx, `/api/invoices/${ctx.invoiceBId}`, { token: ctx.tokenA });
    expect(denied.status).toBe(404);
    expect(denied.body.error).toBe("NOT_FOUND");

    const allowed = await request(ctx, `/api/invoices/${ctx.invoiceBId}`, { token: ctx.tokenB });
    expect(allowed.status).toBe(200);
    expect(allowed.body.invoice.tenantId).toBe(ctx.tenantBId);
  });

  it("returns only the authenticated tenant's sales policy", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");

    await prisma.tenantSalesPolicy.upsert({
      where: { tenantId: ctx.tenantAId },
      create: { tenantId: ctx.tenantAId, maxDiscountPercent: 7, taxRatePercent: 15, taxMode: "EXCLUSIVE" },
      update: { maxDiscountPercent: 7, taxRatePercent: 15, taxMode: "EXCLUSIVE" },
    });
    await prisma.tenantSalesPolicy.upsert({
      where: { tenantId: ctx.tenantBId },
      create: { tenantId: ctx.tenantBId, maxDiscountPercent: 2, taxRatePercent: 5, taxMode: "INCLUSIVE" },
      update: { maxDiscountPercent: 2, taxRatePercent: 5, taxMode: "INCLUSIVE" },
    });

    try {
      const policyA = await request(ctx, "/api/invoices/sales-policy", { token: ctx.tokenA });
      const policyB = await request(ctx, "/api/invoices/sales-policy", { token: ctx.tokenB });

      expect(policyA.status).toBe(200);
      expect(policyA.body.policy.tenantId).toBe(ctx.tenantAId);
      expect(policyA.body.policy.maxDiscountPercent).toBe("7");
      expect(policyA.body.policy.taxMode).toBe("EXCLUSIVE");

      expect(policyB.status).toBe(200);
      expect(policyB.body.policy.tenantId).toBe(ctx.tenantBId);
      expect(policyB.body.policy.maxDiscountPercent).toBe("2");
      expect(policyB.body.policy.taxMode).toBe("INCLUSIVE");
    } finally {
      await prisma.tenantSalesPolicy.deleteMany({
        where: { tenantId: { in: [ctx.tenantAId, ctx.tenantBId] } }
      });
    }
  });

  it("posts a persisted Draft through HTTP and verifies FIFO stock plus balanced PostgreSQL ledger rows", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const created = await request(ctx, "/api/invoices/create", {
      method: "POST",
      token: ctx.tokenA,
      body: {
        invoiceNumber: `FIFO-SALE-${ctx.suffix}`,
        type: "SALE",
        totalAmount: 9999,
        paymentStatus: "PAID",
        items: [{ productId: ctx.productAId, qty: 2, price: 10 }],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.success).toBe(true);
    const draft = created.body.invoice;
    expect(draft.status).toBe("DRAFT");
    expect(draft.documentStatus).toBe("ACTIVE");
    expect(Number(draft.totalAmount)).toBe(20);
    expect(draft.items).toHaveLength(1);

    const posted = await request(ctx, "/api/invoices/post", {
      method: "POST",
      token: ctx.tokenA,
      body: { invoiceId: draft.id },
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.success).toBe(true);

    const replicationAudit = await prisma.auditLog.findFirst({
      where: {
        action: "REPLICATION_PUBLISHED",
        entity: "ReplicationEvent",
        userId: ctx.userAId,
      },
    });
    expect(replicationAudit).toBeTruthy();

    const storedInvoice = await prisma.invoice.findUnique({ where: { id: draft.id } });
    expect(storedInvoice?.status).toBe("CONFIRMED");
    expect(storedInvoice?.documentStatus).toBe("POSTED");

    const storedProduct = await prisma.product.findUnique({ where: { id: ctx.productAId } });
    const storedBatch = await prisma.inventoryBatch.findFirst({
      where: { tenantId: ctx.tenantAId, productId: ctx.productAId },
    });
    expect(storedProduct?.stockQuantity).toBe(4);
    expect(storedBatch?.stockQuantity).toBe(4);

    const movement = await prisma.inventoryMovement.findFirst({
      where: { tenantId: ctx.tenantAId, referenceId: draft.id, type: "STOCK_OUT" },
    });
    expect(movement?.qty).toBe(-2);

    const journal = await prisma.journalEntry.findFirst({
      where: { tenantId: ctx.tenantAId, sourceId: draft.id, sourceType: "INVOICE" },
      include: { lines: true },
    });
    expect(journal).toBeTruthy();
    expect(Number(journal?.debitTotal)).toBe(26);
    expect(Number(journal?.creditTotal)).toBe(26);
    expect(journal?.lines.length).toBe(4);

    const retry = await request(ctx, "/api/invoices/post", {
      method: "POST",
      token: ctx.tokenA,
      body: { invoiceId: draft.id },
    });
    expect(retry.status).toBe(400);

    const journalCount = await prisma.journalEntry.count({
      where: { tenantId: ctx.tenantAId, sourceId: draft.id, sourceType: "INVOICE" },
    });
    const movementCount = await prisma.inventoryMovement.count({
      where: { tenantId: ctx.tenantAId, referenceId: draft.id, type: "STOCK_OUT" },
    });
    expect(journalCount).toBe(1);
    expect(movementCount).toBe(1);
  });


  it("posts SALE tax separately to the tenant tax-payable account without changing FIFO behavior", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");

    await prisma.tenantSalesPolicy.upsert({
      where: { tenantId: ctx.tenantAId },
      create: {
        tenantId: ctx.tenantAId,
        maxDiscountPercent: 10,
        taxRatePercent: 15,
        taxMode: "EXCLUSIVE",
      },
      update: {
        maxDiscountPercent: 10,
        taxRatePercent: 15,
        taxMode: "EXCLUSIVE",
      },
    });

    const created = await request(ctx, "/api/invoices/create", {
      method: "POST",
      token: ctx.tokenA,
      body: {
        invoiceNumber: `TAX-SALE-${ctx.suffix}`,
        type: "SALE",
        totalAmount: 1,
        paymentStatus: "UNPAID",
        discountPercent: 10,
        items: [{ productId: ctx.productAId, qty: 1, price: 10 }],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(Number(created.body.invoice.subtotalAmount)).toBe(10);
    expect(Number(created.body.invoice.discountAmount)).toBe(1);
    expect(Number(created.body.invoice.taxAmount)).toBe(1.35);
    expect(Number(created.body.invoice.totalAmount)).toBe(10.35);

    const posted = await request(ctx, "/api/invoices/post", {
      method: "POST",
      token: ctx.tokenA,
      body: { invoiceId: created.body.invoice.id },
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);

    const journal = await prisma.journalEntry.findFirst({
      where: { tenantId: ctx.tenantAId, sourceId: created.body.invoice.id, sourceType: "INVOICE" },
      include: { lines: { include: { account: true } } },
    });
    expect(journal).toBeTruthy();
    // The journal includes the balanced FIFO COGS / inventory pair in addition to the sale settlement.
    expect(Number(journal?.debitTotal)).toBe(13.35);
    expect(Number(journal?.creditTotal)).toBe(13.35);
    expect(journal?.lines.some((line) => line.account.code === "401001" && Number(line.credit) === 9)).toBe(true);
    expect(journal?.lines.some((line) => line.account.code === "203001" && Number(line.credit) === 1.35)).toBe(true);
  });

  it("persists lock acquire, extend, and release audit events in PostgreSQL", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const { LockingService } = await import("../modules/locking/locking.service.js");
    const lockKey = `ci-audit-lock-${ctx.suffix}`;

    const lock = await LockingService.acquireLock({
      key: lockKey,
      branchId: ctx.branchAId,
      ttl: 30000,
      lockType: "GENERIC",
      ownerId: ctx.userAId,
    });
    expect(lock).toBeTruthy();

    try {
      const extended = await LockingService.extendLock(
        lockKey,
        lock!.id,
        ctx.branchAId,
        45000,
        ctx.userAId,
      );
      expect(extended).toBe(true);

      const released = await LockingService.releaseLock(
        lockKey,
        lock!.id,
        ctx.branchAId,
        ctx.userAId,
      );
      expect(released).toBe(true);

      const auditRows = await prisma.auditLog.findMany({
        where: { entity: "DistributedLock", entityId: lock!.id },
        orderBy: { timestamp: "asc" },
        select: { action: true },
      });
      expect(auditRows.map((row) => row.action)).toEqual([
        "LOCK_ACQUIRED",
        "LOCK_EXTENDED",
        "LOCK_RELEASED",
      ]);
    } finally {
      if (await LockingService.isLocked(lockKey, ctx.branchAId)) {
        await LockingService.releaseLock(lockKey, lock!.id, ctx.branchAId, ctx.userAId);
      }
    }
  });
}, { includeInvoiceRoutes: true });

