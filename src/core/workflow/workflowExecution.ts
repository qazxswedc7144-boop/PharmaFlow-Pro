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
    let transactionCommitted = false;
    let committedResult!: TResult;
    const postCommitWarnings: string[] = [];
    let syncStatus: 'ENQUEUED' | 'SYNCED' | 'FAILED' | 'LOCAL_ONLY' = 'ENQUEUED';
    const addPostCommitWarning = (step: string, error: unknown) => {
      console.warn(`[WorkflowExecutionPipeline] Post-commit step failed (${step}):`, error);
      postCommitWarnings.push(step);
    };
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
        const existing = await IdempotencyRegistry.get(ctx.idempotencyKey, ctx.tenantId);
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
              if (workflow.id.toUpperCase() === 'SALE' && (replayData as any)?.sale?.isReturn !== true) {
                try {
                  const [{ DistributedSyncEngine }, { toSaleSyncDTO }] = await Promise.all([
                    import('@/features/sync/sync.engine'),
                    import('@/features/sync/saleSyncDto')
                  ]);
                  await DistributedSyncEngine.getInstance().enqueue(
                    workflow.operationType,
                    toSaleSyncDTO(replayData),
                    'SALE',
                    ctx.idempotencyKey,
                    { tenantId: ctx.tenantId, branchId: ctx.branchId, requireOutbox: true }
                  );
                  DistributedSyncEngine.getInstance().requestSync().catch(() => {});
                } catch (syncErr: any) {
                  return WorkflowResultBuilder.failure(
                    new WorkflowExecutionError(
                      `SYNC_ENQUEUE_FAILED: committed sale replay has no safely reusable durable queue/outbox pair: ${syncErr?.message || String(syncErr)}`,
                      'SYNC_ENQUEUE_FAILED'
                    ),
                    'SYNC_ENQUEUE_FAILED',
                    ctx
                  );
                }
                return WorkflowResultBuilder.success(replayData, ctx, {
                  warnings: ['تم استرجاع النتيجة بعد التحقق من وجود حدث مزامنة دائم أو إعادة إنشائه بأمان.'],
                  syncStatus: 'ENQUEUED'
                });
              }
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

      // Resolve sync dependencies before opening the IndexedDB transaction.
      // Dynamic imports / non-IDB awaits inside an active Dexie transaction can
      // let IndexedDB auto-commit before the Queue/Outbox writes are reached.
      const saleSyncDependencies = workflow.id.toUpperCase() === 'SALE'
        ? await Promise.all([
            import('@/features/sync/sync.engine'),
            import('@/features/sync/saleSyncDto')
          ])
        : null;

      // Step 9 & 10: ExecutionGuard + TransactionBoundary Execution
      const useLocalExecutionGuard = typeof workflow.localExecutionGuard === 'function'
        ? workflow.localExecutionGuard(input)
        : workflow.localExecutionGuard === true;
      const guardOptions = {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        operation: workflow.operationType,
        entityId: useLocalExecutionGuard
          ? String((input as any)?.product?.id || ctx.idempotencyKey)
          : ctx.idempotencyKey
      };

      const executeDomainTransaction = async (): Promise<TResult> => {
        const committed = await TransactionBoundary.executeAtomic<TResult>(tables, async (tx?: any) => {
          // Step 11: Execute Domain Steps
          const res = await workflow.executeDomainSteps(input, ctx, tx);

          // SALE persistence and both durable sync records share the same Dexie transaction.
          if (workflow.id.toUpperCase() === 'SALE' && (res as any)?.sale?.isReturn !== true) {
            if (!saleSyncDependencies) {
              throw new WorkflowExecutionError(
                'SYNC_ENQUEUE_FAILED: Sale sync dependencies were not initialized before transaction start.',
                'SYNC_ENQUEUE_FAILED'
              );
            }
            const [{ DistributedSyncEngine }, { toSaleSyncDTO }] = saleSyncDependencies;
            const enqueueResult = await DistributedSyncEngine.getInstance().enqueueWithinTransaction(
              workflow.operationType,
              toSaleSyncDTO(res),
              'SALE',
              ctx.idempotencyKey,
              { tenantId: ctx.tenantId, branchId: ctx.branchId }
            );
            if (!enqueueResult?.mutationId || enqueueResult.idempotencyKey !== ctx.idempotencyKey) {
              throw new WorkflowExecutionError(
                'SYNC_ENQUEUE_FAILED: Durable sale queue/outbox acknowledgement is incomplete.',
                'SYNC_ENQUEUE_FAILED'
              );
            }
          }
          return res;
        });

        // TransactionBoundary resolves only after the IndexedDB transaction commits.
        transactionCommitted = true;
        committedResult = committed;
        // Release local-first UI consumers as soon as Dexie confirms commit.
        // Post-commit audit/projection/sync work must not hold the item-entry UI.
        try {
          ctx.onLocalCommit?.(committed);
        } catch (localCommitCallbackError) {
          addPostCommitWarning('local-commit-callback', localCommitCallbackError);
        }
        return committed;
      };

      // Catalog product creation uses only an in-tab guard; its idempotency and
      // queue/outbox writes remain durable inside the Dexie transaction.
      const domainResult = useLocalExecutionGuard
        ? await ExecutionGuard.executeWithLocalGuard<TResult>(guardOptions, executeDomainTransaction)
        : await ExecutionGuard.executeWithGuard<TResult>(guardOptions, executeDomainTransaction);

      // Step 12: Mark Idempotency Completed & Invalidate Meter Cache
      if (ctx.idempotencyKey) {
        try {
          await IdempotencyRegistry.updateStatus(ctx.idempotencyKey, 'COMMITTED', domainResult, undefined, ctx.tenantId);
        } catch (idempotencyError) {
          // The domain transaction is already committed: never roll back its key.
          addPostCommitWarning('idempotency-status-update', idempotencyError);
        }
        try {
          UsageMeterService.invalidate();
        } catch (usageMeterError) {
          addPostCommitWarning('usage-meter-invalidation', usageMeterError);
        }
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

      try {
        (observabilityService as any).recordMetric?.('workflow.duration_ms', Date.now() - startTime, {
          workflow: workflow.id,
          status: 'success'
        });
      } catch (metricError) {
        addPostCommitWarning('success-metric', metricError);
      }

      // Step 14: Emit the completion event without changing the committed transaction result.
      try {
        await WorkflowEventBus.emit('WORKFLOW_COMPLETED', ctx, {
          result: domainResult
        });
      } catch (eventError) {
        addPostCommitWarning('workflow-completed-event', eventError);
      }

      if (workflow.id.toUpperCase() === 'SALE' && (domainResult as any)?.sale?.isReturn !== true) {
        try {
          const { DistributedSyncEngine } = await import('@/features/sync/sync.engine');
          DistributedSyncEngine.getInstance().requestSync().catch((syncError: unknown) => {
            addPostCommitWarning('sync-dispatch-request', syncError);
          });
        } catch (syncDispatchError) {
          // The SALE queue/outbox pair was committed atomically with the invoice.
          addPostCommitWarning('sync-dispatch-request', syncDispatchError);
        }
      } else if (workflow.syncHandledInDomainTransaction === true) {
        // The workflow already committed its local queue/outbox pair atomically.
        // Dispatch is deliberately fire-and-forget: local business success must
        // never wait for remote synchronization.
        try {
          const { DistributedSyncEngine } = await import('@/features/sync/sync.engine');
          DistributedSyncEngine.getInstance().requestSync().catch((syncError: unknown) => {
            addPostCommitWarning('sync-dispatch-request', syncError);
          });
        } catch (syncDispatchError) {
          addPostCommitWarning('sync-dispatch-request', syncDispatchError);
        }
      } else {
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
          syncStatus = 'FAILED';
          addPostCommitWarning('sync-enqueue', syncErr);
        }
      }

      // Step 15: After Execute & After Commit Hooks
      try {
        await WorkflowHooksRunner.runHook(workflow.hooks?.afterExecute, domainResult, ctx, 'afterExecute');
        await WorkflowHooksRunner.runHook(workflow.hooks?.afterCommit, domainResult, ctx, 'afterCommit');
      } catch (hookError) {
        addPostCommitWarning('after-commit-hooks', hookError);
      }

      return WorkflowResultBuilder.success(domainResult, ctx, {
        auditReference: auditRef,
        warnings: postCommitWarnings,
        syncStatus
      });

    } catch (err: any) {
      if (transactionCommitted) {
        // A post-commit exception cannot turn a durable invoice into a failed transaction.
        // Reassert COMMITTED if the exception happened between the transaction and normal status update.
        if (ctx.idempotencyKey) {
          try {
            await IdempotencyRegistry.updateStatus(
              ctx.idempotencyKey,
              'COMMITTED',
              committedResult,
              undefined,
              ctx.tenantId
            );
          } catch (idempotencyError) {
            addPostCommitWarning('idempotency-status-update', idempotencyError);
          }
        }
        addPostCommitWarning('unexpected-post-commit-error', err);
        return WorkflowResultBuilder.success(committedResult, ctx, {
          auditReference: `AUDIT-${ctx.workflowId}`,
          warnings: postCommitWarnings,
          syncStatus
        });
      }

      const errorObj = err instanceof WorkflowExecutionError ? err : new WorkflowExecutionError(err.message || String(err), 'TRANSACTION_FAILED', { originalError: err });

      // Rollback Idempotency status
      if (ctx.idempotencyKey) {
        await IdempotencyRegistry.delete(ctx.idempotencyKey, ctx.tenantId).catch(() => null);
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
