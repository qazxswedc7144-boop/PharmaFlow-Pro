// server/routes/invoice.routes.ts
import { Router, Response } from "express";
import { z } from "zod";
import { tenantPrisma as prisma } from "../database/tenantPrisma.js";
import { OfflineDatabaseError } from "../database/prisma.js";
import { FinancialTransactionService } from "../modules/accounting/services/financialTransaction.service.js";
import { authenticateToken, requireRoles, AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { LockingService } from "../modules/locking/locking.service.js";
import { ReplicationPublisher } from "../modules/replication/replication.publisher.js";
import { InvoiceStatus, DocumentStatus, Role, Prisma } from "@prisma/client";
import { InvoiceSchema } from "../../src/shared/validation/invoice.schema.js";
import { validateRequestBody } from "../middleware/validate.js";
import { UUIDSchema } from "../../src/shared/validation/common.schema.js";
import { SaasService } from "../modules/saas/saas.service.js";
import { SalesPricingService } from "../modules/accounting/services/salesPricing.service.js";

export const invoiceRouter = Router();

/**
 * GET /api/invoices/sales-policy
 * Returns only the authenticated tenant's policy for online use and offline caching.
 */
invoiceRouter.get("/sales-policy", authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId?.trim();
    if (!tenantId) {
      return res.status(403).json({ error: "TENANT_REQUIRED" });
    }

    const policy = await prisma.tenantSalesPolicy.findUnique({
      where: { tenantId },
      select: {
        tenantId: true,
        maxDiscountPercent: true,
        taxRatePercent: true,
        taxMode: true,
        updatedAt: true
      }
    });

    return res.json({
      success: true,
      policy: {
        tenantId,
        maxDiscountPercent: policy?.maxDiscountPercent.toString() ?? "0",
        taxRatePercent: policy?.taxRatePercent.toString() ?? "0",
        taxMode: policy?.taxMode ?? "NONE",
        updatedAt: policy?.updatedAt.toISOString() ?? new Date(0).toISOString()
      }
    });
  } catch {
    return res.status(503).json({ error: "SALES_POLICY_UNAVAILABLE" });
  }
});

/**
 * POST /api/invoices/create
 * Registers a new invoice. Saved as a DRAFT.
 */
