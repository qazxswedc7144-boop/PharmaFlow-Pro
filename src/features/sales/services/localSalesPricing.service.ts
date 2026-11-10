import Decimal from 'decimal.js-light';

export type SalesTaxMode = 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE';

export interface LocalSalesPolicy {
  tenantId: string;
  maxDiscountPercent: string | number;
  taxRatePercent: string | number;
  taxMode: SalesTaxMode;
  updatedAt: string;
}

export interface LocalSalesPricingResult {
  subtotalAmount: string;
  discountPercent: string;
  discountAmount: string;
  taxableAmount: string;
  taxRatePercent: string;
  taxAmount: string;
  taxMode: SalesTaxMode;
  revenueAmount: string;
  totalAmount: string;
}

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);
const MONEY_SCALE = 4;

const money = (value: Decimal): Decimal =>
  value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);

export class LocalSalesPricingService {
  static calculate(
    items: Array<{ price: string | number; catalogPrice?: string | number; qty: number }>,
    policy: LocalSalesPolicy,
    requestedDiscountPercent: string | number = 0
  ): LocalSalesPricingResult {
    if (!items.length) throw new Error('SALE_ITEMS_REQUIRED');

    const maxDiscount = new Decimal(policy.maxDiscountPercent);
    const requestedDiscount = new Decimal(requestedDiscountPercent);
    const configuredTaxRate = new Decimal(policy.taxRatePercent);

    if (
      !Number.isFinite(Number(maxDiscount.toString())) || maxDiscount.isNegative() || maxDiscount.greaterThan(HUNDRED) ||
      !Number.isFinite(Number(configuredTaxRate.toString())) || configuredTaxRate.isNegative() || configuredTaxRate.greaterThan(HUNDRED)
    ) {
      throw new Error('INVALID_SALES_POLICY');
    }
    if (
      !Number.isFinite(Number(requestedDiscount.toString())) || requestedDiscount.isNegative() ||
      requestedDiscount.greaterThan(maxDiscount)
    ) {
      throw new Error('DISCOUNT_LIMIT_EXCEEDED');
    }
    if (!['NONE', 'EXCLUSIVE', 'INCLUSIVE'].includes(policy.taxMode)) {
      throw new Error('INVALID_SALES_POLICY');
    }

    const totals = items.reduce((result, item) => {
      if (!Number.isSafeInteger(item.qty) || item.qty <= 0) {
        throw new Error('INVALID_SALE_QUANTITY');
      }
      const price = new Decimal(item.price);
      const catalogPrice = new Decimal(item.catalogPrice ?? item.price);
      if (
        !Number.isFinite(Number(price.toString())) || price.isNegative() ||
        !Number.isFinite(Number(catalogPrice.toString())) || catalogPrice.isNegative()
      ) {
        throw new Error('INVALID_SERVER_PRODUCT_PRICE');
      }
      if (catalogPrice.greaterThan(0) && price.lessThan(catalogPrice)) {
        const lineDiscountPercent = catalogPrice.minus(price).mul(HUNDRED).div(catalogPrice);
        if (lineDiscountPercent.greaterThan(maxDiscount)) {
          throw new Error('DISCOUNT_LIMIT_EXCEEDED');
        }
      }
      return {
        subtotal: result.subtotal.plus(price.mul(item.qty)),
        catalogSubtotal: result.catalogSubtotal.plus(catalogPrice.mul(item.qty))
      };
    }, { subtotal: ZERO, catalogSubtotal: ZERO });

    const subtotal = money(totals.subtotal);
    const effectiveNetAmount = totals.subtotal.minus(totals.subtotal.mul(requestedDiscount).div(HUNDRED));
    const effectiveDiscountAmount = totals.catalogSubtotal.minus(effectiveNetAmount);
    const maxAllowedDiscountAmount = totals.catalogSubtotal.mul(maxDiscount).div(HUNDRED);
    if (effectiveDiscountAmount.greaterThan(maxAllowedDiscountAmount)) {
      throw new Error('DISCOUNT_LIMIT_EXCEEDED');
    }

    const discountAmount = money(subtotal.mul(requestedDiscount).div(HUNDRED));
    const taxableAmount = money(subtotal.minus(discountAmount));
    const taxRate = policy.taxMode === 'NONE' ? ZERO : configuredTaxRate;

    let taxAmount = ZERO;
    let revenueAmount = taxableAmount;
    let totalAmount = taxableAmount;

    if (policy.taxMode === 'EXCLUSIVE') {
      taxAmount = money(taxableAmount.mul(taxRate).div(HUNDRED));
      totalAmount = money(taxableAmount.plus(taxAmount));
    } else if (policy.taxMode === 'INCLUSIVE') {
      taxAmount = taxRate.isZero()
        ? ZERO
        : money(taxableAmount.mul(taxRate).div(HUNDRED.plus(taxRate)));
      revenueAmount = money(taxableAmount.minus(taxAmount));
    }

    return {
      subtotalAmount: subtotal.toString(),
      discountPercent: requestedDiscount.toString(),
      discountAmount: discountAmount.toString(),
      taxableAmount: taxableAmount.toString(),
      taxRatePercent: taxRate.toString(),
      taxAmount: taxAmount.toString(),
      taxMode: policy.taxMode,
      revenueAmount: revenueAmount.toString(),
      totalAmount: totalAmount.toString()
    };
  }
}
