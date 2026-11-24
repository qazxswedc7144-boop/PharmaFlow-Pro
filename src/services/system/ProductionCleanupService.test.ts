import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sales: vi.fn(),
  purchases: vi.fn(),
  cashFlow: vi.fn(),
  journalEntries: vi.fn(),
  journalLines: vi.fn(),
  inventoryTransactions: vi.fn(),
  inventoryWhere: vi.fn(),
  getCurrentUserSession: vi.fn((): { tenantId?: string } => ({ tenantId: 'tenant-a' })),
  customers: vi.fn(),
  suppliers: vi.fn(),
  products: vi.fn(),
  writes: {
    bulkDelete: vi.fn(),
    clear: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    put: vi.fn(),
    add: vi.fn()
  },
  posting: {
    setMaintenanceMode: vi.fn(),
    unpostSale: vi.fn(),
    unpostPurchase: vi.fn(),
    unpostVoucher: vi.fn()
  }
}));

vi.mock('@/core/db', () => ({
  getCurrentUserSession: mocks.getCurrentUserSession,
  db: {
    sales: { toArray: mocks.sales, ...mocks.writes },
    purchases: { toArray: mocks.purchases, ...mocks.writes },
    cashFlow: { toArray: mocks.cashFlow, ...mocks.writes },
    journalEntries: { toArray: mocks.journalEntries, ...mocks.writes },
    journalLines: { toArray: mocks.journalLines, ...mocks.writes },
    inventoryTransactions: { where: mocks.inventoryWhere },
    customers: { toArray: mocks.customers, ...mocks.writes },
    suppliers: { toArray: mocks.suppliers, ...mocks.writes },
    products: { toArray: mocks.products, ...mocks.writes }
  }
}));

vi.mock('@features/accounting/services/PostingEngine', () => ({
  PostingEngine: mocks.posting
}));

import { ProductionCleanupService } from './ProductionCleanupService';

const setRows = (rows: {
  sales?: any[];
  purchases?: any[];
  cashFlow?: any[];
  journalEntries?: any[];
  journalLines?: any[];
  inventoryTransactions?: any[];
  customers?: any[];
  suppliers?: any[];
  products?: any[];
}) => {
  mocks.sales.mockResolvedValue(rows.sales || []);
  mocks.purchases.mockResolvedValue(rows.purchases || []);
  mocks.cashFlow.mockResolvedValue(rows.cashFlow || []);
  mocks.journalEntries.mockResolvedValue(rows.journalEntries || []);
  mocks.journalLines.mockResolvedValue(rows.journalLines || []);
  mocks.inventoryTransactions.mockResolvedValue(rows.inventoryTransactions || []);
  mocks.customers.mockResolvedValue(rows.customers || []);
  mocks.suppliers.mockResolvedValue(rows.suppliers || []);
  mocks.products.mockResolvedValue(rows.products || []);
};