invoiceRouter.post("/create", authenticateToken, requireRoles([Role.PLATFORM_OWNER, Role.TENANT_ADMIN, Role.ADMIN, Role.ACCOUNTANT, Role.PHARMACIST, Role.INVENTORY_MANAGER]), validateRequestBody(InvoiceSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = req.body; // sanitized and verified by validateRequestBody
    const tenantId = req.user?.tenantId?.trim();

    // Tenant identity is security context, never optional client input.
    if (!tenantId) {
      return res.status(403).json({
        error: "TENANT_REQUIRED",
        message: "لا يمكن إنشاء فاتورة دون سياق مؤسسة موثوق."
      });
    }

    if (data.type === "SALE") {
      const checkLimit = await SaasService.checkSubscriptionLimit(tenantId);
      if (!checkLimit.allowed) {
        return res.status(403).json({
          error: "SUBSCRIPTION_LIMIT_REACHED",
          message: checkLimit.reason
        });
      }
    }

    // Product lookup, authoritative pricing, invoice creation, and audit write
    // must commit or roll back together. Client price/total values are never
    // used for SALE invoices.
    const invoice = await prisma.$transaction(async (tx: any) => {
      const existing = await tx.invoice.findFirst({
        where: { tenantId, invoiceNumber: data.invoiceNumber },
        select: { id: true }
      });

      if (existing) {
        const error: any = new Error("INVOICE_EXISTS");
        error.code = "INVOICE_EXISTS";
        throw error;
      }

      const productIds: string[] = [...new Set<string>(
        data.items.map((item: any) => item.productId as string)
      )];

      const products = await tx.product.findMany({
        where: {
          tenantId,
          id: { in: productIds },
          isActive: true,
          deletedAt: null
        },
        select: { id: true, price: true }
      });

      const productsById = new Map<string, any>(
        products.map((product: any) => [product.id, product])
      );

      if (productsById.size !== productIds.length) {
        const error: any = new Error("PRODUCT_NOT_FOUND_OR_INACTIVE");
        error.code = "PRODUCT_NOT_FOUND_OR_INACTIVE";
        throw error;
      }

      let calculatedTotal = new Prisma.Decimal(0);
      let salesPricing: ReturnType<typeof SalesPricingService.calculate> | null = null;
      const itemData = data.items.map((item: any) => {
        const product = productsById.get(item.productId);
        if (!product) {
          const error: any = new Error("PRODUCT_NOT_FOUND_OR_INACTIVE");
          error.code = "PRODUCT_NOT_FOUND_OR_INACTIVE";
          throw error;
        }

        // Sales use the tenant-owned catalog price. Purchase invoices retain
        // their supplier purchase price, since Product.price is a retail price.
        const price = data.type === "SALE"
          ? new Prisma.Decimal(product.price.toString())
          : new Prisma.Decimal(item.price);

        if (!price.isFinite() || price.isNegative()) {
          const error: any = new Error("INVALID_SERVER_PRODUCT_PRICE");
          error.code = "INVALID_SERVER_PRODUCT_PRICE";
          throw error;
        }

        const lineTotal = price.mul(item.qty);
        calculatedTotal = calculatedTotal.plus(lineTotal);

        return {
          // The parent Invoice relation supplies tenantId to InvoiceItem.
          // Connect Product through its composite key so Prisma enforces the
          // same tenant boundary for the item/product relation.
          product: {
            connect: {
              id_tenantId: { id: item.productId, tenantId }
            }
          },
          qty: item.qty,
          price,
          cost: new Prisma.Decimal(0),
          total: lineTotal,
          expiryDate: item.expiryDate,
          note: item.note
        };
      });

      if (data.type === "SALE") {
        const policy = await tx.tenantSalesPolicy.findUnique({ where: { tenantId } });
        salesPricing = SalesPricingService.calculate(
          itemData.map((item: any) => ({ price: item.price, qty: item.qty })),
          {
            maxDiscountPercent: policy?.maxDiscountPercent ?? 0,
            taxRatePercent: policy?.taxRatePercent ?? 0,
            taxMode: policy?.taxMode ?? "NONE"
          },
          data.discountPercent ?? 0
        );
        calculatedTotal = salesPricing.totalAmount;
      } else if (data.discountPercent !== undefined && new Prisma.Decimal(data.discountPercent).greaterThan(0)) {
        const error: any = new Error("DISCOUNT_ONLY_ALLOWED_ON_SALE");
        error.code = "DISCOUNT_ONLY_ALLOWED_ON_SALE";
        throw error;
      }

      const createdInvoice = await tx.invoice.create({
        data: {
          invoiceNumber: data.invoiceNumber,
          type: data.type,
          partnerId: data.partnerId,
          partnerType: data.partnerType,
          totalAmount: calculatedTotal,
          ...(salesPricing ? {
            subtotalAmount: salesPricing.subtotalAmount,
            discountPercent: salesPricing.discountPercent,
            discountAmount: salesPricing.discountAmount,
            taxRatePercent: salesPricing.taxRatePercent,
            taxAmount: salesPricing.taxAmount,
            taxMode: salesPricing.taxMode
          } : {}),
          status: InvoiceStatus.DRAFT,
          paymentStatus: data.paymentStatus,
          documentStatus: DocumentStatus.ACTIVE,
          tenantId,
          items: { create: itemData }
        },
        include: { items: true }
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          userId: req.user?.userId || null,
          action: "CREATE",
          entity: "Invoice",
          entityId: createdInvoice.id,
          before: null,
          after: JSON.stringify(createdInvoice),
          ipAddress: req.ip
        }
      });

      return createdInvoice;
    });

    // Usage is incremented only after the invoice transaction commits.
    await SaasService.incrementUsage(tenantId);

    return res.status(201).json({
      success: true,
      invoice
    });
  } catch (err: any) {
    if (err.code === "INVOICE_EXISTS") {
      return res.status(409).json({ error: "INVOICE_EXISTS", message: "رقم الفاتورة مستخدم مسبقاً داخل المؤسسة." });
    }
    if (err.code === "PRODUCT_NOT_FOUND_OR_INACTIVE") {
      return res.status(404).json({ error: "PRODUCT_NOT_FOUND_OR_INACTIVE", message: "أحد المنتجات غير موجود أو غير نشط داخل المؤسسة." });
    }
    if (err.code === "P2002") {
      return res.status(409).json({ error: "INVOICE_EXISTS", message: "رقم الفاتورة مستخدم مسبقاً داخل المؤسسة." });
    }
    if (err.code === "INVALID_SERVER_PRODUCT_PRICE") {
      return res.status(422).json({ error: "INVALID_SERVER_PRODUCT_PRICE", message: "سعر المنتج المحفوظ غير صالح." });
    }
    if (err.code === "DISCOUNT_ONLY_ALLOWED_ON_SALE") {
      return res.status(422).json({ error: "DISCOUNT_ONLY_ALLOWED_ON_SALE", message: "الخصم متاح لفواتير المبيعات فقط." });
    }
    if (err.message === "DISCOUNT_LIMIT_EXCEEDED") {
      return res.status(422).json({ error: "DISCOUNT_LIMIT_EXCEEDED", message: "نسبة الخصم تتجاوز الحد المسموح للمؤسسة." });
    }
    if (err.message === "INVALID_SALES_POLICY") {
      return res.status(422).json({ error: "INVALID_SALES_POLICY", message: "إعدادات التسعير والضريبة للمؤسسة غير صالحة." });
    }
    if (err instanceof OfflineDatabaseError) {
      return res.status(503).json({ error: "DATABASE_UNAVAILABLE", message: "قاعدة البيانات غير متاحة حالياً." });
    }
    return res.status(500).json({ error: "INTERNAL_ERROR", message: "تعذر إنشاء الفاتورة حالياً." });
  }
});

