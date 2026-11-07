// src/shared/validation/invoice.schema.ts
import { z } from "zod";
import { MoneySchema, QuantitySchema, OptionalStringSchema } from "./common.schema";

export const InvoiceItemSchema = z.object({
  productId: z.string().uuid("معرّف المنتج يجب أن يكون UUID صالح"),
  qty: QuantitySchema,
  // SALE prices are resolved by the server from the tenant catalog.
  // Purchase prices remain supplied from the supplier document and are required below.
  price: MoneySchema.optional(),
  expiryDate: z.coerce.date().nullable().optional(),
  note: OptionalStringSchema
}).strict();

export const InvoiceSchema = z.object({
  invoiceNumber: z.string().trim().min(3, "رقم الفاتورة يجب أن يحتوي على 3 أرقام أو حروف على الأقل").max(50),
  type: z.enum(["SALE", "PURCHASE", "RETURN_SALE", "RETURN_PURCHASE"]),
  partnerId: z.string().uuid("معرّف الشريك يجب أن يكون UUID صالح").nullable().optional(),
  partnerType: z.enum(["CUSTOMER", "SUPPLIER"]).nullable().optional(),
  // Never authoritative for SALE; retained as optional for legacy clients.
  totalAmount: MoneySchema.optional(),
  discountPercent: z.number().finite().min(0).max(100).optional(),
  status: z.enum(["DRAFT", "PENDING", "CONFIRMED", "CANCELLED"]).default("DRAFT"),
  paymentStatus: z.enum(["PAID", "UNPAID", "PARTIALLY_PAID"]).default("UNPAID"),
  documentStatus: z.enum(["ACTIVE", "POSTED", "ARCHIVED", "LOCKED"]).default("ACTIVE"),
  items: z.array(InvoiceItemSchema).min(1, "يجب أن تحتوي الفاتورة على صنف واحد على الأقل")
}).strict().superRefine((invoice, ctx) => {
  if (invoice.type !== "SALE") {
    invoice.items.forEach((item, index) => {
      if (item.price === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "price"],
          message: "سعر الصنف مطلوب لفواتير الشراء والمرتجعات."
        });
      }
    });
    if ((invoice.discountPercent ?? 0) !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discountPercent"],
        message: "الخصم المدخل متاح لفواتير البيع فقط."
      });
    }
  }
});

export type InvoiceDTO = z.infer<typeof InvoiceSchema>;
export type InvoiceItemDTO = z.infer<typeof InvoiceItemSchema>;
