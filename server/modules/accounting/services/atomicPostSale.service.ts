// server/modules/accounting/services/atomicPostSale.service.ts
import { prisma } from "../../../database/prisma.js";
import { runInTransaction } from "../../../core/database/transactionGuard.js";
import { FinancialTransactionService } from "./financialTransaction.service.js";
import { InvoiceStatus, DocumentStatus, Prisma } from "@prisma/client";
import { SalesPricingService } from "./salesPricing.service.js";
import { AuthorizationService } from "../../../services/rbac/authorization.service.js";
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
    userRole?: string;
    ipAddress: string;
    tx?: any;
  }) {
    const { payload, tenantId, userId, userRole, ipAddress, tx: providedTx } = params;

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

    // 2. Resolve tenant catalog prices, authorize manual overrides, and recalculate on the server.
    const productIds = validated.items.map(i => i.productId);
    const client = providedTx || prisma;
    const products = await client.product.findMany({
      where: { id: { in: productIds }, tenantId },
      select: { id: true, price: true }
    });
    const productMap = new Map(products.map((product: any) => [product.id, product]));

    const pricingItems = validated.items.map(item => {
      const product = productMap.get(item.productId) as any;
      if (!product) {
        throw new Error(`PRODUCT_NOT_FOUND: Product ${item.productId} does not exist in tenant catalog.`);
      }
      const catalogPrice = new Prisma.Decimal(product.price);
      const price = new Prisma.Decimal(item.price ?? product.price);
      if (!catalogPrice.isFinite() || catalogPrice.isNegative() || !price.isFinite() || price.isNegative()) {
        const error: any = new Error("INVALID_SERVER_PRODUCT_PRICE");
        error.code = "INVALID_SERVER_PRODUCT_PRICE";
        throw error;
      }
      return { price, catalogPrice, qty: item.qty };
    });

    const manualPriceOverrideRequested = pricingItems.some(item => !item.price.equals(item.catalogPrice));
    if (manualPriceOverrideRequested) {
      const canOverridePrice = await AuthorizationService.can(
        { userId, role: userRole, tenantId },
        "sales.price.override",
        { tenantId }
      );
      if (!canOverridePrice) {
        const error: any = new Error("PRICE_OVERRIDE_FORBIDDEN");
        error.code = "PRICE_OVERRIDE_FORBIDDEN";
        throw error;
      }
    }

    const policy = await client.tenantSalesPolicy.findUnique({ where: { tenantId } });
    const salesPricing = SalesPricingService.calculate(
      pricingItems,
      {
        maxDiscountPercent: policy?.maxDiscountPercent ?? 0,
        taxRatePercent: policy?.taxRatePercent ?? 0,
        taxMode: policy?.taxMode ?? "NONE"
      },
      validated.discountPercent ?? 0
    );

    const calculatedTotal = salesPricing.totalAmount;
    const clientTotal = new Prisma.Decimal(validated.totalAmount);
    const totalDifference = calculatedTotal.minus(clientTotal).abs();
    if (totalDifference.greaterThan(new Prisma.Decimal("0.01"))) {
      const error: any = new Error("SALES_PRICE_POLICY_MISMATCH");
      error.code = "SALES_PRICE_POLICY_MISMATCH";
      throw error;
    }

    const itemsData = validated.items.map((item, index) => {
      const price = pricingItems[index]!.price;
      return {
        productId: item.productId,
        qty: item.qty,
        price,
        total: price.mul(item.qty),
        cost: new Prisma.Decimal(0), // Updated by the existing ledger/FIFO posting flow.
        note: item.note
      };
    });

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
          subtotalAmount: salesPricing.subtotalAmount,
          discountPercent: salesPricing.discountPercent,
          discountAmount: salesPricing.discountAmount,
          taxRatePercent: salesPricing.taxRatePercent,
          taxAmount: salesPricing.taxAmount,
          taxMode: salesPricing.taxMode,
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
