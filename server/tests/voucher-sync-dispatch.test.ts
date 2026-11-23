import { beforeEach, describe, expect, it, vi } from "vitest";

const postingMocks = vi.hoisted(() => ({
  create: vi.fn(),
  cancel: vi.fn()
}));

vi.mock("../modules/accounting/services/voucherPosting.service.js", () => ({
  VoucherPostingService: {
    create: postingMocks.create,
    cancel: postingMocks.cancel
  }
}));

import { SyncProcessorService } from "../modules/sync/sync-processor.service.js";

function mutation(operation: string, payload: Record<string, unknown> = {}) {
  return {
    id: `mutation-${operation.toLowerCase()}`,
    entityType: "VOUCHER",
    entityId: "voucher-001",
    operation,
    payload: { id: "voucher-001", ...payload },
    version: 2
  };
}

function params(operation: string, payload: Record<string, unknown> = {}) {
  return {
    mutation: mutation(operation, payload) as any,
    tenantId: "tenant-a",
    branchId: "branch-a",
    userId: "user-a",
    userRole: "TENANT_ADMIN",
    deviceId: "device-a",
    version: 2,
    tx: { transactionMarker: true }
  };
}

describe("SyncProcessor VOUCHER dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes CREATE to VoucherPostingService with trusted tenant and branch scope", async () => {
    postingMocks.create.mockResolvedValue({ paymentId: "voucher-001", allocationCount: 1 });
    const input = params("CREATE", { amount: 50, type: "RECEIPT" });
    const result = await (SyncProcessorService as any).executeEntityMutation(input);

    expect(postingMocks.create).toHaveBeenCalledWith(
      {
        tx: input.tx,
        tenantId: "tenant-a",
        branchId: "branch-a",
        userId: "user-a"
      },
      input.mutation.payload
    );
    expect(result.status).toBe("SUCCESS");
    expect(result.details.paymentId).toBe("voucher-001");
  });

  it("routes CANCEL to VoucherPostingService and preserves the cancellation result", async () => {
    postingMocks.cancel.mockResolvedValue({ paymentId: "voucher-001", reversalJournalId: "journal-reversal" });
    const input = params("CANCEL", { type: "RECEIPT", partnerId: "customer-a", amount: 50 });
    const result = await (SyncProcessorService as any).executeEntityMutation(input);

    expect(postingMocks.cancel).toHaveBeenCalledWith(
      {
        tx: input.tx,
        tenantId: "tenant-a",
        branchId: "branch-a",
        userId: "user-a"
      },
      input.mutation.payload
    );
    expect(result.status).toBe("SUCCESS");
    expect(result.details.reversalJournalId).toBe("journal-reversal");
  });

  it("rejects cross-tenant and cross-branch payload scope before calling the posting service", async () => {
    const tenantMismatch = await (SyncProcessorService as any).executeEntityMutation(
      params("CREATE", { tenantId: "tenant-b" })
    );
    const branchMismatch = await (SyncProcessorService as any).executeEntityMutation(
      params("CREATE", { branchId: "branch-b" })
    );

    expect(tenantMismatch.status).toBe("REJECTED");
    expect(tenantMismatch.errorCode).toBe("TENANT_MISMATCH");
    expect(branchMismatch.status).toBe("REJECTED");
    expect(branchMismatch.errorCode).toBe("BRANCH_MISMATCH");
    expect(postingMocks.create).not.toHaveBeenCalled();
  });

  it("rejects unsupported voucher operations", async () => {
    const result = await (SyncProcessorService as any).executeEntityMutation(params("UPDATE"));
    expect(result.status).toBe("REJECTED");
    expect(result.errorCode).toBe("UNKNOWN_SYNC_OPERATION");
  });
});
