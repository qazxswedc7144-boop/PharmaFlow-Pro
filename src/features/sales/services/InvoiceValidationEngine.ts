
import { InvoiceItem } from '@/types';
import { db } from '@/core/db';

export interface ValidationInvoicePayload {
  id?: string;
  date?: string;
  customerId?: string;
  partnerId?: string;
  finalTotal?: number;
  totalAmount?: number;
  items?: InvoiceItem[];
  [key: string]: unknown;
}

export const InvoiceValidationEngine = {
  /**
   * توليد بصمة فريدة للفاتورة لمنع التكرار بصورة ذكية
   */
  generateHash: (invoice: ValidationInvoicePayload): string => {
    // نستخدم تفاصيل الأصناف (المعرف، الكمية، السعر) لجعل البصمة أكثر دقة ومنع التشابه الخاطئ
    const itemsSignature = (invoice.items || []).map((i: InvoiceItem) => `${i.product_id || i.name}:${i.qty}:${i.price}`).join('|');
    const data = `${invoice.date || ''}|${invoice.customerId || invoice.partnerId || ''}|${invoice.finalTotal ?? invoice.totalAmount ?? 0}|${itemsSignature}`;
    
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; 
    }
    return hash.toString();
  },

  /**
   * التحقق من صحة الفاتورة قبل الحفظ
   */
  validate: async (invoice: ValidationInvoicePayload, type: 'SALE' | 'PURCHASE') => {
    // 1. منع الفاتورة الفارغة
    if (!invoice.items || invoice.items.length === 0) {
      throw new Error("يجب أن تحتوي الفاتورة على صنف واحد على الأقل");
    }

    // 2. منع الكميات الصفرية أو السالبة
    // 3. منع الأسعار السالبة
    invoice.items.forEach((item: InvoiceItem) => {
      if (item.qty <= 0) {
        throw new Error(`كمية غير صالحة للصنف: ${item.name}`);
      }
      if (item.price < 0) {
        throw new Error(`سعر غير صالح للصنف: ${item.name}`);
      }
    });

    // 4. منع الإجمالي السالب
    const total = (type === 'SALE' ? invoice.finalTotal : invoice.totalAmount) ?? 0;
    if (total < 0) {
      throw new Error("إجمالي الفاتورة لا يمكن أن يكون سالباً");
    }

    // 5. منع تجاوز المخزون (للمبيعات فقط)
    if (type === 'SALE') {
      const products = await db.getProducts();
      for (const item of invoice.items) {
        const product = products.find(p => p.id === item.product_id);
        const availStock = product ? (product.StockQuantity ?? product.stock ?? 0) : 0;
        if (product && item.qty > availStock) {
          throw new Error(`مخزون غير كافٍ للصنف: ${item.name} (المتاح: ${availStock})`);
        }
      }
    }

    // التحقق من تكرار الفاتورة عبر البصمة بصورة فعالة باستخدام الفهرس
    const hash = InvoiceValidationEngine.generateHash(invoice);
    
    const duplicateSales = await db.sales.where('hash').equals(hash).toArray();
    const duplicatePurchases = await db.purchases.where('hash').equals(hash).toArray();
    
    const isDuplicate = [...duplicateSales, ...duplicatePurchases].some(inv => inv.id !== invoice.id);
    if (isDuplicate) {
      throw new Error("تم اكتشاف فاتورة مكررة (نفس التاريخ، الشريك، والإجمالي والأصناف)");
    }

    return hash;
  }
};
