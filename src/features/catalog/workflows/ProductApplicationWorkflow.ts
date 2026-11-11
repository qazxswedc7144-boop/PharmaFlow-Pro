import { BusinessWorkflow, WorkflowContext } from '@/core/workflow';
import { Product } from '@/types';
import { InventoryService } from '@features/inventory/services/InventoryService';
import { AuditService } from '@/services/system/AuditService';
import { ProjectionEventBus } from '@/services/system/ProjectionEventBus';
import { DistributedSyncEngine } from '@features/sync/sync.engine';
import { useAuthStore } from '@/store/authStore';
import { getProductApplicationPermission } from '../utils/productApplicationPermission';

export interface ProductApplicationInput {
  product: Product;
  isNew?: boolean;
}

export interface ProductApplicationResult {
  success: boolean;
  productId: string;
}

export class ProductApplicationWorkflow implements BusinessWorkflow<ProductApplicationInput, ProductApplicationResult> {
  public id = 'catalog.product.save';
  public name = 'حفظ وتسجيل الصنف الدوائي';
  public operationType = 'PRODUCT_SAVE';
  // The workflow chooses the correct capability from input.isNew in validateBusinessRules.
  public requiredPermissions: string[] = [];
  // Product + its durable sync mutation are committed together in the local Dexie transaction.
  public syncHandledInDomainTransaction = true;
  public tables = ['products', 'auditLogs', 'idempotencyKeys', 'projectionEvents', 'syncQueue', 'outbox'];

  public async validateInput(input: ProductApplicationInput): Promise<void> {
    if (!input.product) {
      throw new Error('بيانات الصنف مطلوبة للحفظ');
    }
    const name = input.product.name || (input.product as any).Name;
    if (!name || !name.trim()) {
      throw new Error('اسم الصنف مطلوب');
    }
  }

  public async validateBusinessRules(input: ProductApplicationInput): Promise<void> {
    const requiredPermission = getProductApplicationPermission(input.isNew);
    const legacyPermission = input.isNew === false ? 'products.edit' : 'products.manage';
    const authState = useAuthStore.getState();
    const hasPermission =
      authState.hasPermission(requiredPermission) ||
      // Preserve explicitly assigned legacy custom grants during the RBAC migration.
      authState.hasPermission(legacyPermission) ||
      authState.user?.permissions?.includes('ALL') === true;

    if (!hasPermission) {
      throw new Error(`PRODUCT_PERMISSION_REQUIRED: غير مصرح لك بـ [${requiredPermission}] لتسجيل الصنف.`);
    }
  }

  public async executeDomainSteps(
    input: ProductApplicationInput,
    ctx: WorkflowContext,
    tx?: any
  ): Promise<ProductApplicationResult> {
    if (!tx) {
      throw new Error('PRODUCT_TRANSACTION_REQUIRED: Product registration must run inside the workflow transaction.');
    }

    const savedId = await InventoryService.saveProduct(input.product);

    await (AuditService.log as any)({
      action: input.isNew ? 'CREATE' : 'EDIT',
      module: 'CATALOG',
      transactionUuid: ctx.workflowId,
      recordId: savedId
    }, tx);

    await ProjectionEventBus.publish('PRODUCT_SAVED', savedId, {
      productId: savedId,
      correlationId: ctx.correlationId
    });

    const syncPayload = {
      ...(input.product as any),
      id: savedId,
      ProductID: savedId,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId
    };

    const enqueueResult = await DistributedSyncEngine.getInstance().enqueueWithinTransaction(
      this.operationType,
      syncPayload,
      'PRODUCT',
      ctx.idempotencyKey,
      { tenantId: ctx.tenantId, branchId: ctx.branchId }
    );

    if (!enqueueResult?.mutationId || enqueueResult.idempotencyKey !== ctx.idempotencyKey) {
      throw new Error('PRODUCT_SYNC_ENQUEUE_FAILED: Product was not paired with a durable local sync mutation.');
    }

    return {
      success: true,
      productId: savedId
    };
  }
}

export const productApplicationWorkflow = new ProductApplicationWorkflow();
