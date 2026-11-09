import { useCallback, useRef, useState } from 'react';
import { db, getCurrentUserSession } from '@/core/db';

type Row = Record<string, any>;
type Class = 'VERIFIED' | 'RECONSTRUCTABLE' | 'UNVERIFIABLE' | 'NO_EVIDENCE';
type StoreCounts = { linkedToTenantInvoices: number; tenantMatched: number; tenantlessLinked: number; rejectedTenantMismatch: number };
type Summary = {
  generatedAt: string; scope: string; database: { name: string; version: number; readOnly: true };
  tenantScope: 'active-tenant-only';
  storesDetected: string[]; storesNotPresent: string[];
  invoices: { postedSales: number; VERIFIED: number; RECONSTRUCTABLE: number; UNVERIFIABLE: number; NO_EVIDENCE: number };
  evidenceByStore: Record<string, StoreCounts>;
  evidenceQuality: Record<string, number>;
  limitations: string[]; notes: string[];
};

const CANDIDATE_STORES = [
  'invoices', 'sales', 'invoiceItems', 'inventoryTransactions', 'medicineBatches',
  'journalEntries', 'journalLines', 'purchases', 'financialTransactions',
  'syncQueue', 'sync_queue', 'outbox', 'eventStore', 'stock_movements',
  'inventory_logs', 'inventory', 'warehouseStock', 'inventory_layers', 'fifo_consumption_log'
] as const;
const pick = (r: Row, keys: string[]): any => {
  for (const k of keys) if (r?.[k] !== undefined && r?.[k] !== null && r?.[k] !== '') return r[k];
  return undefined;
};
const text = (v: any): string => v === undefined || v === null ? '' : String(v).trim();
const number = (v: any): number => {
  if (v === undefined || v === null || v === '') return Number.NaN;
  const n = Number(v); return Number.isFinite(n) ? n : Number.NaN;
};
const tenantOf = (r: Row): string => text(pick(r, ['tenantId', 'tenant_id']));
const productOf = (r: Row): string => text(pick(r, ['productId', 'product_id', 'itemId', 'item_id']));
const aliasesOf = (r: Row): string[] => [...new Set([
  pick(r, ['id']), pick(r, ['invoiceId', 'invoice_id']), pick(r, ['SaleID', 'saleId']),
  pick(r, ['invoiceNumber', 'invoice_number'])
].map(text).filter(Boolean))];
const refsOf = (r: Row): string[] => [...new Set([
  pick(r, ['source_doc_id', 'sourceDocId', 'SourceDocumentID', 'source_document_id', 'sourceDocumentId']),
  pick(r, ['invoice_id', 'invoiceId', 'sale_id', 'saleId']),
  pick(r, ['reference_id', 'referenceId', 'Reference_ID', 'referenceID', 'source_id', 'sourceId']),
  pick(r, ['document_id', 'documentId', 'parent_id', 'parentId', 'sourceInvoiceId', 'source_invoice_id'])
].map(text).filter(Boolean))];
const rowId = (r: Row): string => text(pick(r, ['id', 'entryId', 'entry_id', 'batchId', 'batch_id']));
const statusOf = (r: Row): string => text(pick(r, ['document_status', 'documentStatus', 'InvoiceStatus', 'invoiceStatus', 'status'])).toUpperCase();
const typeOf = (r: Row): string => text(pick(r, ['type', 'invoiceType', 'invoice_type'])).toUpperCase();
const isReturn = (r: Row): boolean => r?.isReturn === true || r?.is_return === true || typeOf(r).includes('RETURN') || typeOf(r).includes('مرتجع');
const req = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error || new Error('IndexedDB read failed'));
});
const rate = (n: number, total: number) => total ? Number((n / total * 100).toFixed(2)) : 0;

