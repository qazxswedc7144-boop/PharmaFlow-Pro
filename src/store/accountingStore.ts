
import { create } from 'zustand';
import { CashFlow, AccountingEntry, Account } from '@/types';
import { AccountingRepository } from '@/database/repositories/AccountingRepository';
import { UnifiedBusinessWorkflowOrchestrator, WorkflowSalePayload, WorkflowPurchasePayload, WorkflowInvoiceOptions } from '@/services/orchestration/UnifiedBusinessWorkflowOrchestrator';

interface AccountingState {
  cashFlow: CashFlow[];
  journalEntries: AccountingEntry[];
  accounts: Account[];
  loadAccounting: () => Promise<void>;
  addInvoice: (invoice: { type?: 'SALE' | 'PURCHASE'; payload?: any; options?: WorkflowInvoiceOptions; [key: string]: any }, type?: 'SALE' | 'PURCHASE') => Promise<{ success: boolean; refId: string } | any>;
  addPartner: (partner: unknown, type: 'C' | 'S') => Promise<unknown>;
}

export const useAccountingStore = create<AccountingState>((set) => ({
  cashFlow: [],
  journalEntries: [],
  accounts: [],
  loadAccounting: async () => {
    const [journalEntries, cashFlow, accounts] = await Promise.all([
      AccountingRepository.getEntries(),
      AccountingRepository.getCashFlow(),
      AccountingRepository.getAccounts()
    ]);
    set({ journalEntries, cashFlow, accounts });
  },
  addInvoice: async (invoiceData, explicitType) => {
    const targetType = explicitType || invoiceData.type || (invoiceData.payload as any)?.type || 'SALE';
    const rawPayload = invoiceData.payload || invoiceData;
    const options: WorkflowInvoiceOptions = (invoiceData.options as WorkflowInvoiceOptions) || {};

    if (targetType === 'SALE') {
      const payload: WorkflowSalePayload = {
        customerId: rawPayload.customerId || rawPayload.customer_id,
        items: rawPayload.items || [],
        total: rawPayload.total || rawPayload.subtotal || 0,
        discountPercent: rawPayload.discountPercent ?? options.discountPercent ?? 0,
        id: rawPayload.id,
        invoiceNumber: rawPayload.invoiceNumber || rawPayload.invoice_number || rawPayload.id,
        date: rawPayload.date || options.date,
        notes: rawPayload.notes,
        attachment: rawPayload.attachment,
        transactionUuid: rawPayload.transactionUuid
      };
      return await UnifiedBusinessWorkflowOrchestrator.processSale(payload, options);
    } else {
      const payload: WorkflowPurchasePayload = {
        supplierId: rawPayload.supplierId || rawPayload.supplier_id,
        items: rawPayload.items || [],
        total: rawPayload.total ?? rawPayload.subtotal ?? 0,
        id: rawPayload.id,
        invoiceNumber: rawPayload.invoiceNumber ?? rawPayload.invoice_number ?? undefined,
        date: rawPayload.date || options.date,
        notes: rawPayload.notes,
        attachment: rawPayload.attachment,
        transactionUuid: rawPayload.transactionUuid,
        discountPercent: rawPayload.discountPercent ?? options.discountPercent,
        otherFees: rawPayload.otherFees ?? options.otherFees,
        tax: rawPayload.tax ?? options.tax,
        pendingProducts: rawPayload.pendingProducts,
        isEdit: Boolean(rawPayload.isEdit ?? options.isEdit ?? false),
        isReturn: Boolean(rawPayload.isReturn ?? options.isReturn ?? false),
        currency: rawPayload.currency ?? options.currency,
        warehouseId: rawPayload.warehouseId ?? options.warehouseId,
        originalPurchaseId: rawPayload.originalPurchaseId ?? options.originalPurchaseId
      };
      return await UnifiedBusinessWorkflowOrchestrator.processPurchase(payload, options);
    }
  },
  addPartner: async (partner, _type) => {
    // Basic placeholder implementation
    return partner;
  }
}));
