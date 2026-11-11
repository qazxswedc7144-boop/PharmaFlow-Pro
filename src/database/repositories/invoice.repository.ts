
import { db, getCurrentUserSession } from '@/core/db';
import { Sale, Purchase } from '@/types';

const normalizeInvoiceType = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toUpperCase() : '';

const matchesInvoiceType = (invoice: any, expected: 'SALE' | 'PURCHASE'): boolean => {
  const declaredTypes = [
    normalizeInvoiceType(invoice?.type),
    normalizeInvoiceType(invoice?.Type),
    normalizeInvoiceType(invoice?.invoiceType),
    normalizeInvoiceType(invoice?.invoice_type)
  ].filter(Boolean);
  return declaredTypes.length > 0 && declaredTypes.every(type => type === expected);
};

const getInvoiceSequence = (value: unknown, type: 'SALE' | 'PURCHASE'): number | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  if (!normalized) return null;

  const match = normalized.match(/[0-9]+$/);
  if (!match?.[0]) return null;

  const prefix = normalized.slice(0, -match[0].length).replace(/[-_/]$/, '').toUpperCase();
  const allowedPrefixes = type === 'SALE' ? ['INV', 'SALE', 'SAL'] : ['PUR', 'PURCHASE'];
  if (prefix && !allowedPrefixes.includes(prefix)) return null;

  const sequence = Number(match[0]);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
};

const invoiceReferenceFields = [
  'invoiceId', 'invoice_id', 'source_doc_id', 'sourceDocId',
  'SourceDocumentID', 'SourceDocumentId', 'referenceId', 'reference_id',
  'sourceId', 'source_id', 'documentId', 'document_id',
  'linkedInvoiceId', 'linked_invoice_id'
] as const;

const hasInvoiceReference = (record: any, invoiceId: string): boolean =>
  invoiceReferenceFields.some(field => (
    record?.[field] !== undefined &&
    record?.[field] !== null &&
    String(record[field]) === invoiceId
  ));

const belongsToCurrentInvoiceScope = (
  record: any,
  scope: ReturnType<typeof getCurrentUserSession>
): boolean => {
  const recordTenantId = record?.tenantId ?? record?.tenant_id;
  const recordBranchId = record?.branchId ?? record?.branch_id;
  if (scope.tenantId && recordTenantId && recordTenantId !== scope.tenantId) return false;
  if (scope.branchId && recordBranchId && recordBranchId !== scope.branchId) return false;
  return true;
};


