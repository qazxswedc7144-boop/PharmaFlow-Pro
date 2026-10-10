import { BusinessWorkflow, WorkflowContext, WorkflowResult } from './workflow.types';
import { WorkflowExecutionError } from './workflowError';
import { WorkflowAuthorization } from './workflowAuthorization';
import { WorkflowValidation } from './workflowValidation';
import { WorkflowHooksRunner } from './workflowHooks';
import { WorkflowResultBuilder } from './workflowResult';
import { WorkflowEventBus } from './workflowEvents';
import { WorkflowRecovery } from './workflowRecovery';
import { ExecutionGuard } from '@/core/integrity/executionGuard';
import { TransactionBoundary } from '@/core/integrity/transactionBoundary';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';
import { observabilityService } from '@/core/observability';
import { AuditService } from '@/services/system/AuditService';
import { UsageMeterService } from '@/services/saas/usageMeterService';

export class WorkflowExecutionPipeline {
  /**
   * Executes a business workflow adhering to the 15-step unified execution boundary.
   */
  public static async run<TInput, TResult>(
    workflow: BusinessWorkflow<TInput, TResult>,
    input: TInput,
    ctx: WorkflowContext
  ): Promise<WorkflowResult<TResult>> {
    const startTime = Date.now();
    const tables = workflow.tables || [
      'invoices', 'invoiceItems', 'products', 'inventoryTransactions',
      'warehouseStock', 'branchInventory', 'medicineBatches',
      'inventory_layers', 'journalEntries', 'journalLines', 'accounts',
      'financialTransactions', 'auditLogs', 'idempotencyKeys', 'projectionEvents'
    ];

    await WorkflowEventBus.emit('WORKFLOW_STARTED', ctx);

    try {
      // Step 2 & 3: Authorization & Hooks
      await WorkflowHooksRunner.runHook(workflow.hooks?.beforeAuthorization, input, ctx, 'beforeAuthorization');
      await WorkflowAuthorization.authorize(workflow, ctx);
      await WorkflowHooksRunner.runHook(workflow.hooks?.afterAuthorization, input, ctx, 'afterAuthorization');

      // Step 5 & 6: Validation & Hooks
      await WorkflowHooksRunner.runHook(workflow.hooks?.beforeValidation, input, ctx, 'beforeValidation');
      await WorkflowValidation.validate(workflow, input, ctx);
      await WorkflowHooksRunner.runHook(workflow.hooks?.afterValidation, input, ctx, 'afterValidation');

      // Step 8: Before Execute Hook
      await WorkflowHooksRunner.runHook(workflow.hooks?.beforeExecute, input, ctx, 'beforeExecute');

      // Step 9: Idempotency Check & Acquisition
      if (ctx.idempotencyKey) {
        const payloadFingerprint = JSON.stringify(input ?? {});
        const existing = await IdempotencyRegistry.get(ctx.idempotencyKey);
        if (existing) {
          // Detect payload mismatch on duplicate key
          if (
            existing.fingerprint &&
            existing.fingerprint !== payloadFingerprint &&
            existing.fingerprint !== ctx.idempotencyKey &&
            existing.fingerprint !== 'auto' &&
            existing.fingerprint !== 'legacy'
          ) {
            throw new WorkflowExecutionError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH: تم استخدام مفتاح التكرار هذا سابقاً مع حمولة طلب مختلفة.',
              'IDEMPOTENCY_CONFLICT'
            );
          }

          if (existing.status === 'COMMITTED') {
            const replayData = (existing.responseData || existing.result) as TResult;
            if (replayData) {
              return WorkflowResultBuilder.success(replayData, ctx, {
                warnings: ['تم استرجاع النتيجة من السجل المصادق عليه سابقاً (Idempotent replay)']
              });
            }
          } else if (existing.status === 'PROCESSING') {
            throw new WorkflowExecutionError(
              'العملية قيد المعالجة حالياً من قِبل عملية أخرى. يرجى الانتظار...',
              'IDEMPOTENCY_CONFLICT'
            );
          }
        } else {
          await IdempotencyRegistry.save({
            key: ctx.idempotencyKey,
            status: 'PROCESSING',
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            operationType: ctx.operationType,
            entityType: workflow.id.toUpperCase(),
            fingerprint: payloadFingerprint,
            createdAt: new Date().toISOString()
          });
        }
      }

      // Step 9 & 10: ExecutionGuard + TransactionBoundary Execution
      const domainResult = await ExecutionGuard.executeWithGuard<TResult>(
        {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          operation: workflow.operationType,
          entityId: ctx.idempotencyKey
        },
        async () => {
          return await TransactionBoundary.executeAtomic<TResult>(tables, async () => {
            // Step 11: Execute Domain Steps
            const res = await workflow.executeDomainSteps(input, ctx);
            return res;
          });
        }
      );

      // Step 12: Mark Idempotency Completed & Invalidate Meter Cache
      if (ctx.idempotencyKey) {
        await IdempotencyRegistry.updateStatus(ctx.idempotencyKey, 'COMMITTED', domainResult).catch(() => null);
        UsageMeterService.invalidate();
      }

      // Step 13: Audit & Observability
      let auditRef = `AUDIT-${ctx.workflowId}`;
      try {
        await (AuditService.log as any)({
          action: 'CREATE',
          module: workflow.id,
          transactionUuid: ctx.workflowId,
          recordId: ctx.workflowId
        });
      } catch (aErr) {
        console.warn('[WorkflowExecutionPipeline] Audit log failed silently:', aErr);
      }

      (observabilityService as any).recordMetric?.('workflow.duration_ms', Date.now() - startTime, {
        workflow: workflow.id,
        status: 'success'
      });

      // Step 14: Emit Outbox / Sync Event
      await WorkflowEventBus.emit('WORKFLOW_COMPLETED', ctx, {
        result: domainResult
      });

      try {
        const { DistributedSyncEngine } = await import('@/features/sync/sync.engine');
        await DistributedSyncEngine.getInstance().enqueue(
          workflow.operationType,
          {
            id: (domainResult as any)?.refId || ctx.workflowId,
            ...(typeof domainResult === 'object' && domainResult !== null ? domainResult : {}),
            workflowId: ctx.workflowId,
            operationType: workflow.operationType
          },
          workflow.id.toUpperCase(),
          ctx.idempotencyKey,
          { tenantId: ctx.tenantId, branchId: ctx.branchId }
        );
      } catch (syncErr) {
        console.warn('[WorkflowExecutionPipeline] Sync enqueue non-blocking notification:', syncErr);
      }

      // Step 15: After Execute & After Commit Hooks
      await WorkflowHooksRunner.runHook(workflow.hooks?.afterExecute, domainResult, ctx, 'afterExecute');
      await WorkflowHooksRunner.runHook(workflow.hooks?.afterCommit, domainResult, ctx, 'afterCommit');

      return WorkflowResultBuilder.success(domainResult, ctx, {
        auditReference: auditRef,
        syncStatus: 'ENQUEUED'
      });

    } catch (err: any) {
      const errorObj = err instanceof WorkflowExecutionError ? err : new WorkflowExecutionError(err.message || String(err), 'TRANSACTION_FAILED', { originalError: err });

      // Rollback Idempotency status
      if (ctx.idempotencyKey) {
        await IdempotencyRegistry.delete(ctx.idempotencyKey).catch(() => null);
      }

      // Register Incident Recovery
      const incidentId = await WorkflowRecovery.registerFailure(ctx, errorObj);

      // Record Observability Error
      (observabilityService as any).recordMetric?.('workflow.failure', 1, {
        workflow: workflow.id,
        code: errorObj.code
      });

      // Run Error / Rollback Hooks
      await WorkflowHooksRunner.runHook(workflow.hooks?.onError, errorObj, ctx, 'onError');
      await WorkflowHooksRunner.runHook(workflow.hooks?.onRollback, errorObj, ctx, 'onRollback');

      // Emit Failure Event
      await WorkflowEventBus.emit('WORKFLOW_FAILED', ctx, {
        errorCode: errorObj.code,
        errorMessage: errorObj.message,
        incidentId
      });

      return WorkflowResultBuilder.failure(
        errorObj.toWorkflowError(),
        errorObj.code,
        ctx,
        { auditReference: incidentId }
      );
    }
  }
}
