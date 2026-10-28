
/* eslint-disable @typescript-eslint/no-unused-vars */
import { db } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';

export const PriceHistoryRepository = {
  record: async (productId: string, name: string, partnerId: string, price: number, date: string, tenantId?: string): Promise<void> => {
    const session = TokenProvider.getCurrentSession();
    const effectiveTenantId = tenantId || session.tenantId || session.user?.tenantId || session.user?.tenant_id;
    await db.priceHistory.add({
      id: db.generateId('PH'),
      productId,
      name,
      partnerId,
      Price: price,
      date,
      tenantId: effectiveTenantId,
      tenant_id: effectiveTenantId,
      lastModified: new Date().toISOString()
    });
  },

  getDetailedLastPrice: async (productId: string, partnerId: string): Promise<any | null> => {
    const records = await db.priceHistory
      .where('productId')
      .equals(productId)
      .and(r => r.partnerId === partnerId)
      .reverse()
      .sortBy('date');
    return records.length > 0 ? records[0] : null;
  },

  getPreferredPartnerPrice: async (productId: string): Promise<{ price: number, partner: string } | null> => {
    const records = await db.priceHistory.where('productId').equals(productId).toArray();
    if (records.length === 0) return null;

    // Count by partner
    const counts: Record<string, { count: number, lastPrice: number }> = {};
    records.forEach(r => {
      const existing = counts[r.partnerId];
      if (!existing) {
        counts[r.partnerId] = { count: 1, lastPrice: r.Price };
      } else {
        existing.count++;
        existing.lastPrice = r.Price;
      }
    });

    let bestPartnerId = '';
    let maxCount = 0;
    for (const [pid, data] of Object.entries(counts)) {
      if (data.count > maxCount) {
        maxCount = data.count;
        bestPartnerId = pid;
      }
    }

    if (!bestPartnerId) return null;

    const bestPartnerData = counts[bestPartnerId];
    if (!bestPartnerData) return null;

    return {
      price: bestPartnerData.lastPrice,
      partner: bestPartnerId
    };
  },

  getAveragePriceForProduct: async (productId: string): Promise<number> => {
    // Basic implementation: get average of last few sales
    const sales = await db.sales.toArray();
    const itemPrices = sales
      .flatMap(s => s.items)
      .filter(i => i.product_id === productId)
      .map(i => i.price);
    
    if (itemPrices.length === 0) return 0;
    const sum = itemPrices.reduce((a, b) => a + b, 0);
    return sum / itemPrices.length;
  },

  getRecentInsights: async (productId: string, limit: number = 5, tenantId?: string): Promise<any[]> => {
    if (!productId) return [];
    const session = TokenProvider.getCurrentSession();
    const effectiveTenantId = tenantId || session.tenantId || session.user?.tenantId || session.user?.tenant_id;
    const forbiddenTenants = ['TEN-DEV-001', 'tenant_default', 'default', 'default-tenant'];
    if (!effectiveTenantId || forbiddenTenants.includes(effectiveTenantId)) {
      return [];
    }

    const records = await db.priceHistory
      .where('productId')
      .equals(productId)
      .toArray();

    records.sort((a, b) => new Date(b.date || b.Invoice_Date || 0).getTime() - new Date(a.date || a.Invoice_Date || 0).getTime());

    return records
      .filter((r: any) => {
        const rTenant = r.tenantId || r.tenant_id;
        return rTenant === effectiveTenantId;
      })
      .slice(0, limit);
  }
};
