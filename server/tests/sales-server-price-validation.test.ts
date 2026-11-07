import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockSaas, mockAuthorization } = vi.hoisted(() => {
  const prisma: any = {
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
    product: { findMany: vi.fn() },
    invoice: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    tenantSalesPolicy: { findUnique: vi.fn(), upsert: vi.fn() },
  };
  return {
    mockPrisma: prisma,
    mockSaas: {
      checkSubscriptionLimit: vi.fn(),
      incrementUsage: vi.fn(),
    },
    mockAuthorization: { can: vi.fn() },
  };
});

vi.mock("../database/tenantPrisma.js", () => ({ tenantPrisma: mockPrisma }));
vi.mock("../database/prisma.js", () => ({
  OfflineDatabaseError: class OfflineDatabaseError extends Error {},
}));
vi.mock("../modules/accounting/services/financialTransaction.service.js", () => ({
  FinancialTransactionService: { postInvoiceToLedger: vi.fn() },
}));
vi.mock("../middleware/auth.middleware.js", () => ({
  authenticateToken: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRoles: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../modules/locking/locking.service.js", () => ({ LockingService: {} }));
vi.mock("../modules/replication/replication.publisher.js", () => ({ ReplicationPublisher: {} }));
vi.mock("../modules/saas/saas.service.js", () => ({ SaasService: mockSaas }));
vi.mock("../services/rbac/authorization.service.js", () => ({ AuthorizationService: mockAuthorization }));

import { invoiceRouter } from "../routes/invoice.routes.js";
import { InvoiceSchema } from "../../src/shared/validation/invoice.schema.js";

const tenantId = "tenant-sales-a";
const productId = "11111111-1111-4111-8111-111111111111";

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

async function invokeCreate(payload: Record<string, unknown>) {
  const layer = (invoiceRouter as any).stack.find(
    (entry: any) => entry.route?.path === "/create" && entry.route?.methods?.post,
  );
  if (!layer) throw new Error("POST /create route not registered");

  const req: any = {
    body: payload,
    user: { tenantId, userId: "user-sales-a", username: "cashier", role: "CASHIER" },
    ip: "127.0.0.1",
  };
  const res = makeResponse();

  for (const routeLayer of layer.route.stack) {
    await routeLayer.handle(req, res, () => {});
  }

  return res;
}

describe("Server-side sales price and discount validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaas.checkSubscriptionLimit.mockResolvedValue({ allowed: true });
    mockSaas.incrementUsage.mockResolvedValue(undefined);
    mockAuthorization.can.mockResolvedValue(true);
    mockPrisma.tenantSalesPolicy.findUnique.mockResolvedValue({
      tenantId, maxDiscountPercent: 15, taxRatePercent: 0, taxMode: "NONE",
    });
    mockPrisma.invoice.findUnique.mockResolvedValue(null);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockPrisma.product.findMany.mockResolvedValue([
      { id: productId, tenantId, price: 30, isActive: true, deletedAt: null },
    ]);
    mockPrisma.invoice.create.mockImplementation(async ({ data }: any) => ({
      id: "invoice-created",
      ...data,
      items: data.items.create,
    }));
    mockPrisma.auditLog.create.mockResolvedValue({});
  });

  it("must use the tenant product's database price, not a manipulated client price", async () => {
    const response = await invokeCreate({
      invoiceNumber: "SALE-PRICE-001",
      type: "SALE",
      totalAmount: 10,
      paymentStatus: "UNPAID",
      items: [{ productId, qty: 10, price: 1 }],
    });

    expect(response.statusCode).toBe(201);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.product.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId, id: { in: [productId] }, isActive: true, deletedAt: null }),
    }));

    const invoiceData = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(invoiceData.totalAmount.toString()).toBe("300");
    expect(invoiceData.items.create).toHaveLength(1);
    expect(invoiceData.items.create[0]).toEqual(expect.objectContaining({
      tenantId,
      productId,
      qty: 10,
    }));
    expect(invoiceData.items.create[0].price.toString()).toBe("30");
    expect(invoiceData.items.create[0].total.toString()).toBe("300");
  });

  it("calculates discount and tax from the tenant policy inside the invoice transaction", async () => {
    mockPrisma.tenantSalesPolicy.findUnique.mockResolvedValue({
      tenantId, maxDiscountPercent: 15, taxRatePercent: 5, taxMode: "EXCLUSIVE",
    });
    const response = await invokeCreate({
      invoiceNumber: "SALE-POLICY-001",
      type: "SALE",
      totalAmount: 1,
      discountPercent: 10,
      paymentStatus: "UNPAID",
      items: [{ productId, qty: 10, price: 1 }],
    });

    expect(response.statusCode).toBe(201);
    const invoiceData = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(invoiceData.subtotalAmount.toString()).toBe("300");
    expect(invoiceData.discountPercent.toString()).toBe("10");
    expect(invoiceData.discountAmount.toString()).toBe("30");
    expect(invoiceData.taxRatePercent.toString()).toBe("5");
    expect(invoiceData.taxAmount.toString()).toBe("13.5");
    expect(invoiceData.taxMode).toBe("EXCLUSIVE");
    expect(invoiceData.totalAmount.toString()).toBe("283.5");
    expect(mockPrisma.tenantSalesPolicy.findUnique).toHaveBeenCalledWith({ where: { tenantId } });
    expect(mockAuthorization.can).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-sales-a", tenantId }),
      "sales.discount.apply",
      expect.objectContaining({ tenantId }),
    );
  });

  it("extracts inclusive tax from the tenant policy and ignores client tax totals", async () => {
    mockPrisma.tenantSalesPolicy.findUnique.mockResolvedValue({
      tenantId, maxDiscountPercent: 15, taxRatePercent: 5, taxMode: "INCLUSIVE",
    });
    const response = await invokeCreate({
      invoiceNumber: "SALE-TAX-INCLUSIVE",
      type: "SALE",
      totalAmount: 1,
      taxAmount: 999,
      taxRatePercent: 99,
      taxMode: "EXCLUSIVE",
      paymentStatus: "UNPAID",
      items: [{ productId, qty: 10, price: 1 }],
    });

    expect(response.statusCode).toBe(201);
    const invoiceData = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(invoiceData.subtotalAmount.toString()).toBe("300");
    expect(invoiceData.taxMode).toBe("INCLUSIVE");
    expect(invoiceData.taxRatePercent.toString()).toBe("5");
    expect(invoiceData.taxAmount.toString()).toBe("14.2857");
    expect(invoiceData.totalAmount.toString()).toBe("300");
  });

  it("rejects a discount when the authenticated user lacks sales.discount.apply", async () => {
    mockAuthorization.can.mockResolvedValue(false);
    const response = await invokeCreate({
      invoiceNumber: "SALE-DISCOUNT-DENIED",
      type: "SALE",
      totalAmount: 300,
      discountPercent: 5,
      paymentStatus: "UNPAID",
      items: [{ productId, qty: 10, price: 30 }],
    });

    expect(response.statusCode).toBe(403);
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });

  it("rejects a discount above the tenant policy maximum", async () => {
    const response = await invokeCreate({
      invoiceNumber: "SALE-DISCOUNT-CAP",
      type: "SALE",
      totalAmount: 300,
      discountPercent: 20,
      paymentStatus: "UNPAID",
      items: [{ productId, qty: 10, price: 30 }],
    });

    expect(response.statusCode).toBe(422);
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });

  it("allows SALE requests to omit all client price and total fields", () => {
    const result = InvoiceSchema.safeParse({
      invoiceNumber: "SALE-NO-CLIENT-PRICE",
      type: "SALE",
      paymentStatus: "UNPAID",
      items: [{ productId, qty: 2 }],
    });

    expect(result.success).toBe(true);
  });

  it("fails closed for RETURN_SALE until the original posted invoice is referenced", async () => {
    const response = await invokeCreate({
      invoiceNumber: "SALE-RETURN-001",
      type: "RETURN_SALE",
      totalAmount: 1,
      paymentStatus: "UNPAID",
      items: [{ productId, qty: 1, price: 1 }],
    });

    expect(response.statusCode).toBe(422);
    expect(response.body.error).toBe("RETURN_WORKFLOW_NOT_SUPPORTED");
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });

  it("rejects client-supplied discount amounts, tax overrides, promotions, and tier prices", () => {
    const result = InvoiceSchema.safeParse({
      invoiceNumber: "SALE-OVERRIDE-001",
      type: "SALE",
      totalAmount: 100,
      paymentStatus: "UNPAID",
      discountPercent: 25,
      discountAmount: 25,
      tax: 15,
      taxAmount: 15,
      taxRatePercent: 99,
      taxMode: "EXCLUSIVE",
      promotionId: "client-promo",
      tierPrice: 1,
      items: [{ productId, qty: 1, price: 100 }],
    });

    expect(result.success).toBe(false);
  });
});
