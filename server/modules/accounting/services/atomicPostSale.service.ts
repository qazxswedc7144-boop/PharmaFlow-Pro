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
    const sourceDocumentStatus = String(
      source?.documentStatus ?? source?.InvoiceStatus ?? source?.invoiceStatus ?? "DRAFT"
    ).toUpperCase();
    const createStatus = sourceDocumentStatus === "PENDING"
      ? "PENDING"
      : sourceDocumentStatus === "CANCELLED" || sourceDocumentStatus === "VOID"
        ? "CANCELLED"
        : "DRAFT";

    const rawItems = Array.isArray(source?.items) ? source.items : [];
    const sanitizedPayload = {
      invoiceNumber: source?.invoiceNumber ?? source?.invoice_number ?? source?.invoiceId ?? source?.SaleID ?? payload?.refId,
      type: source?.type ?? "SALE",
      partnerId,
      partnerType: partnerId ? (source?.partnerType ?? "CUSTOMER") : null,
      date: source?.date ?? source?.Date,
      paymentStatus,
      status: createStatus,
      discountPercent: source?.discountPercent ?? source?.discount_percent ?? payload?.discountPercent ?? 0,
      items: rawItems.map((item: any) => {
        const rawExpiry = item?.expiryDate ?? item?.ExpiryDate;
        const parsedExpiry = rawExpiry ? new Date(rawExpiry) : null;
        return {
          productId: item?.productId ?? item?.product_id,
          qty: item?.qty ?? item?.quantity,
          expiryDate: parsedExpiry && Number.isFinite(parsedExpiry.getTime()) ? parsedExpiry : null,
          note: item?.note ?? item?.notes ?? null
        };
      })
    };

    const validated = InvoiceSchema.parse(sanitizedPayload);
    if (validated.type !== "SALE") {
      throw new Error("Invalid command: POST_SALE only supports SALE type.");
    }

    const clientRefCandidate = payload?.refId ?? payload?.id ?? source?.id;
    const clientRefId = typeof clientRefCandidate === "string" && clientRefCandidate.trim()
      ? clientRefCandidate.trim()
      : null;

    const executeLogic = async (tx: any) => {
      const identityClauses: any[] = [{ invoiceNumber: validated.invoiceNumber }];
      if (clientRefId) identityClauses.unshift({ clientRefId });

      const existing = await tx.invoice.findFirst({
        where: { tenantId, OR: identityClauses },
        include: { items: true }
      });

      if (existing && existing.type !== "SALE") {
        throw new Error("INVOICE_TYPE_CONFLICT: Existing invoice is not a SALE.");
      }
      if (existing && clientRefId && existing.clientRefId && existing.clientRefId !== clientRefId) {
        throw new Error("INVOICE_IDENTITY_CONFLICT: Invoice number belongs to another offline document.");
      }
      if (existing && (existing.documentStatus === DocumentStatus.POSTED ||
          existing.documentStatus === DocumentStatus.LOCKED ||
          existing.status === InvoiceStatus.CONFIRMED)) {
        return {
          success: true,
          idempotent: true,
          invoiceId: existing.id,
          invoiceNumber: existing.invoiceNumber,
          journalId: null,
          cogs: 0,
          effects: []
        };
      }
      if (existing && existing.documentStatus === DocumentStatus.ARCHIVED) {
        throw new Error("INVOICE_ARCHIVED: Archived invoices cannot be changed or posted.");
      }
      if (existing && existing.status === InvoiceStatus.CANCELLED) {
        if (postImmediately) {
          throw new Error("INVOICE_CANCELLED: Cancelled invoices cannot be posted.");
        }
        return {
          success: true,
          idempotent: true,
          invoiceId: existing.id,
          invoiceNumber: existing.invoiceNumber,
          journalId: null,
          cogs: 0,
          effects: []
        };
      }
      if (postImmediately && createStatus === "CANCELLED") {
        throw new Error("INVOICE_CANCELLED: Cancelled invoices cannot be posted.");
      }
      if (existing?.branchId && branchId && existing.branchId !== branchId) {
        throw new Error("INVOICE_BRANCH_MISMATCH: Draft belongs to a different branch.");
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

      // A repeated CREATE updates the same tenant-owned draft; POST promotes that
      // draft using freshly calculated catalog prices, discount policy, and tax.
      const invoiceData = {
        invoiceNumber: validated.invoiceNumber,
        clientRefId: clientRefId ?? existing?.clientRefId ?? undefined,
        type: "SALE" as const,
        partnerId: validated.partnerId ?? existing?.partnerId ?? null,
        partnerType: validated.partnerType ?? existing?.partnerType ?? null,
        branchId: branchId || existing?.branchId || undefined,
        subtotalAmount: pricing.subtotalAmount,
        discountPercent: pricing.discountPercent,
        discountAmount: pricing.discountAmount,
        taxRatePercent: pricing.taxRatePercent,
        taxAmount: pricing.taxAmount,
        taxMode: pricing.taxMode,
        totalAmount: pricing.totalAmount,
        status: postImmediately
          ? InvoiceStatus.DRAFT
          : (createStatus === "CANCELLED" ? InvoiceStatus.CANCELLED : createStatus === "PENDING" ? InvoiceStatus.PENDING : InvoiceStatus.DRAFT),
        paymentStatus: validated.paymentStatus,
        date: validated.date ?? existing?.date,
        documentStatus: DocumentStatus.ACTIVE,
        tenantId
      };

      const invoice: any = existing
        ? await tx.invoice.update({
            where: { id_tenantId: { id: existing.id, tenantId } },
            data: {
              ...invoiceData,
              items: {
                deleteMany: {},
                create: pricing.itemData
              }
            },
            include: { items: { include: { product: true } } }
          })
        : await tx.invoice.create({
            data: {
              ...invoiceData,
              items: { create: pricing.itemData }
            },
            include: { items: { include: { product: true } } }
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

      if (postImmediately && sourceDocumentStatus === "LOCKED") {
        await tx.invoice.update({
          where: { id_tenantId: { id: invoice.id, tenantId } },
          data: { documentStatus: DocumentStatus.LOCKED }
        });
      }

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
        idempotent: false,
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
