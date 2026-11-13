import { BusinessWorkflow, SyncContract, WorkflowContext } from '@/core/workflow';
import { InvoiceItem, InvoiceStatus } from '@/types';
import { salesWorkflow } from '@features/sales/workflows/SalesWorkflow';

export interface SalesReturnInput {
  originalSaleId?: string;
  customerId?: string;
  items: InvoiceItem[];
  total: number;
  id?: string;
  date?: string;
  notes?: string;
  isCash?: boolean;
}

export interface SalesReturnResult {
  refId: string;
  sale: any;
}

export class SalesReturnWorkflow implements BusinessWorkflow<SalesReturnInput, SalesReturnResult> {
  public id = 'returns.sales.process';
  public name = 'معالجة مرتجع مبيعات';
  public operationType = 'SALES_RETURN';
  /** Documentation-only sync metadata; not consumed by the execution pipeline in V-30A. */
  public syncContract: SyncContract = {
    entityType: 'SALES_RETURN',
    operation: 'CREATE',
    buildPayload: (result) => result as Record<string, unknown>
  };
  public requiredPermissions = ['sales.return', 'sales.edit'];
  public tables = [
    'invoices', 'invoiceItems', 'products', 'inventoryTransactions',
    'inventory_layers', 'fifo_consumption_log', 'customers', 'journalEntries',
    'journalLines', 'accounts', 'financialTransactions', 'auditLogs',
    'idempotencyKeys', 'projectionEvents'
  ];

  public async validateInput(input: SalesReturnInput): Promise<void> {
    if (!input.items || input.items.length === 0) {
      throw new Error('يجب تحديد الأصناف المرتجعة');
    }
  }

  public async validateBusinessRules(input: SalesReturnInput): Promise<void> {
    if (input.total <= 0) {
      throw new Error('قيمة المرتجع يجب أن تكون أكبر من الصفر');
    }
  }

  public async executeDomainSteps(
    input: SalesReturnInput,
    ctx: WorkflowContext
  ): Promise<SalesReturnResult> {
    // Delegates domain execution to salesWorkflow configured with isReturn=true
    const result = await salesWorkflow.executeDomainSteps(
      {
        ...input,
        isReturn: true,
        invoiceStatus: 'POSTED' as InvoiceStatus
      },
      ctx
    );

    return {
      refId: result.refId,
      sale: result.sale
    };
  }
}

export const salesReturnWorkflow = new SalesReturnWorkflow();
