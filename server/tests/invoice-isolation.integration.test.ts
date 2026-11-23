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
      branchId: ctx.branchAId,
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
      branchId: ctx.branchAId,
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
      branchId: ctx.branchAId,
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
      branchId: ctx.branchAId,
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
      branchId: ctx.branchAId,
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


  it("posts real PURCHASE and SALE invoices, then reports supplier liability and revenue as credit balances over HTTP", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const supplier = await prisma.supplier.create({
      data: { tenantId: ctx.tenantAId, name: `CI Trial Balance Supplier ${ctx.suffix}` }
    });
    const openingSupplierAccount = await prisma.account.findFirst({
      where: { tenantId: ctx.tenantAId, code: "201001" },
      select: { balance: true }
    });
    const openingRevenueAccount = await prisma.account.findFirst({
      where: { tenantId: ctx.tenantAId, code: "401001" },
      select: { balance: true }
    });
    const openingSupplierBalance = Number(openingSupplierAccount?.balance ?? 0);
    const openingRevenueBalance = Number(openingRevenueAccount?.balance ?? 0);

    const purchase = await request(ctx, "/api/invoices/create", {
      method: "POST",
      token: ctx.tokenA,
      branchId: ctx.branchAId,
      body: {
        invoiceNumber: `TB-PUR-${ctx.suffix}`,
        type: "PURCHASE",
        partnerId: supplier.id,
        partnerType: "SUPPLIER",
        totalAmount: 8,
        paymentStatus: "UNPAID",
        items: [{ productId: ctx.productAId, qty: 2, price: 4 }]
      }
    });
    expect(purchase.status, JSON.stringify(purchase.body)).toBe(201);
    expect(purchase.body.invoice.status).toBe("DRAFT");

    const purchasePost = await request(ctx, "/api/invoices/post", {
      method: "POST",
      token: ctx.tokenA,
      branchId: ctx.branchAId,
      body: { invoiceId: purchase.body.invoice.id }
    });
    expect(purchasePost.status, JSON.stringify(purchasePost.body)).toBe(200);

    const sale = await request(ctx, "/api/invoices/create", {
      method: "POST",
      token: ctx.tokenA,
      branchId: ctx.branchAId,
      body: {
        invoiceNumber: `TB-SALE-${ctx.suffix}`,
        type: "SALE",
        totalAmount: 10,
        paymentStatus: "UNPAID",
        items: [{ productId: ctx.productAId, qty: 1, price: 10 }]
      }
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const salePost = await request(ctx, "/api/invoices/post", {
      method: "POST",
      token: ctx.tokenA,
      branchId: ctx.branchAId,
      body: { invoiceId: sale.body.invoice.id }
    });
    expect(salePost.status, JSON.stringify(salePost.body)).toBe(200);

    const [purchaseJournal, saleJournal] = await Promise.all([
      prisma.journalEntry.findFirst({
        where: { tenantId: ctx.tenantAId, sourceId: purchase.body.invoice.id, sourceType: "INVOICE", status: "POSTED" },
        include: { lines: { include: { account: true } } }
      }),
      prisma.journalEntry.findFirst({
        where: { tenantId: ctx.tenantAId, sourceId: sale.body.invoice.id, sourceType: "INVOICE", status: "POSTED" },
        include: { lines: { include: { account: true } } }
      })
    ]);
    expect(purchaseJournal).toBeTruthy();
    expect(saleJournal).toBeTruthy();
    expect(purchaseJournal?.lines.some(line => line.account.code === "201001" && Number(line.credit) === 8)).toBe(true);
    expect(saleJournal?.lines.some(line => line.account.code === "401001" && Number(line.credit) === 10)).toBe(true);

    const report = await request(ctx, "/api/accounting/reports/trial-balance", { token: ctx.tokenA });
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const supplierAccount = report.body.accounts.find((account: any) => account.code === "201001");
    const revenueAccount = report.body.accounts.find((account: any) => account.code === "401001");

    expect(Number(supplierAccount.rawBalance) - openingSupplierBalance).toBe(-8);
    expect(Number(revenueAccount.rawBalance) - openingRevenueBalance).toBe(-10);
    expect(supplierAccount.debit).toBe(0);
    expect(revenueAccount.debit).toBe(0);
    expect(supplierAccount.credit).toBeCloseTo(Math.abs(openingSupplierBalance - 8));
    expect(revenueAccount.credit).toBeCloseTo(Math.abs(openingRevenueBalance - 10));
    expect(report.body.summary.totalDebits).toBeGreaterThan(0);
    expect(report.body.summary.totalCredits).toBeGreaterThan(0);
  });

  it("blocks posting in a locked tenant period before inventory or ledger writes", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const period = await prisma.accountingPeriod.findUnique({
      where: { tenantId_clientId: { tenantId: ctx.tenantAId, clientId: "CI-DEFAULT-A" } },
    });
    expect(period).toBeTruthy();

    const beforeProduct = await prisma.product.findUnique({ where: { id: ctx.productAId } });
    const beforeBatch = await prisma.inventoryBatch.findFirst({
      where: { tenantId: ctx.tenantAId, productId: ctx.productAId },
    });

    const created = await request(ctx, "/api/invoices/create", {
      method: "POST",
      token: ctx.tokenA,
      branchId: ctx.branchAId,
      body: {
        invoiceNumber: `PERIOD-CLOSED-${ctx.suffix}`,
        type: "SALE",
        totalAmount: 10,
        paymentStatus: "UNPAID",
        items: [{ productId: ctx.productAId, qty: 1, price: 10 }],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const locked = await request(ctx, "/api/accounting/periods/CI-DEFAULT-A/lock", {
      method: "PATCH",
      token: ctx.tokenA,
    });
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    expect(locked.body.period.isLocked).toBe(true);

    try {
      const rejected = await request(ctx, "/api/invoices/post", {
        method: "POST",
        token: ctx.tokenA,
      branchId: ctx.branchAId,
        body: { invoiceId: created.body.invoice.id },
      });
      expect(rejected.status).toBe(423);
      expect(rejected.body.error).toBe("ACCOUNTING_PERIOD_LOCKED");

      const storedInvoice = await prisma.invoice.findFirst({
        where: { id: created.body.invoice.id, tenantId: ctx.tenantAId },
      });
      expect(storedInvoice?.status).toBe("DRAFT");
      expect(storedInvoice?.documentStatus).toBe("ACTIVE");

      const [journalCount, movementCount, afterProduct, afterBatch] = await Promise.all([
        prisma.journalEntry.count({ where: { tenantId: ctx.tenantAId, sourceId: created.body.invoice.id } }),
        prisma.inventoryMovement.count({ where: { tenantId: ctx.tenantAId, referenceId: created.body.invoice.id } }),
        prisma.product.findUnique({ where: { id: ctx.productAId } }),
        prisma.inventoryBatch.findFirst({ where: { tenantId: ctx.tenantAId, productId: ctx.productAId } }),
      ]);
      expect(journalCount).toBe(0);
      expect(movementCount).toBe(0);
      expect(afterProduct?.stockQuantity).toBe(beforeProduct?.stockQuantity);
      expect(afterBatch?.stockQuantity).toBe(beforeBatch?.stockQuantity);
    } finally {
      const unlocked = await request(ctx, "/api/accounting/periods/CI-DEFAULT-A/unlock", {
        method: "PATCH",
        token: ctx.tokenA,
      });
      expect(unlocked.status).toBe(200);
    }
  });

  it("blocks direct manual journal posting in a locked period without changing ledger rows or account balances", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const [debitAccount, creditAccount] = await Promise.all([
      prisma.account.create({
        data: {
          tenantId: ctx.tenantAId,
          code: `MANUAL-D-${ctx.suffix}`,
          name: "CI Manual Journal Debit",
          type: "ASSET",
          balance: 125,
        },
      }),
      prisma.account.create({
        data: {
          tenantId: ctx.tenantAId,
          code: `MANUAL-C-${ctx.suffix}`,
          name: "CI Manual Journal Credit",
          type: "EQUITY",
          balance: 250,
        },
      }),
    ]);
    const before = {
      debitBalance: Number(debitAccount.balance),
      creditBalance: Number(creditAccount.balance),
      journalEntries: await prisma.journalEntry.count({ where: { tenantId: ctx.tenantAId } }),
      journalLines: await prisma.journalLine.count({ where: { tenantId: ctx.tenantAId } }),
    };

    const locked = await request(ctx, "/api/accounting/periods/CI-DEFAULT-A/lock", {
      method: "PATCH",
      token: ctx.tokenA,
    });
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    expect(locked.body.period.isLocked).toBe(true);

    try {
      const rejected = await request(ctx, "/api/accounting/journal", {
        method: "POST",
        token: ctx.tokenA,
        body: {
          date: "2026-11-22T12:00:00.000Z",
          description: "CI direct manual journal against locked period",
          lines: [
            { accountId: debitAccount.id, debit: 25, credit: 0 },
            { accountId: creditAccount.id, debit: 0, credit: 25 },
          ],
        },
      });

      expect(rejected.status).toBe(423);
      expect(rejected.body.error).toBe("ACCOUNTING_PERIOD_LOCKED");

      const [afterDebit, afterCredit, journalEntries, journalLines] = await Promise.all([
        prisma.account.findFirst({ where: { id: debitAccount.id, tenantId: ctx.tenantAId } }),
        prisma.account.findFirst({ where: { id: creditAccount.id, tenantId: ctx.tenantAId } }),
        prisma.journalEntry.count({ where: { tenantId: ctx.tenantAId } }),
        prisma.journalLine.count({ where: { tenantId: ctx.tenantAId } }),
      ]);
      expect(Number(afterDebit?.balance)).toBe(before.debitBalance);
      expect(Number(afterCredit?.balance)).toBe(before.creditBalance);
      expect(journalEntries).toBe(before.journalEntries);
      expect(journalLines).toBe(before.journalLines);
    } finally {
      const unlocked = await request(ctx, "/api/accounting/periods/CI-DEFAULT-A/unlock", {
        method: "PATCH",
        token: ctx.tokenA,
      });
      expect(unlocked.status).toBe(200);
    }
  });

  it("fails closed when the authenticated tenant has no configured accounting period", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    await prisma.accountingPeriod.deleteMany({ where: { tenantId: ctx.tenantBId } });

    const rejected = await request(ctx, "/api/invoices/post", {
      method: "POST",
      token: ctx.tokenB,
      branchId: ctx.branchBId,
      body: { invoiceId: ctx.invoiceBId },
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toBe("ACCOUNTING_PERIOD_NOT_CONFIGURED");

    const [journalCount, storedInvoice] = await Promise.all([
      prisma.journalEntry.count({ where: { tenantId: ctx.tenantBId, sourceId: ctx.invoiceBId } }),
      prisma.invoice.findFirst({ where: { id: ctx.invoiceBId, tenantId: ctx.tenantBId } }),
    ]);
    expect(journalCount).toBe(0);
    expect(storedInvoice?.status).toBe("DRAFT");
    expect(storedInvoice?.documentStatus).toBe("ACTIVE");
  });

  it("bootstraps periods once per tenant and rejects overlapping period creation", async () => {
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    await prisma.accountingPeriod.deleteMany({ where: { tenantId: ctx.tenantBId } });

    const bootstrap = await request(ctx, "/api/accounting/periods/bootstrap", {
      method: "POST",
      token: ctx.tokenB,
      body: {
        periods: [{
          clientId: "LEGACY-PERIOD-B",
          startDate: "2026-01-01T00:00:00.000Z",
          endDate: "2026-12-31T23:59:59.999Z",
          isLocked: false,
        }],
      },
    });
    expect(bootstrap.status, JSON.stringify(bootstrap.body)).toBe(201);
    expect(bootstrap.body.periods).toHaveLength(1);
    expect(bootstrap.body.periods[0].clientId).toBe("LEGACY-PERIOD-B");

    const repeatedBootstrap = await request(ctx, "/api/accounting/periods/bootstrap", {
      method: "POST",
      token: ctx.tokenB,
      body: {
        periods: [{
          clientId: "OTHER-PERIOD-B",
          startDate: "2027-01-01T00:00:00.000Z",
          endDate: "2027-12-31T23:59:59.999Z",
          isLocked: false,
        }],
      },
    });
    expect(repeatedBootstrap.status).toBe(409);
    expect(repeatedBootstrap.body.error).toBe("ACCOUNTING_PERIODS_ALREADY_INITIALIZED");

    const overlapping = await request(ctx, "/api/accounting/periods", {
      method: "POST",
      token: ctx.tokenB,
      body: {
        clientId: "OVERLAPPING-PERIOD-B",
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2027-05-31T23:59:59.999Z",
        isLocked: false,
      },
    });
    expect(overlapping.status).toBe(409);
    expect(overlapping.body.error).toBe("ACCOUNTING_PERIOD_OVERLAP");

    const tenantA = await prisma.accountingPeriod.findMany({ where: { tenantId: ctx.tenantAId } });
    const tenantB = await prisma.accountingPeriod.findMany({ where: { tenantId: ctx.tenantBId } });
    expect(tenantA.map((period) => period.clientId)).toEqual(["CI-DEFAULT-A"]);
    expect(tenantB.map((period) => period.clientId)).toEqual(["LEGACY-PERIOD-B"]);
  });

  it("exposes accounting periods only inside the authenticated tenant", async () => {
    const ctx = getContext();
    const [tenantA, tenantB] = await Promise.all([
      request(ctx, "/api/accounting/periods", { token: ctx.tokenA }),
      request(ctx, "/api/accounting/periods", { token: ctx.tokenB }),
    ]);
    expect(tenantA.status).toBe(200);
    expect(tenantB.status).toBe(200);
    expect(tenantA.body.periods.map((period: any) => period.clientId)).toEqual(["CI-DEFAULT-A"]);
    expect(tenantB.body.periods.map((period: any) => period.clientId)).toEqual(["LEGACY-PERIOD-B"]);
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
}, { includeInvoiceRoutes: true, includeAccountingRoutes: true });

