import { describe, expect, it } from "vitest";
import { InvoiceSchema } from "../../src/shared/validation/invoice.schema.js";

const validSale = {
  invoiceNumber: "INV-STRICT-001",
  type: "SALE" as const,
  items: [{ productId: "11111111-1111-4111-8111-111111111111", qty: 1 }],
};

describe("InvoiceSchema server-authoritative financial fields", () => {
  it("rejects client-supplied taxAmount", () => {
    expect(InvoiceSchema.safeParse({ ...validSale, taxAmount: 12 }).success).toBe(false);
  });

  it("rejects client-supplied discountAmount", () => {
    expect(InvoiceSchema.safeParse({ ...validSale, discountAmount: 5 }).success).toBe(false);
  });
});