export const InvoiceRepository = {
  getUnifiedInvoice: async (id: string): Promise<(Sale | Purchase | Record<string, unknown>) | null> => {
    // Try to find in sales then purchases
    const sale = await db.sales.get(id);
    if (sale) return { ...sale, finalTotal: sale.finalTotal || 0, paidAmount: sale.paidAmount || 0 };
    
    const purchase = await db.purchases.get(id);
    if (purchase) return { ...purchase, finalTotal: purchase.totalAmount || 0, paidAmount: purchase.paidAmount || 0 };
    
    return null;
  },

  getSaleById: async (id: string): Promise<Sale | undefined> => {
    const legacySale = await db.sales.get(id);
    if (legacySale) return legacySale as Sale;

    const unifiedInvoice = await db.invoices.get(id);
    if (!unifiedInvoice || !matchesInvoiceType(unifiedInvoice, 'SALE')) return undefined;
    return unifiedInvoice as unknown as Sale;
  },

  getPurchaseById: async (id: string): Promise<Purchase | undefined> => {
    const legacyPurchase = await db.purchases.get(id);
    if (legacyPurchase) return legacyPurchase as Purchase;

    const unifiedInvoice = await db.invoices.get(id);
    if (!unifiedInvoice || !matchesInvoiceType(unifiedInvoice, 'PURCHASE')) return undefined;
    return unifiedInvoice as unknown as Purchase;
  },

  saveSale: async (...args: any[]): Promise<unknown> => {
    const sale = await (db.processSale as any)(...args);
    return sale;
  },

  savePurchase: async (...args: any[]): Promise<unknown> => {
    const purchase = await (db.processPurchase as any)(...args);
    return purchase;
  },

  generateInvoiceNumber: async (type: 'SALE' | 'PURCHASE' = 'SALE'): Promise<string> => {
    const prefix = type === 'SALE' ? 'INV' : 'PUR';
    const records = await db[type === 'SALE' ? 'sales' : 'purchases'].toArray();
    const numberFields = type === 'SALE'
      ? ['SaleID', 'saleId', 'invoice_number', 'invoiceNumber', 'invoiceId']
      : ['invoiceId', 'purchase_id', 'purchaseId', 'invoice_number', 'invoiceNumber'];

    const highestSequence = records.reduce((highest, record: any) => {
      for (const field of numberFields) {
        const sequence = getInvoiceSequence(record?.[field], type);
        if (sequence !== null && sequence > highest) highest = sequence;
      }
      return highest;
    }, 1000);

    return `${prefix}-${highestSequence + 1}`;
  },

  isNumberDuplicate: async (num: string, type: 'SALE' | 'PURCHASE', excludeId?: string | null): Promise<boolean> => {
    const table = type === 'SALE' ? db.sales : db.purchases;
    const field = type === 'SALE' ? 'SaleID' : 'invoiceId';
    
    const matches = await table.where(field).equals(num).toArray();
    if (excludeId) {
      return matches.some(m => m.id !== excludeId);
    }
    return matches.length > 0;
  },

  getArchiveSales: async (): Promise<Sale[]> => {
    return await db.sales.where('InvoiceStatus').equals('POSTED').toArray();
  },

  getArchivePurchases: async (): Promise<Purchase[]> => {
    return await db.purchases.where('invoiceStatus').equals('POSTED').toArray();
  },

  getSavedInvoices: async (): Promise<Sale[]> => {
    return await db.sales.where('InvoiceStatus').equals('DRAFT').toArray();
  },

  getRecentInvoices: async (): Promise<Array<(Sale | Purchase) & { entityType: 'SALE' | 'PURCHASE' }>> => {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    
    const sales = await db.sales
      .where('Date')
      .above(ninetyDaysAgo.toISOString())
      .toArray();
      
    const purchases = await db.purchases
      .where('date')
      .above(ninetyDaysAgo.toISOString())
      .toArray();
      
    return [
      ...sales.map(s => ({ ...s, entityType: 'SALE' as const })),
      ...purchases.map(p => ({ ...p, entityType: 'PURCHASE' as const }))
    ].sort((a, b) => {
      const dateA = new Date(
        (a as Sale).Date || (a as Sale).date || (a as Purchase).date ||
        (a as any).createdAt || (a as any).created_at || 0
      ).getTime();
      const dateB = new Date(
        (b as Sale).Date || (b as Sale).date || (b as Purchase).date ||
        (b as any).createdAt || (b as any).created_at || 0
      ).getTime();
      return dateB - dateA;
    });
  },

  getInvoicesArchive: async (): Promise<Array<(Sale | Purchase) & { entityType: 'SALE' | 'PURCHASE' }>> => {
    const sales = await db.getSales();
    const purchases = await db.getPurchases();
    return [
      ...sales.map(s => ({ ...s, entityType: 'SALE' as const })),
      ...purchases.map(p => ({ ...p, entityType: 'PURCHASE' as const }))
    ];
  },

  checkHasDependencies: async (invoiceId: string, _type: 'SALE' | 'PURCHASE'): Promise<boolean> => {
    if (!invoiceId) return false;

    const scope = getCurrentUserSession();
    if (!scope.tenantId) {
      throw new Error('FAIL_CLOSED: Cannot check invoice dependencies without an active tenant session.');
    }

    const [inventoryTransactions, journalEntries] = await Promise.all([
      db.inventoryTransactions.toArray(),
      db.journalEntries.toArray()
    ]);

    const hasInventoryDependency = inventoryTransactions.some((record: any) =>
      belongsToCurrentInvoiceScope(record, scope) && hasInvoiceReference(record, invoiceId)
    );
    if (hasInventoryDependency) return true;

    return journalEntries.some((record: any) =>
      belongsToCurrentInvoiceScope(record, scope) && hasInvoiceReference(record, invoiceId)
    );
  }
};
