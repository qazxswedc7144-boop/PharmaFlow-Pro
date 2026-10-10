
import { UnifiedBusinessWorkflowOrchestrator } from '@/services/orchestration/UnifiedBusinessWorkflowOrchestrator';

export const voucherService = {
  createReceipt: async (data: { customer_id: string; amount: number; notes?: string; date?: string; paymentMethod?: 'CASH' | 'TRANSFER' }) => {
    const res = await UnifiedBusinessWorkflowOrchestrator.processCustomerReceipt({
      partnerId: data.customer_id,
      amount: data.amount,
      notes: data.notes,
      date: data.date,
      paymentMethod: data.paymentMethod
    });
    return res.receipt;
  },

  createPayment: async (data: {
    supplier_id: string;
    amount: number;
    notes?: string;
    date?: string;
    paymentMethod?: 'CASH' | 'TRANSFER';
    allocations?: Record<string, number | { amount: number; note?: string }>;
    idempotencyKey?: string;
    transactionUuid?: string;
  }) => {
    const res = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
      partnerId: data.supplier_id,
      amount: data.amount,
      notes: data.notes,
      date: data.date,
      paymentMethod: data.paymentMethod,
      allocations: data.allocations,
      idempotencyKey: data.idempotencyKey || data.transactionUuid
    });
    return res.payment;
  },

  cancelVoucher: async (data: { id: string; type: 'RECEIPT' | 'PAYMENT'; partnerId: string; amount: number; reason?: string }) => {
    const { WorkflowOrchestrator } = await import('@/core/workflow');
    const { voucherCancellationWorkflow } = await import('@/features/accounting/workflows/VoucherCancellationWorkflow');
    return await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: data.id,
      type: data.type,
      partnerId: data.partnerId,
      amount: data.amount,
      reason: data.reason
    });
  }
};

