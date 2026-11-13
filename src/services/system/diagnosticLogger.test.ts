import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, dbInstance } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { InvoiceRepository } from '@/database/repositories/invoice.repository';
import { readDiagnosticLogs, writeDiagnosticLog } from './diagnosticLogger';

describe('DiagnosticLogger', () => {
  beforeEach(async () => {
    await db.open();
    TokenProvider.setSession(
      { id: 'diagnostic-user', tenantId: 'diagnostic-tenant', branchId: 'diagnostic-branch' } as any,
      'diagnostic-access-token',
      'diagnostic-refresh-token'
    );
    await (db as any).diagnosticLogs.where('tenantId').equals('diagnostic-tenant').delete();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    TokenProvider.clearSession();
  });

  it('writes and reads a tenant-scoped diagnostic record', async () => {
    await writeDiagnosticLog(db, new TypeError('sample failure'), {
      operation: 'PURCHASE_SAVE',
      tenantId: 'diagnostic-tenant',
      userId: 'diagnostic-user',
      context: { invoiceNumber: 'PUR-TEST-1' }
    });

    const logs = await readDiagnosticLogs(db, 'diagnostic-tenant');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toBeDefined();
    expect(logs[0]!).toMatchObject({
      operation: 'PURCHASE_SAVE',
      errorName: 'TypeError',
      errorMessage: 'sample failure',
      tenantId: 'diagnostic-tenant',
      context: { invoiceNumber: 'PUR-TEST-1', tenantId: 'diagnostic-tenant', userId: 'diagnostic-user' }
    });
    expect(logs[0]!.id).toBeTruthy();
    expect(logs[0]!.timestamp).toBeTruthy();
  });

  it('retains only the newest 50 records for a tenant', async () => {
    for (let index = 0; index < 51; index += 1) {
      await writeDiagnosticLog(db, new Error(`failure-${index}`), {
        operation: 'PURCHASE_SAVE',
        tenantId: 'diagnostic-tenant',
        userId: 'diagnostic-user'
      });
    }

    const logs = await readDiagnosticLogs(db, 'diagnostic-tenant');
    expect(logs).toHaveLength(50);
    expect(logs.some(log => log.errorMessage === 'failure-0')).toBe(false);
    expect(logs.some(log => log.errorMessage === 'failure-50')).toBe(true);
  });

  it('T-DIAG-01 captures a duplicate IndexedDB key failure from savePurchase', async () => {
    vi.spyOn(dbInstance, 'processPurchase').mockImplementation(async () => {
      const invoice = {
        id: 'DUPLICATE-PURCHASE-ID',
        tenantId: 'diagnostic-tenant',
        branchId: 'diagnostic-branch',
        type: 'PURCHASE'
      };
      await db.invoices.add(invoice as any);
      await db.invoices.add(invoice as any);
      return invoice;
    });

    await expect(
      InvoiceRepository.savePurchase('supplier-1', [], 0, 'DUPLICATE-PURCHASE-ID', false, undefined, 'POSTED', 0, 'LOW', 'PUR-DUP-1')
    ).rejects.toMatchObject({ name: 'ConstraintError' });

    const logs = await readDiagnosticLogs(db, 'diagnostic-tenant');
    expect(logs[0]).toBeDefined();
    expect(logs[0]!).toMatchObject({
      operation: 'DEXIE_SAVE_PURCHASE',
      errorName: 'ConstraintError',
      tenantId: 'diagnostic-tenant',
      context: { invoiceNumber: 'PUR-DUP-1', invoiceId: 'DUPLICATE-PURCHASE-ID' }
    });
  });

  it('does not mask the original business error when diagnostic persistence fails', async () => {
    vi.spyOn(db.diagnosticLogs, 'add').mockRejectedValueOnce(new Error('diagnostic storage unavailable'));

    await expect(
      writeDiagnosticLog(db, new Error('original purchase failure'), {
        operation: 'PURCHASE_SAVE',
        tenantId: 'diagnostic-tenant',
        userId: 'diagnostic-user'
      })
    ).resolves.toBeUndefined();
  });
});
