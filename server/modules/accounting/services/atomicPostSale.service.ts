// server/modules/accounting/services/atomicPostSale.service.ts
import { runInTransaction } from "../../../core/database/transactionGuard.js";
import { FinancialTransactionService } from "./financialTransaction.service.js";
import { SalesPricingService } from "./salesPricing.service.js";
import { InvoiceStatus, DocumentStatus } from "@prisma/client";
import { InvoiceSchema } from "../../../../src/shared/validation/invoice.schema.js";
import type { SyncEffect } from "../../sync/sync.types.js";

export class AtomicPostSaleService {
  /**
   * Executes a complete, atomic POST_SALE operation. The authoritative catalog
   * price, tenant discount policy, tax calculation, invoice, FIFO depletion,
   * journal posting, and sync effects all execute in the same transaction.
   */
  static async executePostSaleCommand(params: {
    payload: any;
    tenantId: string;
    userId: string;
    username?: string;
    userRole?: string;
    branchId?: string | null;
    ipAddress: string;
    tx?: any;
    postImmediately?: boolean;
  }) {
    const {
      payload,
      tenantId,
      userId,
      username,
      userRole,
      branchId,
      ipAddress,
      tx: providedTx,
      postImmediately = true
    } = params;

    if (!tenantId?.trim()) {
      throw new Error("TENANT_REQUIRED");
    }

    // WorkflowExecution enqueues the committed domain result as { refId, sale }.
    // Support that established outbox shape and direct POST_SALE payloads.
    const source = payload?.sale && typeof payload.sale === "object"
      ? payload.sale
      : payload;

    const rawPartnerId = source?.partnerId ?? source?.partner_id ?? null;
    const partnerId = [null, undefined, "", "عميل نقدي", "CUST-GEN", "CUST-GENERAL"].includes(rawPartnerId)
      ? null
      : rawPartnerId;

    const paymentStatusRaw = String(source?.paymentStatus ?? source?.payment_status ?? "UNPAID").toUpperCase();
    const paymentStatus = paymentStatusRaw === "CASH" || paymentStatusRaw === "PAID"
      ? "PAID"
      : paymentStatusRaw === "PARTIALLY_PAID" || paymentStatusRaw === "PARTIALLY PAID"
        ? "PARTIALLY_PAID"
        : "UNPAID";

    const rawItems = Array.isArray(source?.items) ? source.items : [];
    const sanitizedPayload = {
      invoiceNumber: source?.invoiceNumber ?? source?.invoice_number ?? source?.invoiceId ?? source?.SaleID ?? payload?.refId,
      type: source?.type ?? "SALE",
      partnerId,
      partnerType: partnerId ? (source?.partnerType ?? "CUSTOMER") : null,
      date: source?.date ?? source?.Date,
      paymentStatus,
      discountPercent: source?.discountPercent ?? source?.discount_percent ?? payload?.discountPercent ?? 0,
      items: rawItems.map((item: any) => {
        const rawExpiry = item?.expiryDate ?? item?.ExpiryDate;
        const parsedExpiry = rawExpiry ? new Date(rawExpiry) : null;
        return {
          productId: item?.productId ?? item?.product_id,
          qty: item?.qty ?? item?.quantity,
          expiryDate: parsedExpiry && Number.isFinite(parsedExpiry.getTime()) ? parsedExpiry : null,
          note: item?.note ?? item?.notes ?? item?.name ?? null
        };
      })
    };

    const validated = InvoiceSchema.parse(sanitizedPayload);
    if (validated.type !== "SALE") {
      throw new Error("Invalid command: POST_SALE only supports SALE type.");
    }

    const executeLogic = async (tx: any) => {
      const existing = await tx.invoice.findFirst({
        where: {
          invoiceNumber: validated.invoiceNumber,
          tenantId
        }
      });

      if (existing) {
        throw new Error(`INVOICE_EXISTS: رقم الفاتورة [${validated.invoiceNumber}] مسجل مسبقاً.`);
      }

      const pricing = await SalesPricingService.calculate(tx, {
        tenantId,
        items: validated.items,
        discountPercent: validated.discountPercent,
        user: {
          userId,
          username: username || userId,
          role: userRole,
          tenantId,
          branchId: branchId || undefined
        }
      });

      const invoice: any = await tx.invoice.create({
        data: {
          invoiceNumber: validated.invoiceNumber,
          type: "SALE",
          partnerId: validated.partnerId,
          partnerType: validated.partnerType,
          branchId: branchId || undefined,
          subtotalAmount: pricing.subtotalAmount,
          discountPercent: pricing.discountPercent,
          discountAmount: pricing.discountAmount,
          taxRatePercent: pricing.taxRatePercent,
          taxAmount: pricing.taxAmount,
          taxMode: pricing.taxMode,
          totalAmount: pricing.totalAmount,
          status: InvoiceStatus.DRAFT,
          paymentStatus: validated.paymentStatus,
          date: validated.date,
          documentStatus: DocumentStatus.ACTIVE,
          tenantId,
          items: {
            create: pricing.itemData
          }
        },
        include: {
          items: {
            include: {
              product: true
            }
          }
        }
      });

      const postResult = postImmediately
        ? await FinancialTransactionService.executeInvoiceLedgerPosting(
            tx,
            invoice,
            userId,
            ipAddress,
            tenantId
          )
        : { journalId: null, cogs: 0 };

      const finalInvoice = await tx.invoice.findFirst({
        where: { id: invoice.id, tenantId },
        include: { items: true }
      });

      const journalEntry = postResult.journalId
        ? await tx.journalEntry.findFirst({
            where: { id: postResult.journalId, tenantId },
            include: { lines: true }
          })
        : null;

      const movements = postImmediately
        ? await tx.inventoryMovement.findMany({
            where: { referenceId: invoice.id, referenceType: "INVOICE", tenantId }
          })
        : [];

      const effects: SyncEffect[] = [];

      if (finalInvoice) {
        effects.push({
          entity: "INVOICE",
          entityId: finalInvoice.id,
          operation: postImmediately ? "POST" : "CREATE",
          payload: finalInvoice
        });
      }

      if (journalEntry) {
        effects.push({
          entity: "JOURNAL_ENTRY",
          entityId: journalEntry.id,
          operation: "CREATE",
          payload: journalEntry
        });
      }

      for (const movement of movements) {
        effects.push({
          entity: "INVENTORY_MOVEMENT",
          entityId: movement.id,
          operation: "CREATE",
          payload: movement
        });
      }

      return {
        success: true,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        journalId: postResult.journalId,
        cogs: postResult.cogs,
        effects
      };
    };

    return providedTx
      ? executeLogic(providedTx)
      : runInTransaction("AtomicPostSaleCommand", executeLogic);
  }
}
