// server/modules/accounting/services/financialTransaction.service.ts
import { runInTransaction } from "../../../core/database/transactionGuard.js";
import { FifoService } from "../../inventory/services/fifo.service.js";
import { Prisma, InvoiceStatus, DocumentStatus, InvoiceType } from "@prisma/client";
import { prisma } from "../../../database/prisma.js";
import { AuthorizationService } from "../../../services/rbac/authorization.service.js";
import { SalesPricingService } from "./salesPricing.service.js";

export class FinancialTransactionService {
  /**
   * Helper to fetch or bootstrap system accounting ledger codes safely
   */
  private static async getOrCreateAccount(
    tx: Prisma.TransactionClient,
    code: string,
    name: string,
    type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE",
    tenantId: string
  ) {
    let account = await tx.account.findFirst({ where: { code, tenantId } });
    if (!account) {
      account = await tx.account.create({
        data: {
          code,
          name,
          type,
          tenantId,
          isSystem: true,
          balance: 0.00
        }
      });
    }
    return account;
  }

  /**
   * Safe transaction router to post any Invoice (Sale/Purchase/Returns) dynamically to General Ledger.
   * Completely encapsulated inside an ACID prisma transaction.
   */
  static async postInvoiceToLedger(
    invoiceId: string,
    userId: string | null = null,
    ipAddress: string | null = null,
    tenantId: string | null = null,
    userRole?: string
  ) {
    try {
      return await runInTransaction("AccountingService", async (tx) => {
        // 1. Fetch invoice and include all line items with product definitions
        // ⚠️ FAIL-CLOSED: tenantId is mandatory. Without it, no invoice 
        // lookup should proceed — otherwise we silently revert to an 
        // unscoped query.
        if (!tenantId || typeof tenantId !== 'string' || tenantId.trim() === '') {
          throw new Error(
            'TENANT_REQUIRED: tenantId is mandatory for invoice posting.'
          );
        }

        const invoice = await tx.invoice.findFirst({
          where: { id: invoiceId, tenantId },
          include: { items: { include: { product: true } } }
        });

        if (!invoice) {
          throw new Error(`INVOICE_NOT_FOUND: Invoice ID ${invoiceId} doesn't exist or access is unauthorized.`);
        }

        return await this.executeInvoiceLedgerPosting(tx, invoice, userId, ipAddress, tenantId, userRole);
      });
    } catch (err: any) {
      if (
        err.message?.includes("INSUFFICIENT_STOCK") ||
        err.message?.includes("FIFO_DEPLETION_MISMATCH") ||
        err.message?.includes("INVENTORY_ALLOCATION_FAILED")
      ) {
        try {
          await prisma.auditLog.create({
            data: {
              userId,
              action: "INVENTORY_ALLOCATION_FAILED",
              entity: "Invoice",
              entityId: invoiceId,
              before: JSON.stringify({ error: err.message }),
              after: null,
              ipAddress
            }
          });
        } catch (auditErr: any) {
          console.error("Failed to write INVENTORY_ALLOCATION_FAILED audit log:", auditErr.message);
        }
      }
      throw err;
    }
  }

