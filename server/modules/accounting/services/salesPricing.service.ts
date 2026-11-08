import { Prisma, SalesTaxMode } from "@prisma/client";

export interface SalesPricingItem {
  price: Prisma.Decimal | string | number;
  qty: number;
}

export interface SalesPricingPolicy {
  maxDiscountPercent: Prisma.Decimal | string | number;
  taxRatePercent: Prisma.Decimal | string | number;
  taxMode: SalesTaxMode;
}

export interface SalesPricingResult {
  subtotalAmount: Prisma.Decimal;
  discountPercent: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  taxableAmount: Prisma.Decimal;
  taxRatePercent: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  taxMode: SalesTaxMode;
  revenueAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
}

const ZERO = new Prisma.Decimal(0);
const HUNDRED = new Prisma.Decimal(100);
const MONEY_SCALE = 4;

export class SalesPricingService {
  private static money(value: Prisma.Decimal): Prisma.Decimal {
    return value.toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_UP);
  }

  static calculate(
    items: SalesPricingItem[],
    policy: SalesPricingPolicy,
    requestedDiscountPercent: Prisma.Decimal | string | number = ZERO
  ): SalesPricingResult {
    if (!items.length) throw new Error("SALE_ITEMS_REQUIRED");

    const maxDiscount = new Prisma.Decimal(policy.maxDiscountPercent);
    const discountPercent = new Prisma.Decimal(requestedDiscountPercent);
    const configuredTaxRate = new Prisma.Decimal(policy.taxRatePercent);

    if (!maxDiscount.isFinite() || maxDiscount.isNegative() || maxDiscount.greaterThan(HUNDRED)) {
      throw new Error("INVALID_SALES_POLICY");
    }
    if (!configuredTaxRate.isFinite() || configuredTaxRate.isNegative() || configuredTaxRate.greaterThan(HUNDRED)) {
      throw new Error("INVALID_SALES_POLICY");
    }
    if (!discountPercent.isFinite() || discountPercent.isNegative() || discountPercent.greaterThan(maxDiscount)) {
      throw new Error("DISCOUNT_LIMIT_EXCEEDED");
    }

    const subtotalRaw = items.reduce((sum, item) => {
      if (!Number.isSafeInteger(item.qty) || item.qty <= 0) throw new Error("INVALID_SALE_QUANTITY");
      const price = new Prisma.Decimal(item.price);
      if (!price.isFinite() || price.isNegative()) throw new Error("INVALID_SERVER_PRODUCT_PRICE");
      return sum.plus(price.mul(item.qty));
    }, ZERO);

    const subtotalAmount = this.money(subtotalRaw);
    const discountAmount = this.money(subtotalAmount.mul(discountPercent).div(HUNDRED));
    const taxableAmount = this.money(subtotalAmount.minus(discountAmount));
    const taxRatePercent = policy.taxMode === SalesTaxMode.NONE ? ZERO : configuredTaxRate;

    let taxAmount = ZERO;
    let revenueAmount = taxableAmount;
    let totalAmount = taxableAmount;

    if (policy.taxMode === SalesTaxMode.EXCLUSIVE) {
      taxAmount = this.money(taxableAmount.mul(taxRatePercent).div(HUNDRED));
      totalAmount = this.money(taxableAmount.plus(taxAmount));
    } else if (policy.taxMode === SalesTaxMode.INCLUSIVE) {
      const divisor = HUNDRED.plus(taxRatePercent);
      taxAmount = taxRatePercent.isZero()
        ? ZERO
        : this.money(taxableAmount.mul(taxRatePercent).div(divisor));
      revenueAmount = this.money(taxableAmount.minus(taxAmount));
      totalAmount = taxableAmount;
    } else if (policy.taxMode !== SalesTaxMode.NONE) {
      throw new Error("INVALID_SALES_POLICY");
    }

    return {
      subtotalAmount,
      discountPercent,
      discountAmount,
      taxableAmount,
      taxRatePercent,
      taxAmount,
      taxMode: policy.taxMode,
      revenueAmount,
      totalAmount,
    };
  }
}
