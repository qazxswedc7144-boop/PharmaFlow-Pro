// src/domain/purchases.domain.ts
import { DomainEntity } from "./base.types";
import { InvoiceStatus, PaymentStatus } from "./enums.types";
import { SalesInvoiceItem } from "./sales.domain";

/**
 * Purchase Invoice Item Entity
 */
export type PurchaseInvoiceItem = SalesInvoiceItem;

/**
 * Purchase Invoice Domain Entity
 */
export interface PurchaseInvoice extends DomainEntity {
  id: string;
  purchaseId?: string;
  invoiceNumber?: string;
  supplierInvoiceNumber?: string;
  date?: string;
  supplierId?: string;
  supplierName?: string;
  subtotal?: number;
  taxTotal?: number;
  discountTotal?: number;
  grandTotal?: number;
  paidAmount?: number;
  remainingAmount?: number;
  paymentStatus?: PaymentStatus | 'PAID' | 'UNPAID' | string;
  invoiceStatus?: InvoiceStatus;
  items?: PurchaseInvoiceItem[];
  branchId?: string;
  isReturn?: boolean;
  notes?: string;

  // Compatibility fields matching Purchase and UnifiedInvoice
  purchase_id?: string;
  invoiceId?: string;
  supplier_id?: string;
  partnerId?: string;
  partnerName?: string;
  totalAmount?: number;
  finalTotal?: number;
  tax?: number;
  status?: 'PAID' | 'UNPAID' | string;
  payment_status?: PaymentStatus;
}

/**
 * Purchase Return Domain Entity
 */
export interface PurchaseReturn extends DomainEntity {
  id: string;
  returnNumber?: string;
  originalInvoiceId?: string;
  date?: string;
  supplierId?: string;
  items?: PurchaseInvoiceItem[];
  grandTotal?: number;
  reason?: string;
  branchId?: string;
}

export type Purchase = PurchaseInvoice;