/**
 * POST /api/invoices/post
 * Enterprise endpoint to post and freeze an active draft invoice into General Ledger.
 */
invoiceRouter.post("/post", authenticateToken, requireRoles([Role.PLATFORM_OWNER, Role.TENANT_ADMIN, Role.ADMIN, Role.ACCOUNTANT, Role.PHARMACIST, Role.INVENTORY_MANAGER]), async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Validate request UUID with strict validator
    const bodyValidation = z.object({ invoiceId: UUIDSchema }).strict().safeParse(req.body);
    if (!bodyValidation.success) {
      return res.status(400).json({
        error: "VALIDATION_FAILED",
        message: "معرّف الفاتورة غير صالح أو مفقود."
      });
    }

    const { invoiceId } = bodyValidation.data;

    const key = `sales:${invoiceId}`;
    const branchId = "BRH-MAIN-001";
    const userId = req.user?.userId || "SYSTEM";

    const lock = await LockingService.acquireLock({
      key,
      branchId,
      lockType: "SALES",
      ownerId: userId,
      ttl: 20000
    });

    if (!lock) {
      return res.status(423).json({
        error: "LOCK_CONFLICT",
        message: "The requested invoice is currently being posted. Please wait."
      });
    }

    try {
      const result = await FinancialTransactionService.postInvoiceToLedger(
        invoiceId,
        req.user?.userId || null,
        req.ip || "127.0.0.1",
        req.user?.tenantId || null
      );

      // Distribute replication events in real-time
      try {
        const invoice = await prisma.invoice.findUnique({
          where: { id: invoiceId },
          include: { items: true }
        });

        if (invoice) {
          const type = (invoice.type === "SALE" || invoice.type === "RETURN_SALE") ? "InvoicePosted" : "PurchasePosted";
          await ReplicationPublisher.publish({
            type,
            branchId: invoice.branchId || "BRH-MAIN-001",
            userId: req.user?.userId || "SYSTEM",
            tenantId: invoice.tenantId || req.user?.tenantId,
            payload: {
              invoiceId: invoice.id,
              invoiceNumber: invoice.invoiceNumber,
              totalAmount: Number(invoice.totalAmount),
              type: invoice.type,
              itemsCount: invoice.items.length,
            }
          });
        }
      } catch (repErr: any) {
        console.warn("[REPLICATION] Failed to publish post-invoice event:", repErr.message);
      }

      return res.json({
        success: true,
        message: "Invoice successfully validated, costed via FIFO/FEFO, and posted to General Ledger accounts.",
        data: result
      });
    } finally {
      await LockingService.releaseLock(key, lock.id, branchId, userId);
    }
  } catch (err: any) {
    if (err instanceof OfflineDatabaseError) return res.status(503).json({ success: false, offline: true, message: "Database unavailable." });
    return res.status(400).json({
      error: "POST_FAILED",
      message: err.message || err
    });
  }
});

/**
 * GET /api/invoices
 * Retrieves a list of invoices with pagination and strict tenant isolation.
 */
invoiceRouter.get("/", authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const tenantId = req.user?.tenantId;

    const whereClause: any = tenantId ? { tenantId } : {};

    const invoices = await prisma.invoice.findMany({
      where: whereClause,
      take: limit,
      skip: offset,
      orderBy: { date: "desc" },
      include: {
        items: true
      }
    });

    const total = await prisma.invoice.count({ where: whereClause });

    return res.json({
      success: true,
      total,
      limit,
      offset,
      invoices
    });
  } catch (err: any) {
    if (err instanceof OfflineDatabaseError) return res.status(503).json({ success: false, offline: true, message: "Database unavailable." });
    return res.status(500).json({ error: "INTERNAL_ERROR", message: err.message });
  }
});

/**
 * GET /api/invoices/:id
 * Retrieve a single invoice structure with tenant validation.
 */
invoiceRouter.get("/:id", authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        items: {
          include: {
            product: true
          }
        }
      }
    });

    if (!invoice || (tenantId && invoice.tenantId && invoice.tenantId !== tenantId)) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Invoice not found." });
    }

    return res.json({
      success: true,
      invoice
    });
  } catch (err: any) {
    if (err instanceof OfflineDatabaseError) return res.status(503).json({ success: false, offline: true, message: "Database unavailable." });
    return res.status(500).json({ error: "INTERNAL_ERROR", message: err.message });
  }
});
