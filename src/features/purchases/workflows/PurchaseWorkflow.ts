import { BusinessWorkflow, WorkflowContext } from '@/core/workflow';
import { InvoiceItem, InvoiceStatus, Purchase } from '@/types';
import { ValidationService as validationService } from '@/services/integrity/ValidationService';
import { UnifiedInventoryMutationEngine } from '@features/inventory/services/UnifiedInventoryMutationEngine';
import { InvoiceRepository } from '@/database/repositories/invoice.repository';
import { FinancialTransactionRepository } from '@/database/repositories/FinancialTransactionRepository';
import { AccountingEngine as accountingEngine } from '@features/accounting/services/AccountingEngine';
import { CurrencyService } from '@/services/localization/CurrencyService';
import { db } from '@/core/db';
import { ProjectionEventBus } from '@/services/system/ProjectionEventBus';
import { configurationService } from '@/services/config/configurationService';

export interface PurchaseWorkflowInput {
  supplierId?: string;
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
  originalPurchaseId?: string;
}

export interface PurchaseWorkflowResult {
  refId: string;
  purchase: Purchase | any;
}

export class PurchaseWorkflow implements BusinessWorkflow<PurchaseWorkflowInput, PurchaseWorkflowResult> {
  public id = 'purchases.invoice.process';
  public name = 'معالجة فاتورة مشتريات';
  public operationType = 'PURCHASE';
  public requiredPermissions = ['purchases.create', 'purchases.edit'];
  public tables = [
    'invoices', 'invoiceItems', 'products', 'inventoryTransactions',
    'inventory_layers', 'fifo_consumption_log', 'warehouseStock',
    'branchInventory',
    'medicineBatches', 'stock_movements', 'suppliers', 'journalEntries',
    'journalLines', 'accounts', 'financialTransactions', 'auditLogs',
    'idempotencyKeys', 'projectionEvents', 'projectionCheckpoints',
    'accountingPeriods', 'purchases', 'settings', 'systemSettings'
  ];

  public async validateInput(input: PurchaseWorkflowInput): Promise<void> {
    if (!input.items || input.items.length === 0) {
      throw new Error('يجب إضافة صنف واحد على الأقل بفاتورة المشتريات');
    }
    if (input.total < 0) {
      throw new Error('إجمالي الفاتورة يجب أن يكون أكبر من أو يساوي الصفر');
    }
  }

  public async validateBusinessRules(input: PurchaseWorkflowInput, ctx: WorkflowContext): Promise<void> {
    if (ctx && (!ctx.tenantId || ctx.tenantId === 'default' || ctx.tenantId === 'default-tenant')) {
      throw new Error('FAIL_CLOSED: يتطلب تنفيذ فاتورة المشتريات وجود سياق مؤسسة موثوق (Trusted Tenant Context Required).');
    }

    // 1. Cross-Tenant Supplier Validation
    if (input.supplierId && input.supplierId !== 'مورد نقدي') {
      const supplier = await db.suppliers.get(input.supplierId);
      if (!supplier) {
        throw new Error(`SUPPLIER_NOT_FOUND: لم يتم العثور على المورد المحدد [${input.supplierId}].`);
      }
      if (ctx?.tenantId && supplier.tenantId && supplier.tenantId !== ctx.tenantId) {
        throw new Error(`CROSS_TENANT_SUPPLIER_FORBIDDEN: المورد [${input.supplierId}] تابع لمؤسسة أخرى.`);
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
        throw new Error(`CROSS_TENANT_INVOICE_FORBIDDEN: فاتورة المشتريات [${input.id}] تابعة لمؤسسة أخرى.`);
      }
    }

    await validationService.validateInvoice(input, 'PURCHASE');
    if (!input.isEdit && input.id) {
      await validationService.validateInvoiceIdUniqueness(input.id, 'purchases', db.db);
    }
  }

