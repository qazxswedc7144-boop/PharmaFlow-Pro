import { BusinessWorkflow, WorkflowContext } from '@/core/workflow';
import { db } from '@/core/db';
import { TransferStatus } from '@/types';
import { ProjectionEventBus } from '@/services/system/ProjectionEventBus';
import { unifiedInventoryMutationEngine } from '@features/inventory/services/UnifiedInventoryMutationEngine';

export interface InventoryTransferInput {
  sourceBranchId: string;
  targetBranchId: string;
  sourceWarehouseId?: string;
  targetWarehouseId?: string;
  notes?: string;
  autoExecute?: boolean;
  items: Array<{
    productId: string;
    qty: number;
    batchNumber?: string;
    expiryDate?: string;
  }>;
}

export interface InventoryTransferResult {
  transferId: string;
  success: boolean;
  status: TransferStatus;
}

export class InventoryTransferWorkflow implements BusinessWorkflow<InventoryTransferInput, InventoryTransferResult> {
  public id = 'inventory.transfer.create';
  public name = 'إنشاء طلب تحويل مخزني';
  public operationType = 'INVENTORY_TRANSFER';
  public requiredPermissions = ['inventory.transfer', 'inventory.manage'];
  public tables = [
    'branchTransfers', 'branchTransferItems', 'branchInventory',
    'products', 'warehouseStock', 'inventoryTransactions', 'inventory_layers', 'medicineBatches',
    'auditLogs', 'idempotencyKeys', 'projectionEvents'
  ];

  public async validateInput(input: InventoryTransferInput): Promise<void> {
    if (!input.sourceBranchId || !input.targetBranchId) {
      throw new Error('يجب تحديد فرع المصدر وفرع الوجهة');
    }
    if (input.sourceBranchId === input.targetBranchId) {
      throw new Error('لا يمكن تحويل المخزون لنفس الفرع');
    }
    if (!input.items || input.items.length === 0) {
      throw new Error('يجب اختيار صنف واحد على الأقل للتحويل');
    }
  }

  public async validateBusinessRules(input: InventoryTransferInput): Promise<void> {
    for (const item of input.items) {
      if (item.qty <= 0) {
        throw new Error(`الكمية المحولة للصنف [${item.productId}] يجب أن تكون أكبر من الصفر`);
      }
    }
  }

  public async executeDomainSteps(
    input: InventoryTransferInput,
    ctx: WorkflowContext
  ): Promise<InventoryTransferResult> {
    const transferId = `TRF-${Date.now()}`;
    const now = new Date().toISOString();
    const shouldAutoExecute = input.autoExecute === true;
    const initialStatus: TransferStatus = shouldAutoExecute ? 'RECEIVED' : 'DRAFT';

    const transferRecord = {
      id: transferId,
      sourceBranchId: input.sourceBranchId,
      targetBranchId: input.targetBranchId,
      status: initialStatus,
      createdBy: ctx.userId,
      notes: input.notes || 'تحويل مخزني بين الفروع',
      createdAt: now,
      updatedAt: now
    };

    await db.branchTransfers.put(transferRecord);

    const transferItems = input.items.map((item) => ({
      id: `TRFI-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      transferId,
      productId: item.productId,
      qty: item.qty,
      receivedQty: shouldAutoExecute ? item.qty : 0,
      batchNumber: item.batchNumber || 'BATCH-GEN',
      expiryDate: item.expiryDate || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: now
    }));

    await db.branchTransferItems.bulkAdd(transferItems);

    // If autoExecute is requested, execute atomic physical transfer immediately via Unified Engine
    if (shouldAutoExecute) {
      const srcWarehouse = input.sourceWarehouseId || 
        (input.sourceBranchId.startsWith('WH-') ? input.sourceBranchId : `WH-${input.sourceBranchId}`);
      const tgtWarehouse = input.targetWarehouseId || 
        (input.targetBranchId.startsWith('WH-') ? input.targetBranchId : `WH-${input.targetBranchId}`);

      for (const item of input.items) {
        const tenantId = ctx.tenantId;
        const forbiddenTenants = ['TEN-DEV-001', 'tenant_default', 'default', 'default-tenant'];
        if (!tenantId || forbiddenTenants.includes(tenantId)) {
          throw new Error('FAIL_CLOSED: TRUSTED_TENANT_CONTEXT_REQUIRED: يتطلب تنفيذ التحويل المخزني وجود سياق مؤسسة موثوق.');
        }

        await unifiedInventoryMutationEngine.executeTransfer({
          transferId,
          fromWarehouseId: srcWarehouse,
          toWarehouseId: tgtWarehouse,
          productId: item.productId,
          quantity: item.qty,
          batchNumber: item.batchNumber,
          expiryDate: item.expiryDate,
          userId: ctx.userId || 'system',
          tenantId,
          branchId: input.sourceBranchId,
          transactionUuid: `${transferId}-${item.productId}`,
          notes: input.notes || `تحويل مخزني فوري من ${input.sourceBranchId} إلى ${input.targetBranchId}`
        });
      }
    }

    await ProjectionEventBus.publish('STOCK_TRANSFER_CREATED', transferId, {
      source: input.sourceBranchId,
      target: input.targetBranchId,
      status: initialStatus,
      correlationId: ctx.correlationId
    });

    return {
      success: true,
      transferId,
      status: initialStatus
    };
  }
}

export const inventoryTransferWorkflow = new InventoryTransferWorkflow();
