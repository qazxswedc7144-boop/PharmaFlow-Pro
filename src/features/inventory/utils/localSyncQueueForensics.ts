export type ForensicSession = { tenantId: string; userId?: string; branchId?: string };
type Row = Record<string, any>;
export type InvoiceSyncFinding = {
  source: 'invoices' | 'sales'; status: string; queueCount: number; outboxCount: number; failedCount: number;
  classification: string; ownership: string; queueOutboxSameMutation: 'YES' | 'NO' | 'UNKNOWN';
  records: Array<{ store: string; entityType: string; operationType: string; type: string; operation: string;
    status: string; mutationFingerprint: string; idempotencyFingerprint: string; payloadShape: string;
    requiredFields: { invoiceNumber: boolean; type: boolean; totalAmount: boolean; items: boolean };
    errorCategories: string[]; ownerCheck: string }>;
};
export type LocalSyncForensics = {
  generatedAt: string; readOnly: true; databaseVersion: number; detectedStores: string[]; missingStores: string[];
  invoiceCount: number; findings: InvoiceSyncFinding[]; summary: Record<string, number>; limitations: string[];
};
const STORES = ['invoices','sales','syncQueue','outbox','sync_queue','failedMutations','eventStore'] as const;
const text = (v: unknown) => v == null ? '' : String(v).trim();
const first = (r: Row, keys: string[]) => { for (const k of keys) if (r?.[k] != null && r[k] !== '') return r[k]; return undefined; };
const owner = (r: Row, key: string) => text(first(r, key === 'tenantId' ? ['tenantId','tenant_id'] : key === 'userId' ? ['userId','user_id','actorId'] : ['branchId','branch_id']));
const invoiceId = (r: Row) => text(first(r,['id','invoiceId','invoice_id','saleId','SaleID']));
const aliases = (r: Row) => [...new Set([invoiceId(r), text(first(r,['invoiceId','invoice_id','saleId','SaleID']))].filter(Boolean))];
const status = (r: Row) => text(first(r,['documentStatus','document_status','invoiceStatus','InvoiceStatus','status'])).toUpperCase();
const isSale = (r: Row) => { const t=text(first(r,['type','invoiceType','invoice_type'])).toUpperCase(); return !t || t === 'SALE'; };
const isReturn = (r: Row) => r?.isReturn === true || r?.is_return === true || text(first(r,['type','invoiceType','invoice_type'])).toUpperCase().includes('RETURN');
const payloadOf = (r: Row): Row => (r?.payload && typeof r.payload === 'object' ? r.payload : r);
const documentRefs = (r: Row): string[] => {
  const p=payloadOf(r), nested=p?.sale && typeof p.sale === 'object' ? p.sale : undefined;
  return [...new Set([
    first(p,['id','refId','invoiceId','invoice_id','saleId','sale_id','documentId','document_id','entityId','entity_id']),
    first(nested || {},['id','refId','invoiceId','invoice_id','saleId','sale_id'])
  ].map(text).filter(Boolean))];
};
const sha = async (value: unknown) => {
  const raw=text(value); if (!raw) return 'غير متوفر';
  try {
    const bytes = new TextEncoder().encode(raw);
    const digest = await globalThis.crypto.subtle.digest('SHA-256',bytes);
    return Array.from(new Uint8Array(digest)).slice(0,6).map(x=>x.toString(16).padStart(2,'0')).join('');
  } catch { return 'متاح-بصمة-غير-متوفرة'; }
};
export function classifyPayloadShape(payload: Row) {
  const p=payloadOf({payload});
  const nested=Boolean(p?.sale && typeof p.sale === 'object');
  const fields={invoiceNumber:Boolean(first(p,['invoiceNumber','invoice_number'])),
    type:Boolean(first(p,['type','invoiceType','invoice_type'])),
    totalAmount:p?.totalAmount != null || p?.total_amount != null,
    items:Array.isArray(p?.items)};
  return {shape:nested ? 'SALE_NESTED' : 'FLAT_OR_UNKNOWN',fields};
}
export function classifyOwner(record: Row, invoice: Row, session: ForensicSession) {
  const checks: string[]=[];
  for (const key of ['tenantId','userId','branchId'] as const) {
    const a=owner(record,key), b=key==='tenantId'?text(session.tenantId):key==='userId'?text(session.userId):text(session.branchId);
    const invoiceValue=owner(invoice,key);
    if (a && b && a!==b) return 'MISMATCH';
    if (a && invoiceValue && a!==invoiceValue) return 'MISMATCH';
    if (!a) checks.push(key+':MISSING');
  }
  return checks.length ? 'PARTIAL' : 'VERIFIED';
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
const recordId = (r: Row) => text(first(r,['mutationId','mutation_id']));
const keyId = (r: Row) => text(first(r,['idempotencyKey','idempotency_key']));
const normalizedRecord = async (store: string, r: Row, invoice: Row, session: ForensicSession) => {
  const p=payloadOf(r), shape=classifyPayloadShape(p);
  return {
    store, entityType:text(first(r,['entityType','entity_type'])).toUpperCase() || 'UNKNOWN',
    operationType:text(first(r,['operationType','operation_type'])).toUpperCase() || 'UNKNOWN',
    type:text(r.type).toUpperCase() || 'UNKNOWN', operation:text(r.operation).toUpperCase() || 'UNKNOWN',
    status:text(first(r,['syncStatus','status','state'])).toUpperCase() || 'UNKNOWN',
    mutationFingerprint:await sha(recordId(r)), idempotencyFingerprint:await sha(keyId(r)),
    payloadShape:shape.shape, requiredFields:shape.fields, errorCategories:errorCategories(r),
    ownerCheck:classifyOwner(r,invoice,session)
  };
};
export async function buildLocalSyncForensics(database: any, session: ForensicSession): Promise<LocalSyncForensics> {
  if (!database?.isOpen?.()) throw new Error('Dexie غير مفتوحة؛ أوقف الفحص دون محاولة فتحها.');
  if (!session?.tenantId || !session?.userId) throw new Error('هوية المستأجر والمستخدم النشطة مطلوبة للفحص الآمن.');
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
  for (const source of ['invoices','sales'] as const) {
    for (const row of snapshots[source] || []) {
      if (owner(row,'tenantId') !== session.tenantId || !isSale(row) || isReturn(row) || !['POSTED','LOCKED'].includes(status(row))) continue;
      const id=invoiceId(row); if (id && !activeInvoices.has(id)) activeInvoices.set(id,{row,source});
    }
  }
  const aliasOwners = new Map<string,Set<string>>();
  for (const [id,item] of activeInvoices) for (const alias of aliases(item.row)) {
    if (!aliasOwners.has(alias)) aliasOwners.set(alias,new Set()); aliasOwners.get(alias)!.add(id);
  }
  const sourceRows = ['syncQueue','sync_queue','outbox','eventStore','failedMutations'];
  const all: Record<string,Array<{row:Row;store:string;invoiceId:string}>> = {};
  for (const store of sourceRows) {
    all[store]=[];
    for (const row of snapshots[store] || []) {
      const refs=documentRefs(row), matches=new Set<string>();
      for (const ref of refs) { const ids=aliasOwners.get(ref); if (ids?.size===1) ids.forEach(id=>matches.add(id)); }
      if (matches.size!==1) continue;
      const id=[...matches][0], inv=activeInvoices.get(id)?.row; if (!inv) continue;
      if (classifyOwner(row,inv,session)==='MISMATCH') continue;
      all[store].push({row,store,invoiceId:id});
    }
  }
  const findings: InvoiceSyncFinding[]=[];
  for (const [id,item] of activeInvoices) {
    const q=all.syncQueue.filter(x=>x.invoiceId===id).map(x=>x.row);
    const legacy=all.sync_queue.filter(x=>x.invoiceId===id).map(x=>x.row);
    const o=all.outbox.filter(x=>x.invoiceId===id).map(x=>x.row);
    const ev=all.eventStore.filter(x=>x.invoiceId===id).map(x=>x.row);
    const failed=all.failedMutations.filter(x=>x.invoiceId===id).map(x=>x.row);
    const queue=[...q,...legacy,...ev], normalized=[];
    for (const [store,rows] of [['syncQueue',q],['sync_queue',legacy],['outbox',o],['eventStore',ev],['failedMutations',failed]] as Array<[string,Row[]]>) {
      for (const row of rows) normalized.push(await normalizedRecord(store,row,item.row,session));
    }
    const qMutations=new Set(queue.map(recordId).filter(Boolean)), oMutations=new Set(o.map(recordId).filter(Boolean));
    const queueOutboxSameMutation = qMutations.size && oMutations.size
      ? ([...qMutations].some(m=>oMutations.has(m))?'YES':'NO') : 'UNKNOWN';
    const hasQueue=q.length+legacy.length+ev.length>0, hasOutbox=o.length>0;
    const classification = hasQueue && hasOutbox ? 'QUEUE_AND_OUTBOX' : hasQueue ? 'QUEUE_ONLY' : hasOutbox ? 'OUTBOX_ONLY' : failed.length ? 'FAILED_MUTATION_ONLY' : 'NO_LINKED_SYNC_EVIDENCE';
    const ownership=normalized.every(r=>r.ownerCheck==='VERIFIED')?'VERIFIED':normalized.some(r=>r.ownerCheck==='MISMATCH')?'MISMATCH':'PARTIAL_OR_MISSING';
    findings.push({source:item.source,status:status(item.row),queueCount:q.length+legacy.length+ev.length,outboxCount:o.length,failedCount:failed.length,classification,ownership,queueOutboxSameMutation,records:normalized});
  }
  const summary: Record<string,number>={postedLockedInvoices:findings.length,withQueue:0,withOutbox:0,withFailedMutation:0,noLinkedSyncEvidence:0,mutationMismatch:0,payloadNestedSale:0,flatPayload:0,missingRequiredFields:0};
  for (const f of findings) {
    if (f.queueCount) summary.withQueue++;
    if (f.outboxCount) summary.withOutbox++;
    if (f.failedCount) summary.withFailedMutation++;
    if (f.classification==='NO_LINKED_SYNC_EVIDENCE') summary.noLinkedSyncEvidence++;
    if (f.queueOutboxSameMutation==='NO') summary.mutationMismatch++;
    for (const r of f.records) {
      if (r.payloadShape==='SALE_NESTED') summary.payloadNestedSale++;
      else summary.flatPayload++;
      if (!Object.values(r.requiredFields).every(Boolean)) summary.missingRequiredFields++;
    }
  }
  return {generatedAt:new Date().toISOString(),readOnly:true,databaseVersion:database.verno,detectedStores,missingStores,invoiceCount:findings.length,findings,summary,
    limitations:['الربط يعتمد فقط على معرّفات المستند الدقيقة في payload؛ لا يُستخدم رقم الفاتورة أو اسم العميل أو المنتج.','المخازن التي لا تحمل tenantId/userId/branchId تُصنّف ملكيتها جزئية ولا تُعتبر دليلاً مؤكداً.','eventStore قد لا يحمل بيانات ملكية أو مرجع مستند؛ عدم الربط لا يثبت غياب الحدث.','لا تُقرأ البيانات من الخادم ولا تُرسل أي طلبات.','لا تُعرض قيم mutationId أو idempotencyKey الخام؛ البصمات SHA-256 مختصرة.','NO_LINKED_SYNC_EVIDENCE يعني عدم العثور على ارتباط دقيق في المخازن الموجودة فقط، ولا يثبت فشل المزامنة.']};
}
