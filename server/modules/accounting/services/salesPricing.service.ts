import { Prisma } from "@prisma/client";
import { AuthorizationService } from "../../../services/rbac/authorization.service.js";
import type { UserIdentityContext } from "../../../services/rbac/types.js";

export interface SalePricingResult {
  itemData: Array<{
    tenantId: string;
    productId: string;
    qty: number;
    price: Prisma.Decimal;
    cost: Prisma.Decimal;
    total: Prisma.Decimal;
    expiryDate?: Date | null;
    note?: string | null;
  }>;
  subtotalAmount: Prisma.Decimal;
  discountPercent: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  taxRatePercent: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  taxMode: "NONE" | "EXCLUSIVE" | "INCLUSIVE";
  totalAmount: Prisma.Decimal;
}

function pricingError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

/**
 * The single server-authoritative pricing calculator for every SALE creation
 * path (HTTP invoice creation and sync POST_SALE). It must run inside the
 * caller's Prisma transaction.
 */
export class SalesPricingService {
  static async calculate(
    tx: any,
    params: {
      tenantId: string;
      items: Array<{ productId: string; qty: number; expiryDate?: Date | null; note?: string | null }>;
      discountPercent?: number | string | null;
      user: UserIdentityContext;
    }
  ): Promise<SalePricingResult> {
    const { tenantId, items, user } = params;
    if (!tenantId || !Array.isArray(items) || items.length === 0) {
      throw pricingError("INVALID_SALE_PRICING_INPUT");
    }

    let discountPercent: Prisma.Decimal;
    try {
      discountPercent = new Prisma.Decimal(String(params.discountPercent ?? 0));
    } catch {
      throw pricingError("INVALID_DISCOUNT_PERCENT");
    }

    if (!discountPercent.isFinite() || discountPercent.isNegative() || discountPercent.gt(100)) {
      throw pricingError("INVALID_DISCOUNT_PERCENT");
    }

    if (discountPercent.gt(0)) {
      const allowed = await AuthorizationService.can(
        { ...user, tenantId },
        "sales.discount.apply",
        { tenantId, branchId: user.branchId || undefined }
      );
      if (!allowed) {
        throw pricingError("DISCOUNT_PERMISSION_REQUIRED");
      }
    }

    const productIds: string[] = [...new Set(items.map(item => item.productId))];
    const products = await tx.product.findMany({
      where: {
        tenantId,
        id: { in: productIds },
        isActive: true,
        deletedAt: null
      },
      select: { id: true, price: true }
    });
    const productsById = new Map<string, any>(products.map((product: any) => [product.id, product]));

    if (productsById.size !== productIds.length) {
      throw pricingError("PRODUCT_NOT_FOUND_OR_INACTIVE");
    }

    let subtotalAmount = new Prisma.Decimal(0);
    const itemData = items.map(item => {
      const product = productsById.get(item.productId);
      if (!product) throw pricingError("PRODUCT_NOT_FOUND_OR_INACTIVE");

      const qty = Number(item.qty);
      if (!Number.isFinite(qty) || qty <= 0) throw pricingError("INVALID_SALE_QUANTITY");

      const price = new Prisma.Decimal(product.price.toString());
      if (!price.isFinite() || price.isNegative()) {
        throw pricingError("INVALID_SERVER_PRODUCT_PRICE");
      }

      const lineTotal = price.mul(qty).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
      subtotalAmount = subtotalAmount.plus(lineTotal);

      return {
        tenantId,
        productId: item.productId,
        qty,
        price,
        cost: new Prisma.Decimal(0),
        total: lineTotal,
        expiryDate: item.expiryDate,
        note: item.note
      };
    });

    const policy = await tx.tenantSalesPolicy.findUnique({ where: { tenantId } });
    const maxDiscountPercent = new Prisma.Decimal(
      policy?.maxDiscountPercent?.toString?.() ?? "0"
    );
    if (!maxDiscountPercent.isFinite() || maxDiscountPercent.isNegative() || maxDiscountPercent.gt(100)) {
      throw pricingError("INVALID_SALES_POLICY");
    }
    if (discountPercent.gt(maxDiscountPercent)) {
      throw pricingError("DISCOUNT_LIMIT_EXCEEDED");
    }

    const discountAmount = subtotalAmount
      .mul(discountPercent)
      .div(100)
      .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
    const taxableBase = subtotalAmount.minus(discountAmount);

    const taxMode = (policy?.taxMode ?? "NONE") as "NONE" | "EXCLUSIVE" | "INCLUSIVE";
    const configuredTaxRate = new Prisma.Decimal(policy?.taxRatePercent?.toString?.() ?? "0");
    if (!configuredTaxRate.isFinite() || configuredTaxRate.isNegative() || configuredTaxRate.gt(100)) {
      throw pricingError("INVALID_SALES_POLICY");
    }
    if ((taxMode === "NONE" && !configuredTaxRate.isZero()) ||
        (taxMode !== "NONE" && configuredTaxRate.isZero())) {
      throw pricingError("INVALID_SALES_POLICY");
    }

    const taxRatePercent = taxMode === "NONE" ? new Prisma.Decimal(0) : configuredTaxRate;
    let taxAmount = new Prisma.Decimal(0);
    let totalAmount = taxableBase;

    if (taxMode === "EXCLUSIVE") {
      taxAmount = taxableBase
        .mul(taxRatePercent)
        .div(100)
        .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
      totalAmount = taxableBase.plus(taxAmount);
    } else if (taxMode === "INCLUSIVE") {
      taxAmount = taxableBase
        .mul(taxRatePercent)
        .div(new Prisma.Decimal(100).plus(taxRatePercent))
        .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
    }

    return {
      itemData,
      subtotalAmount,
      discountPercent,
      discountAmount,
      taxRatePercent,
      taxAmount,
      taxMode,
      totalAmount
    };
  }
}
