import { describe, expect, it } from 'vitest';
import type { SyncContract } from '@/core/workflow/workflow.types';
import { salesWorkflow } from '@/features/sales/workflows/SalesWorkflow';
import { productApplicationWorkflow } from '@/features/catalog/workflows/ProductApplicationWorkflow';
import { purchaseWorkflow } from '@/features/purchases/workflows/PurchaseWorkflow';
import { inventoryAdjustmentWorkflow } from '@/features/inventory/workflows/InventoryAdjustmentWorkflow';
import { inventoryTransferWorkflow } from '@/features/inventory/workflows/InventoryTransferWorkflow';
import { voucherWorkflow } from '@/features/accounting/workflows/VoucherWorkflow';
import { journalPostingWorkflow } from '@/features/accounting/workflows/JournalPostingWorkflow';
import { voucherCancellationWorkflow } from '@/features/accounting/workflows/VoucherCancellationWorkflow';
import { salesCancellationWorkflow } from '@/features/sales/workflows/SalesCancellationWorkflow';
import { salesReturnWorkflow } from '@/features/returns/workflows/SalesReturnWorkflow';
import { purchaseReturnWorkflow } from '@/features/returns/workflows/PurchaseReturnWorkflow';

const workflows = [
  { name: 'SalesWorkflow', workflow: salesWorkflow, entityType: 'SALE', operation: 'POST' },
  { name: 'ProductApplicationWorkflow', workflow: productApplicationWorkflow, entityType: 'PRODUCT', operation: 'CREATE' },
  { name: 'PurchaseWorkflow', workflow: purchaseWorkflow, entityType: 'PURCHASE', operation: 'CREATE' },
  { name: 'InventoryAdjustmentWorkflow', workflow: inventoryAdjustmentWorkflow, entityType: 'STOCK_ADJUSTMENT', operation: 'ADJUST' },
  { name: 'InventoryTransferWorkflow', workflow: inventoryTransferWorkflow, entityType: 'BRANCH_TRANSFER', operation: 'CREATE' },
  { name: 'VoucherWorkflow', workflow: voucherWorkflow, entityType: 'VOUCHER', operation: 'CREATE' },
  { name: 'JournalPostingWorkflow', workflow: journalPostingWorkflow, entityType: 'JOURNAL_ENTRY', operation: 'CREATE' },
  { name: 'VoucherCancellationWorkflow', workflow: voucherCancellationWorkflow, entityType: 'VOUCHER', operation: 'CANCEL' },
  { name: 'SalesCancellationWorkflow', workflow: salesCancellationWorkflow, entityType: 'INVOICE', operation: 'CANCEL' },
  { name: 'SalesReturnWorkflow', workflow: salesReturnWorkflow, entityType: 'SALES_RETURN', operation: 'CREATE' },
  { name: 'PurchaseReturnWorkflow', workflow: purchaseReturnWorkflow, entityType: 'PURCHASE_RETURN', operation: 'CREATE' },
] as const;

describe('V-30A workflow sync contracts (documentation only)', () => {
  it('T-01: declares a sync contract for every in-scope workflow', () => {
    for (const { name, workflow } of workflows) {
      expect(workflow.syncContract, name).toBeDefined();
      expect(typeof workflow.syncContract?.buildPayload, name).toBe('function');
    }
  });

  it('T-02: declares the approved entity type and operation for each workflow', () => {
    for (const { name, workflow, entityType, operation } of workflows) {
      expect(workflow.syncContract?.entityType, name).toBe(entityType);
      expect(workflow.syncContract?.operation, name).toBe(operation);
    }
  });

  it('T-03: supports the optional shouldSync predicate without making it mandatory', () => {
    const contract: SyncContract = {
      entityType: 'TEST_ENTITY',
      operation: 'CREATE',
      buildPayload: (result) => result as Record<string, unknown>,
      shouldSync: (result) => Boolean((result as { shouldSync?: boolean } | null)?.shouldSync),
    };

    expect(contract.shouldSync?.({ shouldSync: true })).toBe(true);
    expect(contract.shouldSync?.({ shouldSync: false })).toBe(false);
    expect(workflows.every(({ workflow }) => workflow.syncContract?.shouldSync === undefined)).toBe(true);
  });
});
