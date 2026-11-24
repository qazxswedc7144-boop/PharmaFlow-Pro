import { db, getCurrentUserSession } from '@/core/db';

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
    postedDemoSales: CleanupPreviewCandidate[];
    postedDemoPurchases: CleanupPreviewCandidate[];
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
      customers,
      suppliers,
      products
    ] = await Promise.all([
      db.sales.toArray(),
      db.purchases.toArray(),
      db.cashFlow.toArray(),
      db.journalEntries.toArray(),
      db.journalLines.toArray(),
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

    // inventoryTransactions is NOT in the Dexie tenant-scoped table allow-list
    // and has no tenantId index. Never perform a full-table read here.
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) {
      throw new Error('FAIL_CLOSED: Dry Run requires an active tenant session.');
    }

    const demoDocumentIds = [...new Set([
      ...demoSales.map(record => record.id),
      ...demoPurchases.map(record => record.id)
    ].filter((id): id is string => typeof id === 'string' && id.length > 0))];
    const demoProductIds = [...new Set([
      ...products.filter(record => this.isDemo(record)).map(record => record.id),
      ...demoSales.flatMap(record => Array.isArray(record.items) ? record.items.map((item: any) => item?.product_id || item?.productId) : []),
      ...demoPurchases.flatMap(record => Array.isArray(record.items) ? record.items.map((item: any) => item?.product_id || item?.productId) : [])
    ].filter((id): id is string => typeof id === 'string' && id.length > 0))];

    const movementReads = await Promise.all([
      demoDocumentIds.length
        ? db.inventoryTransactions.where('source_doc_id').anyOf(demoDocumentIds).toArray()
        : Promise.resolve([]),
      demoProductIds.length
        ? db.inventoryTransactions.where('productId').anyOf(demoProductIds).toArray()
        : Promise.resolve([]),
      demoProductIds.length
        ? db.inventoryTransactions.where('product_id').anyOf(demoProductIds).toArray()
        : Promise.resolve([])
    ]);
    const movementMap = new Map<string, any>();
    movementReads.flat().forEach((movement: any, index: number) => {
      const movementTenantId = movement?.tenantId || movement?.tenant_id;
      if (!movementTenantId || movementTenantId !== tenantId) return;
      const movementId = getRecordId(movement.id, movement.TransactionID, movement.transaction_id, String(index));
      movementMap.set(movementId, movement);
    });
    const stockMovements = [...movementMap.values()];

    const realSales = sales.filter(record => !this.isDemo(record));
    const realPurchases = purchases.filter(record => !this.isDemo(record));

    const journalCandidates = journalEntries.flatMap(record => {
      const sourceId = record.sourceId || record.source_id;
      const directReason = this.getDemoReason(record);
      if (directReason) {
        return [{ id: getRecordId(record.id), reason: directReason }];
      }
      if (demoSaleIds.has(sourceId)) {
        return [{ id: getRecordId(record.id), reason: `مرتبط بفاتورة بيع تجريبية ${sourceId}` }];
      }
      if (demoPurchaseIds.has(sourceId)) {
        return [{ id: getRecordId(record.id), reason: `مرتبط بفاتورة شراء تجريبية ${sourceId}` }];
      }
      if (demoVoucherIds.has(sourceId)) {
        return [{ id: getRecordId(record.id), reason: `مرتبط بسند تجريبي ${sourceId}` }];
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
      const sourceDocumentId = record.SourceDocumentID || record.source_doc_id || record.sourceDocId;
      const directReason = this.getDemoReason(record);
      if (directReason) {
        return [{ id: getRecordId(record.id, record.TransactionID, record.transaction_id), reason: directReason }];
      }
      if (demoSaleIds.has(sourceDocumentId)) {
        return [{ id: getRecordId(record.id, record.TransactionID, record.transaction_id), reason: `مرتبط بفاتورة بيع تجريبية ${sourceDocumentId}` }];
      }
      if (demoPurchaseIds.has(sourceDocumentId)) {
        return [{ id: getRecordId(record.id, record.TransactionID, record.transaction_id), reason: `مرتبط بفاتورة شراء تجريبية ${sourceDocumentId}` }];
      }
      return [];
    });

    const linkedProductIds = new Set<string>();
    for (const product of products) {
      if (!this.isDemo(product) || !product.id) continue;
      const linkedToSale = realSales.some(sale =>
        Array.isArray(sale.items) && sale.items.some((item: any) => item?.product_id === product.id || item?.productId === product.id)
      );
      const linkedToPurchase = realPurchases.some(purchase =>
        Array.isArray(purchase.items) && purchase.items.some((item: any) => item?.product_id === product.id || item?.productId === product.id)
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
      const sourceType = entry.sourceType || entry.source_type;
      const sourceId = entry.sourceId || entry.source_id;
      if (sourceType === 'SALE' && !sales.some(sale => sale.id === sourceId)) {
        return [{ id: getRecordId(entry.id), reason: 'قيد بيع لا يوجد مستند بيع مطابق له' }];
      }
      if (sourceType === 'PURCHASE' && !purchases.some(purchase => purchase.id === sourceId)) {
        return [{ id: getRecordId(entry.id), reason: 'قيد شراء لا يوجد مستند شراء مطابق له' }];
      }
      if (sourceType === 'VOUCHER' && !vouchers.some(voucher => voucher.transaction_id === sourceId)) {
        return [{ id: getRecordId(entry.id), reason: 'قيد سند لا يوجد سند مطابق له' }];
      }
      return [];
    });

    const postedDemoSales = demoSales
      .filter(record => record.InvoiceStatus === 'POSTED')
      .map(record => ({ id: getRecordId(record.id, record.SaleID), reason: 'فاتورة بيع تجريبية مرحّلة؛ تتطلب مراجعة محاسبية' }));
    const postedDemoPurchases = demoPurchases
      .filter(record => record.invoiceStatus === 'POSTED')
      .map(record => ({ id: getRecordId(record.id, record.purchase_id), reason: 'فاتورة شراء تجريبية مرحّلة؛ تتطلب مراجعة محاسبية' }));
    const warnings = [
      'هذه معاينة للمرشحات وفق قواعد التصنيف الحالية، وليست موافقة على حذفها أو ضماناً بأن حذفها آمن.',
      'المستندات المرحلة تحتاج مراجعة محاسبية مستقلة؛ لم يتم تنفيذ أي عكس للقيود أو الحركات.',
      'القيود اليتيمة معروضة للتشخيص فقط، ولا تُضاف إلى قائمة المرشحات ولا تُحذف تلقائياً.',
      'المنتجات المرتبطة بفواتير غير تجريبية مستبعدة من مرشحات الحذف.',
      'جدول حركات المخزون لا يطبق tenant guard على القراءة العامة؛ لذلك عُرضت فقط الحركات المسترجعة بمفاتيح مستندات/أصناف مرشحة ثم طابقت tenantId صراحةً. الحركات غير المرتبطة بهذه المفاتيح غير مشمولة.'
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
