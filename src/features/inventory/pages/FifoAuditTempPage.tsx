import { useCallback, useRef, useState } from 'react';
import { db, getCurrentUserSession } from '@/core/db';
import { buildLocalSyncForensics, type LocalSyncForensics } from '../utils/localSyncQueueForensics';

type AnyRecord = Record<string, any>;
type AuditCounts = {
  inventory_layers: number;
  fifo_consumption_log: number;
  tenantlessLogsLinkedToTenantInvoices: number;
  tenantlessLayersLinkedToTenantLogs: number;
  saleInvoicesFound: number;
  postedOrLockedSales: number;
  categoryA_verifiedComplete: number;
  categoryB_partialOrUnverifiable: number;
  categoryC_noFifoEvidence: number;
  excludedNonPosted: number;
  excludedUnknownStatus: number;
  excludedNonSales: number;
  excludedReturns: number;
  excludedUnknownType: number;
  orphanOrAmbiguousTenantLogs: number;
};

type AuditRates = {
  A_verifiedComplete: number;
  B_partialOrUnverifiable: number;
  C_noFifoEvidence: number;
  B_plus_C_incompleteOrNoEvidence: number;
  B_only_partialOrUnverifiable: number;
};

type AuditSummary = {
  generatedAt: string;
  scope: string;
  database: { name: string; version: number; readOnly: true };
  counts: AuditCounts;
  ratesPercent: AuditRates;
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
    if (!invoiceId) continue;
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
    if (!invoiceId) return;
    if (!logTenant) {
      tenantlessLinkedLogs.add(asText(log?.id) || `row-${index}`);
    }

    if (!logsByInvoice.has(invoiceId)) logsByInvoice.set(invoiceId, []);
    logsByInvoice.get(invoiceId)!.push(log);
  });

  const linkedTenantlessLayerIds = new Set<string>();
  const duplicateLayerIds = new Set<string>();
  for (const [layerId, candidates] of layerCandidates) {
    if (candidates.length > 1) duplicateLayerIds.add(layerId);
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
      if (!layer) {
        missingLayerReferences += 1;
        reasons.add('missing_layer_reference');
        continue;
      }
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
const extPick = (r: Row, keys: string[]): any => {
  for (const k of keys) if (r?.[k] !== undefined && r?.[k] !== null && r?.[k] !== '') return r[k];
  return undefined;
};
const extText = (v: any): string => v === undefined || v === null ? '' : String(v).trim();
const extNumber = (v: any): number => {
  if (v === undefined || v === null || v === '') return Number.NaN;
  const n = Number(v); return Number.isFinite(n) ? n : Number.NaN;
};
const extTenantOf = (r: Row): string => extText(extPick(r, ['tenantId', 'tenant_id']));
const extProductOf = (r: Row): string => extText(extPick(r, ['productId', 'product_id', 'itemId', 'item_id']));
const extBranchOf = (r: Row): string => extText(extPick(r, ['branchId', 'branch_id']));
const extAliasesOf = (r: Row): string[] => [...new Set([
  extPick(r, ['id']), extPick(r, ['invoiceId', 'invoice_id']), extPick(r, ['SaleID', 'saleId']),
  extPick(r, ['invoiceNumber', 'invoice_number'])
].map(extText).filter(Boolean))];
const extRefsOf = (r: Row): string[] => [...new Set([
  extPick(r, ['source_doc_id', 'sourceDocId', 'SourceDocumentID', 'source_document_id', 'sourceDocumentId']),
  extPick(r, ['invoice_id', 'invoiceId', 'sale_id', 'saleId']),
  extPick(r, ['reference_id', 'referenceId', 'Reference_ID', 'referenceID', 'source_id', 'sourceId']),
  extPick(r, ['document_id', 'documentId', 'parent_id', 'parentId', 'sourceInvoiceId', 'source_invoice_id'])
].map(extText).filter(Boolean))];
const extRowId = (r: Row): string => extText(extPick(r, ['id', 'entryId', 'entry_id', 'batchId', 'batch_id']));
const extStatusOf = (r: Row): string => extText(extPick(r, ['document_status', 'documentStatus', 'InvoiceStatus', 'invoiceStatus', 'status'])).toUpperCase();
const extTypeOf = (r: Row): string => extText(extPick(r, ['type', 'invoiceType', 'invoice_type'])).toUpperCase();
const extIsReturn = (r: Row): boolean => r?.isReturn === true || r?.is_return === true || extTypeOf(r).includes('RETURN') || extTypeOf(r).includes('مرتجع');
const extReq = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error || new Error('IndexedDB read failed'));
});
const extRate = (n: number, total: number) => total ? Number((n / total * 100).toFixed(2)) : 0;

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
  const pairs = await Promise.all(names.map(async name => [name, await extReq(tx.objectStore(name).getAll())] as const));
  const stores: Record<string, Row[]> = {};
  pairs.forEach(([name, rows]) => { stores[name] = rows as Row[]; });
  return { version: native.version, stores, storesDetected: [...names], storesNotPresent: CANDIDATE_STORES.filter(name => !names.includes(name)) };
}

