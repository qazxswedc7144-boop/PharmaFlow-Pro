import { Prisma } from "@prisma/client";

type VoucherType = "RECEIPT" | "PAYMENT";
type PartnerType = "CUSTOMER" | "SUPPLIER";

interface VoucherAllocationInput {
  invoiceId: string;
  amount: string | number;
  note?: string | null;
}

interface VoucherCreateInput {
  id: string;
  paymentNumber: string;
  date: string | Date;
  amount: string | number;
  type: VoucherType;
  partnerType: PartnerType;
  partnerId: string;
  paymentMethod: "CASH" | "TRANSFER";
  notes?: string | null;
  allocations?: VoucherAllocationInput[];
}

interface VoucherScope {
  tenantId: string;
  branchId: string;
  userId: string;
  tx: Prisma.TransactionClient;
}

const CASH_CUSTOMER = "عميل نقدي";
const CASH_SUPPLIER = "مورد نقدي";
const ZERO = new Prisma.Decimal(0);
const TOLERANCE = new Prisma.Decimal("0.0001");

function fail(code: string, message = code): never {
  const error: any = new Error(message);
  error.code = code;
  throw error;
}

function decimal(raw: unknown, code: string): Prisma.Decimal {
  try {
    if (raw === null || raw === undefined || raw === "") return fail(code);
    const value = new Prisma.Decimal(String(raw));
    if (!value.isFinite() || value.isNegative() || value.decimalPlaces() > 4) return fail(code);
    return value;
  } catch {
    return fail(code);
  }
}

function normalizedVoucherType(raw: unknown): VoucherType {
  const value = String(raw || "").trim().toUpperCase();
  if (value !== "RECEIPT" && value !== "PAYMENT") fail("VOUCHER_TYPE_INVALID");
  return value;
}

function expectedPartnerType(type: VoucherType): PartnerType {
  return type === "PAYMENT" ? "SUPPLIER" : "CUSTOMER";
}

export class VoucherPostingService {
  private static async assertOpenPeriod(
    tx: Prisma.TransactionClient,
    tenantId: string,
    date: Date
  ): Promise<void> {
    const periods = await tx.$queryRaw<Array<{ id: string; isLocked: boolean }>>(
      Prisma.sql`SELECT id, "isLocked"
        FROM "accounting_periods"
        WHERE "tenantId" = ${tenantId}
          AND "startDate" <= ${date}
          AND "endDate" >= ${date}
        ORDER BY "startDate" DESC
        FOR UPDATE`
    );
    if (periods.length === 0) fail("ACCOUNTING_PERIOD_NOT_CONFIGURED");
    if (periods.length !== 1) fail("ACCOUNTING_PERIOD_AMBIGUOUS");
    if (periods[0]?.isLocked) fail("ACCOUNTING_PERIOD_LOCKED");
  }

  private static async getOrCreateAccount(
    tx: Prisma.TransactionClient,
    tenantId: string,
    code: string,
    name: string,
    type: "ASSET" | "LIABILITY"
  ) {
    let account = await tx.account.findFirst({ where: { tenantId, code } });
    if (!account) {
      try {
        account = await tx.account.create({
          data: { tenantId, code, name, type, isSystem: true, balance: ZERO }
        });
      } catch (error: any) {
        if (error?.code !== "P2002") throw error;
        account = await tx.account.findFirst({ where: { tenantId, code } });
      }
    }
    if (!account) fail("SYSTEM_ACCOUNT_UNAVAILABLE");
    return account;
  }