  /**
   * Core logic to post an invoice to the General Ledger.
   * This method expects to be run within an existing transaction.
   */
  static async executeInvoiceLedgerPosting(
    tx: Prisma.TransactionClient,
    invoice: Prisma.InvoiceGetPayload<{ include: { items: { include: { product: true } } } }>,
    userId: string | null = null,
    ipAddress: string | null = null,
    tenantId: string | null = null,
    userRole?: string
  ) {
    // ⚠️ P0 FIX: Pessimistic row-level lock on the invoice.
    // This must run FIRST, inside the caller's transaction (tx).
    // Prevents two concurrent transactions from both passing the state 
    // check and posting the same invoice twice.
    // P0 SECURITY: Include tenantId in lock query
    if (!tenantId || typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new Error(
        'TENANT_REQUIRED: tenantId is mandatory for invoice posting.'
      );
    }

    const invoiceLockRows = await tx.$queryRaw<
      Array<{ id: string; documentStatus: string; status: string }>
    >`
      SELECT id, "documentStatus", status
        FROM "invoices"
       WHERE id = ${invoice.id} AND "tenantId" = ${tenantId}
       FOR UPDATE
    `;

    const lockedInvoice = invoiceLockRows[0];
    if (!lockedInvoice) {
      throw new Error(
        `INVOICE_NOT_FOUND: Invoice ${invoice.id} vanished during posting.`
      );
    }

    // Re-check inside the lock. No race is possible from this point on.
    if (
      lockedInvoice.documentStatus === 'POSTED' ||
      lockedInvoice.documentStatus === DocumentStatus.POSTED ||
      lockedInvoice.status === 'CONFIRMED' ||
      lockedInvoice.status === InvoiceStatus.CONFIRMED
    ) {
      throw new Error(
        `ALREADY_POSTED: Invoice ${invoice.invoiceNumber} is already posted ` +
        `(status=${lockedInvoice.status}, documentStatus=${lockedInvoice.documentStatus}).`
      );
    }

    // Revalidate sale pricing at the posting boundary. A draft must not become
    // postable after its override permission or tenant discount ceiling changes.
    if (invoice.type === InvoiceType.SALE) {
      const policy = await tx.tenantSalesPolicy.findUnique({ where: { tenantId } });
      const pricingItems = invoice.items.map((item: any) => {
        if (!item.product) {
          const error: any = new Error("PRODUCT_NOT_FOUND");
          error.code = "PRODUCT_NOT_FOUND";
          throw error;
        }
        return {
          price: item.price,
          catalogPrice: item.product.price,
          qty: item.qty
        };
      });

      const hasManualPriceOverride = pricingItems.some(
        (item: any) => !new Prisma.Decimal(item.price).equals(new Prisma.Decimal(item.catalogPrice))
      );
      if (hasManualPriceOverride) {
        const canOverridePrice = await AuthorizationService.can({
          userId: userId || "",
          role: userRole,
          tenantId
        }, "sales.price.override", { tenantId });

        if (!canOverridePrice) {
          const error: any = new Error("PRICE_OVERRIDE_FORBIDDEN");
          error.code = "PRICE_OVERRIDE_FORBIDDEN";
          throw error;
        }
      }

      const validatedPricing = SalesPricingService.calculate(
        pricingItems,
        {
          maxDiscountPercent: policy?.maxDiscountPercent ?? 0,
          // Tax settings are snapshotted on the draft; only the discount ceiling
          // is taken from the current tenant policy at posting time.
          taxRatePercent: invoice.taxRatePercent ?? policy?.taxRatePercent ?? 0,
          taxMode: invoice.taxMode ?? policy?.taxMode ?? "NONE"
        },
        invoice.discountPercent ?? 0
      );
      const pricingDifference = validatedPricing.totalAmount
        .minus(new Prisma.Decimal(invoice.totalAmount.toString()))
        .abs();
      if (pricingDifference.greaterThan(new Prisma.Decimal("0.01"))) {
        const error: any = new Error("SALES_PRICE_POLICY_MISMATCH");
        error.code = "SALES_PRICE_POLICY_MISMATCH";
        throw error;
      }
    }

    const ZERO = new Prisma.Decimal(0);
    const totalInvoiceAmount = new Prisma.Decimal(invoice.totalAmount.toString());
    const isCash = invoice.paymentStatus === "PAID" || invoice.paymentStatus === "CASH" as any;
    const isSale = invoice.type === InvoiceType.SALE;
    const saleTaxAmount = isSale ? new Prisma.Decimal(invoice.taxAmount.toString()) : new Prisma.Decimal(0);
    const saleRevenueAmount = isSale
      ? new Prisma.Decimal(invoice.subtotalAmount.toString())
          .minus(new Prisma.Decimal(invoice.discountAmount.toString()))
          .minus(invoice.taxMode === "INCLUSIVE" ? saleTaxAmount : new Prisma.Decimal(0))
      : new Prisma.Decimal(0);

    // 2. Lock core accounts involved in the transaction to prevent concurrent race conditions
    // We will bootstrap core accounts: Cash ('101001'), A/R ('101002'), Inventory ('101003'), Rev ('401001'), COGS ('501001'), A/P ('201001')
    const cashAcc = await this.getOrCreateAccount(tx, "101001", "الصندوق والبنك (النقدية)", "ASSET", tenantId);
    const arAcc = await this.getOrCreateAccount(tx, "101002", "ذمم مدنية عملاء (أوراق القبض)", "ASSET", tenantId);
    const invAcc = await this.getOrCreateAccount(tx, "101003", "مخزون الأدوية والمواد الطبية", "ASSET", tenantId);
    const revAcc = await this.getOrCreateAccount(tx, "401001", "إيرادات المبيعات الدوائية", "REVENUE", tenantId);
    const cogsAcc = await this.getOrCreateAccount(tx, "501001", "تكلفة المبيعات (COGS)", "EXPENSE", tenantId);
    const apAcc = await this.getOrCreateAccount(tx, "201001", "ذمم دائنة موردين (أوراق الدفع)", "LIABILITY", tenantId);
    const taxPayableAcc = isSale && saleTaxAmount.greaterThan(0)
      ? await this.getOrCreateAccount(tx, "203001", "ضريبة مبيعات مستحقة", "LIABILITY", tenantId)
      : null;

    // Lock current accounts for row-level balance security
    const accountIdsToLock = [
      cashAcc.id, arAcc.id, invAcc.id, revAcc.id, cogsAcc.id, apAcc.id,
      ...(taxPayableAcc ? [taxPayableAcc.id] : [])
    ];
    await tx.$executeRaw(
      Prisma.sql`SELECT id FROM accounts WHERE id IN (${Prisma.join(accountIdsToLock)}) FOR UPDATE`
    );

    let totalComputatedCogs = ZERO;
    const ledgerLines: { accountId: string; debit: Prisma.Decimal; credit: Prisma.Decimal; description: string }[] = [];

    // Preserve snapshot state before mutation for auditing purposes
    const invoiceSnapshotBefore = JSON.stringify(invoice);

    // 3. Process Inventory depletion or inclusion & map COGS/Stock entries
    if (invoice.type === InvoiceType.SALE) {
      // SALE: Deplete stock from FIFO batches and calculate actual Cost of Goods Sold
      for (const item of invoice.items) {
        const fifoResult = await FifoService.depleteStock(
          tx,
          item.productId,
          item.qty,
          invoice.id,
          "INVOICE",
          `صرف مبيعات - فاتورة #${invoice.invoiceNumber}`,
          tenantId
        );
        
        const fifoCost = new Prisma.Decimal(fifoResult.totalCost.toString());
        totalComputatedCogs = totalComputatedCogs.plus(fifoCost);

        // Persist FIFO-derived unit cost using Decimal arithmetic.
        await tx.invoiceItem.update({
          where: { id: item.id },
          data: { cost: fifoCost.div(item.qty) }
        });
      }

      // Debit the actual settlement account; credit net revenue and separately recognize tax payable.
      if (isCash) {
        ledgerLines.push({
          accountId: cashAcc.id,
          debit: totalInvoiceAmount,
          credit: ZERO,
          description: `نقدية مبيعات فاتورة #${invoice.invoiceNumber}`
        });
      } else {
        ledgerLines.push({
          accountId: arAcc.id,
          debit: totalInvoiceAmount,
          credit: ZERO,
          description: `آجل مبيعات فاتورة #${invoice.invoiceNumber}`
        });
      }

      ledgerLines.push({
        accountId: revAcc.id,
        debit: ZERO,
        credit: saleRevenueAmount,
        description: `صافي إيراد مبيعات فاتورة #${invoice.invoiceNumber}`
      });

      if (saleTaxAmount.greaterThan(0) && taxPayableAcc) {
        ledgerLines.push({
          accountId: taxPayableAcc.id,
          debit: ZERO,
          credit: saleTaxAmount,
          description: `ضريبة مبيعات مستحقة فاتورة #${invoice.invoiceNumber}`
        });
      }

      // Ledger Entry for COGS: Debit COGS, Credit Inventory
      if (totalComputatedCogs.greaterThan(0)) {
        const cogsAmount = totalComputatedCogs;
        ledgerLines.push({
          accountId: cogsAcc.id,
          debit: cogsAmount,
          credit: ZERO,
          description: `تكلفة مبيعات فاتورة #${invoice.invoiceNumber}`
        });
        ledgerLines.push({
          accountId: invAcc.id,
          debit: ZERO,
          credit: cogsAmount,
          description: `انخفاض المخزون مبيعات فاتورة #${invoice.invoiceNumber}`
        });
      }

    } else if (invoice.type === InvoiceType.PURCHASE) {
      // PURCHASE: Increase inventory layers
      for (const item of invoice.items) {
        const batchNumber = item.note || `BATCH-${Date.now()}`;
        await FifoService.addStock(
          tx,
          item.productId,
          batchNumber,
          item.qty,
          Number(item.cost ?? item.price),
          item.expiryDate,
          invoice.id,
          "INVOICE",
          `توريد مشتريات - فاتورة #${invoice.invoiceNumber}`,
          tenantId,
          invoice.branchId
        );
      }

      // Ledger Entry: Debit Inventory, Credit Cash or Accounts Payable
      ledgerLines.push({
        accountId: invAcc.id,
        debit: totalInvoiceAmount,
        credit: ZERO,
        description: `زيادة مخزون مشتريات فاتورة #${invoice.invoiceNumber}`
      });

      if (isCash) {
        ledgerLines.push({
          accountId: cashAcc.id,
          debit: ZERO,
          credit: totalInvoiceAmount,
          description: `نقدية مشتريات فاتورة #${invoice.invoiceNumber}`
        });
      } else {
        ledgerLines.push({
          accountId: apAcc.id,
          debit: ZERO,
          credit: totalInvoiceAmount,
          description: `آجل مشتريات فاتورة #${invoice.invoiceNumber}`
        });
      }

    } else {
      throw new Error(`UNSUPPORTED_TYPE: Invoice type ${invoice.type} is not yet supported in automatic ledger mapping.`);
    }

    // 4. Double-Entry Enforcement Rule: totalDebit === totalCredit
    const sumDebits = ledgerLines.reduce((acc, line) => acc.plus(line.debit), ZERO);
    const sumCredits = ledgerLines.reduce((acc, line) => acc.plus(line.credit), ZERO);

    if (!sumDebits.equals(sumCredits)) {
      throw new Error(
        `UNBALANCED_ENTRY: Financial posting aborted. Total Debits [${sumDebits.toString()}] must strictly equal Total Credits [${sumCredits.toString()}]`
      );
    }

    // 5. Create general ledger Journal Entry
    const journalEntry = await tx.journalEntry.create({
      data: {
        date: invoice.date,
        sourceId: invoice.id,
        sourceType: "INVOICE",
        referenceId: invoice.invoiceNumber,
        status: "POSTED",
        description: `قيد ترحيل آلي لفاتورة ${invoice.type === "SALE" ? "مبيعات" : "مشتريات"} رقم #${invoice.invoiceNumber}`,
        debitTotal: sumDebits,
        creditTotal: sumCredits,
        tenantId: invoice.tenantId ?? tenantId,
        branchId: invoice.branchId ?? null,
        lines: {
          create: ledgerLines.map(line => ({
            accountId: line.accountId,
            debit: line.debit,
            credit: line.credit,
            description: line.description
          }))
        }
      }
    });

    // 6. Persist core account balance mutations & Optimistic Locking version checks
    for (const line of ledgerLines) {
      const adjustment = line.debit.minus(line.credit);
      const currentAccount = await tx.account.findUnique({ where: { id: line.accountId } });
      if (!currentAccount) throw new Error(`ACCOUNT_NOT_FOUND: Ledger target ID ${line.accountId} lacks setup.`);

      try {
        const updatedAccount = await tx.account.update({
          where: { 
            id: line.accountId,
            version: currentAccount.version, // Optimistic lock validation!
            tenantId: invoice.tenantId ?? tenantId,
          },
          data: {
            balance: { increment: adjustment },
            version: { increment: 1 }
          }
        });

        // Trigger safety check if update failed or missed due to race condition
        if (!updatedAccount) {
          throw new Error(`CONCURRENT_MUTATION_ERROR: Concurrent change detected on Account ${currentAccount.name}. Please retry operation.`);
        }
      } catch (err: any) {
        if (err.code === 'P2025') {
          throw new Error(
            `ACCOUNT_TENANT_MISMATCH: Account ${line.accountId} does not ` +
            `belong to tenant ${invoice.tenantId ?? tenantId}.`
          );
        }
        throw err;
      }
    }

    // 7. Lock the invoice status as "CONFIRMED" and "POSTED".
    // ⚠️ P0 FIX (defense in depth): Guarded update.
    // The where clause ensures we only flip to POSTED from a 
    // non-POSTED state. If a parallel transaction already flipped it, 
    // Prisma throws P2025 and the whole transaction rolls back.
    let updatedInvoice;
    try {
      const updateWhere: any = {
        id: invoice.id,
        documentStatus: { not: DocumentStatus.POSTED },
        status: { not: InvoiceStatus.CONFIRMED },
        tenantId: tenantId
      };

      updatedInvoice = await tx.invoice.update({
        where: updateWhere,
        data: {
          status: InvoiceStatus.CONFIRMED,
          documentStatus: DocumentStatus.POSTED,
        },
      });
    } catch (err: any) {
      if (err.code === 'P2025') {
        throw new Error(
          `ALREADY_POSTED_CONCURRENT: Invoice ${invoice.invoiceNumber} ` +
          `was posted by another concurrent transaction.`
        );
      }
      throw err;
    }

    // 8. Capture immutable Audit Trail
    await tx.auditLog.create({
      data: {
        userId,
        action: "POST_JOURNAL",
        entity: "Invoice",
        entityId: invoice.id,
        before: invoiceSnapshotBefore,
        after: JSON.stringify(updatedInvoice),
        ipAddress
      }
    });

    return {
      success: true,
      journalId: journalEntry.id,
      invoiceNumber: invoice.invoiceNumber,
      cogs: totalComputatedCogs.toNumber()
    };
  }

}
