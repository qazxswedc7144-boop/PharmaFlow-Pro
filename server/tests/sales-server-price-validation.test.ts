import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockSaas, mockAuthorization } = vi.hoisted(() => {
  const prisma: any = {
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
    product: { findMany: vi.fn() },
    tenantSalesPolicy: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
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
    user: { tenantId, userId: "user-sales-a" },
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
    mockAuthorization.can.mockResolvedValue(false);
    mockPrisma.invoice.findUnique.mockResolvedValue(null);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockPrisma.tenantSalesPolicy.findUnique.mockResolvedValue({ maxDiscountPercent: 10, taxRatePercent: 15, taxMode: "EXCLUSIVE" });
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

  it("uses the tenant catalog price when no manual override is requested", async () => {
    const response = await invokeCreate({
      invoiceNumber: "SALE-PRICE-001",
      type: "SALE",
      totalAmount: 10,
      paymentStatus: "UNPAID",
      items: [{ productId, qty: 10, price: 30 }],
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
      product: {
        connect: {
          id_tenantId: { id: productId, tenantId },
        },
      },
      qty: 10,
    }));
    expect(invoiceData.items.create[0].price.toString()).toBe("30");
    expect(invoiceData.items.create[0].total.toString()).toBe("300");
  });

  it("accepts a requested discount percentage but never accepts client-supplied tax or computed amounts", () => {
    const result = InvoiceSchema.safeParse({
      invoiceNumber: "SALE-DISCOUNT-001",
      type: "SALE",
      totalAmount: 100,
      paymentStatus: "UNPAID",
      discountPercent: 5,
      items: [{ productId, qty: 1, price: 100 }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects client-supplied discount amount, tax, promotion, and tier-price overrides", () => {
    const result = InvoiceSchema.safeParse({
      invoiceNumber: "SALE-OVERRIDE-001",
      type: "SALE",
      totalAmount: 100,
      paymentStatus: "UNPAID",
      discountAmount: 25,
      tax: 15,
      promotionId: "client-promo",
      tierPrice: 1,
      items: [{ productId, qty: 1, price: 100 }],
    });

    expect(result.success).toBe(false);
  });


  it("rejects a manual price override when the actor lacks sales.price.override", async () => {
    const response = await invokeCreate({
      invoiceNumber: "SALE-OVERRIDE-DENIED",
      type: "SALE",
      totalAmount: 27,
      paymentStatus: "UNPAID",
      items: [{ productId, qty: 1, price: 27 }],
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual(expect.objectContaining({ error: "PRICE_OVERRIDE_FORBIDDEN" }));
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });

  it("persists an authorized manual price and recalculates totals from tenant policy", async () => {
    mockAuthorization.can.mockResolvedValue(true);
    const response = await invokeCreate({
      invoiceNumber: "SALE-OVERRIDE-ALLOWED",
      type: "SALE",
      totalAmount: 31.05,
      paymentStatus: "UNPAID",
      items: [{ productId, qty: 1, price: 27 }],
    });
    expect(response.statusCode).toBe(201);
    const invoiceData = mockPrisma.invoice.create.mock.calls[0][0].data;
    expect(invoiceData.items.create[0].price.toString()).toBe("27");
    expect(invoiceData.totalAmount.toString()).toBe("31.05");
  });

  it("rejects a manual unit price below the tenant maximum discount floor", async () => {
    mockAuthorization.can.mockResolvedValue(true);
    const response = await invokeCreate({
      invoiceNumber: "SALE-OVERRIDE-OVER-LIMIT",
      type: "SALE",
      totalAmount: 26,
      paymentStatus: "UNPAID",
      items: [{ productId, qty: 1, price: 26 }],
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({ error: "DISCOUNT_LIMIT_EXCEEDED" }));
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });

  it("enforces maxDiscountPercent against combined manual-price and invoice discounts", async () => {
    mockAuthorization.can.mockResolvedValue(true);
    const response = await invokeCreate({
      invoiceNumber: "SALE-OVERRIDE-COMBINED-LIMIT",
      type: "SALE",
      totalAmount: 1,
      paymentStatus: "UNPAID",
      discountPercent: 6,
      items: [{ productId, qty: 1, price: 28.5 }],
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({ error: "DISCOUNT_LIMIT_EXCEEDED" }));
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });

});