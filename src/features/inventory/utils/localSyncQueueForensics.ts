export type ForensicSession = { tenantId: string; userId?: string; branchId?: string };
type Row = Record<string, any>;
type OwnerResult = 'VERIFIED' | 'PARTIAL' | 'UNVERIFIABLE' | 'TENANT_MISMATCH' | 'USER_MISMATCH' | 'BRANCH_MISMATCH';
type MutationMatch = 'EXACT_MATCH' | 'PARTIAL_MATCH' | 'MISMATCH' | 'UNKNOWN';
type EvidenceStore = 'syncQueue' | 'sync_queue' | 'outbox' | 'eventStore' | 'failedMutations';
type LinkedRow = { row: Row; invoiceId: string };

export type InvoiceSyncFinding = {
  source: 'invoices' | 'sales';
  status: string;
  syncQueueCount: number;
  legacySyncQueueCount: number;
  outboxCount: number;
  eventStoreCount: number;
  failedMutationCount: number;
  classification: string;
  ownership: OwnerResult | 'TENANT_MISMATCH_RECORDS_EXCLUDED';
  rejectedTenantMismatchCount: number;
  queueOutboxMutationMatch: MutationMatch;
  records: Array<{
    store: string; entityType: string; operationType: string; type: string; operation: string;
    status: string; mutationIdPresent: boolean; idempotencyKeyPresent: boolean;
    payloadShape: string;
    requiredFields: { invoiceNumber: boolean; type: boolean; totalAmount: boolean; items: boolean };
    errorCategories: string[]; ownerCheck: OwnerResult;
  }>;
};

export type LocalSyncForensics = {
  generatedAt: string; readOnly: true; databaseVersion: number;
  detectedStores: string[]; missingStores: string[];
  invoiceCount: number; unknownTypeCount: number;
  findings: InvoiceSyncFinding[];
  summary: Record<string, number>;
  limitations: string[];
};

const STORES = ['invoices','sales','syncQueue','outbox','sync_queue','failedMutations','eventStore'] as const;
const text = (v: unknown) => v == null ? '' : String(v).trim();
const first = (r: Row, keys: string[]) => {
  for (const k of keys) if (r?.[k] != null && r[k] !== '') return r[k];
  return undefined;
};
const owner = (r: Row, key: 'tenantId'|'userId'|'branchId') => text(first(r,
  key === 'tenantId' ? ['tenantId','tenant_id'] :
  key === 'userId' ? ['userId','user_id','createdBy','created_by','creatorId','creator_id'] :
  ['branchId','branch_id']));
