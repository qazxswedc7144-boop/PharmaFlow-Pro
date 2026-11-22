import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { definePostgresHttpSuite } from "./helpers/postgres-http.integration.helpers.js";

function assertTestDatabase(): void {
  const raw = process.env.DATABASE_URL ?? "";
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, "");
  if (process.env.NODE_ENV !== "test" || !/(^|_)(test|ci)(_|$)/i.test(database)) {
    throw new Error("Phase 3 financial reconciliation tests require an explicitly named PostgreSQL test/CI database.");
  }
}

definePostgresHttpSuite("Phase 3 — PostgreSQL financial reconciliation", (getContext) => {
  it("reconciles Trial Balance, General Ledger, P&L and Balance Sheet from the same posted journal lines", async () => {
    assertTestDatabase();
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const accountSpecs = [
      { code: `P3-A-${suffix}`, name: "P3 Cash", type: "ASSET" as const },
      { code: `P3-L-${suffix}`, name: "P3 Payable", type: "LIABILITY" as const },
      { code: `P3-E-${suffix}`, name: "P3 Capital", type: "EQUITY" as const },
      { code: `P3-R-${suffix}`, name: "P3 Revenue", type: "REVENUE" as const },
      { code: `P3-X-${suffix}`, name: "P3 Expense", type: "EXPENSE" as const },
      { code: `P3-501-${suffix}`, name: "P3 Cost of Goods Sold", type: "EXPENSE" as const },
    ];
    const createdAccounts: string[] = [];
    const createdEntries: string[] = [];
    try {
      const accounts = await Promise.all(accountSpecs.map(async (spec) => {
        const account = await prisma.account.create({ data: { ...spec, tenantId: ctx.tenantAId } });
        createdAccounts.push(account.id);
        return account;
      }));
      const [asset, liability, equity, revenue, expense, cogs] = accounts;
      const entry = await prisma.journalEntry.create({
        data: {
          tenantId: ctx.tenantAId,
          branchId: ctx.branchAId,
          date: new Date("2026-10-01T12:00:00.000Z"),
          status: "POSTED",
          sourceType: "MANUAL",
          referenceId: `P3-${suffix}`,
          description: "Phase 3 deterministic reconciliation fixture",
          debitTotal: 175,
          creditTotal: 175,
          lines: { create: [
            { accountId: asset.id, debit: 100, credit: 0 },
            { accountId: expense.id, debit: 50, credit: 0 },
            { accountId: cogs.id, debit: 25, credit: 0 },
            { accountId: liability.id, debit: 0, credit: 30 },
            { accountId: equity.id, debit: 0, credit: 20 },
            { accountId: revenue.id, debit: 0, credit: 125 },
          ] },
        },
        include: { lines: true },
      });
      createdEntries.push(entry.id);

      const ledgerLines = await prisma.journalLine.findMany({
        where: { tenantId: ctx.tenantAId, entry: { status: "POSTED", branchId: ctx.branchAId, id: entry.id } },
        include: { account: true, entry: true },
      });
      const totalDebit = ledgerLines.reduce((sum, line) => sum + Number(line.debit), 0);
      const totalCredit = ledgerLines.reduce((sum, line) => sum + Number(line.credit), 0);
      expect(totalDebit).toBe(175);
      expect(totalCredit).toBe(175);

      // Trial Balance and General Ledger must be two views of the same persisted POSTED lines.
      const trialBalance = new Map<string, { debit: number; credit: number }>();
      for (const line of ledgerLines) {
        const current = trialBalance.get(line.accountId) ?? { debit: 0, credit: 0 };
        current.debit += Number(line.debit);
        current.credit += Number(line.credit);
        trialBalance.set(line.accountId, current);
      }
      const generalLedgerTotals = ledgerLines.reduce((sum, line) => ({
        debit: sum.debit + Number(line.debit),
        credit: sum.credit + Number(line.credit),
      }), { debit: 0, credit: 0 });
      const trialBalanceTotals = [...trialBalance.values()].reduce((sum, row) => ({
        debit: sum.debit + row.debit,
        credit: sum.credit + row.credit,
      }), { debit: 0, credit: 0 });
      expect(trialBalanceTotals).toEqual(generalLedgerTotals);

      // P&L uses natural balances: revenue credit-normal; expense debit-normal.
      const pnl = ledgerLines.reduce((sum, line) => {
        if (line.account.type === "REVENUE") sum.revenue += Number(line.credit) - Number(line.debit);
        if (line.account.type === "EXPENSE") sum.expenses += Number(line.debit) - Number(line.credit);
        return sum;
      }, { revenue: 0, expenses: 0 });
      expect(pnl).toEqual({ revenue: 125, expenses: 75 });
      expect(pnl.revenue - pnl.expenses).toBe(50);

      // Balance Sheet: Assets = Liabilities + Equity + unclosed current-period net income.
      const balances = ledgerLines.reduce((sum, line) => {
        const debit = Number(line.debit), credit = Number(line.credit);
        switch (line.account.type) {
          case "ASSET": sum.assets += debit - credit; break;
          case "LIABILITY": sum.liabilities += credit - debit; break;
          case "EQUITY": sum.equity += credit - debit; break;
        }
        return sum;
      }, { assets: 0, liabilities: 0, equity: 0 });
      expect(balances.assets).toBe(100);
      expect(balances.liabilities + balances.equity + (pnl.revenue - pnl.expenses)).toBe(100);

      // Exercise the application's report engine against these exact persisted PostgreSQL rows.
      const { FinancialReportEngine } = await import("../services/reporting/financial-report.engine.js");
      const filters = {
        tenantId: ctx.tenantAId,
        branchId: ctx.branchAId,
        startDate: "2026-10-01",
        endDate: "2026-10-02",
        asOfDate: "2026-10-02",
      };
      const reportTrialBalance = await FinancialReportEngine.generateTrialBalance(filters, "phase3-ci");
      const reportAsset = reportTrialBalance.accounts.find(row => row.id === asset.id);
      const reportRevenue = reportTrialBalance.accounts.find(row => row.id === revenue.id);
      const reportExpense = reportTrialBalance.accounts.find(row => row.id === expense.id);
      expect(reportAsset?.periodDebit).toBe(100);
      expect(reportRevenue?.periodCredit).toBe(125);
      expect(reportExpense?.periodDebit).toBe(50);
      expect(reportTrialBalance.accounts.find(row => row.id === cogs.id)?.periodDebit).toBe(25);
      expect(reportTrialBalance.totals.periodDebitTotal).toBe(reportTrialBalance.totals.periodCreditTotal);

      const reportLedger = await FinancialReportEngine.generateGeneralLedger(
        { ...filters, accountId: asset.id },
        "phase3-ci"
      );
      expect(reportLedger.summary.overallDebits).toBe(100);
      expect(reportLedger.summary.overallCredits).toBe(0);
      expect(reportLedger.accounts[0]?.transactions).toHaveLength(1);

      const reportPnl = await FinancialReportEngine.generateProfitLoss(filters, "phase3-ci");
      expect(reportPnl.revenue.totalRevenue).toBe(125);
      expect(reportPnl.costOfGoodsSold.cogsAmount).toBe(25);
      expect(reportPnl.operatingExpenses.totalExpenses).toBe(50);
      expect(reportPnl.netProfit).toBe(50);

      const reportBalanceSheet = await FinancialReportEngine.generateBalanceSheet(
        { tenantId: ctx.tenantAId, branchId: ctx.branchAId, asOfDate: "2026-10-02" },
        "phase3-ci"
      );
      // BalanceSheetReport exposes totals under its documented nested sections.
      expect(reportBalanceSheet.assets.totalAssets).toBe(100);
      expect(
        reportBalanceSheet.liabilities.totalLiabilities + reportBalanceSheet.equity.totalEquity
      ).toBe(100);
      expect(reportBalanceSheet.isBalanced).toBe(true);
    } finally {
      if (createdEntries.length) await prisma.journalEntry.deleteMany({ where: { id: { in: createdEntries }, tenantId: ctx.tenantAId } });
      if (createdAccounts.length) await prisma.account.deleteMany({ where: { id: { in: createdAccounts }, tenantId: ctx.tenantAId } });
    }
  });

  it("proves tenant and branch filters exclude posted ledger rows outside the requested scope", async () => {
    assertTestDatabase();
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const accountA = await prisma.account.create({
      data: { tenantId: ctx.tenantAId, code: `P3-ISO-A-${suffix}`, name: "P3 Isolation A", type: "ASSET" }
    });
    const accountB = await prisma.account.create({
      data: { tenantId: ctx.tenantBId, code: `P3-ISO-B-${suffix}`, name: "P3 Isolation B", type: "ASSET" }
    });
    const entryIds: string[] = [];
    try {
      const entryA = await prisma.journalEntry.create({
        data: {
          tenantId: ctx.tenantAId, branchId: ctx.branchAId, status: "POSTED",
          debitTotal: 25, creditTotal: 25,
          lines: { create: [
            { accountId: accountA.id, debit: 25, credit: 0 },
            { accountId: accountA.id, debit: 0, credit: 25 },
          ] }
        }
      });
      const entryB = await prisma.journalEntry.create({
        data: {
          tenantId: ctx.tenantBId, branchId: ctx.branchBId, status: "POSTED",
          debitTotal: 40, creditTotal: 40,
          lines: { create: [
            { accountId: accountB.id, debit: 40, credit: 0 },
            { accountId: accountB.id, debit: 0, credit: 40 },
          ] }
        }
      });
      entryIds.push(entryA.id, entryB.id);
      const tenantA = await prisma.journalLine.findMany({
        where: { tenantId: ctx.tenantAId, entry: { status: "POSTED" } }
      });
      expect(tenantA.every(line => line.tenantId === ctx.tenantAId)).toBe(true);
      expect(tenantA.some(line => line.entryId === entryB.id)).toBe(false);

      const branchA = await prisma.journalLine.findMany({
        where: { tenantId: ctx.tenantAId, entry: { status: "POSTED", branchId: ctx.branchAId } }
      });
      expect(branchA.every(line => line.entryId !== entryB.id)).toBe(true);
      expect(branchA.some(line => line.entryId === entryA.id)).toBe(true);
    } finally {
      if (entryIds.length) await prisma.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
      await prisma.account.deleteMany({ where: { id: { in: [accountA.id, accountB.id] } } });
    }
  });

  it("enforces tenant and branch isolation through the production Trial Balance report engine", async () => {
    assertTestDatabase();
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const { FinancialReportEngine } = await import("../services/reporting/financial-report.engine.js");
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const branchA2 = await prisma.branch.create({
      data: { tenantId: ctx.tenantAId, code: `P3-A2-${suffix}`, name: "Phase 3 Branch A2", isActive: true },
    });
    const accountSpecs = [
      { code: `P3-RA-${suffix}`, name: "P3 Report Branch A", type: "ASSET" as const, tenantId: ctx.tenantAId },
      { code: `P3-RAC-${suffix}`, name: "P3 Report Branch A Contra", type: "LIABILITY" as const, tenantId: ctx.tenantAId },
      { code: `P3-RA2-${suffix}`, name: "P3 Report Other Branch", type: "ASSET" as const, tenantId: ctx.tenantAId },
      { code: `P3-RB-${suffix}`, name: "P3 Report Other Tenant", type: "ASSET" as const, tenantId: ctx.tenantBId },
      { code: `P3-RBC-${suffix}`, name: "P3 Report Other Tenant Contra", type: "LIABILITY" as const, tenantId: ctx.tenantBId },
    ];
    const createdAccounts: string[] = [];
    const createdEntries: string[] = [];
    try {
      const accounts = await Promise.all(accountSpecs.map(async (spec) => {
        const account = await prisma.account.create({ data: spec });
        createdAccounts.push(account.id);
        return account;
      }));
      const [branchAAsset, branchAContra, branchA2Asset, tenantBAsset, tenantBContra] = accounts;
      const fixtures = [
        { tenantId: ctx.tenantAId, branchId: ctx.branchAId, debitAccountId: branchAAsset.id, creditAccountId: branchAContra.id, amount: 10 },
        { tenantId: ctx.tenantAId, branchId: branchA2.id, debitAccountId: branchA2Asset.id, creditAccountId: branchAContra.id, amount: 20 },
        { tenantId: ctx.tenantBId, branchId: ctx.branchBId, debitAccountId: tenantBAsset.id, creditAccountId: tenantBContra.id, amount: 30 },
      ];
      for (const fixture of fixtures) {
        const entry = await prisma.journalEntry.create({
          data: {
            tenantId: fixture.tenantId,
            branchId: fixture.branchId,
            date: new Date("2026-10-01T12:00:00.000Z"),
            status: "POSTED",
            sourceType: "MANUAL",
            referenceId: `P3-REPORT-SCOPE-${suffix}`,
            description: "Phase 3 report-engine scope fixture",
            debitTotal: fixture.amount,
            creditTotal: fixture.amount,
            lines: { create: [
              { accountId: fixture.debitAccountId, debit: fixture.amount, credit: 0 },
              { accountId: fixture.creditAccountId, debit: 0, credit: fixture.amount },
            ] },
          },
        });
        createdEntries.push(entry.id);
      }

      const report = await FinancialReportEngine.generateTrialBalance({
        tenantId: ctx.tenantAId,
        branchId: ctx.branchAId,
        startDate: "2026-10-01",
        endDate: "2026-10-02",
      }, "phase3-ci");

      const reportedAccountIds = new Set(report.accounts.map(row => row.id));
      expect(reportedAccountIds.has(branchAAsset.id)).toBe(true);
      // The chart of accounts is tenant-scoped, not branch-scoped. An account
      // belonging to another branch may therefore appear with a zero balance;
      // isolation is proven by ensuring its other-branch journal activity is absent.
      const otherBranchAccount = report.accounts.find(row => row.id === branchA2Asset.id);
      expect(otherBranchAccount).toBeDefined();
      expect(otherBranchAccount?.periodDebit).toBe(0);
      expect(otherBranchAccount?.periodCredit).toBe(0);
      // Accounts belonging to another tenant must not be present at all.
      expect(reportedAccountIds.has(tenantBAsset.id)).toBe(false);
      expect(report.totals.periodDebitTotal).toBe(10);
      expect(report.totals.periodCreditTotal).toBe(10);
    } finally {
      if (createdEntries.length) {
        await prisma.journalEntry.deleteMany({ where: { id: { in: createdEntries } } });
      }
      if (createdAccounts.length) {
        await prisma.account.deleteMany({ where: { id: { in: createdAccounts } } });
      }
      await prisma.branch.deleteMany({ where: { id: branchA2.id, tenantId: ctx.tenantAId } });
    }
  });

  it("reconciles persisted batch valuation with the stock movement quantity ledger", async () => {
    assertTestDatabase();
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const product = await prisma.product.create({
      data: {
        tenantId: ctx.tenantAId,
        name: `P3 Inventory ${suffix}`,
        sku: `P3-${suffix}`,
        barcode: `P3-${suffix}`,
        price: 8,
        cost: 5,
        stockQuantity: 10,
      }
    });
    try {
      const batch = await prisma.inventoryBatch.create({
        data: {
          tenantId: ctx.tenantAId,
          productId: product.id,
          batchNumber: `P3-BATCH-${suffix}`,
          initialQty: 12,
          stockQuantity: 10,
          cost: 5,
        }
      });
      await prisma.inventoryMovement.createMany({
        data: [
          {
            tenantId: ctx.tenantAId, productId: product.id, batchId: batch.id,
            qty: 12, type: "STOCK_IN", previousStock: 0, currentStock: 12,
            branchId: ctx.branchAId, referenceType: "PHASE3_TEST"
          },
          {
            tenantId: ctx.tenantAId, productId: product.id, batchId: batch.id,
            qty: -2, type: "STOCK_OUT", previousStock: 12, currentStock: 10,
            branchId: ctx.branchAId, referenceType: "PHASE3_TEST"
          }
        ]
      });
      const [batches, movements] = await Promise.all([
        prisma.inventoryBatch.findMany({ where: { tenantId: ctx.tenantAId, productId: product.id } }),
        prisma.inventoryMovement.findMany({ where: { tenantId: ctx.tenantAId, productId: product.id, branchId: ctx.branchAId } }),
      ]);
      const batchQuantity = batches.reduce((sum, row) => sum + row.stockQuantity, 0);
      const batchValue = batches.reduce((sum, row) => sum + row.stockQuantity * Number(row.cost), 0);
      const movementQuantity = movements.reduce((sum, row) => sum + row.qty, 0);
      expect(batchQuantity).toBe(10);
      expect(movementQuantity).toBe(batchQuantity);
      expect(batchValue).toBe(50);
    } finally {
      await prisma.inventoryMovement.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.inventoryBatch.deleteMany({ where: { tenantId: ctx.tenantAId, productId: product.id } });
      await prisma.product.deleteMany({ where: { id: product.id, tenantId: ctx.tenantAId } });
    }
  });

  it("confirms durable FIFO schema while reporting the remaining invoice payment allocation gap", async () => {
    assertTestDatabase();
    const { prisma } = await import("../database/prisma.js");
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const tables = new Set(rows.map(row => row.table_name));
    // The payments table already exists. The outstanding payment gap is the
    // missing durable payment-to-invoice allocation relation.
    expect(tables.has("payments")).toBe(true);
    expect(tables.has("inventory_batches")).toBe(true);
    expect(tables.has("inventory_movements")).toBe(true);
    expect(tables.has("inventory_layers")).toBe(true);
    expect(tables.has("fifo_consumption_log")).toBe(true);
    expect(tables.has("invoice_payment_allocations")).toBe(false);

    const missingCapabilities = [
      { capability: "invoice-level payment allocation", requiredTables: ["invoice_payment_allocations"] },
    ];
    const gaps = missingCapabilities.filter(item => item.requiredTables.some(name => !tables.has(name)));
    for (const gap of gaps) {
      console.warn(`PHASE3_SCHEMA_LIMITATION: ${gap.capability}; missing: ${gap.requiredTables.filter(name => !tables.has(name)).join(", ")}`);
    }
    expect(gaps.map(gap => gap.capability)).toContain("invoice-level payment allocation");
    expect(gaps.map(gap => gap.capability)).not.toContain("persistent FIFO layers and consumption history");
  });
});
