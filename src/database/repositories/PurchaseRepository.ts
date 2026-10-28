
import { db } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { Purchase } from '@/types';

export const PurchaseRepository = {
  getAll: async (): Promise<Purchase[]> => {
    return await db.invoices.where('type').equals('PURCHASE').toArray() as unknown as Purchase[];
  },

  getById: async (id: string): Promise<Purchase | undefined> => {
    return await db.invoices.get(id) as unknown as Purchase;
  },

  save: async (purchase: Purchase): Promise<string> => {
    const key = await db.invoices.put({
      ...purchase,
      type: 'PURCHASE',
      updatedAt: new Date().toISOString()
    });
    return String(key);
  },

  delete: async (id: string): Promise<void> => {
    await db.invoices.delete(id);
  },

  getLastPurchasePriceForItem: async (productId: string): Promise<number> => {
    try {
      const items = await db.invoiceItems
        .where('product_id').equals(productId)
        .or('productId').equals(productId)
        .toArray();
      if (items && items.length > 0) {
        const lastItem = items[items.length - 1];
        if (lastItem && (lastItem.price || lastItem.unitPrice || lastItem.costPrice)) {
          return lastItem.price || lastItem.unitPrice || lastItem.costPrice || 0;
        }
      }
    } catch {
      // Fallback
    }

    const purchases = await db.invoices.where('type').equals('PURCHASE').toArray();
    purchases.sort((a, b) => new Date(b.date || b.createdAt || 0).getTime() - new Date(a.date || a.createdAt || 0).getTime());

    for (const p of purchases) {
      if (!p.items || !Array.isArray(p.items)) continue;
      const item = p.items.find(i => i && (i.product_id === productId || i.productId === productId || i.ProductID === productId));
      if (item) {
        return item.price || item.unitPrice || item.costPrice || 0;
      }
    }
    return 0;
  },

  isInvoiceNumberDuplicate: async (invoiceNumber: string, excludeId?: string): Promise<boolean> => {
    const [bySnake, byCamel] = await Promise.all([
      db.invoices.where('[type+invoice_number]').equals(['PURCHASE', invoiceNumber]).toArray(),
      db.invoices.where('[type+invoiceNumber]').equals(['PURCHASE', invoiceNumber]).toArray()
    ]);
    const matches = [...bySnake, ...byCamel].filter(i => i.id !== excludeId);
    return matches.length > 0;
  },

  getNextInvoiceNumber: async (): Promise<string> => {
    const count = await db.invoices.where('type').equals('PURCHASE').count();
    return `PUR-${String(count + 1).padStart(5, '0')}`;
  },

  getItemPurchaseHistory: async (productId: string, limit: number = 5, tenantId?: string): Promise<Purchase[]> => {
    if (!productId) return [];
    const session = TokenProvider.getCurrentSession();
    const sessionTenantId = session.tenantId || session.user?.tenantId || session.user?.tenant_id;

    // Authoritative Security Boundary (Security Fix #5)
    if (sessionTenantId) {
      if (tenantId && tenantId !== sessionTenantId) {
        return []; // Conflict -> Fail Closed
      }
    } else if (tenantId) {
      // A missing session tenant must not automatically authorize access
      return []; // No session -> Fail Closed
    }

    const effectiveTenantId = sessionTenantId || tenantId;
    const forbiddenTenants = ['TEN-DEV-001', 'tenant_default', 'default', 'default-tenant'];
    if (!effectiveTenantId || forbiddenTenants.includes(effectiveTenantId)) {
      return [];
    }

    const purchases = await db.invoices.where('type').equals('PURCHASE').toArray();
    purchases.sort((a, b) => new Date(b.date || b.createdAt || 0).getTime() - new Date(a.date || a.createdAt || 0).getTime());

    const matched: Purchase[] = [];
    for (const p of purchases) {
      const pTenant = (p as any).tenantId || (p as any).tenant_id;
      if (pTenant !== effectiveTenantId) continue;

      if (p.items && Array.isArray(p.items) && p.items.some(i => i && (i.product_id === productId || i.productId === productId || i.ProductID === productId))) {
        matched.push(p as unknown as Purchase);
        if (matched.length >= limit) break;
      }
    }
    return matched;
  },

  getUnpaidBySupplier: async (supplierId: string): Promise<Purchase[]> => {
    const [bySnake, byCamel] = await Promise.all([
      db.invoices.where('[type+partner_id]').equals(['PURCHASE', supplierId]).toArray(),
      db.invoices.where('[type+partnerId]').equals(['PURCHASE', supplierId]).toArray()
    ]);
    const map = new Map<string, any>();
    for (const item of [...bySnake, ...byCamel]) {
      if (item && item.id) map.set(item.id, item);
    }
    return Array.from(map.values()).filter(p => {
      const total = p.finalTotal ?? p.totalAmount ?? 0;
      const paid = p.paidAmount ?? 0;
      return paid < total;
    }) as unknown as Purchase[];
  },

  updatePaidAmount: async (id: string, amount: number, tenantId?: string, tx?: any): Promise<void> => {
    if (typeof amount !== 'number' || !isFinite(amount) || isNaN(amount) || amount <= 0) {
      throw new Error('ALLOCATION_AMOUNT_INVALID: مبلغ السداد يجب أن يكون رقماً موجباً أكبر من الصفر.');
    }
    const performUpdate = async (_t: any) => {
      const invoicesTbl = db.invoices;
      const purchase = await invoicesTbl.get(id);
      if (!purchase) {
        throw new Error(`INVOICE_NOT_FOUND: الفاتورة [${id}] غير موجودة.`);
      }
      if (tenantId && (!purchase.tenantId || purchase.tenantId !== tenantId)) {
        throw new Error(`CROSS_TENANT_INVOICE_FORBIDDEN: الفاتورة [${id}] تابعة لمؤسسة أخرى.`);
      }
      const total = Number(purchase.totalAmount ?? purchase.finalTotal ?? 0);
      const currentPaid = Number(purchase.paidAmount ?? 0);
      const remaining = Math.max(0, Math.round((total - currentPaid) * 100) / 100);

      if (remaining <= 0.001) {
        throw new Error(`INVOICE_ALREADY_PAID: الفاتورة [${id}] مسددة بالكامل بالفعل ولا يمكن تكرار السداد لها.`);
      }

      if (amount > remaining + 0.001) {
        throw new Error(`OVER_ALLOCATION: مبلغ السداد (${amount}) يتجاوز المتبقي على الفاتورة (${remaining}).`);
      }

      const calculatedPaid = Math.round((currentPaid + amount) * 100) / 100;
      const newPaid = Math.min(total, calculatedPaid);
      const newRemaining = Math.max(0, Math.round((total - newPaid) * 100) / 100);
      await invoicesTbl.update(id, {
        paidAmount: newPaid,
        remainingAmount: newRemaining,
        remaining: newRemaining,
        paymentStatus: newPaid >= total - 0.001 ? 'PAID' : (newPaid > 0 ? 'PARTIAL' : purchase.paymentStatus),
        updatedAt: new Date().toISOString()
      });
    };

    const activeTx = tx || (db as any).currentTransaction || (db as any).idbdb?.currentTransaction || (globalThis as any).Dexie?.currentTransaction;
    if (activeTx) {
      await performUpdate(activeTx);
    } else {
      await db.safeTransaction('rw', ['invoices'], performUpdate);
    }
  },

  settleSupplierFIFO: async (supplierId: string, amount: number): Promise<void> => {
    const unpaid = await PurchaseRepository.getUnpaidBySupplier(supplierId);
    let remaining = amount;
    for (const p of unpaid) {
      if (remaining <= 0) break;
      const owed = (p.totalAmount || 0) - (p.paidAmount || 0);
      const toPay = Math.min(remaining, owed);
      await PurchaseRepository.updatePaidAmount(p.id, toPay);
      remaining -= toPay;
    }
  }
};
