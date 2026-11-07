// server/modules/accounting/services/financialTransaction.service.ts
import { runInTransaction } from "../../../core/database/transactionGuard.js";
import { FifoService } from "../../inventory/services/fifo.service.js";
import { Prisma, InvoiceStatus, DocumentStatus, InvoiceType } from "@prisma/client";
import { prisma } from "../../../database/prisma.js";

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
    tenantId: string | null = null
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

        return await this.executeInvoiceLedgerPosting(tx, invoice, userId, ipAddress, tenantId);
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
    tenantId: string | null = null
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

    const totalInvoiceAmount = Number(invoice.totalAmount);
    const taxAmount = Number(invoice.taxAmount ?? 0);
    if (!Number.isFinite(totalInvoiceAmount) || totalInvoiceAmount < 0 ||
        !Number.isFinite(taxAmount) || taxAmount < 0 || taxAmount > totalInvoiceAmount + 0.0001) {
      throw new Error("INVALID_INVOICE_FINANCIAL_BREAKDOWN: Invoice totals or tax amount are invalid.");
    }
    // The customer receivable/cash equals the invoice total. Sales revenue excludes
    // tax for both inclusive and exclusive tax modes; the tax portion is a liability.
    const salesRevenueAmount = totalInvoiceAmount - taxAmount;
    const isCash = invoice.paymentStatus === "PAID" || invoice.paymentStatus === "CASH" as any;

    // 2. Lock core accounts involved in the transaction to prevent concurrent race conditions.
    const cashAcc = await this.getOrCreateAccount(tx, "101001", "الصندوق والبنك (النقدية)", "ASSET", tenantId);
    const arAcc = await this.getOrCreateAccount(tx, "101002", "ذمم مدنية عملاء (أوراق القبض)", "ASSET", tenantId);
    const invAcc = await this.getOrCreateAccount(tx, "101003", "مخزون الأدوية والمواد الطبية", "ASSET", tenantId);
    const revAcc = await this.getOrCreateAccount(tx, "401001", "إيرادات المبيعات الدوائية", "REVENUE", tenantId);
    const cogsAcc = await this.getOrCreateAccount(tx, "501001", "تكلفة المبيعات (COGS)", "EXPENSE", tenantId);
    const apAcc = await this.getOrCreateAccount(tx, "201001", "ذمم دائنة موردين (أوراق الدفع)", "LIABILITY", tenantId);
    const taxPayableAcc = taxAmount > 0
      ? await this.getOrCreateAccount(tx, "202001", "ضرائب مبيعات مستحقة", "LIABILITY", tenantId)
      : null;

    // Lock account rows using a SELECT ... FOR UPDATE query scoped to the tenant.
    const accountIdsToLock = [
      cashAcc.id, arAcc.id, invAcc.id, revAcc.id, cogsAcc.id, apAcc.id,
      ...(taxPayableAcc ? [taxPayableAcc.id] : [])
    ];
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM accounts WHERE id IN (${Prisma.join(accountIdsToLock)}) AND "tenantId" = ${tenantId} FOR UPDATE`
    );

    let totalComputatedCogs = 0;
    const ledgerLines: { accountId: string; debit: number; credit: number; description: string }[] = [];

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
        
        totalComputatedCogs += fifoResult.totalCost;

        // Update actual cost in line item
        await tx.invoiceItem.update({
          where: { id: item.id },
          data: { cost: fifoResult.totalCost / item.qty }
        });
      }

      // Ledger Entry: Debit Cash or Accounts Receivable, Credit Sales Revenue
      if (isCash) {
        ledgerLines.push({
          accountId: cashAcc.id,
          debit: totalInvoiceAmount,
          credit: 0,
          description: `نقدية مبيعات فاتورة #${invoice.invoiceNumber}`
        });
      } else {
        ledgerLines.push({
          accountId: arAcc.id,
          debit: totalInvoiceAmount,
          credit: 0,
          description: `آجل مبيعات فاتورة #${invoice.invoiceNumber}`
        });
      }

      ledgerLines.push({
        accountId: revAcc.id,
        debit: 0,
        credit: salesRevenueAmount,
        description: `صافي إيراد المبيعات بعد الخصم والضريبة - فاتورة #${invoice.invoiceNumber}`
      });

      if (taxAmount > 0 && taxPayableAcc) {
        ledgerLines.push({
          accountId: taxPayableAcc.id,
          debit: 0,
          credit: taxAmount,
          description: `ضريبة مبيعات مستحقة - فاتورة #${invoice.invoiceNumber}`
        });
      }

      // Ledger Entry for COGS: Debit COGS, Credit Inventory
      if (totalComputatedCogs > 0) {
        ledgerLines.push({
          accountId: cogsAcc.id,
          debit: totalComputatedCogs,
          credit: 0,
          description: `تكلفة مبيعات فاتورة #${invoice.invoiceNumber}`
        });
        ledgerLines.push({
          accountId: invAcc.id,
          debit: 0,
          credit: totalComputatedCogs,
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
          Number(item.price),
          item.expiryDate,
          invoice.id,
          "INVOICE",
          `توريد مشتريات - فاتورة #${invoice.invoiceNumber}`,
          tenantId
        );
      }

      // Ledger Entry: Debit Inventory, Credit Cash or Accounts Payable
      ledgerLines.push({
        accountId: invAcc.id,
        debit: totalInvoiceAmount,
        credit: 0,
        description: `زيادة مخزون مشتريات فاتورة #${invoice.invoiceNumber}`
      });

      if (isCash) {
        ledgerLines.push({
          accountId: cashAcc.id,
          debit: 0,
          credit: totalInvoiceAmount,
          description: `نقدية مشتريات فاتورة #${invoice.invoiceNumber}`
        });
      } else {
        ledgerLines.push({
          accountId: apAcc.id,
          debit: 0,
          credit: totalInvoiceAmount,
          description: `آجل مشتريات فاتورة #${invoice.invoiceNumber}`
        });
      }

    } else {
      throw new Error(`UNSUPPORTED_TYPE: Invoice type ${invoice.type} is not yet supported in automatic ledger mapping.`);
    }

    // 4. Double-Entry Enforcement Rule: totalDebit === totalCredit
    const sumDebits = ledgerLines.reduce((acc, l) => acc + l.debit, 0);
    const sumCredits = ledgerLines.reduce((acc, l) => acc + l.credit, 0);

    if (Math.abs(sumDebits - sumCredits) > 0.0001) {
      throw new Error(
        `UNBALANCED_ENTRY: Financial posting aborted. Total Debits [${sumDebits}] must strictly equal Total Credits [${sumCredits}]`
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
      const adjustment = line.debit - line.credit;
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
      cogs: totalComputatedCogs
    };
  }

}
