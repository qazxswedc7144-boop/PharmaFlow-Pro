import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockSaas } = vi.hoisted(() => {
  const prisma: any = {
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
    product: { findMany: vi.fn() },
    invoice: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    mockPrisma: prisma,
    mockSaas: {
      checkSubscriptionLimit: vi.fn(),
      incrementUsage: vi.fn(),
    },
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

import { invoiceRouter } from "../routes/invoice.routes.js";

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
      price: expect.objectContaining({ d: expect.any(Array) }),
    }));
    expect(invoiceData.items.create[0].price.toString()).toBe("30");
    expect(invoiceData.items.create[0].total.toString()).toBe("300");
  });

});
