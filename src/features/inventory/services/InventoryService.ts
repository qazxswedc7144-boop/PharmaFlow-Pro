
import { ProductRepository } from './ProductRepository';
import { Product, MedicineBatch, MedicineAlert } from '@/types';
import { db } from '@/core/db';
import { unifiedInventoryMutationEngine } from './UnifiedInventoryMutationEngine';
import { TokenProvider } from '@/services/auth/tokenProvider';

function getTrustedContext() {
  const session = TokenProvider.getCurrentSession();
  const tenantId = session.tenantId || session.user?.tenantId || session.user?.tenant_id;
  const branchId = session.branchId || session.user?.branchId || session.user?.branch_id;

  if (!tenantId || tenantId === 'TEN-DEV-001' || tenantId === 'tenant_default' || tenantId === 'default' || tenantId === 'default-tenant') {
    throw new Error('TRUSTED_TENANT_CONTEXT_REQUIRED: No valid trusted tenant context available in InventoryService.');
  }
  if (!branchId || branchId === 'BR-MAIN' || branchId === 'branch_default') {
    throw new Error('TRUSTED_BRANCH_CONTEXT_REQUIRED: No valid trusted branch context available in InventoryService.');
  }

  return { tenantId, branchId };
}

export class InventoryService {
  /**
   * Retrieves all products from Dexie.
   */
  static async getProducts(): Promise<Product[]> {
    try {
      const products = await db.products.filter(p => !p.deletedAt).toArray();
      return products || [];
    } catch (error) {
      console.error('Error fetching products from Dexie:', error);
      return [];
    }
  }

  /**
   * Saves a product to Dexie.
   */
  static async saveProduct(product: Product): Promise<string> {
    const isNew = !product.id;
    const now = new Date().toISOString();
    const productPayload: any = {
      ...product,
      updated_at: now,
      updatedAt: now,
      lastModified: now
    };

    if (isNew) {
      productPayload.id = `PRD-${Date.now()}`;
      productPayload.Created_At = now;
      productPayload.createdAt = Date.now();
    }

    try {
      await db.products.put(productPayload);
      return productPayload.id;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to save product to Dexie: ${errMsg}`);
    }
  }

  /**
   * Updates the stock quantity of a product safely via UnifiedInventoryMutationEngine.
   */
  static async updateStock(productId: string, quantityChange: number, options?: { warehouseId?: string; userId?: string; notes?: string; transactionUuid?: string }): Promise<Product | undefined> {
    try {
      if (!productId || typeof productId !== 'string') {
        console.warn('InventoryService.updateStock: Missing or invalid productId');
        return undefined;
      }

      if (typeof quantityChange !== 'number' || !Number.isFinite(quantityChange) || !Number.isInteger(quantityChange)) {
        console.warn('InventoryService.updateStock: Invalid or non-integer quantityChange for product', productId);
        return undefined;
      }

      if (quantityChange === 0) {
        return await db.products.get(productId);
      }

      const { tenantId, branchId } = getTrustedContext();
      const warehouseId = options?.warehouseId || 'WH-MAIN';
      const userId = options?.userId || 'system';
      const transactionUuid = options?.transactionUuid || `TX-STK-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      await unifiedInventoryMutationEngine.executeMutation({
        productId,
        warehouseId,
        delta: quantityChange,
        docType: 'ADJUSTMENT',
        docId: `STK-UPD-${Date.now()}`,
        movementType: quantityChange > 0 ? 'ADJUSTMENT' : 'DAMAGE',
        userId,
        tenantId,
        branchId,
        transactionUuid,
        notes: options?.notes || `تعديل مخزون عبر خدمة المخزون: ${quantityChange}`
      });

      return await db.products.get(productId);
    } catch (updateError) {
      console.error('InventoryService.updateStock: Error during mutation engine execution:', updateError);
      throw updateError;
    }
  }