  private static async updateAccountBalances(
    tx: Prisma.TransactionClient,
    tenantId: string,
    deltas: Map<string, Prisma.Decimal>
  ): Promise<void> {
    const accountIds = [...deltas.keys()].sort();
    if (accountIds.length === 0) fail("JOURNAL_ACCOUNTS_REQUIRED");

    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "accounts"
        WHERE "tenantId" = ${tenantId}
          AND id IN (${Prisma.join(accountIds)})
        ORDER BY id
        FOR UPDATE`
    );

    for (const accountId of accountIds) {
      const delta = deltas.get(accountId)!;
      await tx.account.update({
        where: { id: accountId, tenantId },
        data: { balance: { increment: delta }, version: { increment: 1 } }
      });
    }
  }

  private static async createVoucherJournal(
    tx: Prisma.TransactionClient,
    params: {
      id: string;
      paymentNumber: string;
      date: Date;
      amount: Prisma.Decimal;
      type: VoucherType;
      tenantId: string;
      branchId: string;
      reversalOfId?: string;
      reversal?: boolean;
    }
  ) {
    const { id, paymentNumber, date, amount, type, tenantId, branchId, reversalOfId, reversal } = params;
    const cash = await this.getOrCreateAccount(
      tx, tenantId, "101001", "الصندوق والبنك (النقدية)", "ASSET"
    );
    const receivables = type === "RECEIPT"
      ? await this.getOrCreateAccount(tx, tenantId, "101002", "ذمم العملاء المدينة", "ASSET")
      : null;
    const payables = type === "PAYMENT"
      ? await this.getOrCreateAccount(tx, tenantId, "201001", "ذمم الموردين الدائنة", "LIABILITY")
      : null;

    const debitAccountId = type === "RECEIPT" ? cash.id : payables!.id;
    const creditAccountId = type === "RECEIPT" ? receivables!.id : cash.id;
    const lines = reversal
      ? [
          { accountId: debitAccountId, debit: ZERO, credit: amount, description: "عكس سند" },
          { accountId: creditAccountId, debit: amount, credit: ZERO, description: "عكس سند" }
        ]
      : [
          { accountId: debitAccountId, debit: amount, credit: ZERO, description: type === "RECEIPT" ? "إثبات القبض" : "تسوية ذمم المورد" },
          { accountId: creditAccountId, debit: ZERO, credit: amount, description: type === "RECEIPT" ? "تخفيض ذمم العميل" : "إثبات الصرف" }
        ];

    const entry = await tx.journalEntry.create({
      data: {
        date,
        sourceId: id,
        sourceType: reversal ? "VOUCHER_REVERSAL" : "VOUCHER",
        referenceId: paymentNumber,
        status: "POSTED",
        description: reversal ? `عكس سند ${paymentNumber}` : `ترحيل سند ${paymentNumber}`,
        debitTotal: amount,
        creditTotal: amount,
        reversalOfId: reversalOfId || null,
        tenantId,
        branchId,
        lines: {
          create: lines.map((line) => ({
            tenantId,
            accountId: line.accountId,
            debit: line.debit,
            credit: line.credit,
            description: line.description
          }))
        }
      },
      include: { lines: true }
    });

    const deltas = new Map<string, Prisma.Decimal>();
    for (const line of lines) {
      const delta = line.debit.minus(line.credit);
      deltas.set(line.accountId, (deltas.get(line.accountId) || ZERO).plus(delta));
    }
    await this.updateAccountBalances(tx, tenantId, deltas);
    return entry;
  }

  static async create(scope: VoucherScope, input: VoucherCreateInput) {
    const { tx, tenantId, branchId } = scope;
    const type = normalizedVoucherType(input.type);
    const partnerType = expectedPartnerType(type);
    if (input.partnerType !== partnerType) fail("VOUCHER_PARTNER_TYPE_MISMATCH");
    if (!input.id?.trim() || !input.partnerId?.trim() || !branchId?.trim()) fail("VOUCHER_REQUIRED_FIELDS_MISSING");

    const amount = decimal(input.amount, "VOUCHER_AMOUNT_INVALID");
    if (amount.lessThanOrEqualTo(0)) fail("VOUCHER_AMOUNT_MUST_BE_POSITIVE");
    const date = input.date instanceof Date ? input.date : new Date(input.date);
    if (!Number.isFinite(date.getTime())) fail("VOUCHER_DATE_INVALID");
    if (input.paymentMethod !== "CASH" && input.paymentMethod !== "TRANSFER") fail("VOUCHER_PAYMENT_METHOD_INVALID");

    const existing = await tx.payment.findUnique({ where: { id: input.id } });
    if (existing) {
      if (existing.tenantId !== tenantId) fail("CROSS_TENANT_VOUCHER_FORBIDDEN");
      fail("VOUCHER_ALREADY_EXISTS");
    }

    const payloadPartnerIsCash =
      input.partnerId === CASH_CUSTOMER || input.partnerId === CASH_SUPPLIER;
    if (!payloadPartnerIsCash) {
      const partner = type === "RECEIPT"
        ? await tx.customer.findFirst({ where: { id: input.partnerId, tenantId } })
        : await tx.supplier.findFirst({ where: { id: input.partnerId, tenantId } });
      if (!partner) fail(type === "RECEIPT" ? "CUSTOMER_NOT_FOUND" : "SUPPLIER_NOT_FOUND");
    } else if (
      (type === "RECEIPT" && input.partnerId !== CASH_CUSTOMER) ||
      (type === "PAYMENT" && input.partnerId !== CASH_SUPPLIER)
    ) {
      fail("CASH_PARTNER_TYPE_MISMATCH");
    }

    await this.assertOpenPeriod(tx, tenantId, date);

    const allocations = Array.isArray(input.allocations) ? input.allocations : [];
    const seenInvoices = new Set<string>();
    const normalized = allocations.map((allocation) => {
      const invoiceId = String(allocation?.invoiceId || "").trim();
      if (!invoiceId || seenInvoices.has(invoiceId)) fail("DUPLICATE_OR_INVALID_INVOICE_ALLOCATION");
      seenInvoices.add(invoiceId);
      const allocationAmount = decimal(allocation.amount, "INVOICE_ALLOCATION_AMOUNT_INVALID");
      if (allocationAmount.lessThanOrEqualTo(0)) fail("INVOICE_ALLOCATION_AMOUNT_MUST_BE_POSITIVE");
      return { invoiceId, amount: allocationAmount, note: allocation.note || null };
    }).sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));

    const allocationTotal = normalized.reduce((sum, allocation) => sum.plus(allocation.amount), ZERO);
    if (allocationTotal.greaterThan(amount)) fail("ALLOCATIONS_EXCEED_VOUCHER_AMOUNT");

    const invoiceUpdates: Array<{ invoiceId: string; paidAmount: Prisma.Decimal; paymentStatus: string }> = [];
    for (const allocation of normalized) {
      const lockedRows = await tx.$queryRaw<any[]>(
        Prisma.sql`SELECT id, "totalAmount", "paidAmount", "paymentStatus", type, "partnerId", "branchId", "documentStatus"
          FROM "invoices"
          WHERE id = ${allocation.invoiceId} AND "tenantId" = ${tenantId}
          FOR UPDATE`
      );
      const invoice = lockedRows[0];
      if (!invoice) fail("INVOICE_NOT_FOUND_OR_FORBIDDEN");
      const expectedInvoiceType = type === "PAYMENT" ? "PURCHASE" : "SALE";
      if (String(invoice.type) !== expectedInvoiceType) fail("INVOICE_TYPE_MISMATCH");
      if (invoice.partnerId !== input.partnerId) fail("INVOICE_PARTNER_MISMATCH");
      if (invoice.branchId && invoice.branchId !== branchId) fail("INVOICE_BRANCH_MISMATCH");
      if (invoice.documentStatus !== "POSTED") fail("INVOICE_NOT_POSTED");

      const total = new Prisma.Decimal(String(invoice.totalAmount));
      let currentPaid: Prisma.Decimal;
      if (invoice.paidAmount === null || invoice.paidAmount === undefined) {
        if (invoice.paymentStatus === "PAID" || invoice.paymentStatus === "CASH") currentPaid = total;
        else if (invoice.paymentStatus === "UNPAID") currentPaid = ZERO;
        else fail("LEGACY_PARTIAL_PAYMENT_RECONCILIATION_REQUIRED");
      } else {
        currentPaid = new Prisma.Decimal(String(invoice.paidAmount));
      }
      if (currentPaid.isNegative() || currentPaid.greaterThan(total)) {
        fail("INVOICE_PAID_AMOUNT_INVALID");
      }
      if (allocation.amount.greaterThan(total.minus(currentPaid))) {
        fail("INVOICE_OVER_ALLOCATION");
      }
      const nextPaid = currentPaid.plus(allocation.amount);
      const isFullyPaid = nextPaid.greaterThanOrEqualTo(total);
      const normalizedPaid = isFullyPaid ? total : nextPaid;
      const paymentStatus = isFullyPaid ? "PAID" : "PARTIALLY_PAID";
      invoiceUpdates.push({ invoiceId: allocation.invoiceId, paidAmount: normalizedPaid, paymentStatus });
    }

    const payment = await tx.payment.create({
      data: {
        id: input.id,
        paymentNumber: input.paymentNumber || input.id,
        date,
        amount,
        partnerId: input.partnerId,
        partnerType,
        paymentMethod: input.paymentMethod,
        referenceId: input.id,
        notes: input.notes || null,
        status: "POSTED",
        tenantId,
        branchId
      }
    });

    for (let index = 0; index < normalized.length; index++) {
      const allocation = normalized[index]!;
      const invoiceUpdate = invoiceUpdates[index]!;
      await tx.invoicePaymentAllocation.create({
        data: {
          paymentId: payment.id,
          invoiceId: allocation.invoiceId,
          amount: allocation.amount,
          note: allocation.note,
          tenantId,
          branchId
        }
      });
      await tx.invoice.update({
        where: { id: allocation.invoiceId, tenantId },
        data: {
          paidAmount: invoiceUpdate.paidAmount,
          paymentStatus: invoiceUpdate.paymentStatus as any
        }
      });
    }

    if (!payloadPartnerIsCash) {
      if (type === "RECEIPT") {
        await tx.customer.update({
          where: { id: input.partnerId, tenantId },
          data: { balance: { decrement: amount } }
        });
      } else {
        await tx.supplier.update({
          where: { id: input.partnerId, tenantId },
          data: { balance: { decrement: amount } }
        });
      }
    }

    const journal = await this.createVoucherJournal(tx, {
      id: payment.id,
      paymentNumber: payment.paymentNumber || payment.id,
      date,
      amount,
      type,
      tenantId,
      branchId,
    });

    return {
      paymentId: payment.id,
      journalId: journal.id,
      allocationCount: normalized.length,
      allocatedAmount: allocationTotal.toString(),
      unallocatedAmount: amount.minus(allocationTotal).toString()
    };
  }

  static async cancel(
    scope: VoucherScope,
    input: { id: string; type: VoucherType; partnerId: string; amount: string | number; reason?: string | null }
  ) {
    const { tx, tenantId, branchId, userId } = scope;
    const type = normalizedVoucherType(input.type);
    const paymentRows = await tx.$queryRaw<any[]>(
      Prisma.sql`SELECT * FROM "payments"
        WHERE id = ${input.id} AND "tenantId" = ${tenantId}
        FOR UPDATE`
    );
    const payment = paymentRows[0];
    if (!payment) fail("VOUCHER_NOT_FOUND_OR_FORBIDDEN");
    if (payment.status !== "POSTED") fail("VOUCHER_ALREADY_CANCELLED");
    if (payment.branchId !== branchId) fail("VOUCHER_BRANCH_MISMATCH");
    if (payment.partnerId !== input.partnerId || payment.partnerType !== expectedPartnerType(type)) {
      fail("VOUCHER_PARTNER_MISMATCH");
    }
    const amount = new Prisma.Decimal(String(payment.amount));
    const requestedAmount = decimal(input.amount, "VOUCHER_AMOUNT_INVALID");
    if (amount.minus(requestedAmount).abs().greaterThan(TOLERANCE)) fail("VOUCHER_AMOUNT_MISMATCH");

    await this.assertOpenPeriod(tx, tenantId, new Date());

    const allocations = await tx.invoicePaymentAllocation.findMany({
      where: { paymentId: payment.id, tenantId, status: "ACTIVE" },
      orderBy: { invoiceId: "asc" }
    });
    for (const allocation of allocations) {
      const lockedRows = await tx.$queryRaw<any[]>(
        Prisma.sql`SELECT id, "totalAmount", "paidAmount", "paymentStatus", "branchId", type, "partnerId"
          FROM "invoices"
          WHERE id = ${allocation.invoiceId} AND "tenantId" = ${tenantId}
          FOR UPDATE`
      );
      const invoice = lockedRows[0];
      if (!invoice || (invoice.branchId && invoice.branchId !== branchId)) fail("INVOICE_NOT_FOUND_OR_FORBIDDEN");
      const expectedInvoiceType = type === "PAYMENT" ? "PURCHASE" : "SALE";
      if (invoice.type !== expectedInvoiceType || invoice.partnerId !== payment.partnerId) fail("INVOICE_ALLOCATION_PARTNER_MISMATCH");
      if (invoice.paidAmount === null || invoice.paidAmount === undefined) {
        fail("INVOICE_PAID_AMOUNT_UNKNOWN");
      }
      const currentPaid = new Prisma.Decimal(String(invoice.paidAmount));
      const allocationAmount = new Prisma.Decimal(allocation.amount.toString());
      if (currentPaid.lessThan(allocationAmount)) {
        fail("INVOICE_ALLOCATION_REVERSAL_EXCEEDS_PAID_AMOUNT");
      }
      const nextPaid = currentPaid.minus(allocationAmount).isZero()
        ? ZERO
        : currentPaid.minus(allocationAmount);
      const total = new Prisma.Decimal(String(invoice.totalAmount));
      const paymentStatus = nextPaid.isZero()
        ? "UNPAID"
        : nextPaid.greaterThanOrEqualTo(total) ? "PAID" : "PARTIALLY_PAID";

      await tx.invoice.update({
        where: { id: invoice.id, tenantId },
        data: { paidAmount: nextPaid, paymentStatus: paymentStatus as any }
      });
      await tx.invoicePaymentAllocation.update({
        where: { id: allocation.id, tenantId },
        data: { status: "REVERSED", reversedAt: new Date() }
      });
    }

    const originalJournal = await tx.journalEntry.findFirst({
      where: { sourceId: payment.id, sourceType: "VOUCHER", tenantId, status: "POSTED" },
      include: { lines: true }
    });
    if (!originalJournal || originalJournal.lines.length < 2) fail("VOUCHER_JOURNAL_ENTRY_MISSING");

    const accountIds = [...new Set(originalJournal.lines.map((line) => line.accountId))].sort();
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "accounts"
        WHERE "tenantId" = ${tenantId}
          AND id IN (${Prisma.join(accountIds)})
        ORDER BY id
        FOR UPDATE`
    );

