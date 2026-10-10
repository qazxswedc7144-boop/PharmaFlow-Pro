import { WorkflowContext } from './workflow.types';
import { generateTransactionUuid } from '@/utils/uuid';
import { authService } from '@features/auth/services/authService';
import { useAuthStore } from '@/store/authStore';
import { WorkflowExecutionError } from './workflowError';

export class WorkflowContextFactory {
  /**
   * Creates a standardized, unified WorkflowContext instance.
   * Strictly enforces trusted tenant context (Fail Closed).
   */
  public static create(
    operationType: string,
    options?: Partial<WorkflowContext>
  ): WorkflowContext {
    const user = authService.getCurrentUser?.() || useAuthStore.getState().user;
    const authState = useAuthStore.getState();

    const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const workflowId = options?.workflowId || `WF-${Date.now()}-${randomSuffix}`;
    const correlationId = options?.correlationId || `CORR-${Date.now()}-${randomSuffix}`;

    const rawTenantId = options?.tenantId || (user as any)?.tenantId || (user as any)?.tenant_id || authState.tenantId || null;
    const rawBranchId = options?.branchId || (user as any)?.branchId || (user as any)?.branch_id || authState.branchId || null;

    if (!rawTenantId || rawTenantId === 'default' || rawTenantId === 'default-tenant') {
      throw new WorkflowExecutionError(
        'FAIL_CLOSED: لا يمكن تنفيذ العملية المالية بدون سياق مؤسسة موثوق (Trusted Tenant Context Required).',
        'TENANT_REQUIRED'
      );
    }

    const tenantId = rawTenantId;
    const branchId = rawBranchId || 'BRH-DEFAULT';
    const userId = options?.userId || user?.id || (user as any)?.userId || 'system';
    const deviceId = options?.deviceId || 'browser-client';
    const idempotencyKey =
      options?.idempotencyKey ||
      generateTransactionUuid(operationType.toUpperCase().replace(/[^A-Z0-9]/g, '_') as any);

    return {
      workflowId,
      correlationId,
      idempotencyKey,
      tenantId,
      branchId,
      userId,
      deviceId,
      operationType,
      startedAt: options?.startedAt || new Date().toISOString(),
      metadata: options?.metadata || {}
    };
  }
}
