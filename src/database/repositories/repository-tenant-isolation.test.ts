import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { AccountingRepository } from './AccountingRepository';
import { FinancialTransactionRepository } from './FinancialTransactionRepository';
import { SupplierRepository } from './SupplierRepository';
import { ensureActiveBranchRegistered } from '@/features/branches/services/activeBranchRegistry';

const tenantA = 'repo-isolation-tenant-a';
const tenantB = 'repo-isolation-tenant-b';
const branchA = 'repo-isolation-branch-a';
const branchB = 'repo-isolation-branch-b';
const sourceId = 'repo-isolation-source';
const referenceId = 'repo-isolation-reference';

const ids = {
  journalA: 'repo-isolation-je-a',
  journalB: 'repo-isolation-je-b',
  financialA: 'repo-isolation-ft-a',
  financialOtherTenant: 'repo-isolation-ft-other-tenant',
  financialOtherBranch: 'repo-isolation-ft-other-branch',
  supplierNull: 'repo-isolation-supplier-null',
  supplierUndefined: 'repo-isolation-supplier-undefined',
  customerNull: 'repo-isolation-customer-null',
  customerUndefined: 'repo-isolation-customer-undefined'
};

const setSession = (tenantId: string, branchId: string) => {
  TokenProvider.setSession(
    { id: `repo-isolation-user-${tenantId}`, tenantId, branchId } as any,
    `repo-isolation-token-${tenantId}`,
    { tenantId, branchId }
  );
};