describe('ProductionCleanupService safety boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRows({});
    mocks.getCurrentUserSession.mockReturnValue({ tenantId: 'tenant-a' });
    mocks.inventoryWhere.mockImplementation(() => ({
      anyOf: vi.fn(() => ({ toArray: mocks.inventoryTransactions }))
    }));
  });

  it('returns a read-only preview with reasons and linked-record candidates', async () => {
    setRows({
      sales: [
        { id: 'sale-demo', isDemo: true, InvoiceStatus: 'POSTED' },
        { id: 'sale-real', items: [{ product_id: 'product-linked' }] }
      ],
      purchases: [{ id: 'purchase-demo', Created_By: 'demo' }],
      cashFlow: [{ transaction_id: 'voucher-demo', isDemo: true }],
      journalEntries: [
        { id: 'journal-linked', sourceType: 'SALE', sourceId: 'sale-demo' },
        { id: 'journal-marked', isDemo: true },
        { id: 'journal-real', sourceType: 'SALE', sourceId: 'sale-real' },
        { id: 'journal-orphan', sourceType: 'SALE', sourceId: 'missing-sale' }
      ],
      journalLines: [
        { id: 'line-linked-1', entryId: 'journal-linked' },
        { id: 'line-real', entryId: 'journal-real' }
      ],
      inventoryTransactions: [
        { id: 'movement-linked', source_doc_id: 'sale-demo', tenantId: 'tenant-a' },
        { TransactionID: 'movement-marked', productId: 'product-demo', isDemo: true, tenantId: 'tenant-a' },
        { TransactionID: 'movement-foreign', SourceDocumentID: 'sale-demo', source_doc_id: 'sale-demo', tenantId: 'tenant-b' }
      ],
      customers: [{ id: 'customer-demo', Customer_Name: 'عميل تجريبي 1' }],
      suppliers: [{ id: 'supplier-demo', Supplier_Name: 'مورد تجريبي 1' }],
      products: [
        { id: 'product-demo', isDemo: true },
        { id: 'product-linked', isDemo: true }
      ]
    });

    const report = await ProductionCleanupService.previewCleanup();

    expect(report.candidates.sales).toHaveLength(1);
    expect(report.candidates.sales[0].reason).toContain('isDemo');
    expect(report.candidates.purchases.map(item => item.id)).toEqual(['purchase-demo']);
    expect(report.candidates.vouchers.map(item => item.id)).toEqual(['voucher-demo']);
    expect(report.candidates.journalEntries.map(item => item.id)).toEqual(['journal-linked', 'journal-marked']);
    expect(report.candidates.journalLines.map(item => item.id)).toEqual(['line-linked-1']);
    expect(report.candidates.stockMovements.map(item => item.id)).toEqual(['movement-linked', 'movement-marked']);
    expect(mocks.inventoryWhere).toHaveBeenCalledWith('source_doc_id');
    expect(mocks.inventoryWhere).toHaveBeenCalledWith('productId');
    expect(mocks.inventoryWhere).toHaveBeenCalledWith('product_id');
    expect(report.warnings.some(warning => warning.includes('tenant guard'))).toBe(true);
    expect(report.candidates.customers.map(item => item.id)).toEqual(['customer-demo']);
    expect(report.candidates.suppliers.map(item => item.id)).toEqual(['supplier-demo']);
    expect(report.candidates.products.map(item => item.id)).toEqual(['product-demo']);
    expect(report.excluded.productsLinkedToNonDemoInvoices.map(item => item.id)).toEqual(['product-linked']);
    expect(report.diagnostics.postedDemoSales).toBe(1);
    expect(report.diagnostics.orphanJournalEntries.map(item => item.id)).toContain('journal-orphan');
    expect(report.notice).toContain('لم يتم تعديل أو حذف');

    for (const method of Object.values(mocks.writes)) {
      expect(method).not.toHaveBeenCalled();
    }
    for (const method of Object.values(mocks.posting)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it('fails closed when no trusted tenant session is available', async () => {
    mocks.getCurrentUserSession.mockReturnValue({ tenantId: undefined });

    await expect(ProductionCleanupService.previewCleanup()).rejects.toThrow('FAIL_CLOSED');
    expect(mocks.inventoryWhere).not.toHaveBeenCalled();
  });

  it('fails closed when the legacy cleanup entry point is invoked', async () => {
    const result = await ProductionCleanupService.runCleanup();

    expect(result.success).toBe(false);
    expect(result.deletedCount).toBe(0);
    expect(result.message).toContain('تعطيل الحذف');
    for (const method of Object.values(mocks.writes)) {
      expect(method).not.toHaveBeenCalled();
    }
    for (const method of Object.values(mocks.posting)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it('does not mutate records through the legacy clearDemoData entry point', async () => {
    await ProductionCleanupService.clearDemoData();

    for (const method of Object.values(mocks.writes)) {
      expect(method).not.toHaveBeenCalled();
    }
  });
});
