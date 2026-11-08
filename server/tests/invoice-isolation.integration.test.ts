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
        items: [{ productId: ctx.productAId, qty: 2, price: 9999 }],
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
}, { includeInvoiceRoutes: true });