async function buildAudit(): Promise<Summary> {
  const activeTenant = extText(getCurrentUserSession().tenantId);
  if (!activeTenant) throw new Error('توقف آمن: لا توجد جلسة مستأجر نشطة.');
  const { version, stores, storesDetected, storesNotPresent } = await readSnapshot();
  // Deduplicate the canonical invoices and legacy sales mirror by stable invoice ID.
  // Prefer invoices; only use sales as a fallback when the canonical row is absent.
  const invoiceById = new Map<string, Row>();
  for (const row of stores.invoices || []) {
    const id = extText(extPick(row, ['id', 'invoiceId', 'invoice_id', 'SaleID', 'saleId']));
    if (id && extTenantOf(row) === activeTenant) invoiceById.set(id, row);
  }
  for (const row of stores.sales || []) {
    const id = extText(extPick(row, ['id', 'invoiceId', 'invoice_id', 'SaleID', 'saleId']));
    if (id && extTenantOf(row) === activeTenant && !invoiceById.has(id)) invoiceById.set(id, row);
  }
  const invoices = [...invoiceById.values()].filter(r =>
    !extIsReturn(r) && (!extTypeOf(r) || extTypeOf(r) === 'SALE') &&
    ['POSTED', 'LOCKED'].includes(extStatusOf(r))
  );
  const invoiceAliases = new Map<Row, Set<string>>();
  const aliasOwners = new Map<string, Set<Row>>();
  for (const invoice of invoices) {
    const aliases = new Set(extAliasesOf(invoice));
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
      for (const ref of extRefsOf(row)) {
        const owners = aliasOwners.get(ref);
        if (owners?.size === 1) owners.forEach(owner => matches.add(owner));
        else if (owners && owners.size > 1) ambiguousInvoiceReferences += 1;
      }
      if (matches.size !== 1) continue;
      const invoice = [...matches][0];
      if (!invoice) continue;
      const owner = extTenantOf(row);
      if (owner && owner !== activeTenant) { rejectedTenantMismatch += 1; continue; }
      if (owner) tenantMatched += 1; else tenantlessLinked += 1;
      if (!perInvoice.has(invoice)) perInvoice.set(invoice, []);
      perInvoice.get(invoice)!.push(row);
      if (name === 'journalEntries' && owner && extRowId(row)) trustedJournalIds.add(extRowId(row));
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
      extRefsOf(item).some(ref => aliases.has(ref)) && (!extTenantOf(item) || extTenantOf(item) === activeTenant)
    );
    const effectiveItems = embedded.length ? embedded : linkedItems;
    for (const item of effectiveItems) {
      const product = extProductOf(item);
      const qty = extNumber(extPick(item, ['qty', 'quantity', 'Quantity']));
      if (product && Number.isFinite(qty) && qty > 0) addExpected(invoice, product, qty);
    }
  }

  const quality: Record<string, number> = {
    canonicalInventoryMovementsLinked: 0, canonicalMovementsWithCost: 0,
    canonicalMovementsWithoutCost: 0, movementQuantityMismatches: 0,
    movementProductMismatches: 0, movementBranchMismatches: 0, journalEntriesLinked: 0,
    journalLinesLinkedToTrustedEntries: 0, journalLinesWithTenantMismatch: 0,
    batchReferencesLinked: 0, batchTenantlessLinked: 0, syncRecordsLinked: 0,
    legacyMovementRecordsLinked: 0, ambiguousInvoiceReferences
  };
  const bumpQuality = (key: string, amount = 1) => { quality[key] = (quality[key] ?? 0) + amount; };
  for (const line of stores.journalLines || []) {
    const parentId = extText(extPick(line, ['entry_id', 'entryId', 'journalEntryId', 'journal_entry_id']));
    if (!parentId || !trustedJournalIds.has(parentId)) continue;
    const lineTenant = extTenantOf(line);
    if (lineTenant && lineTenant !== activeTenant) bumpQuality('journalLinesWithTenantMismatch', 1);
    else bumpQuality('journalLinesLinkedToTrustedEntries', 1);
  }

  const layerCandidates = new Map<string, Row[]>();
  for (const layer of stores.inventory_layers || []) {
    const layerId = extRowId(layer);
    if (!layerId) continue;
    if (!layerCandidates.has(layerId)) layerCandidates.set(layerId, []);
    layerCandidates.get(layerId)!.push(layer);
  }
  quality.fifoConsumptionLogsLinked = 0;
  quality.fifoLayerReferencesVerified = 0;
  quality.fifoLayerReferencesMissingOrAmbiguous = 0;
  quality.fifoTenantlessLogOrLayerLinks = 0;
  quality.fifoLayerCostMismatches = 0;
  quality.fifoLayerQuantityAnomalies = 0;

  const classes: Class[] = [];
  for (const invoice of invoices) {
    const expectedLines = expected.get(invoice) || new Map<string, number>();
    const canonical = (rowsByStoreInvoice.get('inventoryTransactions')?.get(invoice) || []).filter(row => {
      const docType = extText(extPick(row, ['SourceDocumentType', 'sourceDocType', 'source_doc_type'])).toUpperCase();
      const movementType = extText(extPick(row, ['TransactionType', 'transactionType', 'transaction_type'])).toUpperCase();
      return (!docType || docType === 'SALE') && (!movementType || movementType === 'SALE');
    });
    const canonicalTrusted = canonical.filter(row => extTenantOf(row) === activeTenant);
    const legacy = ['stock_movements', 'inventory_logs', 'inventory'].flatMap(name => rowsByStoreInvoice.get(name)?.get(invoice) || []);
    const journals = rowsByStoreInvoice.get('journalEntries')?.get(invoice) || [];
    const sync = ['syncQueue', 'sync_queue', 'outbox', 'eventStore'].flatMap(name => rowsByStoreInvoice.get(name)?.get(invoice) || []);
    const fifoLogs = rowsByStoreInvoice.get('fifo_consumption_log')?.get(invoice) || [];
    const hasTenantless = canonical.some(row => !extTenantOf(row)) || legacy.some(row => !extTenantOf(row)) || journals.some(row => !extTenantOf(row)) || fifoLogs.some(row => !extTenantOf(row));
    let qtyMatches = false, hasMismatch = false, hasProductQtyMismatch = false, costRows = 0;
    if (canonicalTrusted.length && expectedLines.size) {
      const actual = new Map<string, number>();
      for (const row of canonicalTrusted) {
        const product = extProductOf(row);
        const invoiceBranch = extBranchOf(invoice);
        if (invoiceBranch && extBranchOf(row) !== invoiceBranch) { hasMismatch = true; bumpQuality('movementBranchMismatches', 1); }
        const rawQty = extNumber(extPick(row, ['quantity_delta', 'quantityDelta', 'QuantityChange', 'quantityChange', 'quantity', 'qty', 'Quantity']));
        if (!product || !Number.isFinite(rawQty) || rawQty === 0) { hasMismatch = true; hasProductQtyMismatch = true; continue; }
        actual.set(product, (actual.get(product) || 0) + Math.abs(rawQty));
        const unitCost = extNumber(extPick(row, ['unit_cost', 'unitCost', 'cost_per_unit', 'costPerUnit']));
        const totalCost = extNumber(extPick(row, ['total_cost', 'totalCost', 'cost_amount', 'costAmount']));
        if ((Number.isFinite(unitCost) && unitCost >= 0) || (Number.isFinite(totalCost) && totalCost >= 0)) costRows += 1;
      }
      qtyMatches = [...expectedLines].every(([product, qty]) => Math.abs((actual.get(product) || 0) - qty) <= 0.000001) &&
        [...actual.keys()].every(product => expectedLines.has(product));
      if (!qtyMatches) { hasMismatch = true; hasProductQtyMismatch = true; bumpQuality('movementQuantityMismatches', 1); }
      if (canonicalTrusted.length) bumpQuality('canonicalInventoryMovementsLinked', canonicalTrusted.length);
      bumpQuality('canonicalMovementsWithCost', costRows);
      bumpQuality('canonicalMovementsWithoutCost', canonicalTrusted.length - costRows);
    }
    if (journals.length) bumpQuality('journalEntriesLinked', journals.filter(row => extTenantOf(row) === activeTenant).length);
    bumpQuality('syncRecordsLinked', sync.length);
    bumpQuality('fifoConsumptionLogsLinked', fifoLogs.length);

    // Verify the original FIFO chain: invoice -> consumption log -> unique layer.
    // Tenantless or ambiguous links remain unverified, even when IDs happen to match.
    let fifoChainVerified = fifoLogs.length > 0 && expectedLines.size > 0;
    const fifoQtyByProduct = new Map<string, number>();
    let linkedLayerCount = 0, linkedLayerTenantMatched = 0, linkedLayerTenantless = 0, linkedLayerTenantMismatch = 0;
    for (const log of fifoLogs) {
      if (extTenantOf(log) !== activeTenant) { fifoChainVerified = false; bumpQuality('fifoTenantlessLogOrLayerLinks', 1); }
      const layerId = extText(extPick(log, ['layer_id', 'layerId']));
      const candidates = layerId ? layerCandidates.get(layerId) || [] : [];
      if (candidates.length !== 1) {
        fifoChainVerified = false;
        bumpQuality('fifoLayerReferencesMissingOrAmbiguous', 1);
        continue;
      }
      const layer = candidates[0];
      if (!layer) { fifoChainVerified = false; continue; }
      let layerValid = true;
      const layerTenant = extTenantOf(layer);
      if (layerTenant === activeTenant) linkedLayerTenantMatched += 1;
      else if (!layerTenant) { linkedLayerTenantless += 1; bumpQuality('fifoTenantlessLogOrLayerLinks', 1); layerValid = false; }
      else { linkedLayerTenantMismatch += 1; layerValid = false; }
      const logProduct = extProductOf(log);
      const layerProduct = extProductOf(layer);
      if (!logProduct || !layerProduct || logProduct !== layerProduct) layerValid = false;
      const initialQty = extNumber(extPick(layer, ['quantity_initial', 'quantityInitial']));
      const remainingQty = extNumber(extPick(layer, ['quantity_remaining', 'quantityRemaining']));
      if (!Number.isFinite(initialQty) || initialQty <= 0 || !Number.isFinite(remainingQty) ||
          remainingQty < 0 || remainingQty - initialQty > 0.000001) {
        layerValid = false;
        bumpQuality('fifoLayerQuantityAnomalies', 1);
      }
      const consumed = extNumber(extPick(log, ['quantity_consumed', 'quantityConsumed', 'qty', 'quantity']));
      if (!Number.isFinite(consumed) || consumed <= 0 || !logProduct) fifoChainVerified = false;
      else fifoQtyByProduct.set(logProduct, (fifoQtyByProduct.get(logProduct) || 0) + consumed);
      const logCost = extNumber(extPick(log, ['unit_cost', 'unitCost']));
      const layerCost = extNumber(extPick(layer, ['unit_cost', 'unitCost']));
      if (!Number.isFinite(logCost) || logCost < 0 || !Number.isFinite(layerCost) || layerCost < 0) layerValid = false;
      else if (Math.abs(logCost - layerCost) > 0.000001) {
        layerValid = false;
        bumpQuality('fifoLayerCostMismatches', 1);
      }
      if (!layerValid) fifoChainVerified = false;
      linkedLayerCount += 1;
      if (layerValid) bumpQuality('fifoLayerReferencesVerified', 1);
    }
    if (fifoChainVerified) {
      const quantitiesMatch = [...expectedLines].every(([product, qty]) => Math.abs((fifoQtyByProduct.get(product) || 0) - qty) <= 0.000001) &&
        [...fifoQtyByProduct.keys()].every(product => expectedLines.has(product));
      fifoChainVerified = quantitiesMatch;
    }
    if (linkedLayerCount > 0 && stores.inventory_layers) {
      const layerCounts = evidenceByStore.inventory_layers || { linkedToTenantInvoices: 0, tenantMatched: 0, tenantlessLinked: 0, rejectedTenantMismatch: 0 };
      layerCounts.linkedToTenantInvoices += linkedLayerCount;
      layerCounts.tenantMatched += linkedLayerTenantMatched;
      layerCounts.tenantlessLinked += linkedLayerTenantless;
      layerCounts.rejectedTenantMismatch += linkedLayerTenantMismatch;
      evidenceByStore.inventory_layers = layerCounts;
    }
    bumpQuality('legacyMovementRecordsLinked', legacy.length);
    if (hasProductQtyMismatch) bumpQuality('movementProductMismatches', 1);

    // Canonical inventory movement costs are corroborating evidence only.
    // They do not prove FIFO provenance because the mutation engine can fall back
    // to the product's stored cost when FIFO consumption returns no positive cost.
    let classification: Class = 'NO_EVIDENCE';
    const canonicalTypeVerified = canonicalTrusted.length > 0 && canonicalTrusted.every(row =>
      extText(extPick(row, ['SourceDocumentType', 'sourceDocType', 'source_doc_type'])).toUpperCase() === 'SALE' &&
      extText(extPick(row, ['TransactionType', 'transactionType', 'transaction_type'])).toUpperCase() === 'SALE'
    );
    if (fifoChainVerified) classification = 'VERIFIED';
    else if (canonical.length || legacy.length || journals.length || sync.length || fifoLogs.length || hasTenantless ||
      (canonicalTypeVerified && qtyMatches && costRows > 0 && !hasMismatch)) classification = 'UNVERIFIABLE';
    classes.push(classification);
  }

  // Batch references are counted only when an invoice-linked movement names a batch.
  const referencedBatchIds = new Set<string>();
  for (const rows of (rowsByStoreInvoice.get('inventoryTransactions') || new Map()).values()) {
    for (const row of rows) {
      const batch = extText(extPick(row, ['batchId', 'batch_id', 'medicineBatchId', 'medicine_batch_id']));
      if (batch) referencedBatchIds.add(batch);
    }
  }
  for (const batch of stores.medicineBatches || []) {
    if (!referencedBatchIds.has(extRowId(batch))) continue;
    const owner = extTenantOf(batch);
    if (owner && owner !== activeTenant) continue;
    bumpQuality('batchReferencesLinked', 1);
    if (!owner) bumpQuality('batchTenantlessLinked', 1);
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
      'قيد COGS أو تكلفة inventoryTransactions وحدهما لا يثبتان FIFO؛ قد يُستخدم fallback من CostPrice. medicineBatches يخدم تتبع التشغيلات/FEFO وليس بديلاً عن inventory_layers.',
      'VERIFIED يتطلب ربط FIFO consumption log بالفاتورة والطبقة الأصلية، مع تطابق المستأجر والمنتج والكمية والتكلفة. لا يثبت وحده أن سجل الطبقات التاريخي كامل أو أن ترتيب FIFO الزمني لم يتعرض لفجوات.',
      'لا تُعرض معرفات الفواتير أو المنتجات أو الدفعات أو القيم المالية.'
    ],
    notes: [
      'VERIFIED: سجل استهلاك FIFO مرتبط بالفاتورة والطبقة الأصلية الفريدة، وملكية المستأجر والمنتج والكمية والتكلفة قابلة للتحقق.',
      'RECONSTRUCTABLE لا يُمنح لمجرد وجود inventoryTransactions أو قيد COGS؛ يلزم دليل تاريخي مستقل يسمح بإعادة بناء تسلسل الطبقات والتكلفة، وهذا الإصدار لا يفترض وجوده.',
      'UNVERIFIABLE: توجد قرائن مع نقص في الملكية أو الربط أو مطابقة الكميات أو مصدر التكلفة.',
      'NO_EVIDENCE: لا توجد سجلات محلية مرتبطة ضمن المخازن الموجودة فعلياً.',
      'قراءة IndexedDB أصلية بوضع readonly؛ لا كتابة أو ترقية Schema أو اتصال شبكة.'
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
      <ExtendedFifoEvidencePanel />
      <LocalSyncQueueForensicsPanel />
    </section>
  );
}

