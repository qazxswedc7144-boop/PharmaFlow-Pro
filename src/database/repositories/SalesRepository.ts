
import { db } from '@/core/db';
import { Sale } from '@/types';

export const SalesRepository = {
  getAll: async (): Promise<Sale[]> => {
    const raw = await db.invoices.where('type').equals('SALE').toArray();
    return raw as unknown as Sale[];
  },

  getById: async (id: string): Promise<Sale | undefined> => {
    return await db.invoices.get(id) as unknown as Sale;
  },

  save: async (sale: Sale): Promise<string> => {
    const key = await db.invoices.put({
      ...sale,
      type: 'SALE',
      updatedAt: new Date().toISOString()
    });
    return String(key);
  },

  delete: async (id: string): Promise<void> => {
    await db.invoices.delete(id);
  },

  getUnpaidByCustomer: async (partnerId: string): Promise<Sale[]> => {
    const [bySnake, byCamel] = await Promise.all([
      db.invoices.where('[type+partner_id]').equals(['SALE', partnerId]).toArray(),
      db.invoices.where('[type+partnerId]').equals(['SALE', partnerId]).toArray()
    ]);
    const map = new Map<string, any>();
    for (const item of [...bySnake, ...byCamel]) {
      if (item && item.id) map.set(item.id, item);
    }
    return Array.from(map.values()).filter(s => {
      const total = s.finalTotal ?? s.totalAmount ?? 0;
      const paid = s.paidAmount ?? 0;
      return paid < total;
    }) as unknown as Sale[];
  },

  updatePaidAmount: async (id: string, amount: number, tenantId?: string, tx?: any): Promise<void> => {
    if (typeof amount !== 'number' || !isFinite(amount) || isNaN(amount) || amount <= 0) {
      throw new Error('ALLOCATION_AMOUNT_INVALID: مبلغ السداد يجب أن يكون رقماً موجباً أكبر من الصفر.');
    }
    const performUpdate = async (_t: any) => {
      const invoicesTbl = db.invoices;
      const sale = await invoicesTbl.get(id);
      if (!sale) {
        throw new Error(`INVOICE_NOT_FOUND: فاتورة المبيعات [${id}] غير موجودة.`);
      }
      if (tenantId && (!sale.tenantId || sale.tenantId !== tenantId)) {
        throw new Error(`CROSS_TENANT_INVOICE_FORBIDDEN: الفاتورة [${id}] تابعة لمؤسسة أخرى.`);
      }
      const total = Number(sale.totalAmount ?? sale.finalTotal ?? 0);
      const currentPaid = Number(sale.paidAmount ?? 0);
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
        paymentStatus: newPaid >= total - 0.001 ? 'PAID' : (newPaid > 0 ? 'PARTIAL' : sale.paymentStatus),
        updatedAt: new Date().toISOString()
      });
    };

    const activeTx = tx || (db as any).currentTransaction || (db as any).idbdb?.currentTransaction || (globalThis as any).Dexie?.currentTransaction;
    if (activeTx) {
      await performUpdate(activeTx);
    } else {
      await db.safeTransaction('rw', ['invoices'], async (t: any) => {
        await performUpdate(t);
      });
    }
  }
};
