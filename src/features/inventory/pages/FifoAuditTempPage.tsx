import { useCallback, useRef, useState } from 'react';
import { db, getCurrentUserSession } from '@/core/db';

type AnyRecord = Record<string, any>;
type AuditSummary = {
  generatedAt: string;
  scope: string;
  database: { name: string; version: number; readOnly: true };
  counts: Record<string, number>;
  ratesPercent: Record<string, number>;
  dataQuality: Record<string, number | Record<string, number>>;
  statusCounts: Record<string, number>;
  notes: string[];
};

const pick = (record: AnyRecord, keys: string[]): any => {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

const asText = (value: any): string =>
  value === undefined || value === null ? '' : String(value).trim();

const asNumber = (value: any): number => {
  if (value === undefined || value === null || value === '') return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const tenantOf = (record: AnyRecord): string =>
  asText(pick(record, ['tenantId', 'tenant_id']));

const invoiceIdOf = (record: AnyRecord): string =>
  asText(pick(record, ['id', 'invoiceId', 'invoice_id', 'SaleID', 'saleId']));

const invoiceAliasesOf = (record: AnyRecord, id: string): string[] =>
  [...new Set([
    id,
    asText(pick(record, ['invoiceNumber', 'invoice_number'])),
    asText(pick(record, ['SaleID', 'saleId'])),
    asText(pick(record, ['invoiceId', 'invoice_id']))
  ].filter(Boolean))];

const productOf = (record: AnyRecord): string =>
  asText(pick(record, ['product_id', 'productId', 'item_id', 'itemId']));

const itemQuantityOf = (record: AnyRecord): number =>
  asNumber(pick(record, ['qty', 'quantity', 'Quantity']));

const logQuantityOf = (record: AnyRecord): number =>
  asNumber(pick(record, ['quantity_consumed', 'quantityConsumed', 'qty', 'quantity']));

const statusOf = (record: AnyRecord): string =>
  asText(pick(record, [
    'document_status',
    'documentStatus',
    'InvoiceStatus',
    'invoiceStatus',
    'status'
  ])).toUpperCase();

const typeOf = (record: AnyRecord): string =>
  asText(pick(record, ['type', 'invoiceType', 'invoice_type'])).toUpperCase();

const isReturnRecord = (record: AnyRecord): boolean => {
  const returnFlag = record?.isReturn === true || record?.is_return === true;
  const type = typeOf(record);
  return returnFlag || type.includes('RETURN') || type.includes('مرتجع');
};

const logReferencesOf = (record: AnyRecord): string[] =>
  [...new Set([
    asText(record?.sale_id),
    asText(record?.saleId),
    asText(record?.invoice_id),
    asText(record?.invoiceId)
  ].filter(Boolean))];

const percent = (value: number, total: number): number =>
  total > 0 ? Number(((value / total) * 100).toFixed(2)) : 0;

async function buildFifoAudit(): Promise<AuditSummary> {
  const session = getCurrentUserSession();
  const activeTenantId = asText(session.tenantId);

  if (!activeTenantId) {
    throw new Error('توقف آمن: لا توجد جلسة مستأجر نشطة. سجّل الدخول بحساب مخوّل ثم أعد المحاولة.');
  }

  // Do not open or upgrade the database from this temporary audit page.
  const database = db as any;
  if (!database.isOpen()) {
    throw new Error('توقف آمن: قاعدة Dexie ليست مفتوحة حالياً. أعد تحميل التطبيق بعد اكتمال تسجيل الدخول ثم أعد المحاولة.');
  }

  const requiredStores = [
    'invoices',
    'sales',
    'invoiceItems',
    'inventory_layers',
    'fifo_consumption_log'
  ];
  const availableStores = (database.tables || []).map((table: any) => table.name);
  const missingStores = requiredStores.filter(name => !availableStores.includes(name));

  if (missingStores.length > 0) {
    throw new Error(`توقف آمن: جداول Dexie المطلوبة غير موجودة: ${missingStores.join(', ')}. لم تُجرَ أي كتابة.`);
  }

  // One Dexie read-only transaction gives a consistent local snapshot.
  // No add/put/update/delete/bulkWrite/clear operation is called anywhere here.
  const snapshot = await database.transaction(
    'r',
    ...requiredStores,
    async (transaction: any) => {
      const [invoices, sales] = await Promise.all([
        transaction.table('invoices').toArray(),
        transaction.table('sales').toArray()
      ]);

      // Build only the current tenant's sale-invoice reference set before
      // touching stores that do not have tenant indexes.
      const activeInvoiceReferences = new Set<string>();
      for (const [row, source] of [
        ...invoices.map((value: AnyRecord) => [value, 'invoices'] as const),
        ...sales.map((value: AnyRecord) => [value, 'sales'] as const)
      ]) {
        if (isReturnRecord(row)) continue;
        const type = typeOf(row);
        if (type && type !== 'SALE') continue;
        if (!type && source === 'invoices') continue;
        const invoiceId = invoiceIdOf(row);
        if (!invoiceId) continue;
        invoiceAliasesOf(row, invoiceId).forEach(alias => activeInvoiceReferences.add(alias));
      }

      const invoiceItems = await transaction.table('invoiceItems')
        .filter((item: AnyRecord) => [
          asText(item?.parent_id),
          asText(item?.parentId),
          asText(item?.invoice_id),
          asText(item?.invoiceId)
        ].some(reference => reference && activeInvoiceReferences.has(reference)))
        .toArray();

      const allLogs = await transaction.table('fifo_consumption_log')
        .filter((log: AnyRecord) => {
          const logTenant = tenantOf(log);
          if (logTenant) return logTenant === activeTenantId;
          return logReferencesOf(log).some(reference => activeInvoiceReferences.has(reference));
        })
        .toArray();

      const referencedLayerIds = new Set<string>(
        allLogs.map((log: AnyRecord) => asText(pick(log, ['layer_id', 'layerId']))).filter(Boolean)
      );

      const allLayers = await transaction.table('inventory_layers')
        .filter((layer: AnyRecord) => {
          const layerTenant = tenantOf(layer);
          if (layerTenant) return layerTenant === activeTenantId;
          return referencedLayerIds.has(asText(layer?.id));
        })
        .toArray();

      return { invoices, sales, invoiceItems, allLayers, allLogs };
    }
  );

  // invoices/sales are read through the app's tenant-guarded Dexie tables.
  // FIFO stores have no tenantId index in the current schema, so filter them
  // explicitly and only retain tenantless rows when a strong invoice/layer
  // relationship ties them to this tenant's invoice evidence.
  const invoiceMap = new Map<string, {
    id: string;
    row: AnyRecord;
    source: 'invoices' | 'sales';
    aliases: string[];
  }>();
  const duplicateInvoiceTenantConflicts = new Set<string>();
  let excludedNonSales = 0;
  let excludedReturns = 0;
  let excludedUnknownType = 0;

  const addInvoice = (row: AnyRecord, source: 'invoices' | 'sales') => {
    if (isReturnRecord(row)) {
      excludedReturns += 1;
      return;
    }

    const type = typeOf(row);
    if (type && type !== 'SALE') {
      excludedNonSales += 1;
      return;
    }
    if (!type && source === 'invoices') {
      excludedUnknownType += 1;
      return;
    }

    const id = invoiceIdOf(row);
    if (!id) {
      excludedUnknownType += 1;
      return;
    }

    const rowTenant = tenantOf(row);
    if (rowTenant && rowTenant !== activeTenantId) return;

    const aliases = invoiceAliasesOf(row, id);
    const existing = invoiceMap.get(id);

    if (!existing) {
      invoiceMap.set(id, { id, row, source, aliases });
      return;
    }

    const existingTenant = tenantOf(existing.row);
    if (
      existingTenant &&
      rowTenant &&
      existingTenant !== rowTenant
    ) {
      duplicateInvoiceTenantConflicts.add(id);
    }

    if (source === 'invoices' && existing.source !== 'invoices') {
      invoiceMap.set(id, {
        id,
        row,
        source,
        aliases: [...new Set([...existing.aliases, ...aliases])]
      });
    } else {
      existing.aliases = [...new Set([...existing.aliases, ...aliases])];
    }
  };

  snapshot.invoices.forEach((row: AnyRecord) => addInvoice(row, 'invoices'));
  snapshot.sales.forEach((row: AnyRecord) => addInvoice(row, 'sales'));

  const invoices = [...invoiceMap.values()];
  const aliasesToInvoices = new Map<string, Set<string>>();

  for (const invoice of invoices) {
    for (const alias of invoice.aliases) {
      if (!aliasesToInvoices.has(alias)) aliasesToInvoices.set(alias, new Set());
      aliasesToInvoices.get(alias)!.add(invoice.id);
    }
  }

  const invoiceItemsByInvoice = new Map<string, AnyRecord[]>();
  for (const item of snapshot.invoiceItems as AnyRecord[]) {
    const parentReferences = [
      asText(item?.parent_id),
      asText(item?.parentId),
      asText(item?.invoice_id),
      asText(item?.invoiceId)
    ].filter(Boolean);

    const matchedIds = new Set<string>();
    for (const reference of parentReferences) {
      const matches = aliasesToInvoices.get(reference);
      if (matches) matches.forEach(id => matchedIds.add(id));
    }

    if (matchedIds.size !== 1) continue;
    const invoiceId = [...matchedIds][0];
    if (!invoiceItemsByInvoice.has(invoiceId)) invoiceItemsByInvoice.set(invoiceId, []);
    invoiceItemsByInvoice.get(invoiceId)!.push(item);
  }

  const tenantLayers = (snapshot.allLayers as AnyRecord[]).filter(layer =>
    tenantOf(layer) === activeTenantId
  );

  const layerCandidates = new Map<string, AnyRecord[]>();
  for (const layer of snapshot.allLayers as AnyRecord[]) {
    const layerTenant = tenantOf(layer);
    if (layerTenant && layerTenant !== activeTenantId) continue;
    const id = asText(layer?.id);
    if (!id) continue;
    if (!layerCandidates.has(id)) layerCandidates.set(id, []);
    layerCandidates.get(id)!.push(layer);
  }

  const logsByInvoice = new Map<string, AnyRecord[]>();
  const orphanOrAmbiguousLogs = new Set<string>();
  const tenantlessLinkedLogs = new Set<string>();
  const logsWithReferenceMismatch = new WeakSet<AnyRecord>();

  (snapshot.allLogs as AnyRecord[]).forEach((log, index) => {
    const logTenant = tenantOf(log);
    if (logTenant && logTenant !== activeTenantId) return;

    const references = logReferencesOf(log);
    const matchedInvoiceIds = new Set<string>();

    for (const reference of references) {
      const matches = aliasesToInvoices.get(reference);
      if (matches) matches.forEach(id => matchedInvoiceIds.add(id));
    }

    if (references.some(reference => !aliasesToInvoices.has(reference))) {
      logsWithReferenceMismatch.add(log);
    }

    if (matchedInvoiceIds.size !== 1) {
      if (logTenant === activeTenantId) {
        orphanOrAmbiguousLogs.add(asText(log?.id) || `row-${index}`);
      }
      return;
    }

    const invoiceId = [...matchedInvoiceIds][0];
    if (!logTenant) {
      tenantlessLinkedLogs.add(asText(log?.id) || `row-${index}`);
    }

    if (!logsByInvoice.has(invoiceId)) logsByInvoice.set(invoiceId, []);
    logsByInvoice.get(invoiceId)!.push(log);
  });

  const linkedTenantlessLayerIds = new Set<string>();
  const duplicateLayerIds = new Set<string>();
  for (const [layerId, candidates] of layerCandidates) {
    if (candidates.length > 1 && candidates.some(layer => tenantOf(layer) === activeTenantId)) {
      duplicateLayerIds.add(layerId);
    }
  }

  const duplicateLogIds = new Set<string>();
  const seenLogIds = new Set<string>();
  (snapshot.allLogs as AnyRecord[]).forEach(log => {
    const id = asText(log?.id);
    if (!id) return;
    if (seenLogIds.has(id)) duplicateLogIds.add(id);
    seenLogIds.add(id);
  });

  const categoryA: string[] = [];
  const categoryB: string[] = [];
  const categoryC: string[] = [];
  const reasonCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  const addReason = (reason: string) => {
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  };

  let excludedNonPosted = 0;
  let excludedUnknownStatus = 0;
  let invalidLogQuantities = 0;
  let invalidLogCosts = 0;
  let missingLayerReferences = 0;
  let layerCostMismatches = 0;
  let layerInvalidQuantities = 0;

  for (const invoice of invoices) {
    const status = statusOf(invoice.row) || '(missing)';
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    if (status === 'CANCELLED' || status === 'VOID' || status === 'DRAFT' ||
        status === 'DRAFT_EDIT' || status === 'PENDING') {
      excludedNonPosted += 1;
      continue;
    }

    if (status !== 'POSTED' && status !== 'LOCKED') {
      excludedUnknownStatus += 1;
      continue;
    }

    const invoiceLogs = logsByInvoice.get(invoice.id) || [];
    if (invoiceLogs.length === 0) {
      categoryC.push(invoice.id);
      continue;
    }

    const reasons = new Set<string>();
    if (duplicateInvoiceTenantConflicts.has(invoice.id)) {
      reasons.add('duplicate_invoice_tenant_conflict');
    }
    if (!tenantOf(invoice.row)) reasons.add('invoice_tenant_missing');

    const embeddedItems = Array.isArray(invoice.row?.items) ? invoice.row.items : [];
    const lineItems = embeddedItems.length
      ? embeddedItems
      : (invoiceItemsByInvoice.get(invoice.id) || []);

    if (lineItems.length === 0) reasons.add('invoice_items_missing');

    const expected = new Map<string, number>();
    for (const item of lineItems) {
      const productId = productOf(item);
      const quantity = itemQuantityOf(item);
      if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
        reasons.add('invalid_invoice_line');
        continue;
      }
      expected.set(productId, (expected.get(productId) || 0) + quantity);
    }

    if (lineItems.length > 0 && expected.size === 0) {
      reasons.add('invoice_lines_unreadable');
    }

    const actual = new Map<string, number>();

    for (const log of invoiceLogs) {
      if (logsWithReferenceMismatch.has(log)) {
        reasons.add('log_invoice_reference_mismatch');
      }
      const logTenant = tenantOf(log);
      if (!logTenant) reasons.add('log_tenant_missing');
      else if (logTenant !== activeTenantId) reasons.add('log_tenant_mismatch');

      const productId = productOf(log);
      const quantity = logQuantityOf(log);
      const layerId = asText(pick(log, ['layer_id', 'layerId']));

      if (!Number.isFinite(quantity) || quantity <= 0) {
        invalidLogQuantities += 1;
        reasons.add('invalid_log_quantity');
      }
      if (!productId) {
        reasons.add('log_product_missing');
      } else if (Number.isFinite(quantity) && quantity > 0) {
        actual.set(productId, (actual.get(productId) || 0) + quantity);
      }

      if (!layerId) {
        missingLayerReferences += 1;
        reasons.add('missing_layer_reference');
        continue;
      }

      const candidates = layerCandidates.get(layerId) || [];
      if (candidates.length !== 1) {
        missingLayerReferences += 1;
        reasons.add(candidates.length > 1 ? 'duplicate_layer_id' : 'missing_layer_reference');
        continue;
      }

      const layer = candidates[0];
      const layerTenant = tenantOf(layer);
      if (!layerTenant) {
        reasons.add('layer_tenant_missing');
        linkedTenantlessLayerIds.add(layerId);
      } else if (layerTenant !== activeTenantId) {
        reasons.add('layer_tenant_mismatch');
      }

      const layerProduct = productOf(layer);
      if (!layerProduct) reasons.add('layer_product_missing');
      else if (productId && productId !== layerProduct) {
        reasons.add('log_layer_product_mismatch');
      }

      const logCost = asNumber(pick(log, ['unit_cost', 'unitCost']));
      const layerCost = asNumber(pick(layer, ['unit_cost', 'unitCost']));
      if (!Number.isFinite(logCost) || logCost < 0) {
        invalidLogCosts += 1;
        reasons.add('invalid_log_unit_cost');
      }
      if (!Number.isFinite(layerCost) || layerCost < 0) {
        reasons.add('invalid_layer_unit_cost');
      } else if (
        Number.isFinite(logCost) &&
        Math.abs(logCost - layerCost) > 0.000001
      ) {
        layerCostMismatches += 1;
        reasons.add('log_layer_cost_mismatch');
      }

      const initial = asNumber(pick(layer, ['quantity_initial', 'quantityInitial']));
      const remaining = asNumber(pick(layer, [
        'quantity_remaining',
        'quantityRemaining',
        'remaining_qty',
        'remainingQty'
      ]));
      if (
        !Number.isFinite(initial) ||
        initial <= 0 ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining - initial > 0.000001
      ) {
        layerInvalidQuantities += 1;
        reasons.add('invalid_layer_quantities');
      }
    }

    if (expected.size > 0) {
      for (const [productId, expectedQuantity] of expected) {
        const actualQuantity = actual.get(productId) || 0;
        if (Math.abs(actualQuantity - expectedQuantity) > 0.000001) {
          reasons.add('invoice_log_quantity_mismatch');
        }
      }
      for (const productId of actual.keys()) {
        if (!expected.has(productId)) reasons.add('unexpected_log_product');
      }
    }

    if (reasons.size === 0) categoryA.push(invoice.id);
    else {
      categoryB.push(invoice.id);
      reasons.forEach(addReason);
    }
  }

  const postedInvoices = categoryA.length + categoryB.length + categoryC.length;
  const incompleteEvidence = categoryB.length + categoryC.length;

  return {
    generatedAt: new Date().toISOString(),
    scope: 'السجلات التابعة للمستأجر النشط فقط؛ لا تتضمن بيانات مستأجرين آخرين.',
    database: {
      name: 'PharmaFlowPRO',
      version: database.verno,
      readOnly: true
    },
    counts: {
      inventory_layers: tenantLayers.length,
      fifo_consumption_log: (snapshot.allLogs as AnyRecord[]).filter(log => tenantOf(log) === activeTenantId).length,
      tenantlessLogsLinkedToTenantInvoices: tenantlessLinkedLogs.size,
      tenantlessLayersLinkedToTenantLogs: linkedTenantlessLayerIds.size,
      saleInvoicesFound: invoices.length,
      postedOrLockedSales: postedInvoices,
      categoryA_verifiedComplete: categoryA.length,
      categoryB_partialOrUnverifiable: categoryB.length,
      categoryC_noFifoEvidence: categoryC.length,
      excludedNonPosted,
      excludedUnknownStatus,
      excludedNonSales,
      excludedReturns,
      excludedUnknownType,
      orphanOrAmbiguousTenantLogs: orphanOrAmbiguousLogs.size
    },
    ratesPercent: {
      A_verifiedComplete: percent(categoryA.length, postedInvoices),
      B_partialOrUnverifiable: percent(categoryB.length, postedInvoices),
      C_noFifoEvidence: percent(categoryC.length, postedInvoices),
      B_plus_C_incompleteOrNoEvidence: percent(incompleteEvidence, postedInvoices),
      B_only_partialOrUnverifiable: percent(categoryB.length, postedInvoices)
    },
    dataQuality: {
      duplicateLayerIds: duplicateLayerIds.size,
      duplicateLogIds: duplicateLogIds.size,
      invoiceIdTenantConflicts: duplicateInvoiceTenantConflicts.size,
      missingLayerReferences: missingLayerReferences,
      invalidLogQuantities,
      invalidLogCosts,
      invalidLayerQuantities: layerInvalidQuantities,
      layerCostMismatches,
      reasonCounts
    },
    statusCounts,
    notes: [
      'A: فاتورة POSTED/LOCKED مع تطابق كميات البنود وسجلات FIFO، وروابط الطبقات والتكلفة وملكية المستأجر قابلة للتحقق.',
      'B: توجد سجلات FIFO لكن بها نقص أو تعارض أو تعذر تحقق؛ لا يعني ذلك وحده ثبوت فساد البيانات.',
      'C: لا يوجد سجل FIFO مرتبط بالفاتورة؛ هذه فجوة أدلة وليست دليلاً تلقائياً على فساد البيانات.',
      'تم احتساب B+C كنسبة الفواتير غير المكتملة أو التي لا يوجد لها دليل FIFO من إجمالي فواتير POSTED/LOCKED.',
      'السجلات التي لا تحمل tenantId لا تُنسب إلى مستأجر بمجرد وجودها؛ أُدرجت فقط عندما ارتبطت مباشرة بفاتورة للمستأجر الحالي، وصُنفت حينها كغير قابلة للتحقق.',
      'الفواتير التاريخية التي أخفاها Tenant Guard بسبب غياب tenantId لا يمكن إسنادها بأمان من هذه الصفحة، وتحتاج تدقيق Orphan Records منفصلاً.',
      'لا يتم إرسال أي بيانات إلى الخادم، ولا تُعرض معرفات الفواتير أو المنتجات في نتيجة JSON.'
    ]
  };
}

export default function FifoAuditTempPage() {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [error, setError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const outputRef = useRef<HTMLTextAreaElement | null>(null);

  const output = summary ? JSON.stringify(summary, null, 2) : '';

  const runAudit = useCallback(async () => {
    setLoading(true);
    setError('');
    setCopyMessage('');
    setSummary(null);
    try {
      const result = await buildFifoAudit();
      setSummary(result);
    } catch (cause: any) {
      setError(cause?.message || 'تعذر تنفيذ تدقيق FIFO.');
    } finally {
      setLoading(false);
    }
  }, []);

  const copyResult = useCallback(async () => {
    if (!output) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(output);
      } else if (outputRef.current) {
        outputRef.current.focus();
        outputRef.current.select();
        const copied = document.execCommand('copy');
        if (!copied) throw new Error('Clipboard API unavailable');
      } else {
        throw new Error('Clipboard unavailable');
      }
      setCopyMessage('تم نسخ JSON. أرسله في المحادثة لتحليله.');
    } catch {
      setCopyMessage('تعذر النسخ التلقائي. اضغط مطولاً داخل مربع JSON واختر تحديد الكل ثم نسخ.');
      outputRef.current?.focus();
    }
  }, [output]);

  return (
    <section className="mx-auto w-full max-w-4xl space-y-5 p-3 sm:p-6" dir="rtl">
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950">
        <h1 className="text-lg font-black">تدقيق بيانات FIFO — صفحة مؤقتة</h1>
        <p className="mt-2 text-sm leading-7">
          هذه الأداة تفحص بيانات Dexie المحلية للمستأجر النشط فقط. التنفيذ للقراءة فقط،
          ولا يغيّر المخزون أو الفواتير أو سجلات FIFO.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={runAudit}
          disabled={loading}
          className="min-h-12 rounded-xl bg-[#1E4D4D] px-6 py-3 text-sm font-black text-white shadow-sm transition hover:bg-[#163b3b] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? 'جارٍ فحص البيانات...' : 'تشغيل التدقيق'}
        </button>
        {summary && (
          <span className="text-xs font-bold text-emerald-700">اكتمل التدقيق المحلي</span>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-bold leading-7 text-red-800">
          {error}
        </div>
      )}

      {summary && (
        <>
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-4 py-3">
              <h2 className="font-black text-slate-800">ملخص النتائج</h2>
              <p className="mt-1 text-xs text-slate-500">النطاق: المستأجر الحالي فقط</p>
            </div>
            <table className="w-full min-w-[520px] text-right text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-3">المؤشر</th>
                  <th className="px-4 py-3">العدد</th>
                  <th className="px-4 py-3">النسبة</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-slate-100">
                  <td className="px-4 py-3 font-bold">A — مكتملة وقابلة للتحقق</td>
                  <td className="px-4 py-3 tabular-nums">{summary.counts.categoryA_verifiedComplete}</td>
                  <td className="px-4 py-3 tabular-nums">{summary.ratesPercent.A_verifiedComplete}%</td>
                </tr>
                <tr className="border-t border-slate-100">
                  <td className="px-4 py-3 font-bold">B — ناقصة أو غير قابلة للتحقق</td>
                  <td className="px-4 py-3 tabular-nums">{summary.counts.categoryB_partialOrUnverifiable}</td>
                  <td className="px-4 py-3 tabular-nums">{summary.ratesPercent.B_partialOrUnverifiable}%</td>
                </tr>
                <tr className="border-t border-slate-100">
                  <td className="px-4 py-3 font-bold">C — بلا دليل FIFO</td>
                  <td className="px-4 py-3 tabular-nums">{summary.counts.categoryC_noFifoEvidence}</td>
                  <td className="px-4 py-3 tabular-nums">{summary.ratesPercent.C_noFifoEvidence}%</td>
                </tr>
                <tr className="border-t border-slate-100 bg-slate-50">
                  <td className="px-4 py-3 font-black">B + C — غير مكتملة / بلا دليل</td>
                  <td className="px-4 py-3 font-black tabular-nums">{summary.counts.categoryB_partialOrUnverifiable + summary.counts.categoryC_noFifoEvidence}</td>
                  <td className="px-4 py-3 font-black tabular-nums">{summary.ratesPercent.B_plus_C_incompleteOrNoEvidence}%</td>
                </tr>
                <tr className="border-t border-slate-100">
                  <td className="px-4 py-3">طبقات FIFO التابعة للمستأجر</td>
                  <td className="px-4 py-3 tabular-nums">{summary.counts.inventory_layers}</td>
                  <td className="px-4 py-3">—</td>
                </tr>
                <tr className="border-t border-slate-100">
                  <td className="px-4 py-3">سجلات الاستهلاك التابعة للمستأجر</td>
                  <td className="px-4 py-3 tabular-nums">{summary.counts.fifo_consumption_log}</td>
                  <td className="px-4 py-3">—</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-black text-slate-800">Summary JSON</h2>
              <button
                type="button"
                onClick={copyResult}
                className="min-h-10 rounded-lg border border-[#1E4D4D] px-4 py-2 text-xs font-black text-[#1E4D4D] hover:bg-teal-50"
              >
                نسخ JSON
              </button>
            </div>
            <textarea
              ref={outputRef}
              readOnly
              value={output}
              rows={20}
              spellCheck={false}
              aria-label="نتيجة تدقيق FIFO بصيغة JSON"
              className="w-full rounded-xl border border-slate-300 bg-slate-950 p-3 font-mono text-xs leading-6 text-emerald-100 outline-none focus:border-teal-500"
            />
            {copyMessage && (
              <p role="status" className="text-xs font-bold text-slate-600">{copyMessage}</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