  /**
   * Resets the stock of a specific product to 0 via UnifiedInventoryMutationEngine.
   */
  static async resetStock(productId: string, userId: string = 'system'): Promise<void> {
    if (!productId || typeof productId !== 'string') {
      console.warn("InventoryService.resetStock: Invalid productId");
      return;
    }
    
    try {
      const adjustmentId = `ADJ-RST-${Date.now()}`;
      const transactionUuid = `TX-RST-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      await unifiedInventoryMutationEngine.executeAdjustment({
        adjustmentId,
        productId,
        warehouseId: 'WH-MAIN',
        actualQuantity: 0,
        reason: 'تصفير رصيد المخزون',
        userId,
        tenantId: 'TEN-DEV-001',
        branchId: 'BR-MAIN',
        transactionUuid
      });
      console.log(`InventoryService: Stock reset to 0 for product ${productId}`);
    } catch (error) {
      console.error("InventoryService.resetStock: Failed to reset stock", error);
      throw error;
    }
  }

  /**
   * Batch processes a list of inventory items safely via UnifiedInventoryMutationEngine.
   */
  static async processItems(
    items: Array<{ productId?: string; product_id?: string; quantity?: number; qty?: number; warehouseId?: string; notes?: string }>,
    type: 'SALE' | 'PURCHASE' | 'ADJUSTMENT' | 'TRANSFER' | 'RETURN',
    userId: string
  ): Promise<void> {
    if (!Array.isArray(items)) {
      console.warn("InventoryService.processItems: Input 'items' is not an array. Ignoring.");
      return;
    }

    for (const item of items) {
      const productId = item.productId || item.product_id;
      const quantity = item.quantity !== undefined ? item.quantity : (item.qty !== undefined ? item.qty : 0);

      if (!productId) {
        console.warn("InventoryService.processItems: Skipping item with missing productId", item);
        continue;
      }

      await this.recordMovement({
        type,
        productId,
        warehouseId: item.warehouseId || 'WH-MAIN',
        quantity: Number(quantity),
        userId,
        notes: item.notes || `Batch ${type} processing`
      });
    }
  }

  /**
   * Retrieves all medicine batches from Dexie.
   */
  static async getMedicineBatches(): Promise<MedicineBatch[]> {
    try {
      const batches = await db.medicineBatches.toArray();
      return batches || [];
    } catch (error) {
       console.warn('Error fetching medicine batches from Dexie:', error);
       return [];
    }
  }

  /**
   * Loads comprehensive data for a product.
   */
  static async getProductDetails(productId: string) {
    const priceHist = await ProductRepository.getPriceHistory(productId);
    const purchHist = await ProductRepository.getPurchaseHistory(productId);
    const moves = await db.inventoryTransactions
      .where('productId')
      .equals(productId)
      .reverse()
      .limit(20)
      .toArray();

    const stocks = await db.warehouseStock
      .where('productId')
      .equals(productId)
      .toArray();
      
    return {
      priceHist,
      purchHist,
      moves,
      stocks
    };
  }

  /**
   * Filters products based on search, category, and status.
   */
  static filterProducts(
    products: Product[],
    filters: { search: string, categoryId: string, filterBy: 'all' | 'low' | 'out' | 'expired', sortAsc: boolean }
  ): Product[] {
    let result = [...products];

    if (filters.categoryId !== 'ALL') {
      result = result.filter(p => p.categoryId === filters.categoryId);
    }

    if (filters.search.trim()) {
      const lower = filters.search.toLowerCase();
      result = result.filter(p => (p.name || p.Name || '').toLowerCase().includes(lower) || p.id.toLowerCase().includes(lower));
    }

    if (filters.filterBy === 'low') {
      result = result.filter(p => (p.stock || p.StockQuantity || 0) > 0 && (p.stock || p.StockQuantity || 0) <= (p.MinLevel || 5));
    } else if (filters.filterBy === 'out') {
      result = result.filter(p => (p.stock || p.StockQuantity || 0) <= 0);
    } else if (filters.filterBy === 'expired') {
      const today: string = new Date().toISOString().substring(0, 10);
      result = result.filter(p => p.ExpiryDate && p.ExpiryDate < today);
    }

    return result.sort((a, b) => {
      const nameA = (a.name || a.Name || '').toLowerCase();
      const nameB = (b.name || b.Name || '').toLowerCase();
      return filters.sortAsc ? nameA.localeCompare(nameB, 'ar') : nameB.localeCompare(nameA, 'ar');
    });
  }

  /**
   * Retrieves all medicine alerts.
   */
  static async getMedicineAlerts(): Promise<MedicineAlert[]> {
    return await db.getMedicineAlerts();
  }

  /**
   * Records a stock movement safely via UnifiedInventoryMutationEngine.
   */
  static async recordMovement(movement: {
    type: 'SALE' | 'PURCHASE' | 'ADJUSTMENT' | 'TRANSFER' | 'RETURN',
    productId: string,
    warehouseId: string,
    quantity: number,
    sourceId?: string,
    sourceType?: string,
    sourceDocId?: string,
    sourceDocType?: string,
    userId: string,
    notes?: string,
    batchNumber?: string,
    expiryDate?: string
  }): Promise<void> {
    try {
      if (!movement || typeof movement !== 'object') {
        console.warn("InventoryService.recordMovement: Invalid movement object");
        return;
      }

      if (!movement.productId) {
        console.warn("InventoryService.recordMovement: productId is required");
        return;
      }

      if (typeof movement.quantity !== 'number' || !Number.isFinite(movement.quantity) || !Number.isInteger(movement.quantity)) {
        console.warn(`InventoryService.recordMovement: Invalid or non-integer quantity (${movement.quantity}) for product ${movement.productId}`);
        return;
      }

      if (movement.quantity === 0) return;

      const docId = movement.sourceDocId || movement.sourceId || `MOV-${Date.now()}`;
      const docType: 'SALE' | 'PURCHASE' | 'TRANSFER' | 'ADJUSTMENT' | 'RETURN' | 'CORRECTION' = 
        movement.type === 'SALE' ? 'SALE' :
        movement.type === 'PURCHASE' ? 'PURCHASE' :
        movement.type === 'TRANSFER' ? 'TRANSFER' :
        movement.type === 'RETURN' ? 'RETURN' : 'ADJUSTMENT';

      const movementType: 'SALE' | 'PURCHASE' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'ADJUSTMENT' | 'CORRECTION' | 'DAMAGE' | 'REVERSAL' =
        movement.type === 'SALE' ? 'SALE' :
        movement.type === 'PURCHASE' ? 'PURCHASE' :
        movement.type === 'TRANSFER' ? (movement.quantity < 0 ? 'TRANSFER_OUT' : 'TRANSFER_IN') :
        movement.type === 'RETURN' ? 'REVERSAL' :
        (movement.quantity >= 0 ? 'ADJUSTMENT' : 'DAMAGE');

      const transactionUuid = movement.sourceDocId 
        ? `TX-${movement.sourceDocId}-${movement.productId}` 
        : `TX-MOV-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      await unifiedInventoryMutationEngine.executeMutation({
        productId: movement.productId,
        warehouseId: movement.warehouseId || 'WH-MAIN',
        delta: movement.quantity,
        docType,
        docId,
        movementType,
        batchNumber: movement.batchNumber,
        expiryDate: movement.expiryDate,
        userId: movement.userId || 'system',
        tenantId: 'TEN-DEV-001',
        branchId: 'BR-MAIN',
        transactionUuid,
        notes: movement.notes
      });
    } catch (error) {
      console.error("InventoryService.recordMovement: Error executing unified mutation:", error);
      throw error;
    }
  }

