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
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';
import { ensureActiveBranchRegistered } from '@features/branches/services/activeBranchRegistry';

export interface PurchaseWorkflowInput {
  supplierId?: string;
  items: InvoiceItem[];
  total: number;
  id?: string;
  invoiceNumber?: string;
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
  discountPercent?: number;
  otherFees?: number;
  tax?: number;
  pendingProducts?: any[];
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
    'accountingPeriods', 'purchases', 'settings', 'systemSettings', 'branches',
    'idempotency_records'
  ];

  public async validateInput(input: PurchaseWorkflowInput): Promise<void> {
    if (!input.items || input.items.length === 0) {
      throw new Error('يجب إضافة صنف واحد على الأقل بفاتورة المشتريات');
    }

    if (input.total < 0) {
      throw new Error('إجمالي الفاتورة يجب أن يكون أكبر من أو يساوي الصفر');
    }
  }

  public async validateBusinessRules(
    input: PurchaseWorkflowInput,
    ctx: WorkflowContext
  ): Promise<void> {
    if (
      !ctx ||
      !ctx.tenantId ||
      ctx.tenantId === 'default' ||
      ctx.tenantId === 'default-tenant' ||
      ctx.tenantId === 'TEN-DEV-001' ||
      ctx.tenantId === 'tenant_default'
    ) {
      throw new Error(
        'FAIL_CLOSED: يتطلب تنفيذ فاتورة المشتريات وجود سياق مؤسسة موثوق (Trusted Tenant Context Required).'
      );
    }

    // Resolve the active branch from the authenticated server context before opening
    // the Dexie transaction. Never synthesize a branch or trust an unbound local row.
    const finalStatus = input.invoiceStatus || 'POSTED';
    if (finalStatus === 'POSTED' || finalStatus === 'LOCKED') {
      await ensureActiveBranchRegistered({
        tenantId: ctx.tenantId,
        branchId: ctx.branchId
      });
    }

    if (!input.id) {
      input.id = db.generateId('PUR');
    }

    // Preserve existing invoiceNumber on Edit if not provided explicitly
    if (input.isEdit && input.id && !input.invoiceNumber) {
      const existing = (await db.invoices.get(input.id)) || (await db.purchases.get(input.id));
      if (existing) {
        input.invoiceNumber = existing.invoiceNumber || existing.invoice_number || existing.invoiceId;
      }
    }

    if (!input.supplierId && input.isCash) {
      input.supplierId = 'مورد نقدي';
    }

    // 1. Cross-Tenant Supplier Validation
    if (input.supplierId && input.supplierId !== 'مورد نقدي') {
      const supplier = await db.suppliers.get(input.supplierId);

      if (!supplier) {
        throw new Error(
          `SUPPLIER_NOT_FOUND: لم يتم العثور على المورد المحدد [${input.supplierId}].`
        );
      }

      if (
        ctx.tenantId &&
        supplier.tenantId &&
        supplier.tenantId !== ctx.tenantId
      ) {
        throw new Error(
          `CROSS_TENANT_SUPPLIER_FORBIDDEN: المورد [${input.supplierId}] تابع لمؤسسة أخرى.`
        );
      }
    }

    // 2. Cross-Tenant Product Validation
    for (const item of input.items || []) {
      const productId = item.productId || (item as any).product_id;

      if (productId) {
        const normalizedProductId = String(productId).trim().toLocaleLowerCase('en-US');
        const pendingProduct = input.pendingProducts?.find(
          pending =>
            String(pending?.id ?? '').trim().toLocaleLowerCase('en-US') ===
            normalizedProductId
        );

        if (pendingProduct) {
          // Use the exact pending-product ID downstream: Dexie keys remain case-sensitive.
          const canonicalPendingId = String(pendingProduct.id).trim();
          item.productId = canonicalPendingId;
          (item as any).product_id = canonicalPendingId;
          continue;
        }

        const product = await db.products.get(String(productId).trim());

        if (!product) {
          throw new Error(
            `PRODUCT_NOT_FOUND: الصنف [${productId}] غير موجود.`
          );
        }

        if (
          ctx.tenantId &&
          product.tenantId &&
          product.tenantId !== ctx.tenantId
        ) {
          throw new Error(
            `CROSS_TENANT_PRODUCT_FORBIDDEN: الصنف [${productId}] تابع لمؤسسة أخرى.`
          );
        }
      }
    }

    // 3. Cross-Tenant Existing Invoice Validation
    if (input.isEdit && input.id) {
      const existing = await db.invoices.get(input.id);

      if (
        existing &&
        ctx.tenantId &&
        existing.tenantId &&
        existing.tenantId !== ctx.tenantId
      ) {
        throw new Error(
          `CROSS_TENANT_INVOICE_FORBIDDEN: فاتورة المشتريات [${input.id}] تابعة لمؤسسة أخرى.`
        );
      }
    }

    // 4. Strict Invoice Validation Enforcement
    const validationResult = await validationService.validateInvoice(
      input,
      'PURCHASE'
    );

    if (!validationResult.valid) {
      throw new Error(
        `INVOICE_VALIDATION_FAILED: ${validationResult.errors.join(', ')}`
      );
    }

    // 5. Strict Purchase Invoice Number Uniqueness Enforcement (Tenant-Scoped)
    if (input.invoiceNumber && input.invoiceNumber.trim() !== '') {
      const existingIdempotency = ctx?.idempotencyKey
        ? await IdempotencyRegistry.get(ctx.idempotencyKey, ctx.tenantId)
        : null;
      const isCommittedReplay = existingIdempotency?.status === 'COMMITTED';

      if (!isCommittedReplay) {
        const isNumUnique = await validationService.validatePurchaseInvoiceNumberUniqueness(
          input.invoiceNumber.trim(),
          ctx.tenantId,
          input.isEdit ? input.id : undefined,
          db
        );

        if (!isNumUnique) {
          throw new Error(
            `DUPLICATE_INVOICE_NUMBER: رقم فاتورة المشتريات [${input.invoiceNumber.trim()}] مسجل مسبقاً في هذه المؤسسة.`
          );
        }
      }
    }

    // 6. Strict Invoice ID Uniqueness Enforcement
    if (!input.isEdit && input.id) {
      const isIdempotentReplay =
        ctx?.idempotencyKey &&
        await IdempotencyRegistry.get(
          ctx.idempotencyKey,
          ctx.tenantId
        );

      if (!isIdempotentReplay) {
        const isUnique =
          await validationService.validateInvoiceIdUniqueness(
            input.id,
            input.isReturn ? 'RETURN' : 'PURCHASE',
            db
          );

        if (!isUnique) {
          throw new Error(
            `DUPLICATE_INVOICE_ID: معرف الفاتورة [${input.id}] مسجل مسبقاً.`
          );
        }
      }
    }
  }

  public async executeDomainSteps(
    input: PurchaseWorkflowInput,
    ctx: WorkflowContext,
    tx?: any
  ): Promise<PurchaseWorkflowResult> {
    const finalStatus: InvoiceStatus = input.invoiceStatus || 'POSTED';
    const isPosting =
      finalStatus === 'POSTED' || finalStatus === 'LOCKED';

    const effectiveDate = input.date || ctx.startedAt;
    const isReturn = !!input.isReturn;

    // Strict Identity Separation: internal database id vs user-facing invoiceNumber
    const docId = input.id || db.generateId('PUR');
    let userFacingInvoiceNumber = input.invoiceNumber ? input.invoiceNumber.trim() : '';
    if (!userFacingInvoiceNumber && input.isEdit && input.id) {
      const existing = (await db.invoices.get(input.id)) || (await db.purchases.get(input.id));
      userFacingInvoiceNumber = existing?.invoiceNumber || existing?.invoice_number || existing?.invoiceId || '';
    }
    if (!userFacingInvoiceNumber) {
      userFacingInvoiceNumber = db.generateId('PURCH');
    }

    // 0. Atomic Manual Product Creation
    if (input.pendingProducts && input.pendingProducts.length > 0) {
      if (!tx) {
        throw new Error(
          'PURCHASE_TRANSACTION_REQUIRED: Manual products must be created inside the purchase transaction.'
        );
      }

      const productsTable = tx.table('products');

      if (!productsTable) {
        throw new Error(
          'PURCHASE_PRODUCTS_TABLE_UNAVAILABLE: Products table is unavailable in the active transaction.'
        );
      }

      const referencedProductIds = new Set(
        (input.items || [])
          .map(item =>
            String(item.productId || (item as any).product_id || '')
          )
          .filter(Boolean)
      );

      for (const prod of input.pendingProducts) {
        if (!prod?.id) {
          throw new Error(
            'INVALID_PENDING_PRODUCT: Manual product is missing its ID.'
          );
        }

        const productId = String(prod.id);

        if (!referencedProductIds.has(productId)) {
          continue;
        }

        const existing = await productsTable.get(productId);

        if (existing) {
          const existingTenantId = existing.tenantId;
          const existingBranchId = existing.branchId;

          if (
            existingTenantId &&
            existingTenantId !== ctx.tenantId
          ) {
            throw new Error(
              `CROSS_TENANT_PRODUCT_FORBIDDEN: Product [${productId}] belongs to another tenant.`
            );
          }

          if (
            existingBranchId &&
            ctx.branchId &&
            existingBranchId !== ctx.branchId
          ) {
            throw new Error(
              `CROSS_BRANCH_PRODUCT_FORBIDDEN: Product [${productId}] belongs to another branch.`
            );
          }

          continue;
        }

        await productsTable.add({
          stock: 0,
          StockQuantity: 0,
          is_active: true,
          ...prod,
          id: productId,
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          created_at: new Date().toISOString()
        });
      }
    }

    // 0.5 Handle Reversals for Edits
    if (input.isEdit && input.id) {
      const existing = await db.invoices.get(input.id);

      const isActuallyPosted =
        existing &&
        (
          existing.document_status === 'POSTED' ||
          existing.document_status === 'LOCKED' ||
          (existing as any).invoiceStatus === 'POSTED'
        );

      if (isActuallyPosted) {
        if (
  !ctx.tenantId ||
  !ctx.branchId ||
  existing.tenantId !== ctx.tenantId ||
  existing.branchId !== ctx.branchId
) {
  throw new Error(
    'PURCHASE_REVERSAL_REJECTED: TENANT_OR_BRANCH_MISMATCH'
  );
        }
        // Reverse Inventory Effect
        const engine = UnifiedInventoryMutationEngine.getInstance();

        await engine.executeReversal({
          originalDocumentId: input.id,
          originalDocumentType: isReturn
            ? 'PURCHASE_RETURN'
            : 'PURCHASE',
          reason: `تعديل الفاتورة رقم ${input.id}`,
          userId: ctx.userId || 'system',
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          transactionUuid: `REV-EDIT-${ctx.idempotencyKey}`
        }, tx);

        // Reverse Supplier Balance
        const oldSuppId = existing.partner_id || existing.partnerId;
        const oldTotal =
          existing.finalTotal || existing.totalAmount || 0;

        if (oldSuppId && oldSuppId !== 'مورد نقدي') {
          const balanceReversal =
            (existing as any).isReturn ? oldTotal : -oldTotal;

          await db.updateSupplierBalance(
            oldSuppId,
            balanceReversal,
            tx
          );
        }

        // Reverse Financial Transactions
        await FinancialTransactionRepository.reverseTransactions(input.id, tx, ctx.idempotencyKey, ctx.tenantId, ctx.branchId);

        // Reverse Accounting Effect
        await accountingEngine.postInvoice(
  {
    ...existing,
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    isReversal: true,
    transactionUuid: ctx.idempotencyKey
  } as any,
  undefined,
  tx
);
      }
    }

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
      userFacingInvoiceNumber,
      input.attachment,
      isReturn,
      effectiveDate,
      ctx.idempotencyKey,
      ctx.tenantId,
      ctx.branchId,
      {
        discountPercent: input.discountPercent,
        otherFees: input.otherFees,
        tax: input.tax,
        notes: input.notes,
        attachment: input.attachment,
        warehouseId: input.warehouseId,
        originalPurchaseId: input.originalPurchaseId,
        tx
      }
    );

    if ((globalThis as any).__FAIL_AT_STAGE__ === 'AFTER_PURCHASE_DOC') {
      throw new Error('SIMULATED_PURCHASE_DOC_FAILURE');
    }

    const refId = (savedDoc as any)?.id || docId;

    let costResult = {
      totalCost: 0,
      itemCosts: {} as Record<string, number>
    };

    if (isPosting) {
      // 1. Resolve Warehouse
      const warehouseId =
        input.warehouseId ||
        (ctx.metadata?.warehouseId as string) ||
        configurationService.getSync<string>(
          'inventory.defaultWarehouseId'
        ) ||
        'WH-MAIN';

      // 2. Extract Inventory Items
      const inventoryItems = (input.items || [])
        .filter(item => {
          const productId =
            item.productId || (item as any).product_id;

          if (!productId) return false;

          const isService = (item as any).isService === true;
          const trackStock = (item as any).trackStock === false;
          const isServiceType =
            (item as any).type === 'SERVICE' ||
            (item as any).itemType === 'SERVICE';

          if (isService || trackStock || isServiceType) {
            return false;
          }

          const qty = Number(
            item.quantity ?? (item as any).qty ?? 0
          );

          return qty > 0;
        })
        .map(item => {
          const productId =
            (item.productId || (item as any).product_id)!;

          const quantity = Number(
            item.quantity ?? (item as any).qty ?? 0
          );

          const rawCost =
            (item as any).unitCost !== undefined
              ? (item as any).unitCost
              : (item as any).cost !== undefined
                ? (item as any).cost
                : (item as any).costPrice !== undefined
                  ? (item as any).costPrice
                  : (item as any).unitPrice !== undefined
                    ? (item as any).unitPrice
                    : (item as any).price;

          const unitCost =
            rawCost !== undefined &&
            rawCost !== null &&
            !isNaN(Number(rawCost))
              ? Number(rawCost)
              : undefined;

          const rawPrice =
            (item as any).unitPrice !== undefined
              ? (item as any).unitPrice
              : (item as any).price;

          const unitPrice =
            rawPrice !== undefined &&
            rawPrice !== null &&
            !isNaN(Number(rawPrice))
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

      // 3. Delegate Inventory Mutation
      if (inventoryItems.length > 0) {
        const engine =
          UnifiedInventoryMutationEngine.getInstance();

        const tenantId = ctx.tenantId;
        const branchId = ctx.branchId;

        const forbiddenTenants = [
          'TEN-DEV-001',
          'tenant_default',
          'default',
          'default-tenant'
        ];

        const forbiddenBranches = [
          'branch_default',
          'default'
        ];

        if (!tenantId || forbiddenTenants.includes(tenantId)) {
          throw new Error(
            'FAIL_CLOSED: TRUSTED_TENANT_CONTEXT_REQUIRED'
          );
        }

        if (!branchId || forbiddenBranches.includes(branchId)) {
          throw new Error(
            'FAIL_CLOSED: TRUSTED_BRANCH_CONTEXT_REQUIRED'
          );
        }

        const userId = ctx.userId || 'system';
        const transactionUuid = ctx.idempotencyKey;

        if (isReturn) {
          const mutationResults =
            await engine.executePurchaseReturn({
              returnInvoiceId: refId,
              originalPurchaseId: input.originalPurchaseId,
              warehouseId,
              items: inventoryItems,
              transactionUuid,
              userId,
              tenantId,
              branchId,
              notes:
                input.notes ||
                `مرتجع مشتريات فاتورة #${refId}`,
              timestamp: effectiveDate
            }, tx);

          const totalCost = mutationResults.reduce(
            (sum, r) =>
              sum +
              ((r.calculatedCost || 0) *
                Math.abs(r.delta || 0)),
            0
          );

          const itemCosts: Record<string, number> = {};

          for (const r of mutationResults) {
            itemCosts[r.productId] =
              (itemCosts[r.productId] || 0) +
              ((r.calculatedCost || 0) *
                Math.abs(r.delta || 0));
          }

          costResult = { totalCost, itemCosts };
        } else {
          const mutationResults =
            await engine.executeReceivePurchase({
              invoiceId: refId,
              warehouseId,
              supplierId: input.supplierId,
              items: inventoryItems,
              transactionUuid,
              userId,
              tenantId,
              branchId,
              notes:
                input.notes ||
                `استلام مشتريات فاتورة #${refId}`,
              timestamp: effectiveDate
            }, tx);

          const totalCost = mutationResults.reduce(
            (sum, r) =>
              sum +
              ((r.calculatedCost || 0) *
                Math.abs(r.delta || 0)),
            0
          );

          const itemCosts: Record<string, number> = {};

          for (const r of mutationResults) {
            itemCosts[r.productId] =
              (itemCosts[r.productId] || 0) +
              ((r.calculatedCost || 0) *
                Math.abs(r.delta || 0));
          }

          costResult = { totalCost, itemCosts };
        }
      }

      if ((globalThis as any).__FAIL_AT_STAGE__ === 'AFTER_INVENTORY') {
        throw new Error('SIMULATED_INVENTORY_FAILURE');
      }

      // 4. Financial & Accounting Ledger Execution
      const suppId = input.supplierId;
      const verifiedTotal = (savedDoc as any).totalAmount || (savedDoc as any).finalTotal || input.total;

      if (suppId && suppId !== 'مورد نقدي') {
        const balanceDelta = isReturn
          ? -verifiedTotal
          : verifiedTotal;

        await db.updateSupplierBalance(
          suppId,
          balanceDelta,
          tx
        );
      }

      if (
        (globalThis as any).__FAIL_AT_STAGE__ ===
        'AFTER_SUPPLIER_BALANCE'
      ) {
        throw new Error('SIMULATED_SUPPLIER_BALANCE_FAILURE');
      }

      await FinancialTransactionRepository.record(
        {
          id: `FT-${refId}-${ctx.idempotencyKey}`, // Idempotent ID
          Transaction_Type: isReturn
            ? 'Refund'
            : input.isCash
              ? 'Payment'
              : 'Invoice',
          Reference_ID: refId,
          Reference_Table: 'Purchase_Invoices',
          Entity_Type: 'Supplier',
          Entity_Name: input.supplierId || 'مورد نقدي',
          Amount: verifiedTotal,
          Direction: isReturn ? 'Debit' : 'Credit',
          Transaction_Date: effectiveDate,
          Notes: `فاتورة مشتريات #${refId}`,
          tenantId: ctx.tenantId,
          branchId: ctx.branchId
        },
        tx
      );

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

      await ProjectionEventBus.publish(
        'INVOICE_POSTED',
        refId,
        {
          type: 'PURCHASE',
          transactionUuid: ctx.idempotencyKey,
          correlationId: ctx.correlationId
        }
      );
    }

    return {
      refId,
      purchase: savedDoc
    };
  }
}

export const purchaseWorkflow = new PurchaseWorkflow();
