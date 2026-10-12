
import { db } from '@/core/db';
import { InvoiceItem, ItemUsageLog } from '@/types';
import { PriceHistoryRepository } from '@/database/repositories/PriceHistoryRepository';

interface SuggestedPriceResult {
  suggestedPrice: number | null;
  basis: 'partner' | 'preferred' | 'average' | 'none';
  insight?: string;
}

const PRICE_CACHE = new Map<string, { result: SuggestedPriceResult, timestamp: number }>();

/**
 * Price Intelligence Service - محرك تحليل سجل الأسعار (Phase 13)
 * يستخرج الأسعار المقترحة بناءً على (المتوسط، المورد المفضل، آخر حركة)
 */
export const priceIntelligenceService = {
  
  async recordInvoiceUsage(items: InvoiceItem[], type: 'SALE' | 'PURCHASE', partnerId: string, userId: string) {
    const timestamp = new Date().toISOString();
    
    // تسجيل الحركات في سجل الاستخدام العام وفي سجل تاريخ الأسعار التفصيلي
    for (const item of items) {
      // 1. تسجيل تاريخ السعر (Price History Memory)
      const prodId = item.product_id || (item as any).productId || 'N/A';
      await PriceHistoryRepository.record(
        prodId,
        item.name || (item as any).productName || 'صنف',
        partnerId,
        item.price,
        timestamp
      );

      // 2. تسجيل الاستخدام اللوجستي
      const logEntry: ItemUsageLog = {
        id: db.generateId('USG'),
        productId: prodId,
        timestamp,
        type,
        partnerId,
        userId,
        qty: item.qty,
        price: item.price
      };
      await db.itemUsageLog.add(logEntry);
      
      // تحديث إحصائيات المنتج في الخلفية
      const product = await db.products.get(item.product_id);
      if (product) {
        product.usageCount = (product.usageCount || 0) + 1;
        product.lastModified = timestamp;
        await db.products.put(product);
      }
    }
    
    // تنظيف كاش الأسعار المرتبط بهذه المنتجات
    items.forEach(it => {
      PRICE_CACHE.delete(`${it.product_id}_${type}`);
      PRICE_CACHE.delete(`${it.product_id}_${type}_${partnerId}`);
    });
  },

  /**
   * استخراج السعر المقترح (Suggested Price Engine)
   */
  async getSuggestedPrice(productId: string, _type: 'SALE' | 'PURCHASE', partnerId?: string): Promise<{ 
    suggestedPrice: number | null, 
    basis: 'partner' | 'preferred' | 'average' | 'none',
    insight?: string 
  }> {
    if (!productId) return { suggestedPrice: null, basis: 'none' };
    
    // 1. Check live authoritative invoices and sales for the actual last sale / purchase price
    try {
      const allInvoices = await db.invoices.toArray().catch(() => []);
      const legacySales = await db.sales.toArray().catch(() => []);
      const legacyPurchases = await db.purchases.toArray().catch(() => []);

      const matchingRecords: Array<{ price: number; date: string; partnerId?: string; type: string }> = [];

      // Unified invoices
      for (const inv of allInvoices) {
        if (inv.documentStatus === 'VOID' || inv.documentStatus === 'CANCELLED') continue;
        if (inv.isReturn) continue;
        const invType = inv.type || (inv as any).entityType;
        if (invType !== _type) continue;

        const items = inv.items || [];
        for (const it of items) {
          const itProdId = it.product_id || (it as any).productId || (it as any).ProductID;
          if (itProdId === productId && Number(it.price) > 0) {
            matchingRecords.push({
              price: Number(it.price),
              date: inv.date || inv.createdAt || '',
              partnerId: inv.partnerId,
              type: invType
            });
          }
        }
      }

      // Legacy records
      if (_type === 'SALE') {
        for (const s of legacySales) {
          if (s.status === 'VOID' || s.status === 'CANCELLED' || s.isReturn) continue;
          const items = s.items || [];
          for (const it of items) {
            const itProdId = it.product_id || (it as any).productId || (it as any).ProductID;
            if (itProdId === productId && Number(it.price) > 0) {
              matchingRecords.push({
                price: Number(it.price),
                date: s.date || s.Date || s.createdAt || '',
                partnerId: s.customerId || s.partnerId,
                type: 'SALE'
              });
            }
          }
        }
      } else {
        for (const p of legacyPurchases) {
          if (p.status === 'VOID' || p.status === 'CANCELLED' || p.isReturn) continue;
          const items = p.items || [];
          for (const it of items) {
            const itProdId = it.product_id || (it as any).productId || (it as any).ProductID;
            if (itProdId === productId && Number(it.price) > 0) {
              matchingRecords.push({
                price: Number(it.price),
                date: p.date || p.Date || p.createdAt || '',
                partnerId: p.supplierId || p.partnerId,
                type: 'PURCHASE'
              });
            }
          }
        }
      }

      // Sort by date desc
      matchingRecords.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());

      // If partnerId given, search partner specific
      if (partnerId) {
        const partnerMatch = matchingRecords.find(r => r.partnerId === partnerId);
        if (partnerMatch) {
          return {
            suggestedPrice: partnerMatch.price,
            basis: 'partner',
            insight: `آخر سعر فعلي مع هذا الشريك: ${partnerMatch.price}`
          };
        }
      }

      // General latest transaction price
      if (matchingRecords.length > 0) {
        const latest = matchingRecords[0];
        if (latest) {
          return {
            suggestedPrice: latest.price,
            basis: 'preferred',
            insight: `آخر سعر ${_type === 'SALE' ? 'بيع' : 'شراء'} مسجل: ${latest.price}`
          };
        }
      }
    } catch (e) {
      console.warn('[priceIntelligenceService] Invoices lookup failed, falling back:', e);
    }

    // 2. Fallback to PriceHistoryRepository
    if (partnerId) {
      const partnerLast = await PriceHistoryRepository.getDetailedLastPrice(productId, partnerId);
      if (partnerLast) {
        return { 
          suggestedPrice: partnerLast.Price, 
          basis: 'partner',
          insight: `آخر سعر تم التعامل به مع ${partnerId}`
        };
      }
    }

    const preferred = await PriceHistoryRepository.getPreferredPartnerPrice(productId);
    if (preferred) {
      return { 
        suggestedPrice: preferred.price, 
        basis: 'preferred',
        insight: `السعر المقترح (${preferred.partner})`
      };
    }

    const avg = await PriceHistoryRepository.getAveragePriceForProduct(productId);
    if (avg) {
      return { 
        suggestedPrice: avg, 
        basis: 'average',
        insight: `متوسط السعر التاريخي في النظام`
      };
    }

    // 3. Fallback to product master price
    try {
      const prod = await db.products.get(productId);
      if (prod) {
        const fallbackPrice = _type === 'SALE' 
          ? (prod.UnitPrice || (prod as any).price || 0) 
          : (prod.LastPurchasePrice || prod.CostPrice || (prod as any).cost_price || 0);
        if (fallbackPrice > 0) {
          return {
            suggestedPrice: fallbackPrice,
            basis: 'average',
            insight: `السعر النظامي الافتراضي: ${fallbackPrice}`
          };
        }
      }
    } catch {
      // ignore
    }

    return { suggestedPrice: null, basis: 'none' };
  }
};