async function readSnapshot() {
  const proxy = db as any;
  if (!proxy.isOpen()) throw new Error('توقف آمن: قاعدة Dexie ليست مفتوحة. أعد تحميل التطبيق بعد تسجيل الدخول.');
  // Use the existing connection and a native IndexedDB readonly transaction.
  // This bypasses tenant read filters only for forensic inspection; ownership is checked below.
  const native = proxy.backendDB() as IDBDatabase;
  if (!native || native.name !== 'PharmaFlowPRO') throw new Error('توقف آمن: تعذر التحقق من قاعدة PharmaFlowPRO المحلية.');
  const names = CANDIDATE_STORES.filter(name => native.objectStoreNames.contains(name));
  if (!names.includes('invoices')) throw new Error('توقف آمن: مخزن invoices غير موجود.');
  const tx = native.transaction([...names], 'readonly');
  const pairs = await Promise.all(names.map(async name => [name, await req(tx.objectStore(name).getAll())] as const));
  const stores: Record<string, Row[]> = {};
  pairs.forEach(([name, rows]) => { stores[name] = rows as Row[]; });
  return { version: native.version, stores, storesDetected: [...names], storesNotPresent: CANDIDATE_STORES.filter(name => !names.includes(name)) };
}

async function buildAudit(): Promise<Summary> {
  const activeTenant = text(getCurrentUserSession().tenantId);
  if (!activeTenant) throw new Error('توقف آمن: لا توجد جلسة مستأجر نشطة.');
  const { version, stores, storesDetected, storesNotPresent } = await readSnapshot();
  // Deduplicate the canonical invoices and legacy sales mirror by stable invoice ID.
  // Prefer invoices; only use sales as a fallback when the canonical row is absent.
  const invoiceById = new Map<string, Row>();
  for (const row of stores.invoices || []) {
    const id = text(pick(row, ['id', 'invoiceId', 'invoice_id', 'SaleID', 'saleId']));
    if (id && tenantOf(row) === activeTenant) invoiceById.set(id, row);
  }
  for (const row of stores.sales || []) {
    const id = text(pick(row, ['id', 'invoiceId', 'invoice_id', 'SaleID', 'saleId']));
    if (id && tenantOf(row) === activeTenant && !invoiceById.has(id)) invoiceById.set(id, row);
  }
  const invoices = [...invoiceById.values()].filter(r =>
    !isReturn(r) && (!typeOf(r) || typeOf(r) === 'SALE') &&
    ['POSTED', 'LOCKED'].includes(statusOf(r))
  );
  const invoiceAliases = new Map<Row, Set<string>>();
  const aliasOwners = new Map<string, Set<Row>>();
  for (const invoice of invoices) {
    const aliases = new Set(aliasesOf(invoice));
    invoiceAliases.set(invoice, aliases);
    for (const alias of aliases) {
      if (!aliasOwners.has(alias)) aliasOwners.set(alias, new Set());
      aliasOwners.get(alias)!.add(invoice);
    }
  }
  const evidenceByStore: Record<string, StoreCounts> = {};
  const rowsByStoreInvoice = new Map<string, Map<Row, Row[]>>();
  const trustedJournalIds = new Set<string>();
  let ambiguousInvoiceReferences = 0;
  const linkStore = (name: string, rows: Row[]) => {
    const perInvoice = new Map<Row, Row[]>();
    let tenantMatched = 0, tenantlessLinked = 0, rejectedTenantMismatch = 0;
    for (const row of rows) {
      const matches = new Set<Row>();
      for (const ref of refsOf(row)) {
        const owners = aliasOwners.get(ref);
        if (owners?.size === 1) owners.forEach(owner => matches.add(owner));
        else if (owners && owners.size > 1) ambiguousInvoiceReferences += 1;
      }
      if (matches.size !== 1) continue;
      const invoice = [...matches][0];
      const owner = tenantOf(row);
      if (owner && owner !== activeTenant) { rejectedTenantMismatch += 1; continue; }
      if (owner) tenantMatched += 1; else tenantlessLinked += 1;
      if (!perInvoice.has(invoice)) perInvoice.set(invoice, []);
      perInvoice.get(invoice)!.push(row);
      if (name === 'journalEntries' && owner && rowId(row)) trustedJournalIds.add(rowId(row));
    }
    rowsByStoreInvoice.set(name, perInvoice);
    evidenceByStore[name] = {
      linkedToTenantInvoices: [...perInvoice.values()].reduce((sum, rowsForInvoice) => sum + rowsForInvoice.length, 0),
      tenantMatched, tenantlessLinked, rejectedTenantMismatch
    };
  };

  const movementStores = ['inventoryTransactions', 'stock_movements', 'inventory_logs', 'inventory'];
  if (stores.invoiceItems) linkStore('invoiceItems', stores.invoiceItems);
  if (stores.medicineBatches) linkStore('medicineBatches', stores.medicineBatches);
  movementStores.forEach(name => { if (stores[name]) linkStore(name, stores[name]); });
  ['journalEntries', 'financialTransactions', 'syncQueue', 'sync_queue', 'outbox', 'eventStore',
    'purchases', 'inventory_layers', 'fifo_consumption_log'].forEach(name => {
      if (stores[name]) linkStore(name, stores[name]);
    });

  const expected = new Map<Row, Map<string, number>>();
  const addExpected = (invoice: Row, product: string, qty: number) => {
    if (!expected.has(invoice)) expected.set(invoice, new Map());
    const map = expected.get(invoice)!; map.set(product, (map.get(product) || 0) + qty);
  };
  for (const invoice of invoices) {
    const aliases = invoiceAliases.get(invoice)!;
    const embedded = Array.isArray(invoice.items) ? invoice.items : [];
    const linkedItems = (stores.invoiceItems || []).filter(item =>
      refsOf(item).some(ref => aliases.has(ref)) && (!tenantOf(item) || tenantOf(item) === activeTenant)
    );
    for (const item of [...embedded, ...linkedItems]) {
      const product = productOf(item);
      const qty = number(pick(item, ['qty', 'quantity', 'Quantity']));
      if (product && Number.isFinite(qty) && qty > 0) addExpected(invoice, product, qty);
    }
  }

  const quality: Record<string, number> = {
    canonicalInventoryMovementsLinked: 0, canonicalMovementsWithCost: 0,
    canonicalMovementsWithoutCost: 0, movementQuantityMismatches: 0,
    movementProductMismatches: 0, journalEntriesLinked: 0,
    journalLinesLinkedToTrustedEntries: 0, journalLinesWithTenantMismatch: 0,
    batchReferencesLinked: 0, batchTenantlessLinked: 0, syncRecordsLinked: 0,
    legacyMovementRecordsLinked: 0, ambiguousInvoiceReferences
  };
  for (const line of stores.journalLines || []) {
    const parentId = text(pick(line, ['entry_id', 'entryId', 'journalEntryId', 'journal_entry_id']));
    if (!parentId || !trustedJournalIds.has(parentId)) continue;
    const lineTenant = tenantOf(line);
    if (lineTenant && lineTenant !== activeTenant) quality.journalLinesWithTenantMismatch += 1;
    else quality.journalLinesLinkedToTrustedEntries += 1;
  }

  const classes: Class[] = [];
  for (const invoice of invoices) {
    const expectedLines = expected.get(invoice) || new Map<string, number>();
    const canonical = (rowsByStoreInvoice.get('inventoryTransactions')?.get(invoice) || []).filter(row => {
      const docType = text(pick(row, ['SourceDocumentType', 'sourceDocType', 'source_doc_type'])).toUpperCase();
      const movementType = text(pick(row, ['TransactionType', 'transactionType', 'transaction_type'])).toUpperCase();
      return (!docType || docType === 'SALE') && (!movementType || movementType === 'SALE');
    });
    const canonicalTrusted = canonical.filter(row => tenantOf(row) === activeTenant);
    const legacy = ['stock_movements', 'inventory_logs', 'inventory'].flatMap(name => rowsByStoreInvoice.get(name)?.get(invoice) || []);
    const journals = rowsByStoreInvoice.get('journalEntries')?.get(invoice) || [];
    const sync = ['syncQueue', 'sync_queue', 'outbox', 'eventStore'].flatMap(name => rowsByStoreInvoice.get(name)?.get(invoice) || []);
    const hasTenantless = canonical.some(row => !tenantOf(row)) || legacy.some(row => !tenantOf(row)) || journals.some(row => !tenantOf(row));
    let qtyMatches = false, hasMismatch = false, costRows = 0;
    if (canonicalTrusted.length && expectedLines.size) {
      const actual = new Map<string, number>();
      for (const row of canonicalTrusted) {
        const product = productOf(row);
        const rawQty = number(pick(row, ['quantity_delta', 'quantityDelta', 'QuantityChange', 'quantityChange', 'quantity', 'qty', 'Quantity']));
        if (!product || !Number.isFinite(rawQty) || rawQty === 0) { hasMismatch = true; continue; }
        actual.set(product, (actual.get(product) || 0) + Math.abs(rawQty));
        const unitCost = number(pick(row, ['unit_cost', 'unitCost', 'cost_per_unit', 'costPerUnit']));
        const totalCost = number(pick(row, ['total_cost', 'totalCost', 'cost_amount', 'costAmount']));
        if ((Number.isFinite(unitCost) && unitCost >= 0) || (Number.isFinite(totalCost) && totalCost >= 0)) costRows += 1;
      }
      qtyMatches = [...expectedLines].every(([product, qty]) => Math.abs((actual.get(product) || 0) - qty) <= 0.000001) &&
        [...actual.keys()].every(product => expectedLines.has(product));
      if (!qtyMatches) { hasMismatch = true; quality.movementQuantityMismatches += 1; }
      if (canonicalTrusted.length) quality.canonicalInventoryMovementsLinked += canonicalTrusted.length;
      quality.canonicalMovementsWithCost += costRows;
      quality.canonicalMovementsWithoutCost += canonicalTrusted.length - costRows;
    }
    if (journals.length) quality.journalEntriesLinked += journals.filter(row => tenantOf(row) === activeTenant).length;
    quality.syncRecordsLinked += sync.length;
    quality.legacyMovementRecordsLinked += legacy.length;
    if (hasMismatch) quality.movementProductMismatches += 1;

    // Only canonical, tenant-owned inventory movements with exact invoice/product/qty
    // linkage and explicit movement cost qualify as verified transaction-cost evidence.
    // This does not by itself prove layer-by-layer FIFO allocation.
    let classification: Class = 'NO_EVIDENCE';
    const canonicalTypeVerified = canonicalTrusted.length > 0 && canonicalTrusted.every(row =>
      text(pick(row, ['SourceDocumentType', 'sourceDocType', 'source_doc_type'])).toUpperCase() === 'SALE' &&
      text(pick(row, ['TransactionType', 'transactionType', 'transaction_type'])).toUpperCase() === 'SALE'
    );
    if (canonicalTypeVerified && qtyMatches && costRows > 0 && !hasMismatch) classification = 'VERIFIED';
    else if (canonical.length || legacy.length || journals.length || sync.length || hasTenantless) classification = 'UNVERIFIABLE';
    classes.push(classification);
  }

  // Batch references are counted only when an invoice-linked movement names a batch.
  const referencedBatchIds = new Set<string>();
  for (const [invoice, rows] of (rowsByStoreInvoice.get('inventoryTransactions') || new Map()).entries()) {
    for (const row of rows) {
      const batch = text(pick(row, ['batchId', 'batch_id', 'medicineBatchId', 'medicine_batch_id']));
      if (batch) referencedBatchIds.add(batch);
    }
  }
  for (const batch of stores.medicineBatches || []) {
    if (!referencedBatchIds.has(rowId(batch))) continue;
    const owner = tenantOf(batch);
    if (owner && owner !== activeTenant) continue;
    quality.batchReferencesLinked += 1;
    if (!owner) quality.batchTenantlessLinked += 1;
  }

  const counts = {
    VERIFIED: classes.filter(c => c === 'VERIFIED').length,
    RECONSTRUCTABLE: classes.filter(c => c === 'RECONSTRUCTABLE').length,
    UNVERIFIABLE: classes.filter(c => c === 'UNVERIFIABLE').length,
    NO_EVIDENCE: classes.filter(c => c === 'NO_EVIDENCE').length
  };
  return {
    generatedAt: new Date().toISOString(),
    scope: 'Dexie المحلية في هذا المتصفح والجهاز فقط؛ فواتير المستأجر النشط؛ لا تشمل Supabase أو أجهزة أخرى.',
    database: { name: 'PharmaFlowPRO', version, readOnly: true },
    tenantScope: 'active-tenant-only',
    storesDetected, storesNotPresent,
    invoices: { postedSales: invoices.length, ...counts },
    evidenceByStore, evidenceQuality: quality,
    limitations: [
      'النتيجة محلية فقط ولا تثبت اكتمال بيانات Supabase أو الأجهزة الأخرى.',
      'السجلات ذات tenantId مختلف مستبعدة تماماً.',
      'السجل بلا tenantId لا يُنسب إلى المستأجر؛ يُعرض فقط كقرينة مرتبطة بمرجع فاتورة دقيق ويظل UNVERIFIABLE.',
      'productId وحده لا يكفي للربط أو إثبات الملكية؛ يلزم مرجع فاتورة/مستند دقيق.',
      'قيد COGS ليس دليلاً مستقلاً على FIFO؛ قد يكون مصدر التكلفة fallback من CostPrice أو تكلفة دفعة غير مثبتة المصدر.',
      'VERIFIED هنا يعني إثبات حركة وتكلفة على مستوى سجل المخزون، وليس إثبات تخصيص FIFO لكل طبقة.',
      'لا تُعرض معرفات الفواتير أو المنتجات أو الدفعات أو القيم المالية.'
    ],
    notes: [
      'VERIFIED: inventoryTransactions مرتبط بالفاتورة بدقة، tenant مطابق، المنتج والكمية متطابقان، والتكلفة مسجلة.',
      'RECONSTRUCTABLE لا يُمنح لمجرد تطابق الكمية؛ يلزم دليل مستقل يسمح بإعادة بناء تكلفة FIFO تاريخياً، وهذا الإصدار لا يفترض وجوده.',
      'UNVERIFIABLE: توجد قرائن مع نقص في الملكية أو الربط أو مطابقة الكميات أو مصدر التكلفة.',
      'NO_EVIDENCE: لا توجد سجلات محلية مرتبطة ضمن المخازن الموجودة فعلياً.',
      'قراءة IndexedDB أصلية بوضع readonly؛ لا كتابة أو ترقية Schema أو اتصال شبكة.'
    ]
  };
}

