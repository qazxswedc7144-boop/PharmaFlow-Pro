import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/core/db';
import { AccountingRepository } from './AccountingRepository';
import { FinancialTransactionRepository } from './FinancialTransactionRepository';
import { SupplierRepository } from './SupplierRepository';

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

describe('Dexie repository tenant isolation and null-safe search', () => {
  beforeEach(async () => {
    await db.open();
  });

  afterEach(async () => {
    await Promise.all([
      ...Object.values(ids).map(id => db.journalEntries.delete(id).catch(() => undefined)),
      ...Object.values(ids).map(id => db.financialTransactions.delete(id).catch(() => undefined)),
      ...Object.values(ids).map(id => db.suppliers.delete(id).catch(() => undefined)),
      ...Object.values(ids).map(id => db.customers.delete(id).catch(() => undefined))
    ]);
  });

  it('fails closed when deleting journal entries without a tenant context', async () => {
    await expect(
      AccountingRepository.deleteEntriesBySource(sourceId, undefined as unknown as string)
    ).rejects.toThrow('FAIL_CLOSED: Tenant context required for deletion');
  });

  it('deletes source journal entries only within the supplied tenant', async () => {
    await db.journalEntries.bulkPut([
      { id: ids.journalA, sourceId, tenantId: tenantA, branchId: branchA, lines: [] },
      { id: ids.journalB, sourceId, tenantId: tenantB, branchId: branchA, lines: [] }
    ] as any);

    await AccountingRepository.deleteEntriesBySource(sourceId, tenantA);

    await expect(db.journalEntries.get(ids.journalA)).resolves.toBeUndefined();
    await expect(db.journalEntries.get(ids.journalB)).resolves.toMatchObject({ tenantId: tenantB });
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
    await db.financialTransactions.bulkPut([
      {
        id: ids.financialA, Transaction_ID: ids.financialA, Reference_ID: referenceId,
        tenantId: tenantA, branchId: branchA, Direction: 'Debit', isDeleted: false
      },
      {
        id: ids.financialOtherTenant, Transaction_ID: ids.financialOtherTenant, Reference_ID: referenceId,
        tenantId: tenantB, branchId: branchA, Direction: 'Debit', isDeleted: false
      },
      {
        id: ids.financialOtherBranch, Transaction_ID: ids.financialOtherBranch, Reference_ID: referenceId,
        tenantId: tenantA, branchId: branchB, Direction: 'Debit', isDeleted: false
      }
    ] as any);

    await FinancialTransactionRepository.reverseTransactions(referenceId, tenantA, branchA);

    await expect(db.financialTransactions.get(ids.financialA)).resolves.toMatchObject({ isDeleted: true });
    await expect(db.financialTransactions.get(ids.financialOtherTenant)).resolves.toMatchObject({ isDeleted: false });
    await expect(db.financialTransactions.get(ids.financialOtherBranch)).resolves.toMatchObject({ isDeleted: false });
  });

  it('cancels only financial transactions matching tenant and branch', async () => {
    await db.financialTransactions.bulkPut([
      {
        id: ids.financialA, Transaction_ID: ids.financialA, Reference_ID: referenceId,
        tenantId: tenantA, branchId: branchA, Direction: 'Debit', isDeleted: false
      },
      {
        id: ids.financialOtherTenant, Transaction_ID: ids.financialOtherTenant, Reference_ID: referenceId,
        tenantId: tenantB, branchId: branchA, Direction: 'Debit', isDeleted: false
      }
    ] as any);

    await FinancialTransactionRepository.cancelTransaction(referenceId, tenantA, branchA);

    await expect(db.financialTransactions.get(ids.financialA)).resolves.toMatchObject({ isDeleted: true });
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
