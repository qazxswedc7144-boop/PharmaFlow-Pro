import { BusinessWorkflow, WorkflowContext } from '@/core/workflow';
import { db } from '@/core/db';
import { JournalLine } from '@/types';
import { AccountingEngine } from '@features/accounting/services/AccountingEngine';
import { unifiedInventoryMutationEngine } from '@features/inventory/services/UnifiedInventoryMutationEngine';

export interface InventoryAdjustmentInput {
  productId: string;
  warehouseId: string;
  actualQty: number;
  userId: string;
  notes?: string;
}

export interface InventoryAdjustmentResult {
  success: boolean;
  adjustmentId: string;
  deltaQty: number;
}

export class InventoryAdjustmentWorkflow implements BusinessWorkflow<InventoryAdjustmentInput, InventoryAdjustmentResult> {
  public id = 'inventory.adjustment.process';
  public name = 'تسوية وتعديل المخزون';
  public operationType = 'INVENTORY_ADJUSTMENT';
  public requiredPermissions = ['inventory.adjust', 'inventory.manage'];
  public tables = [
    'inventoryTransactions', 'products', 'warehouseStock', 'inventory_layers', 'medicineBatches',
    'journalEntries', 'journalLines', 'accounts', 'auditLogs', 'idempotencyKeys', 'projectionEvents'
  ];

  public async validateInput(input: InventoryAdjustmentInput): Promise<void> {
    if (!input.productId) {
      throw new Error('يجب تحديد الصنف المراد تسويته');
    }
    if (input.actualQty < 0) {
      throw new Error('الكمية الفعلية لا يمكن أن تكون بالسالب');
    }
  }

  public async validateBusinessRules(input: InventoryAdjustmentInput): Promise<void> {
    const product = await db.products.get(input.productId);
    if (!product) {
      throw new Error(`لم يتم العثور على الصنف رقم [${input.productId}] في النظام`);
    }
  }

  public async executeDomainSteps(
    input: InventoryAdjustmentInput,
    ctx: WorkflowContext
  ): Promise<InventoryAdjustmentResult> {
    const adjustmentId = `ADJ-${Date.now()}`;
    const transactionUuid = ctx.idempotencyKey || `TX-ADJ-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const tenantId = ctx.tenantId;
    const branchId = ctx.branchId;

    const forbiddenTenants = ['TEN-DEV-001', 'tenant_default', 'default', 'default-tenant'];
    const forbiddenBranches = ['BR-MAIN', 'branch_default', 'default'];

    if (!tenantId || forbiddenTenants.includes(tenantId)) {
      throw new Error('FAIL_CLOSED: TRUSTED_TENANT_CONTEXT_REQUIRED: يتطلب تنفيذ تسوية المخزون وجود سياق مؤسسة موثوق.');
    }
    if (!branchId || forbiddenBranches.includes(branchId)) {
      throw new Error('FAIL_CLOSED: TRUSTED_BRANCH_CONTEXT_REQUIRED: يتطلب تنفيذ تسوية المخزون وجود سياق فرع موثوق.');
    }

    const mutationResult = await unifiedInventoryMutationEngine.executeAdjustment({
      adjustmentId,
      productId: input.productId,
      warehouseId: input.warehouseId || 'WH-MAIN',
      actualQuantity: input.actualQty,
      reason: input.notes || 'تسوية جردية مخزنية',
      userId: input.userId || ctx.userId || 'system',
      tenantId,
      branchId,
      transactionUuid
    });

    const deltaQty = mutationResult.delta;
    const unitCost = mutationResult.calculatedCost || 0;
    const adjustmentValue = Math.abs(deltaQty) * unitCost;

    // Generate balanced accounting side-effect through existing architecture
    if (deltaQty !== 0 && adjustmentValue > 0) {
      try {
        const invAcc = await AccountingEngine.getCoreAccount('INVENTORY');
        const gainLossAcc = deltaQty > 0 
          ? (await AccountingEngine.getCoreAccount('SALES_REVENUE') || 'ACC-401')
          : (await AccountingEngine.getCoreAccount('COGS') || 'ACC-501');

        const entryId = `JE-ADJ-${Date.now()}`;
        const lines: JournalLine[] = [];

        if (deltaQty > 0) {
          lines.push({
            id: db.generateId('JL'),
            lineId: db.generateId('JL'),
            entryId,
            accountId: invAcc,
            accountName: 'المخزون',
            debit: adjustmentValue,
            credit: 0,
            type: 'DEBIT',
            amount: adjustmentValue
          });
          lines.push({
            id: db.generateId('JL'),
            lineId: db.generateId('JL'),
            entryId,
            accountId: gainLossAcc,
            accountName: 'أرباح تسوية المخزون',
            debit: 0,
            credit: adjustmentValue,
            type: 'CREDIT',
            amount: adjustmentValue
          });
        } else {
          lines.push({
            id: db.generateId('JL'),
            lineId: db.generateId('JL'),
            entryId,
            accountId: gainLossAcc,
            accountName: 'تكلفة بضاعة / خسائر تسوية',
            debit: adjustmentValue,
            credit: 0,
            type: 'DEBIT',
            amount: adjustmentValue
          });
          lines.push({
            id: db.generateId('JL'),
            lineId: db.generateId('JL'),
            entryId,
            accountId: invAcc,
            accountName: 'المخزون',
            debit: 0,
            credit: adjustmentValue,
            type: 'CREDIT',
            amount: adjustmentValue
          });
        }

        const now = new Date().toISOString();
        const entry: any = {
          id: entryId,
          entryNumber: `ADJ-${Date.now().toString().slice(-6)}`,
          date: now,
          description: `قيد تسوية مخزون الصنف [${input.productId}] - مستند #${adjustmentId}`,
          referenceType: 'ADJUSTMENT',
          referenceId: adjustmentId,
          lines,
          totalDebit: adjustmentValue,
          totalCredit: adjustmentValue,
          isBalanced: true,
          status: 'POSTED',
          createdBy: ctx.userId || input.userId || 'system',
          createdAt: now,
          updatedAt: now
        };

        await db.journalEntries.add(entry);
        for (const l of lines) {
          await db.journalLines.add(l);
          if (l.accountId) {
            await db.updateAccountBalance(l.accountId, l.debit - l.credit);
          }
        }
      } catch (accErr) {
        console.warn('[InventoryAdjustmentWorkflow] Accounting side-effect notice:', accErr);
      }
    }

    return {
      success: true,
      adjustmentId,
      deltaQty
    };
  }
}

export const inventoryAdjustmentWorkflow = new InventoryAdjustmentWorkflow();