export default function FifoAuditTempPage() {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const outputRef = useRef<HTMLTextAreaElement | null>(null);
  const output = summary ? JSON.stringify(summary, null, 2) : '';
  const runAudit = useCallback(async () => {
    setLoading(true); setError(''); setCopyMessage(''); setSummary(null);
    try { setSummary(await buildAudit()); }
    catch (cause: any) { setError(cause?.message || 'تعذر تنفيذ التدقيق الموسع.'); }
    finally { setLoading(false); }
  }, []);
  const copyResult = useCallback(async () => {
    if (!output) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(output);
      else if (outputRef.current) {
        outputRef.current.focus(); outputRef.current.select();
        if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
      } else throw new Error('Clipboard unavailable');
      setCopyMessage('تم نسخ JSON. أرسله في المحادثة لتحليله.');
    } catch {
      setCopyMessage('تعذر النسخ التلقائي. اضغط مطولاً داخل مربع JSON واختر تحديد الكل ثم نسخ.');
      outputRef.current?.focus();
    }
  }, [output]);
  return (
    <section className="mx-auto w-full max-w-4xl space-y-5 p-3 sm:p-6" dir="rtl">
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950">
        <h1 className="text-lg font-black">تدقيق أدلة FIFO التاريخية — موسع ومؤقت</h1>
        <p className="mt-2 text-sm leading-7">يفحص Dexie المحلية للمستأجر النشط فقط بقراءة IndexedDB في وضع readonly. لا يرسل بيانات إلى الخادم ولا يغيّر أي سجل.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={runAudit} disabled={loading} className="min-h-12 rounded-xl bg-[#1E4D4D] px-6 py-3 text-sm font-black text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-60">{loading ? 'جارٍ فحص البيانات...' : 'تشغيل التدقيق الموسع'}</button>
        {summary && <span className="text-xs font-bold text-emerald-700">اكتمل التدقيق المحلي</span>}
      </div>
      {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-bold leading-7 text-red-800">{error}</div>}
      {summary && <>
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3"><h2 className="font-black text-slate-800">ملخص تصنيف الفواتير</h2><p className="mt-1 text-xs text-slate-500">Dexie v{summary.database.version} — {summary.invoices.postedSales} فاتورة POSTED/LOCKED</p></div>
          <table className="w-full min-w-[520px] text-right text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3">التصنيف</th><th className="px-4 py-3">العدد</th><th className="px-4 py-3">النسبة</th></tr></thead>
            <tbody>{(['VERIFIED', 'RECONSTRUCTABLE', 'UNVERIFIABLE', 'NO_EVIDENCE'] as Class[]).map(key => <tr key={key} className="border-t border-slate-100"><td className="px-4 py-3 font-bold">{key}</td><td className="px-4 py-3 tabular-nums">{summary.invoices[key]}</td><td className="px-4 py-3 tabular-nums">{rate(summary.invoices[key], summary.invoices.postedSales)}%</td></tr>)}</tbody>
          </table>
        </div>
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 font-black text-slate-800">مصادر الأدلة المكتشفة</h2>
          <table className="w-full min-w-[620px] text-right text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr><th className="px-3 py-2">المخزن</th><th className="px-3 py-2">مرتبط</th><th className="px-3 py-2">Tenant مطابق</th><th className="px-3 py-2">Tenant مفقود</th><th className="px-3 py-2">Tenant مختلف</th></tr></thead>
            <tbody>{Object.entries(summary.evidenceByStore).map(([name, value]) => <tr key={name} className="border-t border-slate-100"><td className="px-3 py-2 font-mono">{name}</td><td className="px-3 py-2">{value.linkedToTenantInvoices}</td><td className="px-3 py-2">{value.tenantMatched}</td><td className="px-3 py-2">{value.tenantlessLinked}</td><td className="px-3 py-2">{value.rejectedTenantMismatch}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-black text-slate-800">Extended Audit JSON</h2><button type="button" onClick={copyResult} className="min-h-10 rounded-lg border border-[#1E4D4D] px-4 py-2 text-xs font-black text-[#1E4D4D]">نسخ JSON</button></div>
          <textarea ref={outputRef} readOnly value={output} rows={24} spellCheck={false} aria-label="نتيجة التدقيق الموسع بصيغة JSON" className="w-full rounded-xl border border-slate-300 bg-slate-950 p-3 font-mono text-xs leading-6 text-emerald-100 outline-none focus:border-teal-500" />
          {copyMessage && <p role="status" className="text-xs font-bold text-slate-600">{copyMessage}</p>}
        </div>
      </>}
    </section>
  );
}
