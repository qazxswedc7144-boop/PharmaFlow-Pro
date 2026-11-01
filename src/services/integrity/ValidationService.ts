// src/services/integrity/ValidationService.ts
import { db } from '@/core/db';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Utility to safely coerce any value to a finite number.
 * Handles strings like "10.5", null, undefined, NaN.
 * Returns NaN if coercion fails.
 */
function safeNumber(value: unknown): number {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return NaN;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

export class ValidationService {
  /**
   * ============================================================
   * 1. Generic entity validator (fallback).
   * Fails closed on unknown schemas to prevent silent pass-through.
   * ============================================================
   */
  static validate(entity: any, schema: string): ValidationResult {
    if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
      return { valid: false, errors: ['Entity is null, undefined, or not an object.'] };
    }
    if (!entity.id && schema !== 'create') {
      return { valid: false, errors: ['Missing entity id.'] };
    }
    return { valid: true, errors: [] };
  }

  /**
   * ============================================================
   * 2. Strict Invoice Validation.
   * Validates critical financial and inventory fields.
   * 
   * IMPORTANT: Does NOT enforce tenantId/branchId/userId here.
   * Those come from the session context (getCurrentUserSession),
   * NOT from the invoice payload.
   * ============================================================
   */
  static async validateInvoice(invoice: any, type?: string): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) {
      return { valid: false, errors: ['Invoice payload is missing or invalid.'] };
    }

    // ----- 1. Invoice ID (supports multiple field names) -----
    const invoiceId =
      invoice.id ||
      invoice.invoiceId ||
      invoice.invoice_id ||
      invoice.invoiceNumber ||
      invoice.invoice_number;

    if (!invoiceId || typeof invoiceId !== 'string' || invoiceId.trim() === '') {
      errors.push('Invoice number/ID is required and must be a non-empty string.');
    }

    // ----- 2. Items array -----
    if (!Array.isArray(invoice.items) || invoice.items.length === 0) {
      errors.push('Invoice must contain at least one line item.');
      return { valid: false, errors }; // Early return
    }

    let calculatedTotal = 0;
    let validItemsCount = 0;

    // ----- 3. Validate each line item -----
    for (let i = 0; i < invoice.items.length; i++) {
      const item = invoice.items[i];
      const idx = i + 1;
      let itemValid = true;

      if (!item || typeof item !== 'object') {
        errors.push(`Item #${idx}: Invalid item object.`);
        continue;
      }

      // 3a. Product reference (supports productId / product_id)
      const productId = item.productId || item.product_id;
      if (!productId) {
        errors.push(`Item #${idx}: Missing product ID.`);
        itemValid = false;
      }

      // 3b. Quantity (supports qty / quantity, coerces strings)
      const rawQty = item.qty !== undefined ? item.qty : item.quantity;
      const qty = safeNumber(rawQty);
      if (isNaN(qty) || !Number.isInteger(qty) || qty <= 0) {
        errors.push(`Item #${idx}: Quantity must be a positive integer. Got: "${rawQty}"`);
        itemValid = false;
      }

      // 3c. Price (supports price / unitPrice / unit_price, coerces strings)
      const rawPrice = item.price !== undefined ? item.price : (item.unitPrice !== undefined ? item.unitPrice : item.unit_price);
      const price = safeNumber(rawPrice);
      if (isNaN(price) || price < 0) {
        errors.push(`Item #${idx}: Price must be a non-negative number. Got: "${rawPrice}"`);
        itemValid = false;
      }

      // 3d. Accumulate total only for valid items
      if (itemValid && !isNaN(qty) && !isNaN(price)) {
        const discount = safeNumber(item.discount ?? item.discount_val ?? 0) || 0;
        calculatedTotal += (qty * price) - discount;
        validItemsCount++;
      }
    }

    // If NO valid items at all, fail early
    if (validItemsCount === 0) {
      errors.push('No valid line items found in the invoice.');
      return { valid: false, errors };
    }

    // ----- 4. Total validation (only if declared and finite) -----
    const rawDeclaredTotal = invoice.total ?? invoice.finalTotal ?? invoice.totalAmount ?? invoice.total_amount;
    const declaredTotal = safeNumber(rawDeclaredTotal);

    if (!isNaN(declaredTotal) && declaredTotal > 0) {
      const tolerance = 0.02; // Allow minor float rounding

      // Financial adjustments: subtotal - discount + otherFees + tax
      const rawDiscountPercent = safeNumber(invoice.discountPercent ?? invoice.discount_percent ?? 0);
      const discountPercent = !isNaN(rawDiscountPercent) && rawDiscountPercent > 0 ? rawDiscountPercent : 0;
      const discountFromPercent = discountPercent > 0 ? Math.round(calculatedTotal * (discountPercent / 100) * 100) / 100 : 0;
      const rawFixedDiscount = safeNumber(invoice.discount ?? invoice.discountTotal ?? invoice.discount_val ?? 0);
      const discountAmount = discountFromPercent > 0 ? discountFromPercent : (!isNaN(rawFixedDiscount) ? rawFixedDiscount : 0);

      const otherFees = safeNumber(invoice.otherFees ?? invoice.other_fees ?? 0) || 0;
      const tax = safeNumber(invoice.tax ?? invoice.taxTotal ?? invoice.tax_val ?? 0) || 0;

      const expectedAdjustedTotal = Math.round((calculatedTotal - discountAmount + otherFees + tax) * 100) / 100;

      const matchesAdjusted = Math.abs(declaredTotal - expectedAdjustedTotal) <= tolerance;
      const matchesRawSubtotal = Math.abs(declaredTotal - calculatedTotal) <= tolerance;

      if (!matchesAdjusted && !matchesRawSubtotal) {
        errors.push(
          `Total mismatch: Declared ${declaredTotal.toFixed(2)}, but expected ${expectedAdjustedTotal.toFixed(2)} (items sum: ${calculatedTotal.toFixed(2)} - discount: ${discountAmount.toFixed(2)} + fees: ${otherFees.toFixed(2)} + tax: ${tax.toFixed(2)}). Difference: ${Math.abs(declaredTotal - expectedAdjustedTotal).toFixed(2)}`
        );
      }
    }

    // ----- 5. Partner validation (Customer or Supplier) -----
    const partnerId =
      invoice.customerId ||
      invoice.customer_id ||
      invoice.supplierId ||
      invoice.supplier_id ||
      invoice.partnerId ||
      invoice.partner_id;

    const isAdjustment = type && type.toUpperCase() === 'ADJUSTMENT';
    if (!partnerId && !isAdjustment) {
      errors.push('Invoice must have a customer or supplier (partner ID).');
    }

    // ----- 6. Payment status validation -----
    const rawPaymentStatus = invoice.paymentStatus || invoice.payment_status || invoice.status;
    if (rawPaymentStatus) {
      const normalizedStatus = String(rawPaymentStatus).toUpperCase().replace(/\s+/g, '_');
      const validPaymentStatuses = [
        'PAID',
        'UNPAID',
        'PARTIALLY_PAID',
        'CASH',
        'CREDIT',
        'DRAFT',
        'PENDING',
        'CONFIRMED',
        'CANCELLED',
      ];
      if (!validPaymentStatuses.includes(normalizedStatus)) {
        errors.push(`Invalid payment status: "${rawPaymentStatus}".`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * ============================================================
   * 3. Strict Invoice ID Uniqueness Validation.
   * Prevents saving duplicate invoices that could overwrite data.
   * 
   * Notes:
   * - Returns TRUE if unique (safe to insert).
   * - Returns FALSE if duplicate exists (block the insert).
   * - Fails CLOSED (throws error) if DB query throws or table is unavailable,
   *   to guarantee transaction integrity and avoid silent duplicate inserts.
   * - Allows duplicate IDs for RETURN types (they reference originals).
   * ============================================================
   */
  static async validateInvoiceIdUniqueness(
    id: string,
    type: string,
    dbArg?: any
  ): Promise<boolean> {
    if (!id || typeof id !== 'string' || id.trim() === '') {
      return false;
    }

    // Allow RETURN types to reuse IDs (they reference original invoices)
    if (type && String(type).toUpperCase().includes('RETURN')) {
      return true;
    }

    try {
      const database = dbArg || db;

      if (!database || !database.invoices) {
        console.error('[ValidationService] Invoices table is unavailable for uniqueness verification (failing closed).');
        throw new Error('DATABASE_CHECK_FAILED: جدول الفواتير غير متاح للتحقق من الفرادة.');
      }

      // Check primary key 'id'
      if (typeof database.invoices.get === 'function') {
        const existing = await database.invoices.get(id);
        if (existing) return false;
      }

      // Check indexed queries if where() is supported
      if (typeof database.invoices.where === 'function') {
        const byId = await database.invoices.where('id').equals(id).count();
        if (byId > 0) return false;

        // Some schemas store as invoiceId instead of id
        if (database.invoices.schema?.indexes?.some((i: any) => 
          (typeof i === 'string' ? i : i.name) === 'invoiceId'
        )) {
          const byInvoiceId = await database.invoices.where('invoiceId').equals(id).count();
          if (byInvoiceId > 0) return false;
        }

        if (database.invoices.schema?.indexes?.some((i: any) => 
          (typeof i === 'string' ? i : i.name) === 'invoiceNumber'
        )) {
          const byInvoiceNumber = await database.invoices.where('invoiceNumber').equals(id).count();
          if (byInvoiceNumber > 0) return false;
        }

        if (database.invoices.schema?.indexes?.some((i: any) => 
          (typeof i === 'string' ? i : i.name) === 'invoice_number'
        )) {
          const byInvoiceNumber = await database.invoices.where('invoice_number').equals(id).count();
          if (byInvoiceNumber > 0) return false;
        }
      }

      return true;
    } catch (error: any) {
      console.error('[ValidationService] Uniqueness check failed (failing closed):', error?.message);
      // Fail-closed: reject transaction on DB error, never fail safe
      throw new Error(`DATABASE_CHECK_FAILED: فشل التحقق من فرادة الفاتورة بسبب خطأ في قاعدة البيانات (${error?.message || 'Database query error'})`);
    }
  }

  /**
   * ============================================================
   * 3.1. Strict Purchase Invoice Number Uniqueness Validation.
   * Centralized, tenant-scoped validation for PURCHASE invoice numbers.
   * On edit, excludes the current invoice (excludeInternalId).
   * Returns TRUE if unique, FALSE if duplicate exists.
   * ============================================================
   */
  static async validatePurchaseInvoiceNumberUniqueness(
    invoiceNumber: string,
    tenantId: string,
    excludeInternalId?: string,
    dbArg?: any
  ): Promise<boolean> {
    if (!invoiceNumber || typeof invoiceNumber !== 'string' || invoiceNumber.trim() === '') {
      return true;
    }
    const cleanNumber = invoiceNumber.trim();
    const database = dbArg || db;

    if (!database || !database.invoices) {
      console.error('[ValidationService] Invoices table is unavailable for invoiceNumber uniqueness (failing closed).');
      throw new Error('DATABASE_CHECK_FAILED: جدول الفواتير غير متاح للتحقق من فرادة رقم الفاتورة.');
    }

    try {
      let matches: any[] = [];
      if (typeof database.invoices.where === 'function') {
        try {
          matches = await database.invoices
            .where('tenantId')
            .equals(tenantId)
            .filter((inv: any) => {
              const isPurchase = (inv.type === 'PURCHASE' || inv.type === 'purchase' || inv.invoiceType === 'مرتجع' || inv.invoiceType === 'مشتريات' || inv.invoiceType === 'PURCHASE');
              const numMatch = (
                inv.invoiceNumber === cleanNumber ||
                inv.invoice_number === cleanNumber ||
                inv.invoiceId === cleanNumber
              );
              return isPurchase && numMatch;
            })
            .toArray();
        } catch {
          // Fallback to table filter
          matches = await database.invoices
            .filter((inv: any) => {
              const tId = inv.tenantId || inv.tenant_id;
              if (tId !== tenantId) return false;
              const isPurchase = (inv.type === 'PURCHASE' || inv.type === 'purchase' || inv.invoiceType === 'مرتجع' || inv.invoiceType === 'مشتريات' || inv.invoiceType === 'PURCHASE');
              const numMatch = (
                inv.invoiceNumber === cleanNumber ||
                inv.invoice_number === cleanNumber ||
                inv.invoiceId === cleanNumber
              );
              return isPurchase && numMatch;
            })
            .toArray();
        }
      } else {
        matches = await database.invoices
          .filter((inv: any) => {
            const tId = inv.tenantId || inv.tenant_id;
            if (tId !== tenantId) return false;
            const isPurchase = (inv.type === 'PURCHASE' || inv.type === 'purchase' || inv.invoiceType === 'مرتجع' || inv.invoiceType === 'مشتريات' || inv.invoiceType === 'PURCHASE');
            return isPurchase && (inv.invoiceNumber === cleanNumber || inv.invoice_number === cleanNumber || inv.invoiceId === cleanNumber);
          })
          .toArray();
      }

      if (excludeInternalId) {
        matches = matches.filter((inv: any) => inv.id !== excludeInternalId && inv.invoiceId !== excludeInternalId);
      }

      return matches.length === 0;
    } catch (error: any) {
      console.error('[ValidationService] validatePurchaseInvoiceNumberUniqueness failed:', error?.message);
      throw new Error(`DATABASE_CHECK_FAILED: فشل التحقق من فرادة رقم الفاتورة بسبب خطأ في قاعدة البيانات (${error?.message || 'Database query error'})`);
    }
  }

  /**
   * ============================================================
   * 4. Optional: Strict Product Validation (for future use).
   * ============================================================
   */
  static validateProduct(product: any): ValidationResult {
    const errors: string[] = [];

    if (!product || typeof product !== 'object') {
      return { valid: false, errors: ['Product payload is invalid.'] };
    }

    const name = product.name || product.Name;
    if (!name || typeof name !== 'string' || name.trim() === '') {
      errors.push('Product name is required.');
    }

    const price = safeNumber(product.price ?? product.UnitPrice ?? 0);
    if (isNaN(price) || price < 0) {
      errors.push('Product price must be a non-negative number.');
    }

    const cost = safeNumber(product.cost ?? product.CostPrice ?? 0);
    if (isNaN(cost) || cost < 0) {
      errors.push('Product cost must be a non-negative number.');
    }

    return { valid: errors.length === 0, errors };
  }
                    }