  /**
   * Gets the stock level for a specific warehouse and product.
   */
  static async getWarehouseStock(warehouseId: string, productId: string): Promise<number> {
    if (!warehouseId || !productId || typeof warehouseId !== 'string' || typeof productId !== 'string') {
      return 0;
    }
    
    try {
      const stock = await db.warehouseStock
        .where('[warehouseId+productId]')
        .equals([warehouseId, productId])
        .first();
      return stock ? stock.quantity : 0;
    } catch (error) {
      console.error('Error fetching warehouse stock:', error);
      return 0;
    }
  }

  /**
   * Validates if there is enough stock available.
   */
  static async validateStockAvailability(warehouseId: string, productId: string, requestedQty: number): Promise<boolean> {
    const available = await this.getWarehouseStock(warehouseId, productId);
    return available >= requestedQty;
  }

  /**
   * Adjusts stock quantity for a product safely via UnifiedInventoryMutationEngine.
   */
  static async adjustStock(params: { productId: string; warehouseId?: string; newQty: number; reason?: string; userId?: string; transactionUuid?: string }): Promise<void> {
    const prod = await db.products.get(params.productId);
    if (!prod) throw new Error(`Product ${params.productId} not found`);

    const adjustmentId = `ADJ-${Date.now()}`;
    const transactionUuid = params.transactionUuid || `TX-ADJ-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    await unifiedInventoryMutationEngine.executeAdjustment({
      adjustmentId,
      productId: params.productId,
      warehouseId: params.warehouseId || 'WH-MAIN',
      actualQuantity: params.newQty,
      reason: params.reason || 'تسوية مخزنية',
      userId: params.userId || 'system',
      tenantId: 'TEN-DEV-001',
      branchId: 'BR-MAIN',
      transactionUuid
    });
  }
}
