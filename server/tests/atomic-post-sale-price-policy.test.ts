import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuthorization, mockLedger } = vi.hoisted(() => ({
  mockAuthorization: { can: vi.fn() },
  mockLedger: { executeInvoiceLedgerPosting: vi.fn() },
}));

vi.mock("../services/rbac/authorization.service.js", () => ({
  AuthorizationService: mockAuthorization,
}));
vi.mock("../modules/accounting/services/financialTransaction.service.js", () => ({
  FinancialTransactionService: mockLedger,
}));

import { AtomicPostSaleService } from "../modules/accounting/services/atomicPostSale.service.js";
import { SYSTEM_ROLE_PERMISSIONS } from "../services/rbac/permission.service.js";

const tenantId = "tenant-atomic-sale";
const userId = "user-atomic-sale";
const productId = "11111111-1111-4111-8111-111111111111";

function createTx() {
  const invoice = {
    id: "invoice-atomic-sale",
    invoiceNumber: "SALE-ATOMIC-001",
    totalAmount: 31.05,
    items: [{ productId, qty: 1, price: 27, total: 27 }],
  };
  return {
    product: { findMany: vi.fn().mockResolvedValue([{ id: productId, price: 30, basePrice: 30 }]) },
    tenantSalesPolicy: { findUnique: vi.fn().mockResolvedValue({ maxDiscountPercent: 10, taxRatePercent: 15, taxMode: "EXCLUSIVE" }) },
    invoice: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(invoice),
      findUnique: vi.fn().mockResolvedValue(invoice),
    },
    journalEntry: { findUnique: vi.fn().mockResolvedValue(null) },
    inventoryMovement: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

function payload(price: number, totalAmount: number, discountPercent = 0) {
  return {
    invoiceNumber: "SALE-ATOMIC-001",
    type: "SALE",
    totalAmount,
    paymentStatus: "UNPAID",
    discountPercent,
    items: [{ productId, qty: 1, price }],
  };
}

describe("AtomicPostSaleService manual price policy", () => {
  it("exposes the override permission only to privileged built-in tenant roles", () => {
    expect(SYSTEM_ROLE_PERMISSIONS.TENANT_ADMIN).toContain("sales.price.override");
    expect(SYSTEM_ROLE_PERMISSIONS.ADMIN).toContain("sales.price.override");
    expect(SYSTEM_ROLE_PERMISSIONS.CASHIER || []).not.toContain("sales.price.override");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorization.can.mockResolvedValue(false);
    mockLedger.executeInvoiceLedgerPosting.mockResolvedValue({ journalId: "journal-atomic-sale", cogs: 0 });
  });

  it("rejects a manual item price when the authenticated user lacks sales.price.override", async () => {
    const tx = createTx();
    await expect(AtomicPostSaleService.executePostSaleCommand({
      payload: payload(27, 31.05), tenantId, userId, userRole: "CASHIER", ipAddress: "127.0.0.1", tx,
    })).rejects.toThrow("PRICE_OVERRIDE_FORBIDDEN");
    expect(tx.invoice.create).not.toHaveBeenCalled();
  });

  it("allows a permitted manual price within the tenant discount limit and persists recalculated totals", async () => {
    mockAuthorization.can.mockResolvedValue(true);
    const tx = createTx();
    await AtomicPostSaleService.executePostSaleCommand({
      payload: payload(27, 31.05), tenantId, userId, userRole: "ADMIN", ipAddress: "127.0.0.1", tx,
    });
    const createArgs = tx.invoice.create.mock.calls[0][0];
    expect(createArgs.data.items.create[0].price.toString()).toBe("27");
    expect(createArgs.data.totalAmount.toString()).toBe("31.05");
    expect(createArgs.data.discountAmount.toString()).toBe("0");
  });

  it("rejects a permitted manual price that exceeds the tenant maximum discount", async () => {
    mockAuthorization.can.mockResolvedValue(true);
    const tx = createTx();
    await expect(AtomicPostSaleService.executePostSaleCommand({
      payload: payload(26, 29.9), tenantId, userId, userRole: "ADMIN", ipAddress: "127.0.0.1", tx,
    })).rejects.toThrow("DISCOUNT_LIMIT_EXCEEDED");
    expect(tx.invoice.create).not.toHaveBeenCalled();
  });

  it("enforces the tenant discount ceiling across manual price reduction plus invoice discount", async () => {
    mockAuthorization.can.mockResolvedValue(true);
    const tx = createTx();
    await expect(AtomicPostSaleService.executePostSaleCommand({
      payload: payload(28.5, 1, 6), tenantId, userId, userRole: "ADMIN", ipAddress: "127.0.0.1", tx,
    })).rejects.toThrow("DISCOUNT_LIMIT_EXCEEDED");
    expect(tx.invoice.create).not.toHaveBeenCalled();
  });

  it("does not require override permission when submitted price matches the tenant catalog", async () => {
    const tx = createTx();
    await AtomicPostSaleService.executePostSaleCommand({
      payload: payload(30, 34.5), tenantId, userId, userRole: "CASHIER", ipAddress: "127.0.0.1", tx,
    });
    expect(mockAuthorization.can).not.toHaveBeenCalled();
    expect(tx.invoice.create).toHaveBeenCalledTimes(1);
  });
});
