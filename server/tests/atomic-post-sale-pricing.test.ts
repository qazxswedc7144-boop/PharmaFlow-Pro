import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const { mockCalculate, mockPost } = vi.hoisted(() => ({
  mockCalculate: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock("../modules/accounting/services/salesPricing.service.js", () => ({
  SalesPricingService: { calculate: mockCalculate },
}));
vi.mock("../modules/accounting/services/financialTransaction.service.js", () => ({
  FinancialTransactionService: { executeInvoiceLedgerPosting: mockPost },
}));
vi.mock("../core/database/transactionGuard.js", () => ({
  runInTransaction: vi.fn(),
}));

import { AtomicPostSaleService } from "../modules/accounting/services/atomicPostSale.service.js";

describe("Atomic POST_SALE server pricing", () => {
  const tenantId = "tenant-sync-a";
  const productId = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    vi.clearAllMocks();
    mockCalculate.mockResolvedValue({
      itemData: [{
        tenantId,
        productId,
        qty: 2,
        price: new Prisma.Decimal(30),
        cost: new Prisma.Decimal(0),
        total: new Prisma.Decimal(60),
      }],
      subtotalAmount: new Prisma.Decimal(60),
      discountPercent: new Prisma.Decimal(0),
      discountAmount: new Prisma.Decimal(0),
      taxRatePercent: new Prisma.Decimal(0),
      taxAmount: new Prisma.Decimal(0),
      taxMode: "NONE",
      totalAmount: new Prisma.Decimal(60),
    });
    mockPost.mockResolvedValue({ journalId: "journal-sync-a", cogs: 20 });
  });

  it("ignores client price and total and uses the shared server pricing service inside the transaction", async () => {
    const createdInvoice = {
      id: "invoice-sync-a",
      invoiceNumber: "SYNC-SALE-001",
      tenantId,
      totalAmount: new Prisma.Decimal(60),
      items: [],
    };
    const tx: any = {
      invoice: {
        findFirst: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(createdInvoice),
        create: vi.fn().mockResolvedValue(createdInvoice),
      },
      journalEntry: {
        findFirst: vi.fn().mockResolvedValue({ id: "journal-sync-a", lines: [] }),
      },
      inventoryMovement: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    const result = await AtomicPostSaleService.executePostSaleCommand({
      // This is the actual outbox shape emitted by WorkflowExecution:
      // { refId, sale: { ...legacy local invoice fields... } }.
      payload: {
        id: "invoice-sync-a",
        refId: "SYNC-SALE-001",
        sale: {
          invoiceNumber: "SYNC-SALE-001",
          type: "SALE",
          partnerId: "CUST-GEN",
          paymentStatus: "Cash",
          totalAmount: 2,
          discountPercent: 5,
          items: [{ product_id: productId, qty: 2, price: 1, sum: 2, name: "Tampered item" }],
        },
      },
      tenantId,
      userId: "user-sync-a",
      username: "sync-cashier",
      userRole: "CASHIER",
      branchId: "branch-sync-a",
      ipAddress: "127.0.0.1",
      tx,
    });

    expect(result.success).toBe(true);
    expect(mockCalculate).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        tenantId,
        discountPercent: 5,
        user: expect.objectContaining({
          userId: "user-sync-a",
          username: "sync-cashier",
          role: "CASHIER",
          tenantId,
          branchId: "branch-sync-a",
        }),
      }),
    );
    const pricingInput = mockCalculate.mock.calls[0][1];
    expect(pricingInput.items[0]).toEqual({
      productId,
      qty: 2,
      expiryDate: null,
      note: null,
    });
    expect(pricingInput.items[0]).not.toHaveProperty("price");
    expect(pricingInput).not.toHaveProperty("totalAmount");
    const savedInvoiceData = tx.invoice.create.mock.calls[0][0].data;
    expect(savedInvoiceData.subtotalAmount.toString()).toBe("60");
    expect(savedInvoiceData.totalAmount.toString()).toBe("60");
    expect(savedInvoiceData.items.create[0].price.toString()).toBe("30");
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("creates a priced draft without inventory or ledger posting until an explicit POST", async () => {
    const createdInvoice = {
      id: "invoice-draft-a",
      invoiceNumber: "SYNC-DRAFT-001",
      tenantId,
      status: "PENDING",
      documentStatus: "ACTIVE",
      totalAmount: new Prisma.Decimal(60),
      items: [],
    };
    const tx: any = {
      invoice: {
        findFirst: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(createdInvoice),
        create: vi.fn().mockResolvedValue(createdInvoice),
      },
      journalEntry: {
        findFirst: vi.fn(),
      },
      inventoryMovement: {
        findMany: vi.fn(),
      },
    };

    const result = await AtomicPostSaleService.executePostSaleCommand({
      payload: {
        refId: "SYNC-DRAFT-001",
        sale: {
          invoiceNumber: "SYNC-DRAFT-001",
          type: "SALE",
          documentStatus: "PENDING",
          paymentStatus: "Credit",
          items: [{ product_id: productId, qty: 2, price: 1 }],
        },
      },
      tenantId,
      userId: "user-sync-a",
      username: "sync-cashier",
      userRole: "CASHIER",
      branchId: "branch-sync-a",
      ipAddress: "127.0.0.1",
      tx,
      postImmediately: false,
    });

    expect(result.success).toBe(true);
    expect(mockCalculate).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ tenantId, discountPercent: 0 }),
    );
    expect(mockPost).not.toHaveBeenCalled();
    expect(tx.journalEntry.findFirst).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.findMany).not.toHaveBeenCalled();
    expect(result.effects[0].operation).toBe("CREATE");
    expect(tx.invoice.create.mock.calls[0][0].data.status).toBe("PENDING");
  });

  it("preserves cancelled sale status when syncing a non-posting CREATE", async () => {
    const tx: any = {
      invoice: {
        findFirst: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "invoice-cancelled-a", tenantId, items: [] }),
        create: vi.fn().mockResolvedValue({ id: "invoice-cancelled-a", tenantId, items: [] }),
      },
      journalEntry: { findFirst: vi.fn() },
      inventoryMovement: { findMany: vi.fn() },
    };

    await AtomicPostSaleService.executePostSaleCommand({
      payload: {
        refId: "SYNC-CANCELLED-001",
        sale: {
          invoiceNumber: "SYNC-CANCELLED-001",
          type: "SALE",
          InvoiceStatus: "CANCELLED",
          paymentStatus: "Credit",
          items: [{ product_id: productId, qty: 1, price: 1 }],
        },
      },
      tenantId,
      userId: "user-sync-a",
      username: "sync-cashier",
      userRole: "CASHIER",
      branchId: "branch-sync-a",
      ipAddress: "127.0.0.1",
      tx,
      postImmediately: false,
    });

    expect(tx.invoice.create.mock.calls[0][0].data.status).toBe("CANCELLED");
    expect(mockPost).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.findMany).not.toHaveBeenCalled();
  });
});
