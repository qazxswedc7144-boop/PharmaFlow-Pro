
import { db } from '@/core/db';
import { InvoiceItem, InvoiceStatus } from '@/types';
import { UnifiedBusinessWorkflowOrchestrator } from '@/services/orchestration/UnifiedBusinessWorkflowOrchestrator';

export interface InvoiceProcessingRequest {
  type: 'SALE' | 'PURCHASE';
  payload: {
    customerId?: string;
    supplierId?: string;
    items: InvoiceItem[];
    total: number;
    id?: string;
    date?: string;
    notes?: string;
    attachment?: string;
  };
  options?: {
    isCash?: boolean;
    isReturn?: boolean;
    invoiceStatus?: InvoiceStatus;
    warehouseId?: string;
    currency?: string;
    paymentStatus?: 'Cash' | 'Credit';
    date?: string;
  };
}

export class SystemOrchestrator {
  /**
   * Processes an invoice through the system via the Unified Business Workflow Orchestrator.
   */
  static async processInvoice(request: InvoiceProcessingRequest): Promise<{ success: boolean; refId: string }> {
    if (request.type === 'PURCHASE') {
      return await UnifiedBusinessWorkflowOrchestrator.processPurchase(request.payload, request.options);
    } else {
      return await UnifiedBusinessWorkflowOrchestrator.processSale(request.payload, request.options);
    }
  }

  /**
   * Unposts an invoice.
   */
  static async unpostInvoice(invoiceId: string, type: 'SALE' | 'PURCHASE'): Promise<{ success: boolean }> {
    return await UnifiedBusinessWorkflowOrchestrator.unpostInvoice(invoiceId, type);
  }

  /**
   * Deletes an invoice (Soft Delete).
   */
  static async deleteInvoice(invoiceId: string, type: 'SALE' | 'PURCHASE'): Promise<{ success: boolean }> {
    return await UnifiedBusinessWorkflowOrchestrator.deleteInvoice(invoiceId, type);
  }

  /**
   * Recovers any interrupted PROCESSING records under idempotencyKeys.
   */
  static async recoverIdempotencyKeys(): Promise<void> {
    try {
      const processingKeys = await db.idempotencyKeys.where('status').equals('PROCESSING').toArray().catch(() => []);
      for (const record of processingKeys) {
        let sale = await db.sales.where('transactionUuid').equals(record.id).first().catch(() => null);
        if (!sale) {
          sale = await db.sales.filter((s: any) => s.transactionUuid === record.id || s.id === record.id).first().catch(() => null);
        }
        let purchase = await db.purchases.where('transactionUuid').equals(record.id).first().catch(() => null);
        if (!purchase) {
          purchase = await db.purchases.filter((p: any) => p.transactionUuid === record.id || p.id === record.id).first().catch(() => null);
        }
        let invoice = sale || purchase;
        if (!invoice) {
          invoice = await db.invoices.where('transactionUuid').equals(record.id).first().catch(() => null) as any;
        }

        if (invoice && (invoice.InvoiceStatus === 'POSTED' || invoice.invoiceStatus === 'POSTED')) {
          await db.idempotencyKeys.update(record.id, {
            status: 'COMPLETED',
            completedAt: new Date().toISOString()
          });
          console.log(`[Idempotency Recovery] Recovered completed key for invoice: ${record.id}`);
        } else {
          await db.idempotencyKeys.delete(record.id);
          console.log(`[Idempotency Recovery] Restored/Deleted stuck processing key for interrupted invoice posting: ${record.id}`);
        }
      }
    } catch (err) {
      console.error("[Idempotency Recovery] Error recovering processing keys:", err);
    }
  }
}
