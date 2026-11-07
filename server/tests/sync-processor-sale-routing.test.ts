import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSalePost, mockLedgerPost } = vi.hoisted(() => ({
  mockSalePost: vi.fn(),
  mockLedgerPost: vi.fn(),
}));

vi.mock("../modules/accounting/services/atomicPostSale.service.js", () => ({
  AtomicPostSaleService: { executePostSaleCommand: mockSalePost },
}));
vi.mock("../modules/accounting/services/financialTransaction.service.js", () => ({
  FinancialTransactionService: { executeInvoiceLedgerPosting: mockLedgerPost },
}));

import { SyncProcessorService } from "../modules/sync/sync-processor.service.js";

describe("sync INVOICE POST type routing", () => {
  const base = { tenantId: "tenant-routing-a", branchId: "branch-routing-a", userId: "user-routing-a", deviceId: "device-routing-a", version: 1 };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSalePost.mockResolvedValue({ success: true, effects: [] });
    mockLedgerPost.mockResolvedValue({ success: true, journalId: "journal-purchase" });
  });

  it("does not send RETURN_SALE to the SALE posting service", async () => {
    const returnInvoice = { id: "return-invoice-a", tenantId: base.tenantId, type: "RETURN_SALE", documentStatus: "ACTIVE", status: "DRAFT", items: [] };
    const tx: any = { invoice: { findFirst: vi.fn().mockResolvedValue(returnInvoice) } };
    const result = await (SyncProcessorService as any).executeEntityMutation({
      ...base, tx,
      mutation: { id: "mutation-return-a", entity: "INVOICE", entityId: returnInvoice.id, operation: "POST", payload: { id: returnInvoice.id, type: "RETURN_SALE" } },
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INVOICE_POST_HANDLER_UNAVAILABLE");
    expect(mockSalePost).not.toHaveBeenCalled();
    expect(mockLedgerPost).not.toHaveBeenCalled();
  });

  it("routes PURCHASE POST to the purchase-capable ledger service, not the SALE service", async () => {
    const purchaseInvoice = { id: "purchase-invoice-a", tenantId: base.tenantId, type: "PURCHASE", documentStatus: "ACTIVE", status: "DRAFT", items: [] };
    const tx: any = { invoice: { findFirst: vi.fn().mockResolvedValue(purchaseInvoice) } };
    const result = await (SyncProcessorService as any).executeEntityMutation({
      ...base, tx,
      mutation: { id: "mutation-purchase-a", entity: "INVOICE", entityId: purchaseInvoice.id, operation: "POST", payload: { id: purchaseInvoice.id, type: "PURCHASE" } },
    });
    expect(result.success).toBe(true);
    expect(mockLedgerPost).toHaveBeenCalledWith(tx, purchaseInvoice, base.userId, "127.0.0.1", base.tenantId);
    expect(mockSalePost).not.toHaveBeenCalled();
  });
});
