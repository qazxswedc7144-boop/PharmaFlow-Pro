import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb, mockValidation, mockPolicy } = vi.hoisted(() => ({
  mockDb: {
    generateId: vi.fn(() => 'SALE-LOCAL-REPLACEMENT-001'),
    products: { get: vi.fn() },
    customers: { get: vi.fn() },
    invoices: { get: vi.fn() },
  },
  mockValidation: {
    validateInvoice: vi.fn(),
    validateInvoiceIdUniqueness: vi.fn(),
  },
  mockPolicy: {
    getForTenant: vi.fn(),
  },
}));

vi.mock('@/core/db', () => ({ db: mockDb }));
vi.mock('@/services/integrity/ValidationService', () => ({
  ValidationService: mockValidation,
}));
vi.mock('@/features/sales/services/tenantSalesPolicy.service', () => ({
  TenantSalesPolicyService: mockPolicy,
}));

import { SalesWorkflow } from './SalesWorkflow';

describe('SalesWorkflow local pricing replacement coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.products.get.mockResolvedValue({
      id: 'PRODUCT-LOCAL-001',
      tenantId: 'TENANT-LOCAL-001',
      price: 100,
    });
    mockPolicy.getForTenant.mockResolvedValue({
      maxDiscountPercent: '10',
      taxRatePercent: '15',
      taxMode: 'EXCLUSIVE',
    });
    mockValidation.validateInvoice.mockResolvedValue({ valid: true, errors: [] });
    mockValidation.validateInvoiceIdUniqueness.mockResolvedValue(true);
  });

  it('derives local sale total from tenant policy and Dexie product price, not client totals', async () => {
    const workflow = new SalesWorkflow();
    const input: any = {
      isCash: true,
      total: 1,
      discountPercent: 10,
      items: [{
        productId: 'PRODUCT-LOCAL-001',
        qty: 1,
        quantity: 1,
        price: 1,
        unitPrice: 1,
      }],
    };

    await workflow.validateBusinessRules(input, {
      tenantId: 'TENANT-LOCAL-001',
      branchId: 'BRANCH-LOCAL-001',
      userId: 'USER-LOCAL-001',
      startedAt: '2026-11-08T12:00:00.000Z',
    } as any);

    expect(input.items[0].price).toBe(100);
    expect(input.subtotalAmount).toBe(100);
    expect(input.discountAmount).toBe(10);
    expect(input.taxAmount).toBe(13.5);
    expect(input.revenueAmount).toBe(90);
    expect(input.total).toBe(103.5);
    expect(input.tax).toBe(13.5);
    expect(mockPolicy.getForTenant).toHaveBeenCalledWith('TENANT-LOCAL-001');
    expect(mockValidation.validateInvoice).toHaveBeenCalledWith(input, 'SALE');
  });
});
