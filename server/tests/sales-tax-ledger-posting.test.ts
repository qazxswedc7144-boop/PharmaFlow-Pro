import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const { mockFifo } = vi.hoisted(() => ({
  mockFifo: { depleteStock: vi.fn() },
}));

vi.mock("../modules/inventory/services/fifo.service.js", () => ({
  FifoService: mockFifo,
}));
vi.mock("../core/database/transactionGuard.js", () => ({
  runInTransaction: vi.fn(),
}));
vi.mock("../database/prisma.js", () => ({
  prisma: { auditLog: { create: vi.fn() } },
}));

import { FinancialTransactionService } from "../modules/accounting/services/financialTransaction.service.js";

function makeTransaction() {
  const accounts = new Map<string, any>();
  let lockQueryCount = 0;
  const tx: any = {
    $queryRaw: vi.fn(async () => {
      lockQueryCount += 1;
      return lockQueryCount === 1
        ? [{ id: "invoice-a", documentStatus: "ACTIVE", status: "DRAFT" }]
        : [];
    }),
    account: {
      findFirst: vi.fn(async ({ where }: any) => {
        const account = { id: `account-${where.code}`, code: where.code, name: where.code, version: 1, tenantId: where.tenantId };
        accounts.set(account.id, account);
        return account;
      }),
      findUnique: vi.fn(async ({ where }: any) => accounts.get(where.id) || null),
      update: vi.fn(async ({ where, data }: any) => {
        const account = accounts.get(where.id);
        const adjustment = data.balance.increment;
        const updated = { ...account, balance: (account.balance || 0) + adjustment, version: account.version + 1 };
        accounts.set(where.id, updated);
        return updated;
      }),
      create: vi.fn(),
    },
    invoiceItem: { update: vi.fn().mockResolvedValue({}) },
    journalEntry: { create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: "journal-a", ...data })) },
    invoice: { update: vi.fn().mockResolvedValue({ id: "invoice-a", status: "CONFIRMED", documentStatus: "POSTED" }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return tx;
}

function makeInvoice(taxMode: "EXCLUSIVE" | "INCLUSIVE", totalAmount: string, taxAmount: string) {
  return {
    id: "invoice-a",
    invoiceNumber: "SALE-TAX-001",
    type: "SALE",
    tenantId: "tenant-sales-a",
    branchId: "branch-sales-a",
    date: new Date("2026-11-07T10:00:00.000Z"),
    paymentStatus: "UNPAID",
    status: "DRAFT",
    documentStatus: "ACTIVE",
    subtotalAmount: new Prisma.Decimal("300"),
    discountPercent: new Prisma.Decimal("10"),
    discountAmount: new Prisma.Decimal("30"),
    taxRatePercent: new Prisma.Decimal("5"),
    taxAmount: new Prisma.Decimal(taxAmount),
    taxMode,
    totalAmount: new Prisma.Decimal(totalAmount),
    items: [{ id: "item-a", productId: "product-a", qty: 2, product: {} }],
  } as any;
}

describe("Sales tax ledger posting integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFifo.depleteStock.mockResolvedValue({ totalCost: 40 });
  });

  it("credits sales revenue net of exclusive tax and credits tax payable separately", async () => {
    const tx = makeTransaction();
    await FinancialTransactionService.executeInvoiceLedgerPosting(
      tx,
      makeInvoice("EXCLUSIVE", "283.5", "13.5"),
      "user-a",
      null,
      "tenant-sales-a",
    );

    const journalData = tx.journalEntry.create.mock.calls[0][0].data;
    const lines = journalData.lines.create;
    const revenue = lines.find((line: any) => line.accountId === "account-401001");
    const tax = lines.find((line: any) => line.accountId === "account-202001");

    expect(revenue.credit).toBe(270);
    expect(tax.credit).toBe(13.5);
    expect(lines.reduce((sum: number, line: any) => sum + line.debit, 0))
      .toBeCloseTo(lines.reduce((sum: number, line: any) => sum + line.credit, 0), 4);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("extracts inclusive tax from the total without inflating sales revenue", async () => {
    const tx = makeTransaction();
    await FinancialTransactionService.executeInvoiceLedgerPosting(
      tx,
      makeInvoice("INCLUSIVE", "270", "12.8571"),
      "user-a",
      null,
      "tenant-sales-a",
    );

    const lines = tx.journalEntry.create.mock.calls[0][0].data.lines.create;
    const revenue = lines.find((line: any) => line.accountId === "account-401001");
    const tax = lines.find((line: any) => line.accountId === "account-202001");

    expect(revenue.credit).toBeCloseTo(257.1429, 4);
    expect(tax.credit).toBe(12.8571);
    expect(lines.reduce((sum: number, line: any) => sum + line.debit, 0))
      .toBeCloseTo(lines.reduce((sum: number, line: any) => sum + line.credit, 0), 4);
  });
});
