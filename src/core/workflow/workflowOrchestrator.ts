import { BusinessWorkflow, WorkflowContext, WorkflowResult } from './workflow.types';
import { WorkflowContextFactory } from './workflowContext';
import { WorkflowExecutionPipeline } from './workflowExecution';
import { workflowRegistry } from './workflowRegistry';
import { WorkflowExecutionError } from './workflowError';
import { WorkflowResultBuilder } from './workflowResult';

function createContextFailureResult<TResult = any>(
  error: unknown,
  operationType: string,
  options?: Partial<WorkflowContext>
): WorkflowResult<TResult> {
  const now = Date.now();
  const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
  const failureContext: WorkflowContext = {
    workflowId: options?.workflowId || `WF-CONTEXT-FAILED-${now}-${suffix}`,
    correlationId: options?.correlationId || `CORR-CONTEXT-FAILED-${now}-${suffix}`,
    idempotencyKey: options?.idempotencyKey || `CTX-FAILED-${now}-${suffix}`,
    // Never copy an incomplete or placeholder identity into a failure context.
    tenantId: '',
    branchId: '',
    userId: '',
    deviceId: options?.deviceId || 'browser-client',
    operationType,
    startedAt: options?.startedAt || new Date(now).toISOString(),
    onLocalCommit: options?.onLocalCommit,
    metadata: options?.metadata || {}
  };
  const workflowError = error instanceof WorkflowExecutionError
    ? error
    : new WorkflowExecutionError(
        error instanceof Error ? error.message : String(error),
        'AUTHORIZATION_DENIED'
      );

  return WorkflowResultBuilder.failure(
    workflowError,
    workflowError.code,
    failureContext
  );
}

export class WorkflowOrchestrator {
  /**
   * Central execution method for any business workflow.
   *
   * @param workflowOrId Registered workflow ID or BusinessWorkflow instance
   * @param input Domain input parameters
   * @param contextOptions Optional override for workflow context
   */
  public static async execute<TInput = any, TResult = any>(
    workflowOrId: string | BusinessWorkflow<TInput, TResult>,
    input: TInput,
    contextOptions?: Partial<WorkflowContext>
  ): Promise<WorkflowResult<TResult>> {
    let workflow: BusinessWorkflow<TInput, TResult> | undefined;

    if (typeof workflowOrId === 'string') {
      workflow = workflowRegistry.get<TInput, TResult>(workflowOrId);
      if (!workflow) {
        let ctx: WorkflowContext;
        try {
          ctx = WorkflowContextFactory.create('UNKNOWN', contextOptions);
        } catch (contextError) {
          return createContextFailureResult(contextError, 'UNKNOWN', contextOptions);
        }
        return WorkflowResultBuilder.failure(
          new WorkflowExecutionError(`لم يتم العثور على سير العمل المسجل بـ [${workflowOrId}]`, 'VALIDATION_FAILED'),
          'VALIDATION_FAILED',
          ctx
        );
      }
    } else {
      workflow = workflowOrId;
      if (!workflowRegistry.has(workflow.id)) {
        workflowRegistry.register(workflow as BusinessWorkflow);
      }
    }

    let ctx: WorkflowContext;
    try {
      ctx = WorkflowContextFactory.create(workflow.operationType, contextOptions);
    } catch (contextError) {
      // Return a structured failure before any workflow pipeline or domain side effect starts.
      return createContextFailureResult(contextError, workflow.operationType, contextOptions);
    }
    return await WorkflowExecutionPipeline.run(workflow, input, ctx);
  }

  /**
   * Registers a workflow instance in the orchestrator registry.
   */
  public static registerWorkflow(workflow: BusinessWorkflow): void {
    workflowRegistry.register(workflow);
  }

  /**
   * Returns all registered workflow instances.
   */
  public static getRegisteredWorkflows(): BusinessWorkflow[] {
    return workflowRegistry.getAll();
  }
}
