// server/modules/accounting/services/atomicPostSale.service.ts
import { prisma } from "../../../database/prisma.js";
import { runInTransaction } from "../../../core/database/transactionGuard.js";
import { FinancialTransactionService } from "./financialTransaction.service.js";
import { InvoiceStatus, DocumentStatus } from "@prisma/client";
import { InvoiceSchema } from "../../../../src/shared/validation/invoice.schema.js";
import { SyncEffect } from "../../sync/sync.types.js";

export class AtomicPostSaleService {
  /**
   * Executes a complete, atomic "POST_SALE" business operation.
   * 1. Validates and recalculates the payload.
   * 2. Persists the invoice and items.
   * 3. Executes inventory depletion via FIFO.
   * 4. Generates balanced journal entries.
   * 5. Updates account balances.
   * 6. Marks the operation as POSTED.
   * 7. Returns side-effects for sync propagation.
   */
  static async executePostSaleCommand(params: {
    payload: any;
    tenantId: string;
    userId: string;
    ipAddress: string;
    tx?: any;
  }) {
    const { payload, tenantId, userId, ipAddress, tx: providedTx } = params;

    // 0. Sanitize input (Handle 'عميل نقدي' case)
    const sanitizedPayload = { ...payload };
    if (sanitizedPayload.partnerId === "عميل نقدي") {
      sanitizedPayload.partnerId = null;
    }

    // 1. Validation using shared schema
    const validated = InvoiceSchema.parse(sanitizedPayload);
    
    if (validated.type !== "SALE") {
      throw new Error("Invalid command: POST_SALE only supports SALE type.");
    }

    // 2. Price Verification & Total Recalculation
    // Fetch authoritative product prices to detect client-side tampering
    const productIds = validated.items.map(i => i.productId);
    const client = providedTx || prisma;
    const products = await client.product.findMany({
      where: { id: { in: productIds }, tenantId },
      select: { id: true, price: true, basePrice: true }
    });
    const productMap = new Map(products.map((p: any) => [p.id, Number(p.basePrice || p.price || 0)]));

    let calculatedTotal = 0;
    const itemsData = validated.items.map(item => {
      const serverPriceRaw = productMap.get(item.productId);
      if (serverPriceRaw === undefined) {
        throw new Error(`PRODUCT_NOT_FOUND: Product ${item.productId} does not exist in tenant catalog.`);
      }
      
      const serverPrice = Number(serverPriceRaw);
      const clientPrice = Number(item.price);

      // Strict price verification
      if (Math.abs(serverPrice - clientPrice) > 0.01) {
        throw new Error(`PRICE_TAMPERING: Client price [${item.price}] for product [${item.productId}] does not match server price [${serverPrice}].`);
      }

      const lineTotal = Number(item.qty) * serverPrice;
      calculatedTotal += lineTotal;
      return {
        productId: item.productId,
        qty: item.qty,
        price: serverPrice,
        total: lineTotal,
        cost: 0, // Will be updated by FIFO logic
        note: item.note
      };
    });

    // Precision-safe comparison (2 decimal places)
    const diff = Math.abs(calculatedTotal - Number(validated.totalAmount));
    if (diff > 0.01) {
      throw new Error(`TOTAL_MISMATCH: Client total [${validated.totalAmount}] does not match server recalculated total [${calculatedTotal.toFixed(2)}]. Difference: ${diff.toFixed(4)}`);
    }

    // 3. Atomic Execution within Transaction
    const executeLogic = async (tx: any) => {
      // a. Check for duplicate invoice number within tenant to prevent collisions
      const existing = await tx.invoice.findFirst({
        where: { 
          invoiceNumber: validated.invoiceNumber,
          tenantId 
        }
      });
      
      if (existing) {
        throw new Error(`INVOICE_EXISTS: رقم الفاتورة [${validated.invoiceNumber}] مسجل مسبقاً.`);
      }

      // b. Create Invoice and items in DRAFT state first
      const invoice: any = await tx.invoice.create({
        data: {
          invoiceNumber: validated.invoiceNumber,
          type: "SALE",
          partnerId: validated.partnerId,
          partnerType: validated.partnerType,
          totalAmount: calculatedTotal,
          status: InvoiceStatus.DRAFT,
          paymentStatus: validated.paymentStatus,
          documentStatus: DocumentStatus.ACTIVE,
          tenantId,
          items: {
            create: itemsData
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

      // c. Delegate to core ledger posting logic
      const postResult = await FinancialTransactionService.executeInvoiceLedgerPosting(
        tx,
        invoice,
        userId,
        ipAddress,
        tenantId,
        userRole
      );

      // d. Collect side-effects for sync propagation
      const finalInvoice = await tx.invoice.findUnique({
        where: { id: invoice.id },
        include: { items: true }
      });

      const journalEntry = await tx.journalEntry.findUnique({
        where: { id: postResult.journalId },
        include: { lines: true }
      });

      const movements = await tx.inventoryMovement.findMany({
        where: { referenceId: invoice.id, referenceType: "INVOICE" }
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

      for (const mov of movements) {
        effects.push({
          entity: "INVENTORY_MOVEMENT",
          entityId: mov.id,
          operation: "CREATE",
          payload: mov
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

    if (providedTx) {
      return await executeLogic(providedTx);
    } else {
      return await runInTransaction("AtomicPostSaleCommand", executeLogic);
    }
  }
}
