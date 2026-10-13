export type WorkflowErrorCode =
  | 'AUTHORIZATION_DENIED'
  | 'UNAUTHENTICATED'
  | 'VALIDATION_FAILED'
  | 'BUSINESS_RULE_FAILED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EXECUTION_CONFLICT'
  | 'TRANSACTION_FAILED'
  | 'CONSISTENCY_FAILED'
  | 'ACCOUNTING_FAILED'
  | 'INVENTORY_FAILED'
  | 'SYNC_ENQUEUE_FAILED'
  | 'RECOVERY_REQUIRED'
  | 'UNKNOWN_ERROR';

export interface WorkflowError {
  code: WorkflowErrorCode;
  message: string;
  details?: Record<string, unknown> | any;
}

export interface WorkflowContext {
  workflowId: string;
  correlationId: string;
  idempotencyKey: string;
  tenantId: string;
  branchId: string;
  userId: string;
  deviceId: string;
  operationType: string;
  startedAt: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowResult<TResult = any> {
  success: boolean;
  data?: TResult;
  workflowId: string;
  correlationId: string;
  idempotencyKey: string;
  warnings?: string[];
  error?: WorkflowError;
  auditReference?: string;
  syncStatus?: 'ENQUEUED' | 'SYNCED' | 'FAILED' | 'LOCAL_ONLY';
  metadata?: Record<string, unknown>;
}

export interface WorkflowHooks<TInput = any, TResult = any> {
  beforeAuthorization?: (input: TInput, ctx: WorkflowContext) => Promise<void>;
  afterAuthorization?: (input: TInput, ctx: WorkflowContext) => Promise<void>;
  beforeValidation?: (input: TInput, ctx: WorkflowContext) => Promise<void>;
  afterValidation?: (input: TInput, ctx: WorkflowContext) => Promise<void>;
  beforeExecute?: (input: TInput, ctx: WorkflowContext) => Promise<void>;
  afterExecute?: (result: TResult, ctx: WorkflowContext) => Promise<void>;
  beforeCommit?: (result: TResult, ctx: WorkflowContext) => Promise<void>;
  afterCommit?: (result: TResult, ctx: WorkflowContext) => Promise<void>;
  onError?: (error: Error, ctx: WorkflowContext) => Promise<void>;
  onRollback?: (error: Error, ctx: WorkflowContext) => Promise<void>;
}

export interface BusinessWorkflow<TInput = any, TResult = any> {
  id: string;
  name: string;
  operationType: string;
  requiredPermissions?: string[];
  tables?: string[];
  hooks?: WorkflowHooks<TInput, TResult>;
  validateInput?: (input: TInput, ctx: WorkflowContext) => Promise<void>;
  validateBusinessRules?: (input: TInput, ctx: WorkflowContext) => Promise<void>;
  executeDomainSteps(input: TInput, ctx: WorkflowContext, tx?: any): Promise<TResult>;
}
