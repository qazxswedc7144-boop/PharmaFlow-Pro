import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FinancialTransactionService } from '../modules/accounting/services/financialTransaction.service.js';
import { DocumentStatus, InvoiceStatus, InvoiceType } from '@prisma/client';

// Mock dependencies
vi.mock('../core/database/transactionGuard', () => ({
  runInTransaction: vi.fn((name, cb) => cb(fakeTx)),
}));

vi.mock('../../inventory/services/fifo.service', () => ({
  FifoService: {
    depleteStock: vi.fn(async () => ({ totalCost: 50 })),
    addStock: vi.fn(),
  },
}));

const fakeTx: any = {
  invoice: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  invoiceItem: {
    update: vi.fn(),
  },
  tenantSalesPolicy: {
    findUnique: vi.fn().mockResolvedValue({
      tenantId: 'tenant-A',
      maxDiscountPercent: 10,
      taxRatePercent: 0,
      taxMode: 'NONE',
    }),
  },
  inventoryBatch: {
    update: vi.fn().mockResolvedValue({ id: 'batch-1' }),
  },
  inventoryMovement: {
    create: vi.fn().mockResolvedValue({ id: 'mov-1' }),
  },
  product: {
    update: vi.fn().mockResolvedValue({ id: 'prod-1' }),
  },
  account: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  journalEntry: {
    create: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
};

describe('FinancialTransactionService - Tenant Isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CASE A: Same tenant - should proceed without TENANT_REQUIRED error', async () => {
    fakeTx.invoice.findFirst.mockResolvedValue({
      id: 'INV-1',
      tenantId: 'tenant-A',
      status: 'DRAFT',
      documentStatus: 'ACTIVE',
      invoiceNumber: 'INV-001',
      type: InvoiceType.SALE,
      totalAmount: 100,
      subtotalAmount: 100,
      taxAmount: 0,
      discountAmount: 0,
      taxMode: 'NONE',
      paymentStatus: 'PAID',
      items: [{ productId: 'prod-1', price: 100, qty: 1, product: { id: 'prod-1', price: 100, tenantId: 'tenant-A' } }],
      date: new Date(),
    });

    fakeTx.$queryRaw.mockImplementation(async (stringsOrSql: any, ...values: any[]) => {
      const strings = Array.isArray(stringsOrSql) ? stringsOrSql : (stringsOrSql?.strings || [stringsOrSql?.text || '']);
      const text = strings.join('');
      if (text.includes('invoices') || text.includes('documentStatus')) {
        expect(text).toContain('tenantId');
        expect(values).toContain('INV-1');
        expect(values).toContain('tenant-A');
        return [{ id: 'INV-1', documentStatus: 'ACTIVE', status: 'DRAFT', date: new Date() }];
      }
      if (text.includes('accounting_periods')) {
        return [{ id: 'period-1', isLocked: false }];
      }
      if (text.includes('products') || text.includes('stockQuantity')) {
        return [{ id: 'prod-1', stockQuantity: 100, version: 1, tenantId: 'tenant-A' }];
      }
      if (text.includes('inventory_batches')) {
        return [{ id: 'batch-1', batchNumber: 'B-001', stockQuantity: 200, cost: 10, expiryDate: new Date(Date.now() + 864000000), version: 1 }];
      }
      return [{ id: 'INV-1', documentStatus: 'ACTIVE', status: 'DRAFT', date: new Date() }];
    });
    fakeTx.account.findFirst.mockResolvedValue({ id: 'ACC-1', version: 1, name: 'Cash' });
    fakeTx.account.findUnique.mockResolvedValue({ id: 'ACC-1', version: 1, name: 'Cash' });
    fakeTx.account.update.mockResolvedValue({ id: 'ACC-1' });
    fakeTx.journalEntry.create.mockResolvedValue({ id: 'JE-1' });

    const result = await FinancialTransactionService.postInvoiceToLedger('INV-1', 'user-1', '127.0.0.1', 'tenant-A');

    expect(result.success).toBe(true);
    expect(fakeTx.invoice.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'INV-1', tenantId: 'tenant-A' }
    }));
  });

  it('CASE B: Cross tenant - should throw INVOICE_NOT_FOUND if tenantId mismatch', async () => {
    // findFirst returns null if tenantId doesn't match in the query
    fakeTx.invoice.findFirst.mockResolvedValue(null);

    await expect(
      FinancialTransactionService.postInvoiceToLedger('INV-1', 'user-1', '127.0.0.1', 'tenant-B')
    ).rejects.toThrow(/INVOICE_NOT_FOUND/);

    expect(fakeTx.journalEntry.create).not.toHaveBeenCalled();
    expect(fakeTx.account.update).not.toHaveBeenCalled();
  });

  it('CASE C: Missing tenantId - should throw TENANT_REQUIRED', async () => {
    await expect(
      FinancialTransactionService.postInvoiceToLedger('INV-1', 'user-1', '127.0.0.1', null)
    ).rejects.toThrow('TENANT_REQUIRED: tenantId is mandatory for invoice posting.');

    expect(fakeTx.invoice.findFirst).not.toHaveBeenCalled();
  });

  it('CASE D: Empty tenantId - should throw TENANT_REQUIRED', async () => {
    await expect(
      FinancialTransactionService.postInvoiceToLedger('INV-1', 'user-1', '127.0.0.1', '')
    ).rejects.toThrow('TENANT_REQUIRED: tenantId is mandatory for invoice posting.');
  });

  it('CASE E: JournalEntry includes tenantId', async () => {
    const invoiceDate = new Date();
    fakeTx.invoice.findFirst.mockResolvedValue({
      id: 'INV-1',
      tenantId: 'tenant-A',
      status: 'DRAFT',
      documentStatus: 'ACTIVE',
      invoiceNumber: 'INV-001',
      type: InvoiceType.SALE,
      totalAmount: 100,
      subtotalAmount: 100,
      taxAmount: 0,
      discountAmount: 0,
      taxMode: 'NONE',
      paymentStatus: 'PAID',
      items: [{ productId: 'prod-1', price: 100, qty: 1, product: { id: 'prod-1', price: 100, tenantId: 'tenant-A' } }],
      date: invoiceDate,
    });

    fakeTx.$queryRaw.mockImplementation(async (stringsOrSql: any, ...values: any[]) => {
      const strings = Array.isArray(stringsOrSql) ? stringsOrSql : (stringsOrSql?.strings || [stringsOrSql?.text || '']);
      const text = strings.join('');
      if (text.includes('invoices') || text.includes('documentStatus')) {
        expect(text).toContain('tenantId');
        expect(values).toContain('INV-1');
        expect(values).toContain('tenant-A');
        return [{ id: 'INV-1', documentStatus: 'ACTIVE', status: 'DRAFT', date: new Date() }];
      }
      if (text.includes('accounting_periods')) {
        return [{ id: 'period-1', isLocked: false }];
      }
      if (text.includes('products') || text.includes('stockQuantity')) {
        return [{ id: 'prod-1', stockQuantity: 100, version: 1, tenantId: 'tenant-A' }];
      }
      if (text.includes('inventory_batches')) {
        return [{ id: 'batch-1', batchNumber: 'B-001', stockQuantity: 200, cost: 10, expiryDate: new Date(Date.now() + 864000000), version: 1 }];
      }
      return [{ id: 'INV-1', documentStatus: 'ACTIVE', status: 'DRAFT', date: new Date() }];
    });
    fakeTx.account.findFirst.mockResolvedValue({ id: 'ACC-1', version: 1, name: 'Cash' });
    fakeTx.account.findUnique.mockResolvedValue({ id: 'ACC-1', version: 1, name: 'Cash' });
    fakeTx.account.update.mockResolvedValue({ id: 'ACC-1' });
    fakeTx.journalEntry.create.mockResolvedValue({ id: 'JE-1' });

    await FinancialTransactionService.postInvoiceToLedger('INV-1', 'user-1', '127.0.0.1', 'tenant-A');

    expect(fakeTx.journalEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: 'tenant-A'
      })
    }));
  });
});
