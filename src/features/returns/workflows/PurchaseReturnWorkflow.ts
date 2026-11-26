import { BusinessWorkflow, SyncContract, WorkflowContext } from '@/core/workflow';
import { InvoiceItem, InvoiceStatus } from '@/types';
import { purchaseWorkflow } from '@features/purchases/workflows/PurchaseWorkflow';

export interface PurchaseReturnInput {
  originalPurchaseId?: string;
  supplierId?: string;
  items: InvoiceItem[];
  total: number;
  id?: string;
  date?: string;
  notes?: string;
  isCash?: boolean;
}

export interface PurchaseReturnResult {
  refId: string;
  purchase: any;
}

export class PurchaseReturnWorkflow implements BusinessWorkflow<PurchaseReturnInput, PurchaseReturnResult> {
  public id = 'returns.purchase.process';
  public name = 'معالجة مرتجع مشتريات';
  public operationType = 'PURCHASE_RETURN';
  /** Documentation-only sync metadata; not consumed by the execution pipeline in V-30A. */
  public syncContract: SyncContract = {
    entityType: 'PURCHASE_RETURN',
    operation: 'CREATE',
    buildPayload: (result) => result as Record<string, unknown>
  };
  public requiredPermissions = ['purchases.return', 'purchases.edit'];
  public tables = [
    'invoices', 'invoiceItems', 'purchases', 'products', 'inventoryTransactions',
    'inventory_layers', 'fifo_consumption_log', 'warehouseStock',
    'branches', 'branchInventory', 'medicineBatches',
    'suppliers', 'journalEntries', 'journalLines', 'accounts',
    'financialTransactions', 'auditLogs', 'idempotencyKeys',
    'projectionEvents', 'settings', 'exchangeRates'
  ];

  public async validateInput(input: PurchaseReturnInput): Promise<void> {
    if (!input.items || input.items.length === 0) {
      throw new Error('يجب تحديد الأصناف المرتجعة للمورد');
    }
  }

  public async validateBusinessRules(input: PurchaseReturnInput): Promise<void> {
    if (input.total <= 0) {
      throw new Error('قيمة مرتجع المشتريات يجب أن تكون أكبر من الصفر');
    }
  }

  public getPeriodCheckDates(
    input: PurchaseReturnInput,
    ctx: WorkflowContext
  ): string[] {
    return [input.date || ctx.startedAt];
  }

  public async executeDomainSteps(
    input: PurchaseReturnInput,
    ctx: WorkflowContext,
    tx?: any
  ): Promise<PurchaseReturnResult> {
    const result = await purchaseWorkflow.executeDomainSteps(
      {
        ...input,
        isReturn: true,
        invoiceStatus: 'POSTED' as InvoiceStatus
      },
      ctx,
      tx
    );

    return {
      refId: result.refId,
      purchase: result.purchase
    };
  }
}

export const purchaseReturnWorkflow = new PurchaseReturnWorkflow();