    const reversalLines = originalJournal.lines.map((line) => ({
      tenantId,
      accountId: line.accountId,
      debit: line.credit,
      credit: line.debit,
      description: `عكس: ${line.description || payment.paymentNumber || payment.id}`
    }));
    const reversalJournal = await tx.journalEntry.create({
      data: {
        date: new Date(),
        sourceId: payment.id,
        sourceType: "VOUCHER_REVERSAL",
        referenceId: payment.paymentNumber || payment.id,
        status: "POSTED",
        description: `عكس سند ${payment.paymentNumber || payment.id}`,
        debitTotal: amount,
        creditTotal: amount,
        reversalOfId: originalJournal.id,
        tenantId,
        branchId,
        lines: { create: reversalLines }
      }
    });

    const deltas = new Map<string, Prisma.Decimal>();
    for (const line of reversalLines) {
      const delta = new Prisma.Decimal(line.debit.toString()).minus(line.credit.toString());
      deltas.set(line.accountId, (deltas.get(line.accountId) || ZERO).plus(delta));
    }
    await this.updateAccountBalances(tx, tenantId, deltas);
    await tx.journalEntry.update({
      where: { id: originalJournal.id, tenantId },
      data: { status: "REVERSED" }
    });

    if (payment.partnerId && payment.partnerId !== CASH_CUSTOMER && payment.partnerId !== CASH_SUPPLIER) {
      if (type === "RECEIPT") {
        await tx.customer.update({
          where: { id: payment.partnerId, tenantId },
          data: { balance: { increment: amount } }
        });
      } else {
        await tx.supplier.update({
          where: { id: payment.partnerId, tenantId },
          data: { balance: { increment: amount } }
        });
      }
    }

    await tx.payment.update({
      where: { id: payment.id, tenantId },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancellationReason: input.reason || null
      }
    });

    await tx.auditLog.create({
      data: {
        userId,
        action: "DELETE",
        entity: "Payment",
        entityId: payment.id,
        before: JSON.stringify({ status: payment.status, amount: payment.amount }),
        after: JSON.stringify({ status: "CANCELLED", reversalJournalId: reversalJournal.id, reason: input.reason || null }),
        ipAddress: "SYNC"
      }
    });

    return {
      paymentId: payment.id,
      reversalJournalId: reversalJournal.id,
      reversedAllocations: allocations.length
    };
  }
}
