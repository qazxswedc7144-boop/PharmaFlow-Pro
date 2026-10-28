import { db } from '@/core/db';
import { InventoryService } from '@features/inventory/services/InventoryService';
import { Product, PriceHistory, Purchase } from '@/types';
import { authService } from '@features/auth/services/authService';
import { useUIStore } from '@/store/useUIStore';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { PriceHistoryRepository } from '@/database/repositories/PriceHistoryRepository';
import { PurchaseRepository } from '@/database/repositories/PurchaseRepository';

/**
 * Shared helper for Authoritative Tenant Resolution (Security Fix #6)
 */
const getAuthorizedTenant = (callerTenantId?: string): string | null => {
  const session = TokenProvider.getCurrentSession();
  const sessionTenantId = session.tenantId || session.user?.tenantId || session.user?.tenant_id;

  if (sessionTenantId) {
    if (callerTenantId && callerTenantId !== sessionTenantId) return null;
    return sessionTenantId;
  }
  
  // Fail-closed: No session tenant allowed to access anything
  return null;
};

const FORBIDDEN_TENANTS = ['TEN-DEV-001', 'tenant_default', 'default', 'default-tenant'];

export const ProductRepository = {
  getAll: async (options: { limit?: number; offset?: number; branchId?: string; tenantId?: string } = {}): Promise<Product[]> => {
    const { limit = 20, offset = 0, branchId, tenantId } = options;
    const effectiveTenantId = getAuthorizedTenant(tenantId);
    
    if (!effectiveTenantId || FORBIDDEN_TENANTS.includes(effectiveTenantId)) {
      return [];
    }

    // Performance & Security: Query using tenantId index instead of fetching all products
    let query = db.products.where('tenantId').equals(effectiveTenantId);
    
    const all = await query.toArray();
    let filtered = all.filter(p => p.Is_Active !== false && (p as any).is_active !== false && (p as any).isActive !== false);
    
    if (branchId) {
      filtered = filtered.filter(p => p.branchId === branchId || !p.branchId);
    }
    return filtered.slice(offset, offset + limit);
  },

  getById: async (id: string, tenantId?: string): Promise<Product | undefined> => {
    if (!id) return undefined;
    const effectiveTenantId = getAuthorizedTenant(tenantId);
    
    if (!effectiveTenantId || FORBIDDEN_TENANTS.includes(effectiveTenantId)) {
      return undefined;
    }

    // Use compound index [tenantId+id] if available, with fail-closed fallback
    let product = await db.products.where('[tenantId+id]').equals([effectiveTenantId, id]).first().catch(() => undefined);
    if (!product) {
      const candidate = await db.products.get(id).catch(() => undefined);
      if (candidate && ((candidate as any).tenantId === effectiveTenantId || (candidate as any).tenant_id === effectiveTenantId)) {
        product = candidate;
      }
    }
    return product;
  },

  getByBarcode: async (barcode: string, tenantId?: string): Promise<Product | undefined> => {
    if (!barcode) return undefined;
    const effectiveTenantId = getAuthorizedTenant(tenantId);
    
    if (!effectiveTenantId || FORBIDDEN_TENANTS.includes(effectiveTenantId)) {
      return undefined;
    }

    // Use compound index [tenantId+barcode] (Version 27) with fail-closed fallback
    let product = await db.products.where('[tenantId+barcode]').equals([effectiveTenantId, barcode]).first().catch(() => undefined);
    if (!product) {
      const candidates = await db.products.where('barcode').equals(barcode).toArray().catch(() => []);
      product = candidates.find(p => ((p as any).tenantId === effectiveTenantId || (p as any).tenant_id === effectiveTenantId));
    }
    return product;
  },

  search: async (term: string, limit: number = 50, tenantId?: string): Promise<Product[]> => {
    if (!term) return [];
    const effectiveTenantId = getAuthorizedTenant(tenantId);
    
    if (!effectiveTenantId || FORBIDDEN_TENANTS.includes(effectiveTenantId)) {
      return [];
    }

    const lowerTerm = term.toLowerCase();
    
    // Security: Filter by tenantId in the query
    const all = await db.products.where('tenantId').equals(effectiveTenantId).toArray();
    
    return all
      .filter(p => {
        if (p.Is_Active === false || (p as any).is_active === false || (p as any).isActive === false) return false;
        const name = (p.name || p.Name || '').toLowerCase();
        const id = (p.id || '').toLowerCase();
        const barcode = p.barcode || '';
        return name.includes(lowerTerm) || id.includes(lowerTerm) || barcode.includes(term);
      })
      .slice(0, limit);
  },

  updateStock: async (
    productId: string,
    quantityChange: number,
    sourceDocType: "SALE" | "PURCHASE" | "RETURN" | "ADJUSTMENT" | "TRANSFER" = 'ADJUSTMENT',
    sourceDocId: string = 'SYS-ADJ',
    txType: "SALE" | "PURCHASE" | "RETURN" | "ADJUSTMENT" | "TRANSFER" = 'ADJUSTMENT'
  ): Promise<void> => {
    if (!productId) return;
    const user = authService.getCurrentUser();
    await InventoryService.recordMovement({
      type: txType,
      productId: productId,
      warehouseId: 'WH-MAIN',
      quantity: quantityChange,
      sourceId: sourceDocId,
      sourceType: sourceDocType,
      userId: user?.User_Email || 'SYSTEM'
    });
  },

  save: async (product: Product, tenantId?: string): Promise<void> => {
    if (!product) return;
    const effectiveTenantId = getAuthorizedTenant(tenantId || (product as any).tenantId);
    if (!effectiveTenantId || FORBIDDEN_TENANTS.includes(effectiveTenantId)) {
      throw new Error(`[ProductRepository] CANNOT_SAVE: Missing or invalid authoritative tenant context.`);
    }

    if (product.Is_Active === undefined && (product as any).is_active === undefined) {
      product.Is_Active = true;
    }
    
    // Standardize fields before saving
    product.name = product.name || product.Name || '';
    product.price = product.price || product.UnitPrice || 0;
    product.stock = product.stock || product.StockQuantity || 0;
    product.tenantId = effectiveTenantId;
    const now = new Date().toISOString();
    product.updated_at = now;
    product.lastModified = now;

    const existing = await ProductRepository.getById(product.id, effectiveTenantId);
    if (existing) {
      const diff = (product.stock || 0) - (existing.stock || existing.StockQuantity || 0);
      if (Math.abs(diff) > 0.001) {
        await ProductRepository.updateStock(product.id, diff, 'ADJUSTMENT', 'MANUAL-EDIT', 'ADJUSTMENT');
      }
    } else {
      if ((product.stock || 0) > 0) {
        await db.saveProduct(product);
        await ProductRepository.updateStock(product.id, product.stock!, 'ADJUSTMENT', 'INITIAL-SETUP', 'ADJUSTMENT');
        return;
      }
    }

    await db.saveProduct(product);
  },

  delete: async (id: string, tenantId?: string): Promise<void> => {
    if (!id) return;
    const effectiveTenantId = getAuthorizedTenant(tenantId);
    if (!effectiveTenantId || FORBIDDEN_TENANTS.includes(effectiveTenantId)) {
      return;
    }
    const product = await ProductRepository.getById(id, effectiveTenantId);
    if (!product) return;

    // We always use soft delete now for professional sync
    await db.softDeleteProduct(id);
    useUIStore.getState().addToast('تم حذف الصنف بنجاح (حذف آمن)', 'success');
  },

  calculateCurrentBalance: async (productId: string, tenantId?: string): Promise<number> => {
    if (!productId) return 0;
    const effectiveTenantId = getAuthorizedTenant(tenantId);
    
    if (!effectiveTenantId || FORBIDDEN_TENANTS.includes(effectiveTenantId)) {
      return 0;
    }

    // Security: Verify product ownership first
    const product = await ProductRepository.getById(productId, effectiveTenantId);
    if (!product) return 0;

    const txs = await db.inventoryTransactions
      .where('productId')
      .equals(productId)
      .filter((t: any) => (t.tenantId === effectiveTenantId || t.tenant_id === effectiveTenantId))
      .toArray();

    return txs.reduce((sum, tx) => sum + (tx.QuantityChange || (tx as any).quantityChange || (tx as any).delta || 0), 0);
  },

  getPriceHistory: async (productId: string, limit: number = 5, tenantId?: string): Promise<PriceHistory[]> => {
    if (!productId) return [];
    const effectiveTenantId = getAuthorizedTenant(tenantId);

    if (!effectiveTenantId || FORBIDDEN_TENANTS.includes(effectiveTenantId)) {
      return [];
    }

    // Security: ProductId alone must NOT authorize access if the product belongs to another tenant
    const product = await ProductRepository.getById(productId, effectiveTenantId);
    if (!product) return [];

    return await PriceHistoryRepository.getRecentInsights(productId, limit, effectiveTenantId);
  },

  getPurchaseHistory: async (productId: string, limit: number = 5, tenantId?: string): Promise<Purchase[]> => {
    if (!productId) return [];
    const effectiveTenantId = getAuthorizedTenant(tenantId);

    if (!effectiveTenantId || FORBIDDEN_TENANTS.includes(effectiveTenantId)) {
      return [];
    }

    // Security: ProductId alone must NOT authorize access if the product belongs to another tenant
    const product = await ProductRepository.getById(productId, effectiveTenantId);
    if (!product) return [];

    return await PurchaseRepository.getItemPurchaseHistory(productId, limit, effectiveTenantId);
  },

  getItemAutoFillDetails: async (productId: string, tenantId?: string): Promise<{
    lastPrice: number;
    category: string;
    supplierId: string;
    supplierName: string;
  } | null> => {
    if (!productId) return null;
    const effectiveTenantId = getAuthorizedTenant(tenantId);
    
    if (!effectiveTenantId || FORBIDDEN_TENANTS.includes(effectiveTenantId)) {
      return null;
    }

    const product = await ProductRepository.getById(productId, effectiveTenantId);
    if (!product) return null;

    const lastPurchase = await db.purchasesByItem
      .where('productId')
      .equals(productId)
      .filter((p: any) => (p.tenantId === effectiveTenantId || p.tenant_id === effectiveTenantId))
      .reverse()
      .first();

    return {
      lastPrice: lastPurchase?.unitCost ?? (lastPurchase as any)?.costPrice ?? product.price ?? product.UnitPrice ?? 0,
      category: product.categoryName || (product as any).category || 'General',
      supplierId: lastPurchase?.supplierId || product.supplierId || '',
      supplierName: lastPurchase?.supplierName || product.supplierName || ''
    };
  },

  getExpiringSoon: async (days: number = 30, tenantId?: string): Promise<Product[]> => {
    const effectiveTenantId = getAuthorizedTenant(tenantId);
    
    if (!effectiveTenantId || FORBIDDEN_TENANTS.includes(effectiveTenantId)) {
      return [];
    }

    const today = new Date();
    const limitDate = new Date();
    limitDate.setDate(today.getDate() + days);

    const all = await db.products.where('tenantId').equals(effectiveTenantId).toArray();
    return all
      .filter(p => {
        if (p.Is_Active === false || (p as any).is_active === false || (p as any).isActive === false) return false;
        const expiryDateStr = p.ExpiryDate || (p as any).expiryDate;
        if (!expiryDateStr) return false;
        const expiry = new Date(expiryDateStr);
        return expiry > today && expiry <= limitDate;
      })
      .sort((a, b) => {
        const dateA = new Date(a.ExpiryDate || (a as any).expiryDate!).getTime();
        const dateB = new Date(b.ExpiryDate || (b as any).expiryDate!).getTime();
        return dateA - dateB;
      });
  }
};

