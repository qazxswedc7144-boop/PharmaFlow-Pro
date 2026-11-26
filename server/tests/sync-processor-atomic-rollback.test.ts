import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  verifyDevice: vi.fn(),
  touchDevice: vi.fn(),
  checkIdempotency: vi.fn(),
  recordIdempotency: vi.fn(),
  recordChange: vi.fn(),
  logAudit: vi.fn(),
  getUserEffectivePermissions: vi.fn(),
  executePostSaleCommand: vi.fn(),
  executeInvoiceLedgerPosting: vi.fn(),
  voucherCreate: vi.fn(),
  branchFindFirst: vi.fn(),
  branchUserFindFirst: vi.fn(),
  supplierFindFirst: vi.fn(),
  productFindFirst: vi.fn(),
  invoiceFindFirst: vi.fn(),
  invoiceCreate: vi.fn(),
  invoiceItemCreateMany: vi.fn(),
}));

vi.mock("../database/prisma.js", () => ({
  prisma: {
    $transaction: mocks.transaction,
    branch: { findFirst: mocks.branchFindFirst },
    branchUser: { findFirst: mocks.branchUserFindFirst },
  },
}));

vi.mock("../modules/sync/device.service.js", () => ({
  DeviceService: {
    verifyDevice: mocks.verifyDevice,
    touchDevice: mocks.touchDevice,
  },
}));

vi.mock("../modules/sync/sync-idempotency.service.js", () => ({
  SyncIdempotencyService: {
    check: mocks.checkIdempotency,
    record: mocks.recordIdempotency,
  },
}));

vi.mock("../modules/sync/sync-changelog.service.js", () => ({
  SyncChangelogService: {
    recordChange: mocks.recordChange,
  },
}));

vi.mock("../modules/sync/sync-audit.service.js", () => ({
  SyncAuditService: {
    logEvent: mocks.logAudit,
  },
}));

vi.mock("../services/rbac/authorization.service.js", () => ({
  AuthorizationService: {
    getUserEffectivePermissions: mocks.getUserEffectivePermissions,
  },
}));

vi.mock("../modules/accounting/services/atomicPostSale.service.js", () => ({
  AtomicPostSaleService: {
    executePostSaleCommand: mocks.executePostSaleCommand,
  },
}));

vi.mock("../modules/accounting/services/financialTransaction.service.js", () => ({
  FinancialTransactionService: {
    executeInvoiceLedgerPosting: mocks.executeInvoiceLedgerPosting,
  },
}));

vi.mock("../modules/accounting/services/voucherPosting.service.js", () => ({
  VoucherPostingService: {
    create: mocks.voucherCreate,
    cancel: vi.fn(),
  },
}));

import { SyncProcessorService } from "../modules/sync/sync-processor.service.js";

