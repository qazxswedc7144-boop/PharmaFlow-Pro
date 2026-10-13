import { BusinessWorkflow, WorkflowContext } from '@/core/workflow';
import { InvoiceItem, InvoiceStatus, Sale } from '@/types';
import { ValidationService as validationService } from '@/services/integrity/ValidationService';
import { UnifiedInventoryMutationEngine } from '@features/inventory/services/UnifiedInventoryMutationEngine';
import { InvoiceRepository } from '@/database/repositories/invoice.repository';
import { FinancialTransactionRepository } from '@/database/repositories/FinancialTransactionRepository';
import { AccountingEngine as accountingEngine } from '@features/accounting/services/AccountingEngine';
import { CurrencyService } from '@/services/localization/CurrencyService';
import { db } from '@/core/db';
import { ProjectionEventBus } from '@/services/system/ProjectionEventBus';
import { configurationService } from '@/services/config/configurationService';

export interface SalesWorkflowInput {
  customerId?: string;
  items: InvoiceItem[];
  total: number;
  id?: string;
  date?: string;
  notes?: string;
  attachment?: string;
  isCash?: boolean;
  isReturn?: boolean;
  invoiceStatus?: InvoiceStatus;
  currency?: string;
  isEdit?: boolean;
  warehouseId?: string;
  originalSaleId?: string;
}

export interface SalesWorkflowResult {
  refId: string;
  sale: Sale | any;
}

export class SalesWorkflow implements BusinessWorkflow<SalesWorkflowInput, SalesWorkflowResult> {
  public id = 'SALE';
  public name = 'ترحيل فاتورة مبيعات (آلي)';
  public operationType = 'POST';
  public requiredPermissions = ['sales.create', 'sales.edit'];
  public tables = [
    'invoices', 'invoiceItems', 'products', 'inventoryTransactions',
    'inventory_layers', 'fifo_consumption_log', 'warehouseStock',
    'branchInventory',
    'medicineBatches', 'stock_movements', 'customers', 'journalEntries',
    'journalLines', 'accounts', 'financialTransactions', 'auditLogs',
    'idempotencyKeys', 'projectionEvents', 'projectionCheckpoints',
    'accountingPeriods', 'sales', 'settings', 'systemSettings'
  ];

  public async validateInput(input: SalesWorkflowInput): Promise<void> {
    if (!input.items || input.items.length === 0) {
      throw new Error('يجب إضافة صنف واحد على الأقل بفاتورة المبيعات');
    }
    if (input.total < 0) {
      throw new Error('إجمالي الفاتورة يجب أن يكون أكبر من أو يساوي الصفر');
    }
  }

  public async validateBusinessRules(input: SalesWorkflowInput, ctx?: WorkflowContext): Promise<void> {
    if (ctx && (!ctx.tenantId || ctx.tenantId === 'default' || ctx.tenantId === 'default-tenant')) {
      throw new Error('FAIL_CLOSED: يتطلب تنفيذ فاتورة المبيعات وجود سياق مؤسسة موثوق (Trusted Tenant Context Required).');
    }

    // 1. Cross-Tenant Customer Validation
    if (input.customerId && input.customerId !== 'عميل نقدي') {
      const customer = await db.customers.get(input.customerId);
      if (!customer) {
        throw new Error(`CUSTOMER_NOT_FOUND: لم يتم العثور على العميل المحدد [${input.customerId}].`);
      }
      if (ctx?.tenantId && customer.tenantId && customer.tenantId !== ctx.tenantId) {
        throw new Error(`CROSS_TENANT_CUSTOMER_FORBIDDEN: العميل [${input.customerId}] تابع لمؤسسة أخرى.`);
      }
    }

    // 2. Cross-Tenant Product Validation
    for (const item of input.items || []) {
      const productId = item.productId || (item as any).product_id;
      if (productId) {
        const product = await db.products.get(productId);
        if (!product) {
          throw new Error(`PRODUCT_NOT_FOUND: الصنف [${productId}] غير موجود.`);
        }
        if (ctx?.tenantId && product.tenantId && product.tenantId !== ctx.tenantId) {
          throw new Error(`CROSS_TENANT_PRODUCT_FORBIDDEN: الصنف [${productId}] تابع لمؤسسة أخرى.`);
        }
      }
    }

    // 3. Cross-Tenant Existing Invoice Validation
    if (input.id) {
      const existing = await db.invoices.get(input.id);
      if (existing && ctx?.tenantId && existing.tenantId && existing.tenantId !== ctx.tenantId) {
        throw new Error(`CROSS_TENANT_INVOICE_FORBIDDEN: فاتورة المبيعات [${input.id}] تابعة لمؤسسة أخرى.`);
      }
    }

    await validationService.validateInvoice(input, 'SALE');

    if (!input.isEdit && input.id) {
      await validationService.validateInvoiceIdUniqueness(input.id, 'invoices', db.db);
    }
  }

