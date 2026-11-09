import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import {
  buildLocalSyncForensics, classifyOwner, classifyPayloadShape, compareMutationSets, isSale
} from './localSyncQueueForensics';

const session = { tenantId: 'tenant-A', userId: 'active-user', branchId: 'active-branch' };
const postedInvoice = (extra: Record<string, unknown> = {}) => ({
  id: 'private-invoice-id', tenantId: 'tenant-A', userId: 'invoice-creator',
  branchId: 'invoice-branch', type: 'SALE', status: 'POSTED', ...extra
});
function fakeDb(data: Record<string, any[]>) {
  let writeAttempted = false;
  const database: any = {
    verno: 39, isOpen: () => true, tables: Object.keys(data).map(name => ({ name })),
    table: (name: string) => ({ toArray: async () => data[name] }),
    transaction: async (mode: string, ...args: any[]) => {
      expect(mode).toBe('r');
      const callback = args[args.length - 1];
      return callback();
    }
  };
  return { database, didWrite: () => writeAttempted };
}

describe('Local Sync Queue Forensics — hardened read-only', () => {
  it('TypeScript parses both the analyzer and JSX page without diagnostics', () => {
    for (const [file, kind] of [
      ['src/features/inventory/utils/localSyncQueueForensics.ts', ts.ScriptKind.TS],
      ['src/features/inventory/pages/FifoAuditTempPage.tsx', ts.ScriptKind.TSX]
    ] as const) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      const result = ts.transpileModule(source, {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX }
      });
      const parseErrors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
      expect(parseErrors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), file).toEqual([]);
      expect(source).not.toMatch(/\\n/);
    }
  });

  it('fails closed: missing or unknown invoice type is not a SALE', () => {
    expect(isSale({ type: 'SALE' })).toBe(true);
    expect(isSale({ type: undefined })).toBe(false);
    expect(isSale({})).toBe(false);
    expect(isSale({ type: 'PURCHASE' })).toBe(false);
    expect(isSale({ type: 'SALE_RETURN' })).toBe(false);
  });

  it('compares complete mutation multisets and does not treat duplicates as a valid match', () => {
    const row = (mutationId: string) => ({ mutationId });
    expect(compareMutationSets([row('m1'), row('m2')], [row('m1'), row('m2')])).toBe('EXACT_MATCH');
    expect(compareMutationSets([row('m1'), row('m2')], [row('m1')])).toBe('PARTIAL_MATCH');
    expect(compareMutationSets([row('m1'), row('m1')], [row('m1')])).toBe('PARTIAL_MATCH');
    expect(compareMutationSets([row('m1'), row('m1')], [row('m1'), row('m2')])).toBe('PARTIAL_MATCH');
    expect(compareMutationSets([row('m1'), row('m1')], [row('m1'), row('m1')])).toBe('PARTIAL_MATCH');
    expect(compareMutationSets([row('m1')], [row('m2')])).toBe('MISMATCH');
    expect(compareMutationSets([{}], [row('m1')])).toBe('UNKNOWN');
    expect(compareMutationSets([], [row('m1')])).toBe('UNKNOWN');
  });

  it('does not count EventStore as either current or legacy Queue', async () => {
    const { database } = fakeDb({
      invoices: [postedInvoice()], sales: [], syncQueue: [], sync_queue: [], outbox: [], failedMutations: [],
      eventStore: [{ tenantId: 'tenant-A', userId: 'invoice-creator', branchId: 'invoice-branch', payload: { id: 'private-invoice-id' }, mutationId: 'private-mutation' }]
    });
    const result = await buildLocalSyncForensics(database, session);
    const finding = result.findings[0];
    expect(finding.syncQueueCount).toBe(0);
    expect(finding.legacySyncQueueCount).toBe(0);
    expect(finding.eventStoreCount).toBe(1);
    expect(finding.classification).toBe('EVENTSTORE_ONLY');
  });

  it('does not treat active-user or active-branch differences as ownership corruption', () => {
    const invoice = postedInvoice();
    expect(classifyOwner({
      tenantId: 'tenant-A', userId: 'another-user', branchId: 'invoice-branch'
    }, invoice, session)).toBe('PARTIAL');
    expect(classifyOwner({
      tenantId: 'tenant-A', userId: 'invoice-creator', branchId: 'another-branch'
    }, invoice, session)).toBe('PARTIAL');
  });

  it('excludes real tenant mismatches and counts them without exposing the row', async () => {
    const { database } = fakeDb({
      invoices: [postedInvoice()], sales: [],
      syncQueue: [{ tenantId: 'tenant-B', userId: 'invoice-creator', branchId: 'invoice-branch', payload: { id: 'private-invoice-id' }, mutationId: 'secret-mutation' }],
      sync_queue: [], outbox: [], eventStore: [], failedMutations: []
    });
    const result = await buildLocalSyncForensics(database, session);
    expect(result.findings[0].syncQueueCount).toBe(0);
    expect(result.findings[0].rejectedTenantMismatchCount).toBe(1);
    expect(result.summary.tenantMismatchRecordsExcluded).toBe(1);
  });

  it('does not mark records with incomplete ownership as VERIFIED', () => {
    expect(classifyOwner({ tenantId: 'tenant-A' }, postedInvoice(), session)).toBe('PARTIAL');
    expect(classifyOwner({}, postedInvoice(), session)).toBe('PARTIAL');
  });

  it('does not count missing-type POSTED rows as sales', async () => {
    const { database } = fakeDb({
      invoices: [postedInvoice({ type: undefined }), postedInvoice({ id: 'known-sale', type: 'SALE' })],
      sales: [], syncQueue: [], sync_queue: [], outbox: [], eventStore: [], failedMutations: []
    });
    const result = await buildLocalSyncForensics(database, session);
    expect(result.invoiceCount).toBe(1);
    expect(result.unknownTypeCount).toBe(1);
  });

  it('does not expose raw rows, mutation IDs, idempotency keys, names, or amounts in JSON', async () => {
    const { database } = fakeDb({
      invoices: [postedInvoice({ customerName: 'PRIVATE CUSTOMER', totalAmount: 918273 })], sales: [],
      syncQueue: [{
        tenantId: 'tenant-A', userId: 'invoice-creator', branchId: 'invoice-branch',
        mutationId: 'RAW-MUTATION-987654', idempotencyKey: 'RAW-IDEMPOTENCY-123456',
        payload: { id: 'private-invoice-id', sale: { customerName: 'PRIVATE CUSTOMER', totalAmount: 918273 } },
        lastError: 'InvoiceSchema invalid totalAmount'
      }],
      sync_queue: [], outbox: [], eventStore: [], failedMutations: []
    });
    const result = await buildLocalSyncForensics(database, session);
    const json = JSON.stringify(result);
    for (const forbidden of ['RAW-MUTATION-987654','RAW-IDEMPOTENCY-123456','private-invoice-id','PRIVATE CUSTOMER','918273']) {
      expect(json).not.toContain(forbidden);
    }
    expect(json).toContain('PAYLOAD_VALIDATION');
  });

  it('keeps the Dexie transaction readonly and performs no writes', async () => {
    const { database, didWrite } = fakeDb({
      invoices: [postedInvoice()], sales: [], syncQueue: [], sync_queue: [], outbox: [], eventStore: [], failedMutations: []
    });
    const result = await buildLocalSyncForensics(database, session);
    expect(result.readOnly).toBe(true);
    expect(didWrite()).toBe(false);
  });

  it('classifies nested sale payload and flat required-field contract', () => {
    const nested = classifyPayloadShape({ sale: { id: 'doc', invoiceNumber: 'hidden' } });
    expect(nested.shape).toBe('SALE_NESTED');
    expect(nested.fields).toEqual({ invoiceNumber: false, type: false, totalAmount: false, items: false });
    const flat = classifyPayloadShape({ invoiceNumber: 'x', type: 'SALE', totalAmount: 1, items: [{}] });
    expect(Object.values(flat.fields).every(Boolean)).toBe(true);
  });
});
