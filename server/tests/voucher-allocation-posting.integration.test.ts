import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { definePostgresHttpSuite } from "./helpers/postgres-http.integration.helpers.js";
import { VoucherPostingService } from "../modules/accounting/services/voucherPosting.service.js";

function assertTestDatabase(): void {
  const raw = process.env.DATABASE_URL ?? "";
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, "");
  if (process.env.NODE_ENV !== "test" || !/(^|_)(test|ci)(_|$)/i.test(database)) {
    throw new Error("Voucher allocation tests require an explicitly named PostgreSQL test/CI database.");
  }
}

definePostgresHttpSuite("Phase 4B — PostgreSQL voucher allocation and reversal", (getContext) => {
  it("posts a supplier payment, allocates partial settlement, and reverses it atomically", async () => {
    assertTestDatabase();
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const supplier = await prisma.supplier.create({
      data: { tenantId: ctx.tenantAId, name: `P4 Supplier ${suffix}`, balance: 100 }
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId: ctx.tenantAId,
        branchId: ctx.branchAId,
        invoiceNumber: `P4-PUR-${suffix}`,
        date: new Date(),
        type: "PURCHASE",
        partnerId: supplier.id,
        partnerType: "SUPPLIER",
        subtotalAmount: 100,
        totalAmount: 100,
        paidAmount: 0,
        status: "CONFIRMED",
        paymentStatus: "UNPAID",
        documentStatus: "POSTED"
      }
    });
    const paymentId = `P4-PAY-${suffix}`;

    try {
      const posted = await prisma.$transaction((tx) =>
        VoucherPostingService.create(
          { tx, tenantId: ctx.tenantAId, branchId: ctx.branchAId, userId: ctx.userAId },
          {
            id: paymentId,
            paymentNumber: paymentId,
            date: new Date(),
            amount: 60,
            type: "PAYMENT",
            partnerType: "SUPPLIER",
            partnerId: supplier.id,
            paymentMethod: "CASH",
            notes: "Phase 4B partial supplier settlement",
            allocations: [{ invoiceId: invoice.id, amount: 40, note: "Partial invoice allocation" }]
          }
        )
      );

      const [payment, allocatedInvoice, allocation, supplierAfterPost, journal] = await Promise.all([
        prisma.payment.findFirst({ where: { id: paymentId, tenantId: ctx.tenantAId } }),
        prisma.invoice.findFirst({ where: { id: invoice.id, tenantId: ctx.tenantAId } }),
        prisma.invoicePaymentAllocation.findFirst({ where: { paymentId, tenantId: ctx.tenantAId } }),
        prisma.supplier.findFirst({ where: { id: supplier.id, tenantId: ctx.tenantAId } }),
        prisma.journalEntry.findFirst({
          where: { sourceId: paymentId, sourceType: "VOUCHER", tenantId: ctx.tenantAId },
          include: { lines: { include: { account: true } } }
        })
      ]);

      expect(posted.allocationCount).toBe(1);
      expect(posted.allocatedAmount).toBe("40");
      expect(posted.unallocatedAmount).toBe("20");
      expect(payment?.status).toBe("POSTED");
      expect(Number(payment?.amount)).toBe(60);
      expect(Number(allocatedInvoice?.paidAmount)).toBe(40);
      expect(allocatedInvoice?.paymentStatus).toBe("PARTIALLY_PAID");
      expect(Number(allocation?.amount)).toBe(40);
      expect(allocation?.status).toBe("ACTIVE");
      expect(Number(supplierAfterPost?.balance)).toBe(40);
      expect(Number(journal?.debitTotal)).toBe(60);
      expect(Number(journal?.creditTotal)).toBe(60);
      expect(journal?.status).toBe("POSTED");
      expect(journal?.lines).toHaveLength(2);
      expect(journal?.lines.find((line) => Number(line.debit) > 0)?.account.code).toBe("201001");
      expect(journal?.lines.find((line) => Number(line.credit) > 0)?.account.code).toBe("101001");

      const cancelled = await prisma.$transaction((tx) =>
        VoucherPostingService.cancel(
          { tx, tenantId: ctx.tenantAId, branchId: ctx.branchAId, userId: ctx.userAId },
          {
            id: paymentId,
            type: "PAYMENT",
            partnerId: supplier.id,
            amount: 60,
            reason: "Phase 4B cancellation verification"
          }
        )
      );

      const [cancelledPayment, reversedInvoice, reversedAllocation, restoredSupplier, originalJournal, reversalJournal, accounts] = await Promise.all([
        prisma.payment.findFirst({ where: { id: paymentId, tenantId: ctx.tenantAId } }),
        prisma.invoice.findFirst({ where: { id: invoice.id, tenantId: ctx.tenantAId } }),
        prisma.invoicePaymentAllocation.findFirst({ where: { paymentId, tenantId: ctx.tenantAId } }),
        prisma.supplier.findFirst({ where: { id: supplier.id, tenantId: ctx.tenantAId } }),
        prisma.journalEntry.findFirst({ where: { sourceId: paymentId, sourceType: "VOUCHER", tenantId: ctx.tenantAId } }),
        prisma.journalEntry.findFirst({ where: { sourceId: paymentId, sourceType: "VOUCHER_REVERSAL", tenantId: ctx.tenantAId } }),
        prisma.account.findMany({ where: { tenantId: ctx.tenantAId, code: { in: ["101001", "201001"] } } })
      ]);
      expect(cancelled.reversedAllocations).toBe(1);
      expect(cancelledPayment?.status).toBe("CANCELLED");
      expect(reversedInvoice?.paymentStatus).toBe("UNPAID");
      expect(Number(reversedInvoice?.paidAmount)).toBe(0);
      expect(reversedAllocation?.status).toBe("REVERSED");
      expect(reversedAllocation?.reversedAt).toBeInstanceOf(Date);
      expect(Number(restoredSupplier?.balance)).toBe(100);
      expect(originalJournal?.status).toBe("REVERSED");
      expect(reversalJournal?.status).toBe("POSTED");
      expect(reversalJournal?.reversalOfId).toBe(originalJournal?.id);
      expect(Number(reversalJournal?.debitTotal)).toBe(60);
      expect(Number(reversalJournal?.creditTotal)).toBe(60);
      expect(accounts.every((account) => Number(account.balance) === 0)).toBe(true);
    } finally {
      await prisma.auditLog.deleteMany({ where: { tenantId: ctx.tenantAId, entityId: paymentId } });
      await prisma.invoicePaymentAllocation.deleteMany({ where: { tenantId: ctx.tenantAId, paymentId } });
      await prisma.journalEntry.deleteMany({ where: { tenantId: ctx.tenantAId, sourceId: paymentId } });
      await prisma.payment.deleteMany({ where: { tenantId: ctx.tenantAId, id: paymentId } });
      await prisma.invoice.deleteMany({ where: { tenantId: ctx.tenantAId, id: invoice.id } });
      await prisma.supplier.deleteMany({ where: { tenantId: ctx.tenantAId, id: supplier.id } });
      await prisma.account.deleteMany({ where: { tenantId: ctx.tenantAId, code: { in: ["101001", "101002", "201001"] } } });
    }
  });

  it("posts a customer receipt against a sales invoice and updates paid amount", async () => {
    assertTestDatabase();
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const customer = await prisma.customer.create({
      data: { tenantId: ctx.tenantAId, name: `P4 Customer ${suffix}`, balance: 100 }
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId: ctx.tenantAId,
        branchId: ctx.branchAId,
        invoiceNumber: `P4-SAL-${suffix}`,
        date: new Date(),
        type: "SALE",
        partnerId: customer.id,
        partnerType: "CUSTOMER",
        subtotalAmount: 100,
        totalAmount: 100,
        paidAmount: 0,
        status: "CONFIRMED",
        paymentStatus: "UNPAID",
        documentStatus: "POSTED"
      }
    });
    const receiptId = `P4-REC-${suffix}`;

    try {
      const result = await prisma.$transaction((tx) =>
        VoucherPostingService.create(
          { tx, tenantId: ctx.tenantAId, branchId: ctx.branchAId, userId: ctx.userAId },
          {
            id: receiptId,
            paymentNumber: receiptId,
            date: new Date(),
            amount: 30,
            type: "RECEIPT",
            partnerType: "CUSTOMER",
            partnerId: customer.id,
            paymentMethod: "TRANSFER",
            allocations: [{ invoiceId: invoice.id, amount: 30 }]
          }
        )
      );
      const [updatedInvoice, updatedCustomer, journal] = await Promise.all([
        prisma.invoice.findFirst({ where: { id: invoice.id, tenantId: ctx.tenantAId } }),
        prisma.customer.findFirst({ where: { id: customer.id, tenantId: ctx.tenantAId } }),
        prisma.journalEntry.findFirst({
          where: { sourceId: receiptId, sourceType: "VOUCHER", tenantId: ctx.tenantAId },
          include: { lines: { include: { account: true } } }
        })
      ]);
      expect(result.allocationCount).toBe(1);
      expect(Number(updatedInvoice?.paidAmount)).toBe(30);
      expect(updatedInvoice?.paymentStatus).toBe("PARTIALLY_PAID");
      expect(Number(updatedCustomer?.balance)).toBe(70);
      expect(Number(journal?.debitTotal)).toBe(30);
      expect(Number(journal?.creditTotal)).toBe(30);
      expect(journal?.lines.find((line) => Number(line.debit) > 0)?.account.code).toBe("101004");
      expect(journal?.lines.find((line) => Number(line.credit) > 0)?.account.code).toBe("101002");
    } finally {
      await prisma.auditLog.deleteMany({ where: { tenantId: ctx.tenantAId, entityId: receiptId } });
      await prisma.invoicePaymentAllocation.deleteMany({ where: { tenantId: ctx.tenantAId, paymentId: receiptId } });
      await prisma.journalEntry.deleteMany({ where: { tenantId: ctx.tenantAId, sourceId: receiptId } });
      await prisma.payment.deleteMany({ where: { tenantId: ctx.tenantAId, id: receiptId } });
      await prisma.invoice.deleteMany({ where: { tenantId: ctx.tenantAId, id: invoice.id } });
      await prisma.customer.deleteMany({ where: { tenantId: ctx.tenantAId, id: customer.id } });
      await prisma.account.deleteMany({ where: { tenantId: ctx.tenantAId, code: { in: ["101001", "101002", "101004"] } } });
    }
  });

  it("rejects over-allocation and unreconciled legacy partial invoices without persisting a voucher", async () => {
    assertTestDatabase();
    const ctx = getContext();
    const { prisma } = await import("../database/prisma.js");
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const supplier = await prisma.supplier.create({
      data: { tenantId: ctx.tenantAId, name: `P4 Legacy Supplier ${suffix}`, balance: 100 }
    });
    const overAllocatedInvoice = await prisma.invoice.create({
      data: {
        tenantId: ctx.tenantAId, branchId: ctx.branchAId,
        invoiceNumber: `P4-OVER-${suffix}`, date: new Date(), type: "PURCHASE",
        partnerId: supplier.id, partnerType: "SUPPLIER", subtotalAmount: 100,
        totalAmount: 100, paidAmount: 0, status: "CONFIRMED",
        paymentStatus: "UNPAID", documentStatus: "POSTED"
      }
    });
    const legacyPartialInvoice = await prisma.invoice.create({
      data: {
        tenantId: ctx.tenantAId, branchId: ctx.branchAId,
        invoiceNumber: `P4-LEGACY-${suffix}`, date: new Date(), type: "PURCHASE",
        partnerId: supplier.id, partnerType: "SUPPLIER", subtotalAmount: 100,
        totalAmount: 100, paidAmount: null, status: "CONFIRMED",
        paymentStatus: "PARTIALLY_PAID", documentStatus: "POSTED"
      }
    });
    const overPaymentId = `P4-OVER-PAY-${suffix}`;
    const legacyPaymentId = `P4-LEGACY-PAY-${suffix}`;

    try {
      await expect(prisma.$transaction((tx) =>
        VoucherPostingService.create(
          { tx, tenantId: ctx.tenantAId, branchId: ctx.branchAId, userId: ctx.userAId },
          {
            id: overPaymentId, paymentNumber: overPaymentId, date: new Date(),
            amount: 120, type: "PAYMENT", partnerType: "SUPPLIER",
            partnerId: supplier.id, paymentMethod: "CASH",
            allocations: [{ invoiceId: overAllocatedInvoice.id, amount: 110 }]
          }
        )
      )).rejects.toThrow(/INVOICE_OVER_ALLOCATION/);

      await expect(prisma.$transaction((tx) =>
        VoucherPostingService.create(
          { tx, tenantId: ctx.tenantAId, branchId: ctx.branchAId, userId: ctx.userAId },
          {
            id: legacyPaymentId, paymentNumber: legacyPaymentId, date: new Date(),
            amount: 10, type: "PAYMENT", partnerType: "SUPPLIER",
            partnerId: supplier.id, paymentMethod: "CASH",
            allocations: [{ invoiceId: legacyPartialInvoice.id, amount: 10 }]
          }
        )
      )).rejects.toThrow(/LEGACY_PARTIAL_PAYMENT_RECONCILIATION_REQUIRED/);

      const [payments, allocations, journals, supplierAfter, overInvoiceAfter, legacyAfter] = await Promise.all([
        prisma.payment.findMany({ where: { tenantId: ctx.tenantAId, id: { in: [overPaymentId, legacyPaymentId] } } }),
        prisma.invoicePaymentAllocation.findMany({ where: { tenantId: ctx.tenantAId, paymentId: { in: [overPaymentId, legacyPaymentId] } } }),
        prisma.journalEntry.findMany({ where: { tenantId: ctx.tenantAId, sourceId: { in: [overPaymentId, legacyPaymentId] } } }),
        prisma.supplier.findFirst({ where: { id: supplier.id, tenantId: ctx.tenantAId } }),
        prisma.invoice.findFirst({ where: { id: overAllocatedInvoice.id, tenantId: ctx.tenantAId } }),
        prisma.invoice.findFirst({ where: { id: legacyPartialInvoice.id, tenantId: ctx.tenantAId } })
      ]);
      expect(payments).toHaveLength(0);
      expect(allocations).toHaveLength(0);
      expect(journals).toHaveLength(0);
      expect(Number(supplierAfter?.balance)).toBe(100);
      expect(Number(overInvoiceAfter?.paidAmount)).toBe(0);
      expect(legacyAfter?.paidAmount).toBeNull();
    } finally {
      await prisma.invoice.deleteMany({ where: { tenantId: ctx.tenantAId, id: { in: [overAllocatedInvoice.id, legacyPartialInvoice.id] } } });
      await prisma.supplier.deleteMany({ where: { tenantId: ctx.tenantAId, id: supplier.id } });
    }
  });
});
