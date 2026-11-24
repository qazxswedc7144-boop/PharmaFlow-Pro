import { db } from '@/core/db';

export interface CleanupPreviewCandidate {
  id: string;
  reason: string;
}

export interface CleanupPreviewReport {
  generatedAt: string;
  notice: string;
  candidates: {
    sales: CleanupPreviewCandidate[];
    purchases: CleanupPreviewCandidate[];
    vouchers: CleanupPreviewCandidate[];
    journalEntries: CleanupPreviewCandidate[];
    journalLines: CleanupPreviewCandidate[];
    stockMovements: CleanupPreviewCandidate[];
    customers: CleanupPreviewCandidate[];
    suppliers: CleanupPreviewCandidate[];
    products: CleanupPreviewCandidate[];
  };
  excluded: {
    productsLinkedToNonDemoInvoices: CleanupPreviewCandidate[];
  };
  diagnostics: {
    postedDemoSales: number;
    postedDemoPurchases: number;
    orphanJournalEntries: CleanupPreviewCandidate[];
  };
  warnings: string[];
}

const getRecordId = (...values: unknown[]): string => {
  const value = values.find(candidate => typeof candidate === 'string' && candidate.trim());
  return typeof value === 'string' ? value : '(معرف غير متوفر)';
};

export class ProductionCleanupService {
  /**
   * Preserves the legacy demo-identification rules while exposing the exact
   * matching reason for an auditable, read-only preview.
   */
  static getDemoReason(record: any): string | null {
    if (!record || typeof record !== 'object') return null;

    if (record.isDemo === true) return 'الحقل isDemo مضبوط على true';
    if (record.Created_By === 'demo') return 'تم إنشاء السجل بواسطة demo';

    if (
      (typeof record.SaleID === 'string' && record.SaleID.startsWith('TEST-')) ||
      (typeof record.purchase_id === 'string' && record.purchase_id.startsWith('TEST-')) ||
      (typeof record.invoiceId === 'string' && record.invoiceId.startsWith('TEST-'))
    ) {
      return 'معرف المستند يبدأ بالبادئة TEST-';
    }

    const name = record.Customer_Name || record.Supplier_Name || record.partnerName || record.Entity_Name || '';
    if (typeof name === 'string') {
      if (name.includes('عميل تجريبي')) return 'اسم العميل يحتوي على عميل تجريبي';
      if (name.includes('مورد تجريبي')) return 'اسم المورد يحتوي على مورد تجريبي';
    }

    return null;
  }

  static isDemo(record: any): boolean {
    return this.getDemoReason(record) !== null;
  }

