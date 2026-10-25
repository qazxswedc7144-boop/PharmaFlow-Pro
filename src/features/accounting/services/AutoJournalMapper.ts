import { db } from '@/core/db';
import { CurrencyService } from '@/services/localization/CurrencyService';
import { InvoiceRepository } from '@/database/repositories/invoice.repository';
import { AccountingEngine } from '@features/accounting/services/AccountingEngine';
import { AccountingRepository } from '@/database/repositories/AccountingRepository';
import { AccountingEntry, InvoiceItem, Sale, Purchase, InvoiceStatus, PaymentStatus } from '@/types';
import { TokenProvider } from '@/services/auth/tokenProvider';

/**
 * AutoJournalMapper
 * Production-ready enterprise mapper with ACID-compliant unified transaction logic to guarantee financial data integrity.
 */
export const AutoJournalMapper = {
  /**
   * 1 & 2. Tightly wraps the entire financial transaction pipeline (Inventory, Invoice, and Ledger post)
   * in a unified read-write IndexedDB / Dexie transaction.
   * 
   * @param request Financial invoice data and accounting requirements
   */
  processUnifiedFinancialTransaction: async (request: {
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
      invoiceStatus?: 'DRAFT' | 'POSTED' | 'LOCKED' | 'APPROVED';
      currency?: string;
      paymentStatus?: 'Cash' | 'Credit';
      date?: string;
    };
  }): Promise<{ success: boolean; refId: string }> => {
    const { type, payload, options } = request;
    const isReturn = !!options?.isReturn;
    const finalStatus: InvoiceStatus = (options?.invoiceStatus as InvoiceStatus) || 'POSTED';
    const isPosting = (finalStatus as string) === 'POSTED' || (finalStatus as string) === 'LOCKED' || (finalStatus as string) === 'APPROVED';
    const currency = options?.currency || CurrencyService.getCurrentCurrencyCode();
    const paymentStatus: PaymentStatus = (options?.paymentStatus === 'Credit' ? 'UNPAID' : 'PAID') as PaymentStatus;
    
    const session = TokenProvider.getCurrentSession();
    const tenantId = session.tenantId || session.user?.tenantId;
    const branchId = session.branchId || session.user?.branchId;

    const forbiddenTenants = ['TEN-DEV-001', 'tenant_default', 'default', 'default-tenant'];
    if (!tenantId || forbiddenTenants.includes(tenantId)) {
      throw new Error('TRUSTED_TENANT_CONTEXT_REQUIRED: No valid trusted tenant context available in AutoJournalMapper.');
    }

    const invoiceId = payload.id || db.generateId(type === 'SALE' ? 'SAL' : 'PUR');
    const enrichedPayload = { ...payload, id: invoiceId };

    console.log(`[Financial Architect] [ACID Transaction Start] Processing invoice: ${invoiceId}`);

    try {
      // 3. COMPLETE ROLLBACK: Wrap all three sequential operations in a single db transaction.
      // If any step throws an error, the database transaction is automatically aborted, reversing all modifications.
      const result = await db.safeTransaction('rw', [
        'products', 'invoices', 'invoiceItems', 'sales', 'purchases', 
        'inventoryTransactions', 'journalEntries', 'accounts', 'journalLines',
        'customers', 'suppliers'
      ], async () => {
        
        // --- STEP A: Inventory Movement & Costing (1/3) ---
        console.log(`[Structured Logs] [ACID Step 1/3] Calculating cost & executing Warehouse Stock Movements via Unified Engine.`);
        let costResult = { totalCost: 0, itemCosts: {} };
        try {
          if (isPosting) {
            const engine = (await import('@features/inventory/services/UnifiedInventoryMutationEngine')).unifiedInventoryMutationEngine;
            const inventoryItems = enrichedPayload.items.map(i => ({
              productId: i.product_id || i.productId || '',
              quantity: Number(i.qty || i.quantity || 0),
              unitPrice: Number(i.price || i.unitPrice || 0),
              batchId: i.batchId
            }));

            let mutationResults: any[] = [];
            if (type === 'SALE') {
              if (isReturn) {
                mutationResults = await engine.executeSalesReturn({
                  returnInvoiceId: invoiceId,
                  warehouseId: 'WH-MAIN',
                  items: inventoryItems,
                  transactionUuid: `FIN-${invoiceId}`,
                  userId: 'system-financial-mapper',
                  tenantId,
                  branchId
                });
              } else {
                mutationResults = await engine.executeIssueSale({
                  invoiceId: invoiceId,
                  warehouseId: 'WH-MAIN',
                  items: inventoryItems,
                  transactionUuid: `FIN-${invoiceId}`,
                  userId: 'system-financial-mapper',
                  tenantId,
                  branchId
                });
              }
            } else {
              if (isReturn) {
                mutationResults = await engine.executePurchaseReturn({
                  returnInvoiceId: invoiceId,
                  warehouseId: 'WH-MAIN',
                  items: inventoryItems,
                  transactionUuid: `FIN-${invoiceId}`,
                  userId: 'system-financial-mapper',
                  tenantId,
                  branchId
                });
              } else {
                mutationResults = await engine.executeReceivePurchase({
                  invoiceId: invoiceId,
                  warehouseId: 'WH-MAIN',
                  items: inventoryItems,
                  transactionUuid: `FIN-${invoiceId}`,
                  userId: 'system-financial-mapper',
                  tenantId,
                  branchId
                });
              }
            }

            const totalCost = mutationResults.reduce((sum, r) => sum + ((r.calculatedCost || 0) * Math.abs(r.delta || 0)), 0);
            const itemCosts: Record<string, number> = {};
            for (const r of mutationResults) {
              itemCosts[r.productId] = (itemCosts[r.productId] || 0) + ((r.calculatedCost || 0) * Math.abs(r.delta || 0));
            }
            costResult = { totalCost, itemCosts };
            console.log(`[Structured Logs] [ACID Step 1/3 Success] Unified mutation applied successfully, total computed cost: ${costResult.totalCost}`);
          } else {
            console.log(`[Structured Logs] [ACID Step 1/3 Bypass] Draft Status detected. Skipping inventory transactional write.`);
          }
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[Structured Logs] [Step 1 Execution Failed] Failed during stock movement calculation:`, error);
          throw new Error(`🚫 [الخطوة أ] فشل تسجيل حركة المخازن وتقييم التكلفة (Inventory Movement & FIFO Costing) مما تسبب في التراجع عن المعاملة بالكامل بحالة ACID: ${errMsg}`);
        }

        // --- STEP B: Document Creation & Table Persistence (2/3) ---
        console.log(`[Structured Logs] [ACID Step 2/3] Writing document to DB tables to ensure physical persistence.`);
        let docResult;
        try {
          if (type === 'SALE') {
            docResult = await InvoiceRepository.saveSale(
              payload.customerId!,
              payload.items,
              payload.total,
              isReturn,
              invoiceId,
              currency,
              paymentStatus,
              finalStatus,
              0, // tax
              'LOW', // priority
              costResult.totalCost,
              invoiceId,
              payload.attachment,
              payload.date
            );
          } else {
            docResult = await InvoiceRepository.savePurchase(
              payload.supplierId!,
              payload.items,
              payload.total,
              invoiceId,
              !!options?.isCash,
              currency,
              finalStatus,
              0, // tax
              'LOW', // priority
              invoiceId,
              payload.attachment,
              isReturn,
              payload.date
            );
          }
          console.log(`[Structured Logs] [ACID Step 2/3 Success] Document created successfully. Assigned DB Entry ID: ${docResult.id}`);
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[Structured Logs] [Step 2 Execution Failed] Transaction interrupted while saving the Invoice document to DB:`, error);
          throw new Error(`🚫 [الخطوة ب] فشل تسجيل وإنشاء مستند الفاتورة (Invoice Generation) في قاعدة البيانات مما تسبب في التراجع عن المعاملة بالكامل بحالة ACID: ${errMsg}`);
        }

        // --- STEP C: Dual-Entry Mapping, Ledger Recording, & Balance Integrity (3/3) ---
        console.log(`[Structured Logs] [ACID Step 3/3] Commencing automatic general ledger posting.`);
        try {
          if (isPosting) {
            let entry: AccountingEntry;
            if (type === 'SALE') {
              const salePayload: Sale = {
                id: invoiceId,
                SaleID: invoiceId,
                date: payload.date || new Date().toISOString(),
                customerId: payload.customerId,
                items: payload.items,
                subtotal: payload.total,
                finalTotal: payload.total,
                paymentStatus,
                created_at: new Date().toISOString(),
                lastModified: new Date().toISOString()
              };
              if (isReturn) {
                entry = await AccountingEngine.generateReturnEntry(salePayload, payload.items);
              } else {
                entry = await AccountingEngine.generateSalesEntry(salePayload, payload.items);
              }
            } else {
              const purchasePayload: Purchase = {
                id: invoiceId,
                purchase_id: invoiceId,
                invoiceId: invoiceId,
                date: payload.date || new Date().toISOString(),
                supplierId: payload.supplierId,
                items: payload.items,
                totalAmount: payload.total,
                status: options?.isCash ? 'PAID' : 'PENDING',
                created_at: new Date().toISOString(),
                lastModified: new Date().toISOString()
              };
              if (isReturn) {
                entry = await AccountingEngine.generatePurchaseReturnEntry(purchasePayload);
              } else {
                entry = await AccountingEngine.generatePurchaseEntry(purchasePayload);
              }
            }

            // High Safety Validation Check: Ensure credit and debit lines are strictly equal
            const totalDebit = entry.lines.reduce((sum, l) => sum + (l.debit || 0), 0);
            const totalCredit = entry.lines.reduce((sum, l) => sum + (l.credit || 0), 0);
            
            console.log(`[Structured Logs] [Step 3 Auditing] Validating total debit (${totalDebit}) equals total credit (${totalCredit}) prior to writing.`);
            if (Math.abs(totalDebit - totalCredit) > 0.01) {
              throw new Error(`القيد غير متزن ماليًا: إجمالي المدين (${totalDebit}) لا يساوي إجمالي الدائن (${totalCredit}) بالفاتورة #${invoiceId}`);
            }

            // Post entry to General Ledger tables and update core balances
            await AccountingRepository.addEntry(entry);
            console.log(`[Structured Logs] [ACID Step 3/3 Success] Balanced Ledger Entries successfully posted.`);
          } else {
            console.log(`[Structured Logs] [ACID Step 3/3 Bypass] Draft Status detected. Skipping accounting journal posting.`);
          }
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[Structured Logs] [Step 3 Execution Failed] Balance verification error or ledger entry writing failed:`, error);
          throw new Error(`🚫 [الخطوة ج] فشل توليد أو تدوين القيد المحاسبي المقابل في دفتر اليومية العامة (Journal Entry) أو القيد غير متزن ماليًا مما تسبب في التراجع عن المعاملة بالكامل بحالة ACID: ${errMsg}`);
        }

        return { success: true, refId: invoiceId };
      });

      console.log(`[Financial Architect] [ACID Transaction Success] All database steps committed safely & successfully.`);
      return result;

    } catch (transactionError: unknown) {
      const errMsg = transactionError instanceof Error ? transactionError.message : String(transactionError);
      console.error(`❌ [Financial Architect] [ACID ROLLBACK ENGAGED] Integrity failure detected. Database changes safely undone. Reason: ${errMsg}`);
      throw transactionError; // bubbles up to fail operably and trigger Dexie Rollback
    }
  },

  mapSaleToEntries: async (payload: Sale): Promise<AccountingEntry | AccountingEntry[]> => {
    try {
      return await AccountingEngine.generateSalesEntry(payload, payload.items || []);
    } catch {
      return [];
    }
  },

  mapPurchaseToEntries: async (payload: Purchase): Promise<AccountingEntry | AccountingEntry[]> => {
    try {
      return await AccountingEngine.generatePurchaseEntry(payload);
    } catch {
      return [];
    }
  },

  mapVoucherToEntries: async (vData: { id: string; amount: number }): Promise<Partial<AccountingEntry>> => {
    return {
      id: vData.id,
      date: new Date().toISOString(),
      TotalAmount: vData.amount,
      status: 'Posted',
      sourceId: vData.id,
      sourceType: 'VOUCHER',
      lines: []
    };
  }
};