describe("SyncProcessorService — atomic transaction abort and ACCOUNTING_PERIOD_LOCKED preservation", () => {
  const tenantId = "tenant-atomic-1";
  const branchId = "branch-atomic-1";
  const userId = "user-atomic-1";
  const deviceId = "device-atomic-1";

  let committedCount = 0;
  let rolledBackCount = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    committedCount = 0;
    rolledBackCount = 0;

    mocks.verifyDevice.mockResolvedValue({ allowed: true, status: "ACTIVE" });
    mocks.touchDevice.mockResolvedValue(undefined);
    mocks.branchFindFirst.mockResolvedValue({ id: branchId, tenantId });
    mocks.branchUserFindFirst.mockResolvedValue({ id: "bu-1", tenantId, branchId, userId });
    mocks.getUserEffectivePermissions.mockResolvedValue(
      new Set([
        "sales.invoice.approve",
        "purchases.invoice.create",
        "accounting.voucher.create",
      ])
    );
    mocks.checkIdempotency.mockResolvedValue({ isDuplicate: false });
    mocks.logAudit.mockResolvedValue(undefined);

    const tx = {
      branch: {
        findFirst: mocks.branchFindFirst,
      },
      invoice: {
        findFirst: mocks.invoiceFindFirst,
        create: mocks.invoiceCreate,
      },
      invoiceItem: {
        createMany: mocks.invoiceItemCreateMany,
      },
      supplier: {
        findFirst: mocks.supplierFindFirst,
      },
      product: {
        findFirst: mocks.productFindFirst,
      },
    };

    mocks.transaction.mockImplementation(async (callback: (txArg: any) => Promise<any>) => {
      try {
        const res = await callback(tx);
        committedCount++;
        return res;
      } catch (err) {
        rolledBackCount++;
        throw err;
      }
    });
  });

  it("aborts prisma.$transaction (rollback, not commit) when SALE:POST fails with ACCOUNTING_PERIOD_LOCKED and preserves errorCode", async () => {
    const periodLockedErr: any = new Error("ACCOUNTING_PERIOD_LOCKED: لا يمكن ترحيل فاتورة داخل فترة محاسبية مغلقة.");
    periodLockedErr.code = "ACCOUNTING_PERIOD_LOCKED";
    mocks.executePostSaleCommand.mockRejectedValueOnce(periodLockedErr);

    const response = await SyncProcessorService.processBatch({
      authenticatedTenantId: tenantId,
      authenticatedUserId: userId,
      authenticatedUserRole: "ADMIN",
      envelope: {
        tenantId,
        branchId,
        userId,
        deviceId,
        timestamp: Date.now(),
        schemaVersion: 1,
        clientVersion: "8.3.0",
        mutations: [{
          id: "mut-sale-locked",
          entity: "SALE",
          entityId: "mut-sale-locked",
          operation: "POST",
          payload: { invoiceNumber: "INV-LOCKED-1", totalAmount: 100 },
          idempotencyKey: "idem-sale-locked",
          timestamp: Date.now(),
          version: 1,
        }],
      },
    });

    expect(rolledBackCount).toBe(1);
    expect(committedCount).toBe(0);
    expect(mocks.recordIdempotency).not.toHaveBeenCalled();
    expect(response.success).toBe(false);
    expect(response.results[0]).toMatchObject({
      mutationId: "mut-sale-locked",
      status: "FAILED",
      success: false,
      errorCode: "ACCOUNTING_PERIOD_LOCKED",
    });
    expect(response.summary.rejected).toEqual(["mut-sale-locked"]);
  });

  it("aborts prisma.$transaction and preserves ACCOUNTING_PERIOD_LOCKED (not PROCESSING_EXCEPTION) for PURCHASE:CREATE", async () => {
    mocks.invoiceFindFirst
      .mockResolvedValueOnce(null) // duplicate check before create
      .mockResolvedValueOnce({ id: "pur-1", tenantId, type: "PURCHASE", items: [] }); // reload for posting
    mocks.supplierFindFirst.mockResolvedValueOnce({ id: "sup-1", tenantId });
    mocks.productFindFirst.mockResolvedValueOnce({ id: "prod-1", tenantId });
    mocks.invoiceCreate.mockResolvedValueOnce({ id: "pur-1" });
    mocks.invoiceItemCreateMany.mockResolvedValueOnce({ count: 1 });

    const periodLockedErr: any = new Error("ACCOUNTING_PERIOD_LOCKED: لا يمكن ترحيل فاتورة داخل فترة محاسبية مغلقة.");
    periodLockedErr.code = "ACCOUNTING_PERIOD_LOCKED";
    mocks.executeInvoiceLedgerPosting.mockRejectedValueOnce(periodLockedErr);

    const response = await SyncProcessorService.processBatch({
      authenticatedTenantId: tenantId,
      authenticatedUserId: userId,
      authenticatedUserRole: "ADMIN",
      envelope: {
        tenantId,
        branchId,
        userId,
        deviceId,
        timestamp: Date.now(),
        schemaVersion: 1,
        clientVersion: "8.3.0",
        mutations: [{
          id: "mut-pur-locked",
          entity: "PURCHASE",
          entityId: "pur-1",
          operation: "CREATE",
          payload: {
            id: "pur-1",
            tenantId,
            branchId,
            purchase: {
              id: "pur-1",
              invoiceNumber: "PUR-LOCKED-1",
              date: new Date().toISOString(),
              type: "PURCHASE",
              status: "CONFIRMED",
              documentStatus: "POSTED",
              isReturn: false,
              partnerId: "sup-1",
              partnerType: "SUPPLIER",
              paymentStatus: "UNPAID",
              subtotal: 20,
              totalAmount: 20,
              items: [{
                productId: "prod-1",
                quantity: 2,
                unitPrice: 10,
                unitCost: 10,
                total: 20,
                batchNumber: "B-1",
                expiryDate: new Date(Date.now() + 86400000 * 30).toISOString(),
              }],
            },
          },
          idempotencyKey: "idem-pur-locked",
          timestamp: Date.now(),
          version: 1,
        }],
      },
    });

    expect(rolledBackCount).toBe(1);
    expect(committedCount).toBe(0);
    expect(mocks.recordIdempotency).not.toHaveBeenCalled();
    expect(response.success).toBe(false);
    expect(response.results[0]).toMatchObject({
      mutationId: "mut-pur-locked",
      status: "REJECTED",
      success: false,
      errorCode: "ACCOUNTING_PERIOD_LOCKED",
    });
    expect(response.results[0]?.errorCode).not.toBe("PROCESSING_EXCEPTION");
  });

  it("aborts prisma.$transaction and preserves ACCOUNTING_PERIOD_LOCKED for VOUCHER:CREATE", async () => {
    const periodLockedErr: any = new Error("ACCOUNTING_PERIOD_LOCKED: Closed period");
    periodLockedErr.code = "ACCOUNTING_PERIOD_LOCKED";
    mocks.voucherCreate.mockRejectedValueOnce(periodLockedErr);

    const response = await SyncProcessorService.processBatch({
      authenticatedTenantId: tenantId,
      authenticatedUserId: userId,
      authenticatedUserRole: "ADMIN",
      envelope: {
        tenantId,
        branchId,
        userId,
        deviceId,
        timestamp: Date.now(),
        schemaVersion: 1,
        clientVersion: "8.3.0",
        mutations: [{
          id: "mut-vch-locked",
          entity: "VOUCHER",
          entityId: "vch-1",
          operation: "CREATE",
          payload: { id: "vch-1", amount: 50, tenantId, branchId },
          idempotencyKey: "idem-vch-locked",
          timestamp: Date.now(),
          version: 1,
        }],
      },
    });

    expect(rolledBackCount).toBe(1);
    expect(committedCount).toBe(0);
    expect(mocks.recordIdempotency).not.toHaveBeenCalled();
    expect(response.success).toBe(false);
    expect(response.results[0]).toMatchObject({
      mutationId: "mut-vch-locked",
      status: "REJECTED",
      success: false,
      errorCode: "ACCOUNTING_PERIOD_LOCKED",
    });
  });
});