  public async executeDomainSteps(
    input: SalesWorkflowInput,
    ctx: WorkflowContext,
    tx?: any
  ): Promise<SalesWorkflowResult> {
    const finalStatus: InvoiceStatus = input.invoiceStatus || 'POSTED';
    const isPosting = finalStatus === 'POSTED' || finalStatus === 'LOCKED';
    const effectiveDate = input.date || ctx.startedAt;
    const isReturn = !!input.isReturn;

    const docId = input.id || db.generateId('SALE');

    const savedDoc = await InvoiceRepository.saveSale(
      input.customerId!,
      input.items,
      input.total,
      docId,
      input.isCash || false,
      input.currency || CurrencyService.getCurrentCurrencyCode(),
      finalStatus,
      0,
      'LOW',
      docId,
      input.attachment,
      isReturn,
      effectiveDate,
      ctx.idempotencyKey,
      ctx.tenantId,
      ctx.branchId
    );

    if ((globalThis as any).__FAIL_AT_STAGE__ === 'AFTER_SALES_DOC') {
      throw new Error('SIMULATED_SALES_DOC_FAILURE');
    }

    const refId = (savedDoc as any)?.id || docId;
    let costResult = { totalCost: 0, itemCosts: {} as Record<string, number> };

    if (isPosting) {
      // 1. Resolve Warehouse (Explicit priority: input -> context -> configuration -> default WH-MAIN)
      const warehouseId =
        input.warehouseId ||
        (ctx.metadata?.warehouseId as string) ||
        configurationService.getSync<string>('inventory.defaultWarehouseId') ||
        'WH-MAIN';

      // 2. Extract Inventory Items (Exclude service / non-inventory items)
      const inventoryItems = (input.items || [])
        .filter((item) => {
          const productId = item.productId || (item as any).product_id;
          if (!productId) return false;

          // Defensive service / non-inventory detection
          const isService = (item as any).isService === true;
          const trackStock = (item as any).trackStock === false;
          const isServiceType = (item as any).type === 'SERVICE' || (item as any).itemType === 'SERVICE';
          if (isService || trackStock || isServiceType) {
            return false;
          }

          const qty = Number(item.quantity ?? (item as any).qty ?? 0);
          return qty > 0;
        })
        .map((item) => ({
          productId: (item.productId || (item as any).product_id)!,
          quantity: Number(item.quantity ?? (item as any).qty ?? 0),
          unitPrice: Number(item.unitPrice ?? (item as any).price ?? 0),
          batchId: item.batchId,
          batchNumber: (item as any).batchNumber,
          expiryDate: item.expiryDate
        }));

      // 3. Delegate Inventory Mutation Exclusively to UnifiedInventoryMutationEngine
      if (inventoryItems.length > 0) {
        const engine = UnifiedInventoryMutationEngine.getInstance();
        const tenantId = ctx.tenantId || 'TEN-DEV-001';
        const userId = ctx.userId || 'system';
        const branchId = ctx.branchId || 'BR-MAIN';
        const transactionUuid = ctx.idempotencyKey;

        if (isReturn) {
          const mutationResults = await engine.executeSalesReturn({
            returnInvoiceId: refId,
            originalSaleId: input.originalSaleId,
            warehouseId,
            items: inventoryItems,
            transactionUuid,
            userId,
            tenantId,
            branchId,
            notes: input.notes || `مرتجع مبيعات فاتورة #${refId}`
          });

          const totalCost = mutationResults.reduce((sum, r) => sum + (r.calculatedCost || 0), 0);
          const itemCosts: Record<string, number> = {};
          for (const r of mutationResults) {
            itemCosts[r.productId] = r.calculatedCost || 0;
          }
          costResult = { totalCost, itemCosts };
        } else {
          const mutationResults = await engine.executeIssueSale({
            invoiceId: refId,
            warehouseId,
            items: inventoryItems,
            transactionUuid,
            userId,
            tenantId,
            branchId,
            notes: input.notes || `صرف مبيعات فاتورة #${refId}`
          });

          const totalCost = mutationResults.reduce((sum, r) => sum + (r.calculatedCost || 0), 0);
          const itemCosts: Record<string, number> = {};
          for (const r of mutationResults) {
            itemCosts[r.productId] = r.calculatedCost || 0;
          }
          costResult = { totalCost, itemCosts };
        }
      }

      if ((globalThis as any).__FAIL_AT_STAGE__ === 'AFTER_INVENTORY') {
        throw new Error('SIMULATED_INVENTORY_FAILURE');
      }

      // 4. Financial & Accounting Ledger Execution
      const custId = input.customerId;
      if (custId && custId !== 'عميل نقدي') {
        const balanceDelta = isReturn ? -input.total : input.total;
        await db.updateCustomerBalance(custId, balanceDelta, tx);
      }

      if ((globalThis as any).__FAIL_AT_STAGE__ === 'AFTER_CUSTOMER_BALANCE') {
        throw new Error('SIMULATED_CUSTOMER_BALANCE_FAILURE');
      }

      await FinancialTransactionRepository.record({
        id: db.generateId('FT'),
        Transaction_Type: isReturn ? 'Refund' : (input.isCash ? 'Payment' : 'Invoice'),
        Reference_ID: refId,
        Reference_Table: 'Sales_Invoices',
        Entity_Type: 'Customer',
        Entity_Name: input.customerId || 'عميل نقدي',
        Amount: input.total,
        Direction: isReturn ? 'Credit' : 'Debit',
        Transaction_Date: effectiveDate,
        Notes: `فاتورة مبيعات #${refId}`,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId
      }, tx);

      if ((globalThis as any).__FAIL_AT_STAGE__ === 'AFTER_FT') {
        throw new Error('SIMULATED_FT_FAILURE');
      }

      await accountingEngine.postInvoice(
        {
          ...input,
          type: 'SALE',
          id: refId,
          transactionUuid: ctx.idempotencyKey,
          tenantId: ctx.tenantId,
          branchId: ctx.branchId
        },
        costResult,
        tx
      );

      if ((globalThis as any).__FAIL_AT_STAGE__ === 'AFTER_JOURNAL') {
        throw new Error('SIMULATED_JOURNAL_FAILURE');
      }

      await ProjectionEventBus.publish('INVOICE_POSTED', refId, {
        type: 'SALE',
        transactionUuid: ctx.idempotencyKey,
        correlationId: ctx.correlationId
      });
    }

    return {
      refId,
      sale: savedDoc
    };
  }
}

export const salesWorkflow = new SalesWorkflow();
