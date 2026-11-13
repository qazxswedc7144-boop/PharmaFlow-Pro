// src/domain/sales.domain.ts
import { DomainEntity } from "./base.types";
import { InvoiceStatus, PaymentStatus, PaymentMethod } from "./enums.types";

/**
 * Sales Line Item Entity
 */
export interface SalesInvoiceItem extends DomainEntity {
  id: string;
  invoiceId?: string;
  productId: string;
  productName: string;
  batchId?: string;
  rowOrder?: number;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  discountValue?: number;
  taxValue?: number;
  unit?: string;
  expiryDate?: string;
  category?: string;
  notes?: string;

  // Compatibility properties matching legacy InvoiceItem
  parent_id?: string;
  product_id?: string;
  row_order?: number;
  name?: string;
  qty: number;
  price: number;
  sum?: number;
  discount_val?: number;
  tax_val?: number;
}

/**
 * Sales Invoice Domain Entity
 */
export interface SalesInvoice extends DomainEntity {
  id: string;
  invoiceNumber?: string;
  /** Shared local Invoice-table field; populated only by purchase documents. */
  supplierInvoiceNumber?: string | null;
  date: string;
  customerId?: string;
  customerName?: string;
  subtotal: number;
  taxTotal?: number;
  discountTotal?: number;
  grandTotal?: number;
  paidAmount?: number;
  remainingAmount?: number;
  paymentMethod?: PaymentMethod | 'Cash' | 'Credit' | string;
  financialStatus?: PaymentStatus | 'Unpaid' | 'Partially Paid' | 'Paid' | string;
  invoiceStatus?: InvoiceStatus;
  items: SalesInvoiceItem[];
  isReturn?: boolean;
  notes?: string;
  branchId?: string;
  transactionUuid?: string;
  hash?: string;

  // Compatibility fields for UnifiedInvoice & Sale
  SaleID?: string;
  Date?: string;
  customer_id?: string;
  partnerId?: string;
  partnerName?: string;
  type?: 'SALE' | 'PURCHASE' | string;
  tax?: number;
  finalTotal: number;
  paymentStatus?: 'Cash' | 'Credit' | string;
  documentStatus?: InvoiceStatus;
  InvoiceStatus?: InvoiceStatus;
  totalCost?: number;
  totalAmount?: number;
  status?: string;
  payment_status?: string;
}

/**
 * Sales Return Entity
 */
export interface SalesReturn extends DomainEntity {
  id: string;
  returnNumber?: string;
  originalInvoiceId?: string;
  date: string;
  customerId?: string;
  items: SalesInvoiceItem[];
  grandTotal?: number;
  reason?: string;
  branchId?: string;
}

export type Sale = SalesInvoice;