function ExtendedFifoEvidencePanel() {
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
    <div className="mt-6 space-y-5 rounded-2xl border border-slate-200 p-3 sm:p-5" dir="rtl">
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
            <tbody>{(['VERIFIED', 'RECONSTRUCTABLE', 'UNVERIFIABLE', 'NO_EVIDENCE'] as Class[]).map(key => <tr key={key} className="border-t border-slate-100"><td className="px-4 py-3 font-bold">{key}</td><td className="px-4 py-3 tabular-nums">{summary.invoices[key]}</td><td className="px-4 py-3 tabular-nums">{extRate(summary.invoices[key], summary.invoices.postedSales)}%</td></tr>)}</tbody>
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
    </div>
  );
}

function LocalSyncQueueForensicsPanel() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LocalSyncForensics | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const outputRef = useRef<HTMLTextAreaElement | null>(null);
  const output = result ? JSON.stringify(result, null, 2) : '';
  const run = useCallback(async () => {
    setLoading(true); setError(''); setResult(null); setCopied('');
    try {
      const session = getCurrentUserSession();
      if (!session.tenantId || !session.userId) throw new Error('جلسة المستأجر والمستخدم غير مكتملة؛ أُوقف الفحص.');
      setResult(await buildLocalSyncForensics(db, {
        tenantId: String(session.tenantId), userId: String(session.userId),
        branchId: session.branchId ? String(session.branchId) : undefined
      }));
    } catch (cause: any) {
      setError(cause?.message || 'تعذر فحص طوابير المزامنة المحلية.');
    } finally { setLoading(false); }
  }, []);
  const copy = useCallback(async () => {
    if (!output) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(output);
      else if (outputRef.current) {
        outputRef.current.focus(); outputRef.current.select();
        if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
      } else throw new Error('Clipboard unavailable');
      setCopied('تم نسخ التقرير المنقح.');
    } catch { setCopied('تعذر النسخ التلقائي؛ اضغط مطولاً داخل مربع التقرير ثم اختر نسخ.'); }
  }, [output]);
  return (
    <section className="mt-6 space-y-5 rounded-2xl border-2 border-sky-200 bg-sky-50/40 p-3 sm:p-5" dir="rtl">
      <div className="rounded-xl border border-sky-200 bg-white p-4">
        <h2 className="text-lg font-black text-slate-900">Local Sync Queue Forensics</h2>
        <p className="mt-2 text-sm leading-7 text-slate-600">
          فحص محلي مؤقت للقراءة فقط. لا يشغّل المزامنة ولا يرسل طلبات ولا يغيّر أي سجل.
          تُربط الفواتير بمعرّفات المستند الدقيقة، وتُخفى القيم الخام للمعرّفات ومفاتيح منع التكرار.
        </p>
      </div>
      <button type="button" onClick={run} disabled={loading}
        className="min-h-11 rounded-xl bg-slate-900 px-5 py-3 text-sm font-black text-white disabled:opacity-50">
        {loading ? 'جارٍ فحص المخازن المحلية...' : 'تشغيل فحص Local Sync Queue'}
      </button>
      {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-800">{error}</div>}
      {result && <>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {Object.entries(result.summary).map(([key,value]) => (
            <div key={key} className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="break-words text-xs text-slate-500">{key}</div>
              <div className="mt-1 text-xl font-black tabular-nums text-slate-900">{value}</div>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="font-black text-slate-800">المخازن المكتشفة</h3>
          <p className="mt-2 break-words text-xs leading-6 text-slate-600">موجودة: {result.detectedStores.join('، ') || 'لا يوجد'}</p>
          <p className="mt-1 break-words text-xs leading-6 text-slate-600">غير موجودة: {result.missingStores.join('، ') || 'لا يوجد'}</p>
          <p className="mt-1 text-xs text-slate-500">Dexie v{result.databaseVersion} — {result.invoiceCount} فاتورة POSTED/LOCKED — {result.generatedAt}</p>
        </div>
        <div className="space-y-3">
          <h3 className="font-black text-slate-800">تفاصيل الأدلة لكل فاتورة (بدون بيانات تعريفية أو مالية)</h3>
          {result.findings.map((finding,index) => (
            <article key={index} className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-black">فاتورة بيع #{index+1}</span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold">{finding.status} · {finding.classification}</span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div>Queue: <b>{finding.queueCount ? 'موجود' : 'غير موجود'}</b></div>
                <div>Outbox: <b>{finding.outboxCount ? 'موجود' : 'غير موجود'}</b></div>
                <div>Failed Mutation: <b>{finding.failedCount ? 'موجود' : 'غير موجود'}</b></div>
                <div>تطابق Mutation: <b>{finding.queueOutboxSameMutation}</b></div>
                <div>الملكية: <b>{finding.ownership}</b></div>
              </div>
              {finding.records.map((record,i) => (
                <div key={i} className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-6">
                  <div className="font-black">{record.store} · {record.status}</div>
                  <div>entityType: {record.entityType} | operationType: {record.operationType} | type: {record.type} | operation: {record.operation}</div>
                  <div>Payload: {record.payloadShape} | الحقول المطلوبة: invoiceNumber {record.requiredFields.invoiceNumber?'✓':'✗'} · type {record.requiredFields.type?'✓':'✗'} · totalAmount {record.requiredFields.totalAmount?'✓':'✗'} · items {record.requiredFields.items?'✓':'✗'}</div>
                  <div>Mutation fingerprint: {record.mutationFingerprint} | Idempotency fingerprint: {record.idempotencyFingerprint} | Owner: {record.ownerCheck}</div>
                  <div>تصنيفات الخطأ: {record.errorCategories.join('، ') || 'لا يوجد خطأ محفوظ قابل للتصنيف'}</div>
                </div>
              ))}
            </article>
          ))}
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-950">
          {result.limitations.map((note,i)=><p key={i}>• {note}</p>)}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-black text-slate-800">Forensic JSON — redacted</h3>
          <button type="button" onClick={copy} className="rounded-lg border border-slate-400 bg-white px-4 py-2 text-xs font-black">نسخ التقرير المنقح</button>
        </div>
        <textarea ref={outputRef} readOnly value={output} rows={22} spellCheck={false}
          aria-label="تقرير فحص المزامنة المحلي المنقح"
          className="w-full rounded-xl border border-slate-300 bg-slate-950 p-3 font-mono text-xs leading-6 text-emerald-100" />
        {copied && <p role="status" className="text-xs text-slate-600">{copied}</p>}
      </>}
    </section>
  );
}