  public async executeDomainSteps(
    input: PurchaseWorkflowInput,
    ctx: WorkflowContext,
    tx?: any
  ): Promise<PurchaseWorkflowResult> {
    const finalStatus: InvoiceStatus = input.invoiceStatus || 'POSTED';
    const isPosting = finalStatus === 'POSTED' || finalStatus === 'LOCKED';
    const effectiveDate = input.date || ctx.startedAt;
    const isReturn = !!input.isReturn;

    const docId = input.id || db.generateId('PUR');
    const savedDoc = await InvoiceRepository.savePurchase(
      input.supplierId!,
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

    if ((globalThis as any).__FAIL_AT_STAGE__ === 'AFTER_PURCHASE_DOC') {
      throw new Error('SIMULATED_PURCHASE_DOC_FAILURE');
    }

    const refId = (savedDoc as any)?.id || docId;
    let costResult = { totalCost: 0, itemCosts: {} as Record<string, number> };

    if (isPosting) {
      // 1. Resolve Warehouse (Precedence: input -> context -> configuration -> default WH-MAIN)
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
        .map((item) => {
          const productId = (item.productId || (item as any).product_id)!;
          const quantity = Number(item.quantity ?? (item as any).qty ?? 0);

          // Resolve purchase cost with strict priority: unitCost -> cost -> costPrice -> unitPrice -> price
          const rawCost = (item as any).unitCost !== undefined ? (item as any).unitCost
            : (item as any).cost !== undefined ? (item as any).cost
            : (item as any).costPrice !== undefined ? (item as any).costPrice
            : (item as any).unitPrice !== undefined ? (item as any).unitPrice
            : (item as any).price;

          const unitCost = rawCost !== undefined && rawCost !== null && !isNaN(Number(rawCost))
            ? Number(rawCost)
            : undefined;

          const rawPrice = (item as any).unitPrice !== undefined ? (item as any).unitPrice
            : (item as any).price;
          const unitPrice = rawPrice !== undefined && rawPrice !== null && !isNaN(Number(rawPrice))
            ? Number(rawPrice)
            : unitCost;

          return {
            productId,
            quantity,
            unitCost,
            unitPrice,
            batchId: item.batchId,
            batchNumber: (item as any).batchNumber,
            expiryDate: item.expiryDate
          };
        });

      // 3. Delegate Inventory Mutation Exclusively to UnifiedInventoryMutationEngine
      if (inventoryItems.length > 0) {
        const engine = UnifiedInventoryMutationEngine.getInstance();
        const tenantId = ctx.tenantId || 'TEN-DEV-001';
        const userId = ctx.userId || 'system';
        const branchId = ctx.branchId || 'BR-MAIN';
        const transactionUuid = ctx.idempotencyKey;

        if (isReturn) {
          const mutationResults = await engine.executePurchaseReturn({
            returnInvoiceId: refId,
            originalPurchaseId: input.originalPurchaseId,
            warehouseId,
            items: inventoryItems,
            transactionUuid,
            userId,
            tenantId,
            branchId,
            notes: input.notes || `مرتجع مشتريات فاتورة #${refId}`,
            timestamp: effectiveDate
          });

          const totalCost = mutationResults.reduce((sum, r) => sum + ((r.calculatedCost || 0) * Math.abs(r.delta || 0)), 0);
          const itemCosts: Record<string, number> = {};
          for (const r of mutationResults) {
            itemCosts[r.productId] = (itemCosts[r.productId] || 0) + ((r.calculatedCost || 0) * Math.abs(r.delta || 0));
          }
          costResult = { totalCost, itemCosts };
        } else {
          const mutationResults = await engine.executeReceivePurchase({
            invoiceId: refId,
            warehouseId,
            supplierId: input.supplierId,
            items: inventoryItems,
            transactionUuid,
            userId,
            tenantId,
            branchId,
            notes: input.notes || `استلام مشتريات فاتورة #${refId}`,
            timestamp: effectiveDate
          });

          const totalCost = mutationResults.reduce((sum, r) => sum + ((r.calculatedCost || 0) * Math.abs(r.delta || 0)), 0);
          const itemCosts: Record<string, number> = {};
          for (const r of mutationResults) {
            itemCosts[r.productId] = (itemCosts[r.productId] || 0) + ((r.calculatedCost || 0) * Math.abs(r.delta || 0));
          }
          costResult = { totalCost, itemCosts };
        }
      }

      if ((globalThis as any).__FAIL_AT_STAGE__ === 'AFTER_INVENTORY') {
        throw new Error('SIMULATED_INVENTORY_FAILURE');
      }

      // 4. Financial & Accounting Ledger Execution
      const suppId = input.supplierId;
      if (suppId && suppId !== 'مورد نقدي') {
        const balanceDelta = isReturn ? -input.total : input.total;
        await db.updateSupplierBalance(suppId, balanceDelta, tx);
      }

      if ((globalThis as any).__FAIL_AT_STAGE__ === 'AFTER_SUPPLIER_BALANCE') {
        throw new Error('SIMULATED_SUPPLIER_BALANCE_FAILURE');
      }

      await FinancialTransactionRepository.record({
        id: db.generateId('FT'),
        Transaction_Type: isReturn ? 'Refund' : (input.isCash ? 'Payment' : 'Invoice'),
        Reference_ID: refId,
        Reference_Table: 'Purchase_Invoices',
        Entity_Type: 'Supplier',
        Entity_Name: input.supplierId || 'مورد نقدي',
        Amount: input.total,
        Direction: isReturn ? 'Debit' : 'Credit',
        Transaction_Date: effectiveDate,
        Notes: `فاتورة مشتريات #${refId}`,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId
      }, tx);

      if ((globalThis as any).__FAIL_AT_STAGE__ === 'AFTER_FT') {
        throw new Error('SIMULATED_FT_FAILURE');
      }

      await accountingEngine.postInvoice(
        {
          ...input,
          type: 'PURCHASE',
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
        type: 'PURCHASE',
        transactionUuid: ctx.idempotencyKey,
        correlationId: ctx.correlationId
      });
    }

    return {
      refId,
      purchase: savedDoc
    };
  }
}

export const purchaseWorkflow = new PurchaseWorkflow();
