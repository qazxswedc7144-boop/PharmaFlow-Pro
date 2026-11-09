import { describe, expect, it } from 'vitest';
import { classifyOwner, classifyPayloadShape, buildLocalSyncForensics } from './localSyncQueueForensics';

describe('Local Sync Queue Forensics — read only', () => {
  it('detects a nested sale payload and required top-level contract gaps', () => {
    const result = classifyPayloadShape({ sale: { id: 'doc-1', invoiceNumber: 'hidden' } });
    expect(result.shape).toBe('SALE_NESTED');
    expect(result.fields).toEqual({ invoiceNumber: false, type: false, totalAmount: false, items: false });
  });

  it('detects a flat payload with the required invoice fields', () => {
    const result = classifyPayloadShape({ invoiceNumber: 'x', type: 'SALE', totalAmount: 1, items: [{}] });
    expect(result.shape).toBe('FLAT_OR_UNKNOWN');
    expect(Object.values(result.fields).every(Boolean)).toBe(true);
  });

  it('rejects tenant, user, or branch ownership mismatches', () => {
    const session = { tenantId: 't1', userId: 'u1', branchId: 'b1' };
    expect(classifyOwner({ tenantId: 't2', userId: 'u1', branchId: 'b1' }, {}, session)).toBe('MISMATCH');
    expect(classifyOwner({ tenantId: 't1', userId: 'u2', branchId: 'b1' }, {}, session)).toBe('MISMATCH');
    expect(classifyOwner({ tenantId: 't1', userId: 'u1', branchId: 'b2' }, {}, session)).toBe('MISMATCH');
  });

  it('marks missing ownership metadata as partial, never verified', () => {
    expect(classifyOwner({ tenantId: 't1' }, {}, { tenantId: 't1', userId: 'u1', branchId: 'b1' })).toBe('PARTIAL');
  });

  it('reads only present stores in one readonly transaction and never writes', async () => {
    const data: Record<string, any[]> = {
      invoices: [{ id: 'doc-1', tenantId: 't1', userId: 'u1', branchId: 'b1', type: 'SALE', status: 'POSTED' }],
      sales: [],
      syncQueue: [{ mutationId: 'm1', idempotencyKey: 'secret-key', tenantId: 't1', userId: 'u1', branchId: 'b1', entityType: 'SALE', operationType: 'POST', syncStatus: 'PENDING', payload: { id: 'doc-1', sale: {} } }],
      outbox: [{ mutationId: 'm1', idempotencyKey: 'secret-key', tenantId: 't1', userId: 'u1', branchId: 'b1', entityType: 'SALE', type: 'POST', status: 'PENDING', payload: { id: 'doc-1', sale: {} } }],
      sync_queue: [], failedMutations: [], eventStore: []
    };
    const database: any = {
      verno: 39, isOpen: () => true, tables: Object.keys(data).map(name => ({ name })),
      table: (name: string) => ({ toArray: async () => data[name] }),
      transaction: async (mode: string, ...args: any[]) => {
        expect(mode).toBe('r');
        const callback = args[args.length - 1];
        return callback();
      }
    };
    const result = await buildLocalSyncForensics(database, { tenantId: 't1', userId: 'u1', branchId: 'b1' });
    expect(result.readOnly).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].classification).toBe('QUEUE_AND_OUTBOX');
    expect(result.findings[0].queueOutboxSameMutation).toBe('YES');
    expect(result.findings[0].records[0].mutationFingerprint).not.toBe('m1');
    expect(JSON.stringify(result)).not.toContain('secret-key');
    expect(result.missingStores).toEqual([]);
  });

  it('does not link a row using a non-document reference or a mismatched owner', async () => {
    const data: Record<string, any[]> = {
      invoices: [{ id: 'doc-1', tenantId: 't1', status: 'LOCKED', type: 'SALE' }], sales: [],
      syncQueue: [{ mutationId: 'm1', tenantId: 't2', userId: 'u1', payload: { productId: 'doc-1' } }],
      outbox: [], sync_queue: [], failedMutations: [], eventStore: []
    };
    const database: any = { verno: 1, isOpen: () => true, tables: Object.keys(data).map(name=>({name})),
      table: (name: string) => ({ toArray: async () => data[name] }),
      transaction: async (_mode: string, ...args: any[]) => args[args.length-1]() };
    const result = await buildLocalSyncForensics(database, { tenantId: 't1', userId: 'u1' });
    expect(result.findings[0].classification).toBe('NO_LINKED_SYNC_EVIDENCE');
  });
});
