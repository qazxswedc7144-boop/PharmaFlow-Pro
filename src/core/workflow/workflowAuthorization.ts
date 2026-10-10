import { BusinessWorkflow, WorkflowContext } from './workflow.types';
import { WorkflowExecutionError } from './workflowError';
import { GlobalGuard } from '@/services/security/GlobalGuard';
import { useAuthStore } from '@/store/authStore';

export class WorkflowAuthorization {
  /**
   * Enforces RBAC permissions and system security state before workflow execution
   */
  public static async authorize<TInput, TResult>(
    workflow: BusinessWorkflow<TInput, TResult>,
    ctx: WorkflowContext
  ): Promise<void> {
    // 1. Check system global state & freeze locks
    try {
      await GlobalGuard.checkSystemState(workflow.name || workflow.operationType, ctx.startedAt);
    } catch (err: any) {
      throw new WorkflowExecutionError(
        `تم رفض التنفيذ بواسطة حارس النظام: ${err.message || String(err)}`,
        'AUTHORIZATION_DENIED'
      );
    }

    const authState = useAuthStore.getState();
    const user = authState.user;

    // 0. Check Authentication
    if (!user || !authState.isAuthenticated) {
      throw new WorkflowExecutionError(
        'لم يتم العثور على جلسة مستخدم صحيحة (المستخدم غير مسجل الدخول)',
        'UNAUTHENTICATED'
      );
    }

    // 2. Tenant Isolation Check
    if (user) {
      const userTenant = user.tenantId || (user as any).tenant_id || authState.tenantId;
      if (!userTenant || userTenant === 'default' || userTenant === 'default-tenant') {
        throw new WorkflowExecutionError(
          'FAIL_CLOSED: جلسة المستخدم لا تحتوي على معرف مؤسسة موثوق.',
          'AUTHORIZATION_DENIED'
        );
      }
      if (ctx.tenantId && ctx.tenantId !== userTenant) {
        throw new WorkflowExecutionError(
          `تم رفض التنفيذ بسبب محاولة الوصول لمستأجر آخر [${ctx.tenantId}]`,
          'AUTHORIZATION_DENIED'
        );
      }
    }

    // 3. Check required RBAC permissions
    if (workflow.requiredPermissions && workflow.requiredPermissions.length > 0) {
      for (const perm of workflow.requiredPermissions) {
        if (perm === 'ALL') continue;
        const hasPerm = authState.hasPermission(perm) || (user?.permissions && user.permissions.includes('ALL'));
        if (!hasPerm) {
          throw new WorkflowExecutionError(
            `غير مصرح لك بـ [${perm}] لتنفيذ العملية [${workflow.name}]`,
            'AUTHORIZATION_DENIED',
            { requiredPermission: perm, userId: ctx.userId }
          );
        }
      }
    }
  }
}
