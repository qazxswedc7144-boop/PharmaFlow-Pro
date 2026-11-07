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
  }) {
    const {
      payload,
      tenantId,
      userId,
      username,
      userRole,
      branchId,
      ipAddress,
      tx: providedTx
    } = params;

    if (!tenantId?.trim()) {
      throw new Error("TENANT_REQUIRED");
    }

    const sanitizedPayload = { ...payload };
    if (sanitizedPayload.partnerId === "عميل نقدي") {
      sanitizedPayload.partnerId = null;
    }

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

      const postResult = await FinancialTransactionService.executeInvoiceLedgerPosting(
        tx,
        invoice,
        userId,
        ipAddress,
        tenantId
      );

      const finalInvoice = await tx.invoice.findFirst({
        where: { id: invoice.id, tenantId },
        include: { items: true }
      });

      const journalEntry = await tx.journalEntry.findFirst({
        where: { id: postResult.journalId, tenantId },
        include: { lines: true }
      });

      const movements = await tx.inventoryMovement.findMany({
        where: { referenceId: invoice.id, referenceType: "INVOICE", tenantId }
      });

      const effects: SyncEffect[] = [];

      if (finalInvoice) {
        effects.push({
          entity: "INVOICE",
          entityId: finalInvoice.id,
          operation: "POST",
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
