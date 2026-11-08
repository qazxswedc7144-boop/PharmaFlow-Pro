import { describe, expect, it } from "vitest";
import { SalesTaxMode } from "@prisma/client";
import { SalesPricingService } from "../modules/accounting/services/salesPricing.service.js";

describe("SalesPricingService", () => {
  const items = [{ price: "100.0000", qty: 1 }];

  it("extracts included tax from the discounted gross amount", () => {
    const result = SalesPricingService.calculate(
      items,
      { maxDiscountPercent: "10", taxRatePercent: "15", taxMode: SalesTaxMode.INCLUSIVE },
      "10",
    );

    expect(result.subtotalAmount.toString()).toBe("100");
    expect(result.discountAmount.toString()).toBe("10");
    expect(result.taxableAmount.toString()).toBe("90");
    expect(result.taxAmount.toString()).toBe("11.7391");
    expect(result.revenueAmount.toString()).toBe("78.2609");
    expect(result.totalAmount.toString()).toBe("90");
  });

  it("adds tax on top of the discounted net amount for exclusive tax", () => {
    const result = SalesPricingService.calculate(
      items,
      { maxDiscountPercent: "10", taxRatePercent: "15", taxMode: SalesTaxMode.EXCLUSIVE },
      "10",
    );

    expect(result.taxAmount.toString()).toBe("13.5");
    expect(result.revenueAmount.toString()).toBe("90");
    expect(result.totalAmount.toString()).toBe("103.5");
  });

  it("rejects discounts above the tenant policy maximum", () => {
    expect(() => SalesPricingService.calculate(
      items,
      { maxDiscountPercent: "5", taxRatePercent: "0", taxMode: SalesTaxMode.NONE },
      "5.01",
    )).toThrow("DISCOUNT_LIMIT_EXCEEDED");
  });
});
