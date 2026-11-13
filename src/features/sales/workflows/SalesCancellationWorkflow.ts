import { BusinessWorkflow, SyncContract, WorkflowContext } from '@/core/workflow';
import { db } from '@/core/db';
import { InventoryService } from '@features/inventory/services/InventoryService';
import { AuditService } from '@/services/system/AuditService';
import { ProjectionEventBus } from '@/services/system/ProjectionEventBus';

export interface SalesCancellationInput {
  invoiceId: string;
  reason?: string;
}

export interface SalesCancellationResult {
  success: boolean;
  invoiceId: string;
}

export class SalesCancellationWorkflow implements BusinessWorkflow<SalesCancellationInput, SalesCancellationResult> {
  public id = 'sales.invoice.cancel';
  public name = 'إلغاء الفاتورة بالكامل';
  public operationType = 'INVOICE_CANCEL';
  /** Documentation-only sync metadata; not consumed by the execution pipeline in V-30A. */
  public syncContract: SyncContract = {
    entityType: 'INVOICE',
    operation: 'CANCEL',
    buildPayload: (result) => result as Record<string, unknown>
  };
  public requiredPermissions = ['sales.cancel', 'invoices.manage'];
  public tables = [
    'invoices', 'invoiceItems', 'products', 'inventoryTransactions',
    'journalEntries', 'journalLines', 'accounts', 'auditLogs',
    'idempotencyKeys', 'projectionEvents'
  ];

  public async validateInput(input: SalesCancellationInput): Promise<void> {
    if (!input.invoiceId) {
      throw new Error('معرف الفاتورة مطلوب للإلغاء');
    }
  }

  public async validateBusinessRules(input: SalesCancellationInput): Promise<void> {
    const invoice = (await db.invoices.get(input.invoiceId)) || (await db.sales.get(input.invoiceId)) || (await db.purchases.get(input.invoiceId));
    if (!invoice) {
      throw new Error(`الفاتورة رقم [${input.invoiceId}] غير موجودة بالنظام`);
    }
    const docStatus = (invoice as any).documentStatus || (invoice as any).status || (invoice as any).InvoiceStatus;
    if (docStatus === 'CANCELLED') {
      throw new Error('الفاتورة ملغاة بالفعل مسبقاً');
    }
  }

  public async executeDomainSteps(
    input: SalesCancellationInput,
    ctx: WorkflowContext
  ): Promise<SalesCancellationResult> {
    const invoice = (await db.invoices.get(input.invoiceId)) || (await db.sales.get(input.invoiceId)) || (await db.purchases.get(input.invoiceId));
    if (!invoice) throw new Error('Invoice not found');

    const updatedInvoice = {
      ...invoice,
      documentStatus: 'CANCELLED',
      status: 'CANCELLED',
      updatedAt: new Date().toISOString()
    };

    await db.invoices.put(updatedInvoice as any);

    // If invoice had items, reverse stock movements if applied
    const items = (invoice as any).items || [];
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item.productId && item.quantity) {
          const qtyToReverse = (invoice as any).type === 'SALE' ? item.quantity : -item.quantity;
          await InventoryService.updateStock(item.productId, qtyToReverse).catch(() => null);
        }
      }
    }

    await (AuditService.log as any)({
      action: 'DELETE',
      module: 'SALES',
      transactionUuid: ctx.workflowId,
      recordId: input.invoiceId,
      details: `تم إلغاء الفاتورة [${input.invoiceId}] - السبب: ${input.reason || 'إلغاء من قبل المستخدم'}`
    });

    await ProjectionEventBus.publish('INVOICE_CANCELLED', input.invoiceId, {
      type: (invoice as any).type || 'SALE',
      total: (invoice as any).total || 0,
      correlationId: ctx.correlationId
    });

    return {
      success: true,
      invoiceId: input.invoiceId
    };
  }
}

export const salesCancellationWorkflow = new SalesCancellationWorkflow();