const invoiceId = (r: Row) => text(first(r,['id','invoiceId','invoice_id','saleId','SaleID']));
const aliases = (r: Row) => [...new Set([invoiceId(r), text(first(r,['invoiceId','invoice_id','saleId','SaleID']))].filter(Boolean))];
const status = (r: Row) => text(first(r,['documentStatus','document_status','invoiceStatus','InvoiceStatus','status'])).toUpperCase();
export function saleTypeOf(r: Row): 'SALE'|'RETURN'|'UNKNOWN'|'OTHER' {
  const raw=text(first(r,['type','invoiceType','invoice_type'])).toUpperCase();
  if (r?.isReturn === true || r?.is_return === true || raw.includes('RETURN')) return 'RETURN';
  if (raw === 'SALE') return 'SALE';
  if (!raw) return 'UNKNOWN';
  return 'OTHER';
}
export const isSale = (r: Row) => saleTypeOf(r) === 'SALE';
const payloadOf = (r: Row): Row => (r?.payload && typeof r.payload === 'object' ? r.payload : r);
const documentRefs = (r: Row): string[] => {
  const p=payloadOf(r), nested=p?.sale && typeof p.sale === 'object' ? p.sale : undefined;
  return [...new Set([
    first(p,['id','refId','invoiceId','invoice_id','saleId','sale_id','documentId','document_id','entityId','entity_id']),
    first(nested || {},['id','refId','invoiceId','invoice_id','saleId','sale_id'])
  ].map(text).filter(Boolean))];
};
export function classifyPayloadShape(payload: Row) {
  const p=payloadOf({payload});
  const nested=Boolean(p?.sale && typeof p.sale === 'object');
  const fields={
    invoiceNumber:Boolean(first(p,['invoiceNumber','invoice_number'])),
    type:Boolean(first(p,['type','invoiceType','invoice_type'])),
    totalAmount:p?.totalAmount != null || p?.total_amount != null,
    items:Array.isArray(p?.items)
  };
  return {shape:nested ? 'SALE_NESTED' : 'FLAT_OR_UNKNOWN',fields};
}
export function classifyOwner(record: Row, invoice: Row, session: ForensicSession): OwnerResult {
  const recordTenant=owner(record,'tenantId');
  const invoiceTenant=owner(invoice,'tenantId');
  if (recordTenant && invoiceTenant && recordTenant !== invoiceTenant) return 'TENANT_MISMATCH';
  if (recordTenant && session.tenantId && recordTenant !== session.tenantId) return 'TENANT_MISMATCH';
  if (!recordTenant || !invoiceTenant) return 'PARTIAL';
  let comparable=0;
  for (const key of ['userId','branchId'] as const) {
    const recordValue=owner(record,key), invoiceValue=owner(invoice,key);
    if (recordValue && invoiceValue) {
      comparable++;
      if (recordValue !== invoiceValue) return key === 'userId' ? 'USER_MISMATCH' : 'BRANCH_MISMATCH';
    }
  }
  return comparable === 2 ? 'VERIFIED' : 'PARTIAL';
}
const errorCategories = (r: Row): string[] => {
  const raw=text(first(r,['lastError','error','reason','message','errorMessage','failureReason'])).toLowerCase();
  if (!raw) return [];
  const categories: string[]=[];
  if (/schema|required|invalid|validation|zod/.test(raw)) categories.push('PAYLOAD_VALIDATION');
  if (/tenant|owner|user|branch|permission|unauthori[sz]ed|forbidden/.test(raw)) categories.push('OWNERSHIP_OR_AUTHORIZATION');
  if (/network|timeout|fetch|socket|offline|connection/.test(raw)) categories.push('TRANSPORT');
  if (/duplicate|idempot/.test(raw)) categories.push('IDEMPOTENCY');
  if (/conflict|version/.test(raw)) categories.push('CONFLICT');
  if (!categories.length) categories.push('OTHER_REDACTED');
  return categories;
};
const mutationId = (r: Row) => text(first(r,['mutationId','mutation_id']));
const safeCategory = (value: unknown, allowed: ReadonlySet<string>): string => {
  const normalized = text(value).toUpperCase();
  return allowed.has(normalized) ? normalized : 'UNKNOWN';
};
const SAFE_ENTITY_TYPES = new Set([
  'INVOICE','SALE','SALES_INVOICE','PURCHASE','PURCHASE_INVOICE',
  'RETURN','SALES_RETURN','PURCHASE_RETURN'
]);
const SAFE_OPERATION_TYPES = new Set([
  'CREATE','UPDATE','DELETE','UPSERT','POST','SYNC','RETRY','VOID','CANCEL','RESTORE'
]);
const SAFE_OPERATIONS = new Set([
  'CREATE','UPDATE','DELETE','UPSERT','POST','SYNC','RETRY','VOID','CANCEL','RESTORE'
]);
const SAFE_RECORD_TYPES = new Set([
  'SALE','PURCHASE','SALE_RETURN','PURCHASE_RETURN','RETURN','INVOICE'
]);
const SAFE_SYNC_STATUSES = new Set([
  'PENDING','PROCESSING','FAILED','COMPLETED','SUCCESS','ENQUEUED',
  'SYNCED','RETRYING','BLOCKED','CANCELLED','DEAD_LETTER'
]);
const normalizedRecord = (store: string, r: Row, invoice: Row, session: ForensicSession) => {
  const p=payloadOf(r), shape=classifyPayloadShape(p);
  return {
    store,
    entityType:safeCategory(first(r,['entityType','entity_type']), SAFE_ENTITY_TYPES),
    operationType:safeCategory(first(r,['operationType','operation_type']), SAFE_OPERATION_TYPES),
    type:safeCategory(r.type, SAFE_RECORD_TYPES),
    operation:safeCategory(r.operation, SAFE_OPERATIONS),
    status:safeCategory(first(r,['syncStatus','status','state']), SAFE_SYNC_STATUSES),
    mutationIdPresent:Boolean(mutationId(r)),
    idempotencyKeyPresent:Boolean(first(r,['idempotencyKey','idempotency_key'])),
    payloadShape:shape.shape,
    requiredFields:shape.fields,
    errorCategories:errorCategories(r),
    ownerCheck:classifyOwner(r,invoice,session)
  };
};
export function compareMutationSets(queueRows: Row[], outboxRows: Row[]): MutationMatch {
  if (!queueRows.length || !outboxRows.length) return 'UNKNOWN';
  const q=queueRows.map(mutationId), o=outboxRows.map(mutationId);
  if (q.some(v=>!v) || o.some(v=>!v)) return 'UNKNOWN';
  const qCounts=new Map<string,number>(), oCounts=new Map<string,number>();
  q.forEach(v=>qCounts.set(v,(qCounts.get(v)||0)+1));
  o.forEach(v=>oCounts.set(v,(oCounts.get(v)||0)+1));
  const keys=new Set([...qCounts.keys(),...oCounts.keys()]);
  const hasDuplicates=[...qCounts.values(),...oCounts.values()].some(count=>count>1);
  const same=[...keys].every(k=>qCounts.get(k)===oCounts.get(k));
  const overlap=[...keys].some(k=>qCounts.has(k)&&oCounts.has(k));
  if (same && q.length===o.length && !hasDuplicates) return 'EXACT_MATCH';
  if (overlap) return 'PARTIAL_MATCH';
  return 'MISMATCH';
}
export async function buildLocalSyncForensics(database: any, session: ForensicSession): Promise<LocalSyncForensics> {
  if (!database?.isOpen?.()) throw new Error('Dexie غير مفتوحة؛ أوقف الفحص دون محاولة فتحها.');
  if (!session?.tenantId) throw new Error('هوية المستأجر النشطة مطلوبة للفحص الآمن.');
  const available = new Set<string>((database.tables || []).map((t: any)=>t.name));
  const detectedStores = STORES.filter(name=>available.has(name));
  const missingStores = STORES.filter(name=>!available.has(name));
  const tables = detectedStores.map(name=>database.table(name));
  if (!available.has('invoices') && !available.has('sales')) throw new Error('لا يوجد مخزن invoices أو sales.');
  const snapshots: Record<string, Row[]> = {};
  await database.transaction('r', ...tables, async () => {
    await Promise.all(detectedStores.map(async name => { snapshots[name]=await database.table(name).toArray(); }));
  });
  const activeInvoices = new Map<string,{row:Row;source:'invoices'|'sales'}>();
  let unknownTypeCount=0;
  for (const source of ['invoices','sales'] as const) {
    for (const row of snapshots[source] || []) {
      if (owner(row,'tenantId') !== session.tenantId || saleTypeOf(row)==='RETURN' || !['POSTED','LOCKED'].includes(status(row))) continue;
      const saleType=saleTypeOf(row);
      if (saleType==='UNKNOWN') { unknownTypeCount++; continue; }
      if (saleType!=='SALE') continue;
      const id=invoiceId(row);
      if (id && !activeInvoices.has(id)) activeInvoices.set(id,{row,source});
    }
  }
  const aliasOwners = new Map<string,Set<string>>();
  for (const [id,item] of activeInvoices) for (const alias of aliases(item.row)) {
    if (!aliasOwners.has(alias)) aliasOwners.set(alias,new Set());
    aliasOwners.get(alias)!.add(id);
  }
  const sourceRows: EvidenceStore[] = ['syncQueue','sync_queue','outbox','eventStore','failedMutations'];
  const all: Record<EvidenceStore,LinkedRow[]> = { syncQueue:[], sync_queue:[], outbox:[], eventStore:[], failedMutations:[] };
  const rejectedTenantCounts = new Map<string,number>();
  for (const store of sourceRows) {
    for (const row of snapshots[store] || []) {
      const refs=documentRefs(row), matches=new Set<string>();
      for (const ref of refs) {
        const ids=aliasOwners.get(ref);
        if (ids?.size===1) ids.forEach(id=>matches.add(id));
      }
      if (matches.size!==1) continue;
      const id=matches.values().next().value as string;
      const inv=activeInvoices.get(id)?.row;
      if (!inv) continue;
      if (classifyOwner(row,inv,session)==='TENANT_MISMATCH') {
        rejectedTenantCounts.set(id,(rejectedTenantCounts.get(id)||0)+1);
        continue;
      }
      all[store].push({row,invoiceId:id});
    }
  }
  const findings: InvoiceSyncFinding[]=[];
  for (const [id,item] of activeInvoices) {
    const q=all.syncQueue.filter(x=>x.invoiceId===id).map(x=>x.row);
    const legacy=all.sync_queue.filter(x=>x.invoiceId===id).map(x=>x.row);
    const o=all.outbox.filter(x=>x.invoiceId===id).map(x=>x.row);
    const ev=all.eventStore.filter(x=>x.invoiceId===id).map(x=>x.row);
    const failed=all.failedMutations.filter(x=>x.invoiceId===id).map(x=>x.row);
    const normalized: InvoiceSyncFinding['records'] = [];
    for (const [store,rows] of [['syncQueue',q],['sync_queue',legacy],['outbox',o],['eventStore',ev],['failedMutations',failed]] as Array<[EvidenceStore,Row[]]>) {
      for (const row of rows) normalized.push(normalizedRecord(store,row,item.row,session));
    }
    const queueOutboxMutationMatch=compareMutationSets([...q,...legacy],o);
    const syncQueueCount=q.length;
    const legacySyncQueueCount=legacy.length;
    const outboxCount=o.length;
    const eventStoreCount=ev.length;
    const failedMutationCount=failed.length;
    const hasQueue=syncQueueCount+legacySyncQueueCount>0;
    const hasOutbox=outboxCount>0;
    const classification=hasQueue&&hasOutbox?'QUEUE_AND_OUTBOX':hasQueue?'QUEUE_ONLY':hasOutbox?'OUTBOX_ONLY':failedMutationCount?'FAILED_MUTATION_ONLY':eventStoreCount?'EVENTSTORE_ONLY':'NO_LINKED_SYNC_EVIDENCE';
    const rejectedTenantMismatchCount=rejectedTenantCounts.get(id)||0;
    const ownerStates=normalized.map(r=>r.ownerCheck);
    const ownership: InvoiceSyncFinding['ownership']=rejectedTenantMismatchCount?'TENANT_MISMATCH_RECORDS_EXCLUDED':
      ownerStates.length&&ownerStates.every(v=>v==='VERIFIED')?'VERIFIED':
      ownerStates.some(v=>v==='PARTIAL'||v==='USER_MISMATCH'||v==='BRANCH_MISMATCH')?'PARTIAL':'UNVERIFIABLE';
    findings.push({source:item.source,status:status(item.row),syncQueueCount,legacySyncQueueCount,outboxCount,eventStoreCount,failedMutationCount,classification,ownership,rejectedTenantMismatchCount,queueOutboxMutationMatch,records:normalized});
  }
  const summary={postedLockedSales:findings.length,unknownTypePostedLocked:unknownTypeCount,withSyncQueue:0,withLegacySyncQueue:0,withOutbox:0,withEventStore:0,withFailedMutation:0,exactMutationMatch:0,partialMutationMatch:0,mutationMismatch:0,tenantMismatchRecordsExcluded:0};
  for (const f of findings) {
    if (f.syncQueueCount) summary.withSyncQueue++;
    if (f.legacySyncQueueCount) summary.withLegacySyncQueue++;
    if (f.outboxCount) summary.withOutbox++;
    if (f.eventStoreCount) summary.withEventStore++;
    if (f.failedMutationCount) summary.withFailedMutation++;
    if (f.queueOutboxMutationMatch==='EXACT_MATCH') summary.exactMutationMatch++;
    if (f.queueOutboxMutationMatch==='PARTIAL_MATCH') summary.partialMutationMatch++;
    if (f.queueOutboxMutationMatch==='MISMATCH') summary.mutationMismatch++;
    summary.tenantMismatchRecordsExcluded+=f.rejectedTenantMismatchCount;
  }
  return {
    generatedAt:new Date().toISOString(),readOnly:true,databaseVersion:database.verno,
    detectedStores,missingStores,invoiceCount:findings.length,unknownTypeCount,findings,summary,
    limitations:[
      'الربط يعتمد على مراجع المستند الدقيقة فقط؛ لا يُستخدم رقم الفاتورة أو اسم العميل أو المنتج.',
      'tenantId هو حاجز العزل الأساسي؛ اختلاف المستخدم أو الفرع عن الجلسة النشطة لا يؤدي وحده إلى الاستبعاد.',
      'اختلاف userId أو branchId بين سجل المزامنة والفاتورة يصنف PARTIAL ولا يثبت فساد الملكية.',
      'السجلات الناقصة بيانات الملكية تصنف PARTIAL أو UNVERIFIABLE ولا تعتبر VERIFIED.',
      'eventStore دليل مستقل ولا يدخل ضمن Queue counts أو مقارنة Mutation.',
      'لا تُخرج المخرجات أي سجل خام أو معرف Mutation أو Idempotency أو قيمة مالية.',
      'NO_LINKED_SYNC_EVIDENCE يعني عدم العثور على ارتباط دقيق في المخازن الموجودة فقط، ولا يثبت فشل المزامنة.'
    ]
  };
}