describe('Dexie repository tenant isolation and null-safe search', () => {
  beforeEach(async () => {
    await db.open();
    setSession(tenantA, branchA);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    setSession(tenantA, branchA);
    await db.journalEntries.where('sourceId').equals(sourceId).delete().catch(() => undefined);
    await db.financialTransactions.where('Reference_ID').equals(referenceId).delete().catch(() => undefined);
    for (const id of Object.values(ids)) {
      await db.suppliers.delete(id).catch(() => undefined);
      await db.customers.delete(id).catch(() => undefined);
    }

    setSession(tenantB, branchA);
    await db.journalEntries.where('sourceId').equals(sourceId).delete().catch(() => undefined);
    await db.financialTransactions.where('Reference_ID').equals(referenceId).delete().catch(() => undefined);
    TokenProvider.clearSession();
  });

  it('returns a controlled offline error when the authenticated branch is not trusted locally', async () => {
    vi.stubGlobal('navigator', { onLine: false });

    await expect(ensureActiveBranchRegistered({
      tenantId: tenantA,
      branchId: 'repo-isolation-branch-not-cached'
    })).rejects.toThrow('BRANCH_CONTEXT_UNAVAILABLE_OFFLINE');
  });

  it('fails closed when deleting journal entries without a tenant context', async () => {
    await expect(
      AccountingRepository.deleteEntriesBySource(sourceId, undefined as unknown as string)
    ).rejects.toThrow('FAIL_CLOSED: Tenant context required for deletion');
  });

  it('deletes source journal entries only within the supplied tenant', async () => {
    await db.journalEntries.put({
      id: ids.journalA, sourceId, tenantId: tenantA, branchId: branchA, lines: []
    } as any);
    setSession(tenantB, branchA);
    await db.journalEntries.put({
      id: ids.journalB, sourceId, tenantId: tenantB, branchId: branchA, lines: []
    } as any);

    setSession(tenantA, branchA);
    await AccountingRepository.deleteEntriesBySource(sourceId, tenantA);

    await expect(db.journalEntries.get(ids.journalA)).resolves.toBeUndefined();
    setSession(tenantB, branchA);
    await expect(db.journalEntries.get(ids.journalB)).resolves.toMatchObject({ tenantId: tenantB });
  });

  it('fails closed when looking up financial transactions without tenant context', async () => {
    await expect(
      FinancialTransactionRepository.getByReference(referenceId, undefined as unknown as string)
    ).rejects.toThrow('FAIL_CLOSED');
  });

  it('fails closed when reversing financial transactions without tenant context', async () => {
    await expect(
      FinancialTransactionRepository.reverseTransactions(
        referenceId,
        undefined as unknown as string,
        branchA
      )
    ).rejects.toThrow('FAIL_CLOSED');
  });

  it('fails closed when cancelling financial transactions without branch context', async () => {
    await expect(
      FinancialTransactionRepository.cancelTransaction(
        referenceId,
        tenantA,
        'default'
      )
    ).rejects.toThrow('FAIL_CLOSED');
  });

  it('reverses only financial transactions matching tenant and branch', async () => {
    await db.financialTransactions.put({
      id: ids.financialA, Transaction_ID: ids.financialA, Reference_ID: referenceId,
      tenantId: tenantA, branchId: branchA, Direction: 'Debit', isDeleted: false
    } as any);
    setSession(tenantB, branchA);
    await db.financialTransactions.put({
      id: ids.financialOtherTenant, Transaction_ID: ids.financialOtherTenant, Reference_ID: referenceId,
      tenantId: tenantB, branchId: branchA, Direction: 'Debit', isDeleted: false
    } as any);
    setSession(tenantA, branchB);
    await db.financialTransactions.put({
      id: ids.financialOtherBranch, Transaction_ID: ids.financialOtherBranch, Reference_ID: referenceId,
      tenantId: tenantA, branchId: branchB, Direction: 'Debit', isDeleted: false
    } as any);

    setSession(tenantA, branchA);
    await FinancialTransactionRepository.reverseTransactions(referenceId, tenantA, branchA);

    await expect(db.financialTransactions.get(ids.financialA)).resolves.toMatchObject({ isDeleted: true });
    setSession(tenantB, branchA);
    await expect(db.financialTransactions.get(ids.financialOtherTenant)).resolves.toMatchObject({ isDeleted: false });
    setSession(tenantA, branchB);
    await expect(db.financialTransactions.get(ids.financialOtherBranch)).resolves.toMatchObject({ isDeleted: false });
  });

  it('cancels only financial transactions matching tenant and branch', async () => {
    await db.financialTransactions.put({
      id: ids.financialA, Transaction_ID: ids.financialA, Reference_ID: referenceId,
      tenantId: tenantA, branchId: branchA, Direction: 'Debit', isDeleted: false
    } as any);
    setSession(tenantB, branchA);
    await db.financialTransactions.put({
      id: ids.financialOtherTenant, Transaction_ID: ids.financialOtherTenant, Reference_ID: referenceId,
      tenantId: tenantB, branchId: branchA, Direction: 'Debit', isDeleted: false
    } as any);

    setSession(tenantA, branchA);
    await FinancialTransactionRepository.cancelTransaction(referenceId, tenantA, branchA);

    await expect(db.financialTransactions.get(ids.financialA)).resolves.toMatchObject({ isDeleted: true });
    setSession(tenantB, branchA);
    await expect(db.financialTransactions.get(ids.financialOtherTenant)).resolves.toMatchObject({ isDeleted: false });
  });

  it('returns no supplier matches without crashing when supplier names and IDs are null or undefined', async () => {
    await db.suppliers.bulkPut([
      { id: ids.supplierNull, Supplier_Name: null, Supplier_ID: null, Is_Active: true },
      { id: ids.supplierUndefined, Is_Active: true }
    ] as any);

    await expect(SupplierRepository.searchSuppliers('missing')).resolves.toEqual([]);
  });

  it('returns no customer matches without crashing when customer names and IDs are null or undefined', async () => {
    await db.customers.bulkPut([
      { id: ids.customerNull, Customer_Name: null, Customer_ID: null, Is_Active: true },
      { id: ids.customerUndefined, Is_Active: true }
    ] as any);

    await expect(SupplierRepository.searchCustomers('missing')).resolves.toEqual([]);
  });
});
