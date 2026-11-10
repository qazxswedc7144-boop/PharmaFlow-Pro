import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuthorization } = vi.hoisted(() => ({
  mockAuthorization: { can: vi.fn() },
}));

vi.mock("../services/rbac/authorization.service.js", () => ({
  AuthorizationService: mockAuthorization,
}));

import { FinancialTransactionService } from "../modules/accounting/services/financialTransaction.service.js";

const tenantId = "tenant-financial-price-policy";
const userId = "user-financial-price-policy";
const productId = "22222222-2222-4222-8222-222222222222";

function createInvoice(price: number) {
  return {
    id: "invoice-financial-price-policy",
    invoiceNumber: "SALE-POLICY-001",
    type: "SALE",
    paymentStatus: "UNPAID",
    totalAmount: price === 27 ? 31.05 : price,
    subtotalAmount: price,
    discountPercent: 0,
    discountAmount: 0,
    taxRatePercent: 15,
    taxAmount: price * 0.15,
    taxMode: "EXCLUSIVE",
    items: [{
      id: "item-financial-price-policy",
      productId,
      qty: 1,
      price,
      product: { id: productId, price: 30 },
    }],
  };
}

function createTx() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{
      id: "invoice-financial-price-policy",
      documentStatus: "DRAFT",
      status: "DRAFT",
    }]),
    tenantSalesPolicy: {
      findUnique: vi.fn().mockResolvedValue({
        maxDiscountPercent: 10,
        taxRatePercent: 15,
        taxMode: "EXCLUSIVE",
      }),
    },
    account: { findFirst: vi.fn() },
  };
}

describe("FinancialTransactionService sales price policy at posting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorization.can.mockResolvedValue(false);
  });

  it("rejects posting a manual price when the posting actor lacks sales.price.override", async () => {
    const tx = createTx();
    await expect(FinancialTransactionService.executeInvoiceLedgerPosting(
      tx as any,
      createInvoice(27) as any,
      userId,
      "127.0.0.1",
      tenantId,
      "CASHIER"
    )).rejects.toThrow("PRICE_OVERRIDE_FORBIDDEN");

    expect(tx.account.findFirst).not.toHaveBeenCalled();
  });

  it("rejects posting when a manual price exceeds the current tenant discount ceiling", async () => {
    mockAuthorization.can.mockResolvedValue(true);
    const tx = createTx();
    await expect(FinancialTransactionService.executeInvoiceLedgerPosting(
      tx as any,
      createInvoice(26) as any,
      userId,
      "127.0.0.1",
      tenantId,
      "ADMIN"
    )).rejects.toThrow("DISCOUNT_LIMIT_EXCEEDED");

    expect(tx.account.findFirst).not.toHaveBeenCalled();
  });
});
