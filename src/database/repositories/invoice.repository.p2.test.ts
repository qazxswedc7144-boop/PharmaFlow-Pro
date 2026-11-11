import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { InvoiceRepository } from './invoice.repository';

const tenantId = 'invoice-repository-p2-tenant';
const branchId = 'invoice-repository-p2-branch';
const ids = {
  saleFallback: 'P2-SALE-FALLBACK',
  purchaseFallback: 'P2-PURCHASE-FALLBACK',
  saleWrongType: 'P2-SALE-WRONG-TYPE',
  purchaseWrongType: 'P2-PURCHASE-WRONG-TYPE',
  saleNumberOld: 'P2-SALE-NUMBER-OLD',
  saleNumberRecent: 'P2-SALE-NUMBER-RECENT',
  purchaseNumber: 'P2-PURCHASE-NUMBER',
  recentSale: 'P2-RECENT-SALE',
  recentPurchase: 'P2-RECENT-PURCHASE',
  inventoryDependency: 'P2-INVENTORY-DEPENDENCY',
  journalDependency: 'P2-JOURNAL-DEPENDENCY'
};

describe('InvoiceRepository P2 safeguards', () => {
  beforeEach(async () => {
    await db.open();
    TokenProvider.setSession(
      { id: 'invoice-repository-p2-user', tenantId, branchId } as any,
      'invoice-repository-p2-access',
      'invoice-repository-p2-refresh'
    );
  });

  afterEach(async () => {
    for (const id of Object.values(ids)) {
      await db.sales.delete(id).catch(() => undefined);
      await db.purchases.delete(id).catch(() => undefined);
      await db.invoices.delete(id).catch(() => undefined);
      await db.inventoryTransactions.delete(id).catch(() => undefined);
      await db.journalEntries.delete(id).catch(() => undefined);
    }
    TokenProvider.clearSession();
  });

  it('accepts only SALE fallback invoices in getSaleById', async () => {
    await db.invoices.put({ id: ids.saleFallback, type: 'SALE', tenantId, branchId } as any);
    await db.invoices.put({ id: ids.saleWrongType, type: 'PURCHASE', tenantId, branchId } as any);

    await expect(InvoiceRepository.getSaleById(ids.saleFallback)).resolves.toMatchObject({ type: 'SALE' });
    await expect(InvoiceRepository.getSaleById(ids.saleWrongType)).resolves.toBeUndefined();
  });

  it('accepts only PURCHASE fallback invoices in getPurchaseById and supports invoiceType', async () => {
    await db.invoices.put({ id: ids.purchaseFallback, invoiceType: 'PURCHASE', tenantId, branchId } as any);
    await db.invoices.put({ id: ids.purchaseWrongType, type: 'SALE', tenantId, branchId } as any);

    await expect(InvoiceRepository.getPurchaseById(ids.purchaseFallback)).resolves.toMatchObject({ invoiceType: 'PURCHASE' });
    await expect(InvoiceRepository.getPurchaseById(ids.purchaseWrongType)).resolves.toBeUndefined();
  });

  it('generates the next invoice number from the maximum existing suffix, not createdAt order', async () => {
    await db.sales.put({
      id: ids.saleNumberOld, SaleID: 'INV-1100', createdAt: '2025-01-01T00:00:00.000Z', tenantId, branchId
    } as any);
    await db.sales.put({
      id: ids.saleNumberRecent, SaleID: 'INV-1009', createdAt: '2026-11-11T00:00:00.000Z', tenantId, branchId
    } as any);
    await db.purchases.put({
      id: ids.purchaseNumber, invoiceId: 'PUR-2042', createdAt: '2025-01-01T00:00:00.000Z', tenantId, branchId
    } as any);

    await expect(InvoiceRepository.generateInvoiceNumber('SALE')).resolves.toBe('INV-1101');
    await expect(InvoiceRepository.generateInvoiceNumber('PURCHASE')).resolves.toBe('PUR-2043');
  });

  it('returns recent invoices newest first across sales and purchases', async () => {
    const now = Date.now();
    await db.sales.put({
      id: ids.recentSale, Date: new Date(now - 24 * 60 * 60 * 1000).toISOString(), tenantId, branchId
    } as any);
    await db.purchases.put({
      id: ids.recentPurchase, date: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(), tenantId, branchId
    } as any);

    const recent = await InvoiceRepository.getRecentInvoices();
    expect(recent.findIndex(invoice => invoice.id === ids.recentSale))
      .toBeLessThan(recent.findIndex(invoice => invoice.id === ids.recentPurchase));
  });

  it('detects inventory transaction dependencies for the matching invoice', async () => {
    await db.inventoryTransactions.put({
      id: ids.inventoryDependency,
      SourceDocumentID: 'P2-DEPENDENT-SALE',
      SourceDocumentType: 'SALE',
      tenantId,
      branchId
    } as any);

    await expect(InvoiceRepository.checkHasDependencies('P2-DEPENDENT-SALE', 'SALE')).resolves.toBe(true);
    await expect(InvoiceRepository.checkHasDependencies('P2-UNLINKED-SALE', 'SALE')).resolves.toBe(false);
  });

  it('detects journal-entry dependencies for the matching invoice', async () => {
    await db.journalEntries.put({
      id: ids.journalDependency,
      referenceId: 'P2-DEPENDENT-PURCHASE',
      sourceType: 'PURCHASE',
      tenantId,
      branchId
    } as any);

    await expect(InvoiceRepository.checkHasDependencies('P2-DEPENDENT-PURCHASE', 'PURCHASE')).resolves.toBe(true);
    await expect(InvoiceRepository.checkHasDependencies('P2-UNLINKED-PURCHASE', 'PURCHASE')).resolves.toBe(false);
  });
});