  /**
   * Read-only inventory of records matching the legacy demo heuristics.
   * Candidates are NOT an approved deletion plan: this method deliberately
   * performs no writes, reversals, balance changes, or cleanup actions.
   */
  static async previewCleanup(): Promise<CleanupPreviewReport> {
    const [
      sales,
      purchases,
      vouchers,
      journalEntries,
      journalLines,
      stockMovements,
      customers,
      suppliers,
      products
    ] = await Promise.all([
      db.sales.toArray(),
      db.purchases.toArray(),
      db.cashFlow.toArray(),
      db.journalEntries.toArray(),
      db.journalLines.toArray(),
      db.inventoryTransactions.toArray(),
      db.customers.toArray(),
      db.suppliers.toArray(),
      db.products.toArray()
    ]);

    const demoSales = sales.filter(record => this.isDemo(record));
    const demoPurchases = purchases.filter(record => this.isDemo(record));
    const demoVouchers = vouchers.filter(record => this.isDemo(record));
    const demoSaleIds = new Set(demoSales.map(record => record.id).filter(Boolean));
    const demoPurchaseIds = new Set(demoPurchases.map(record => record.id).filter(Boolean));
    const demoVoucherIds = new Set(demoVouchers.map(record => record.transaction_id).filter(Boolean));

    const realSales = sales.filter(record => !this.isDemo(record));
    const realPurchases = purchases.filter(record => !this.isDemo(record));

    const journalCandidates = journalEntries.flatMap(record => {
      const directReason = this.getDemoReason(record);
      if (directReason) {
        return [{ id: getRecordId(record.id), reason: directReason }];
      }
      if (demoSaleIds.has(record.sourceId)) {
        return [{ id: getRecordId(record.id), reason: `مرتبط بفاتورة بيع تجريبية ${record.sourceId}` }];
      }
      if (demoPurchaseIds.has(record.sourceId)) {
        return [{ id: getRecordId(record.id), reason: `مرتبط بفاتورة شراء تجريبية ${record.sourceId}` }];
      }
      if (demoVoucherIds.has(record.sourceId)) {
        return [{ id: getRecordId(record.id), reason: `مرتبط بسند تجريبي ${record.sourceId}` }];
      }
      return [];
    });

    const candidateJournalEntryIds = new Set(journalCandidates.map(candidate => candidate.id));
    const journalLineCandidates = journalLines.flatMap(line => {
      const parentEntryId = line.entryId || line.entry_id;
      if (!parentEntryId || !candidateJournalEntryIds.has(String(parentEntryId))) return [];
      return [{
        id: getRecordId(line.id, line.lineId),
        reason: `سطر تابع للقيد المرشح ${parentEntryId}`
      }];
    });

    const stockCandidates = stockMovements.flatMap(record => {
      const directReason = this.getDemoReason(record);
      if (directReason) {
        return [{ id: getRecordId(record.TransactionID), reason: directReason }];
      }
      if (demoSaleIds.has(record.SourceDocumentID)) {
        return [{ id: getRecordId(record.TransactionID), reason: `مرتبط بفاتورة بيع تجريبية ${record.SourceDocumentID}` }];
      }
      if (demoPurchaseIds.has(record.SourceDocumentID)) {
        return [{ id: getRecordId(record.TransactionID), reason: `مرتبط بفاتورة شراء تجريبية ${record.SourceDocumentID}` }];
      }
      return [];
    });

    const linkedProductIds = new Set<string>();
    for (const product of products) {
      if (!this.isDemo(product) || !product.id) continue;
      const linkedToSale = realSales.some(sale =>
        Array.isArray(sale.items) && sale.items.some((item: any) => item?.product_id === product.id)
      );
      const linkedToPurchase = realPurchases.some(purchase =>
        Array.isArray(purchase.items) && purchase.items.some((item: any) => item?.product_id === product.id)
      );
      if (linkedToSale || linkedToPurchase) linkedProductIds.add(String(product.id));
    }
    const productsLinkedToNonDemoInvoices = products
      .filter(product => linkedProductIds.has(String(product.id)))
      .map(product => ({
        id: getRecordId(product.id),
        reason: 'مرتبط بفاتورة غير تجريبية؛ مستبعد من مرشحات المنتجات'
      }));

    const orphanJournalEntries = journalEntries.flatMap(entry => {
      if (entry.sourceType === 'SALE' && !sales.some(sale => sale.id === entry.sourceId)) {
        return [{ id: getRecordId(entry.id), reason: 'قيد بيع لا يوجد مستند بيع مطابق له' }];
      }
      if (entry.sourceType === 'PURCHASE' && !purchases.some(purchase => purchase.id === entry.sourceId)) {
        return [{ id: getRecordId(entry.id), reason: 'قيد شراء لا يوجد مستند شراء مطابق له' }];
      }
      if (entry.sourceType === 'VOUCHER' && !vouchers.some(voucher => voucher.transaction_id === entry.sourceId)) {
        return [{ id: getRecordId(entry.id), reason: 'قيد سند لا يوجد سند مطابق له' }];
      }
      return [];
    });

    const postedDemoSales = demoSales.filter(record => record.InvoiceStatus === 'POSTED').length;
    const postedDemoPurchases = demoPurchases.filter(record => record.invoiceStatus === 'POSTED').length;
    const warnings = [
      'هذه معاينة للمرشحات وفق قواعد التصنيف الحالية، وليست موافقة على حذفها أو ضماناً بأن حذفها آمن.',
      'المستندات المرحلة تحتاج مراجعة محاسبية مستقلة؛ لم يتم تنفيذ أي عكس للقيود أو الحركات.',
      'القيود اليتيمة معروضة للتشخيص فقط، ولا تُضاف إلى قائمة المرشحات ولا تُحذف تلقائياً.',
      'المنتجات المرتبطة بفواتير غير تجريبية مستبعدة من مرشحات الحذف.'
    ];

    return {
      generatedAt: new Date().toISOString(),
      notice: 'Dry Run فقط — لم يتم تعديل أو حذف أي سجل.',
      candidates: {
        sales: demoSales.map(record => ({ id: getRecordId(record.id, record.SaleID), reason: this.getDemoReason(record) || 'مطابق لقواعد البيانات التجريبية' })),
        purchases: demoPurchases.map(record => ({ id: getRecordId(record.id, record.purchase_id), reason: this.getDemoReason(record) || 'مطابق لقواعد البيانات التجريبية' })),
        vouchers: demoVouchers.map(record => ({ id: getRecordId(record.transaction_id), reason: this.getDemoReason(record) || 'مطابق لقواعد البيانات التجريبية' })),
        journalEntries: journalCandidates,
        journalLines: journalLineCandidates,
        stockMovements: stockCandidates,
        customers: customers.flatMap(record => {
          const reason = this.getDemoReason(record);
          return reason ? [{ id: getRecordId(record.id), reason }] : [];
        }),
        suppliers: suppliers.flatMap(record => {
          const reason = this.getDemoReason(record);
          return reason ? [{ id: getRecordId(record.id), reason }] : [];
        }),
        products: products.flatMap(record => {
          const reason = this.getDemoReason(record);
          if (!reason) return [];
          if (record.id && linkedProductIds.has(String(record.id))) return [];
          return [{ id: getRecordId(record.id), reason }];
        })
      },
      excluded: { productsLinkedToNonDemoInvoices },
      diagnostics: {
        postedDemoSales,
        postedDemoPurchases,
        orphanJournalEntries
      },
      warnings
    };
  }

  /**
   * Legacy destructive entry points are intentionally fail-closed.
   * Re-enabling deletion requires a separately reviewed implementation.
   */
  static async clearDemoData(): Promise<void> {
    console.error('[ProductionCleanupService] clearDemoData is disabled: destructive cleanup is blocked pending review.');
  }

  static async runCleanup(): Promise<{ success: boolean; message: string; deletedCount: number }> {
    return {
      success: false,
      message: 'تم تعطيل الحذف مؤقتاً لحماية البيانات. استخدم معاينة Dry Run لمراجعة السجلات المرشحة.',
      deletedCount: 0
    };
  }
}
