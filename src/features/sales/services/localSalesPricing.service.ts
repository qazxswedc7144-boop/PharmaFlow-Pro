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
    items: Array<{ price: string | number; qty: number }>,
    policy: LocalSalesPolicy,
    requestedDiscountPercent: string | number = 0
  ): LocalSalesPricingResult {
    if (!items.length) throw new Error('SALE_ITEMS_REQUIRED');

    const maxDiscount = new Decimal(policy.maxDiscountPercent);
    const requestedDiscount = new Decimal(requestedDiscountPercent);
    const configuredTaxRate = new Decimal(policy.taxRatePercent);

    if (
      !maxDiscount.isFinite() || maxDiscount.isNegative() || maxDiscount.greaterThan(HUNDRED) ||
      !configuredTaxRate.isFinite() || configuredTaxRate.isNegative() || configuredTaxRate.greaterThan(HUNDRED)
    ) {
      throw new Error('INVALID_SALES_POLICY');
    }
    if (
      !requestedDiscount.isFinite() || requestedDiscount.isNegative() ||
      requestedDiscount.greaterThan(maxDiscount)
    ) {
      throw new Error('DISCOUNT_LIMIT_EXCEEDED');
    }
    if (!['NONE', 'EXCLUSIVE', 'INCLUSIVE'].includes(policy.taxMode)) {
      throw new Error('INVALID_SALES_POLICY');
    }

    const subtotal = money(items.reduce((sum, item) => {
      if (!Number.isSafeInteger(item.qty) || item.qty <= 0) {
        throw new Error('INVALID_SALE_QUANTITY');
      }
      const price = new Decimal(item.price);
      if (!price.isFinite() || price.isNegative()) {
        throw new Error('INVALID_SERVER_PRODUCT_PRICE');
      }
      return sum.plus(price.mul(item.qty));
    }, ZERO));

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
