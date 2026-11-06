// src/core/observability/crashRecoveryManager.ts

import { db, getCurrentUserSession } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { observabilityService } from './observabilityService';
import { recoveryCoordinator } from './recoveryCoordinator';
import { createObservabilityContext } from './observabilityContext';

export interface CrashRecoveryResult {
  interruptedSyncsFound: number;
  unownedLegacyOutboxCount: number;
  interruptedDraftsFound: number;
  unconfirmedFinancialCount: number;
  recoveredCount: number;
  reconciliationsRequiredCount: number;
  timestamp: string;
}

type RecoveryOwner = {
  tenantId: string;
  userId: string;
};

export class CrashRecoveryManager {
  private static instance: CrashRecoveryManager;

  public static getInstance(): CrashRecoveryManager {
    if (!CrashRecoveryManager.instance) {
      CrashRecoveryManager.instance = new CrashRecoveryManager();
    }
    return CrashRecoveryManager.instance;
  }

  /**
   * Return an owner only when the authenticated token identity and the
   * application's normalized session identity agree exactly.
   */
  private readRecoveryOwner(): RecoveryOwner | null {
    const auth = TokenProvider.getCurrentSession() as any;
    const session = getCurrentUserSession();
    const authUserId = auth?.user?.id || auth?.user?.user_id;
    const authTenantId = auth?.tenantId || auth?.user?.tenantId || auth?.user?.tenant_id;

    if (
      auth?.isAuthenticated !== true ||
      typeof auth?.token !== 'string' ||
      !auth.token.trim() ||
      !authUserId ||
      !authTenantId ||
      session.userId !== authUserId ||
      session.tenantId !== authTenantId
    ) {
      return null;
    }

    return { tenantId: authTenantId, userId: authUserId };
  }

  private isRecoveryOwnerCurrent(owner: RecoveryOwner): boolean {
    const current = this.readRecoveryOwner();
    return Boolean(current && current.tenantId === owner.tenantId && current.userId === owner.userId);
  }

  /**
   * Application Bootstrap Crash Recovery Routine.
   * Sync recovery is strictly user-owned; ownerless legacy rows are reported
   * for controlled reconciliation and are never re-attributed or retried.
   */
  public async bootstrapAppRecovery(): Promise<CrashRecoveryResult> {
    const ctx = createObservabilityContext({ workflow: 'APP_BOOTSTRAP_CRASH_RECOVERY' });
    let interruptedSyncsFound = 0;
    let unownedLegacyOutboxCount = 0;
    let interruptedDraftsFound = 0;
    let unconfirmedFinancialCount = 0;
    let recoveredCount = 0;
    let reconciliationsRequiredCount = 0;

    try {
      if (!db || !db.isOpen()) {
        try {
          await db.open();
        } catch {}
      }

      const recoveryOwner = this.readRecoveryOwner();

      // 1. Inspect only the active tenant's outbox. A row is recoverable only
      // when it has an exact owner match with the authenticated session.
      if (db && db.outbox && recoveryOwner) {
        const tenantOutbox = await db.outbox
          .where('tenantId')
          .equals(recoveryOwner.tenantId)
          .toArray()
          .catch(() => []);

        unownedLegacyOutboxCount = tenantOutbox.filter((event: any) =>
          !event?.userId || typeof event.userId !== 'string' || !event.userId.trim()
        ).length;

        const processingMutations = tenantOutbox.filter((event: any) =>
          event?.status === 'processing' && event.tenantId === recoveryOwner.tenantId &&
          event.userId === recoveryOwner.userId
        );

        interruptedSyncsFound = processingMutations.length;

        for (const mut of processingMutations) {
          if (!this.isRecoveryOwnerCurrent(recoveryOwner)) break;
          if (!mut?.id || mut.tenantId !== recoveryOwner.tenantId || mut.userId !== recoveryOwner.userId) continue;

          // Re-read immediately before mutation to avoid acting on a stale row.
          const latest = await db.outbox.get(mut.id).catch(() => undefined);
          if (!this.isRecoveryOwnerCurrent(recoveryOwner)) break;
          if (
            !latest ||
            latest.tenantId !== recoveryOwner.tenantId ||
            latest.userId !== recoveryOwner.userId ||
            latest.status !== 'processing'
          ) {
            continue;
          }

          await db.outbox.update(mut.id, {
            status: 'pending',
            updatedAt: new Date().toISOString()
          });
          if (!this.isRecoveryOwnerCurrent(recoveryOwner)) break;
          recoveredCount++;
        }

        if (unownedLegacyOutboxCount > 0) {
          reconciliationsRequiredCount += unownedLegacyOutboxCount;
          await observabilityService.recordRecovery(
            'MANUAL_INTERVENTION',
            'RECONCILIATION_REQUIRED',
            ctx,
            `Found ${unownedLegacyOutboxCount} ownerless legacy outbox record(s) for this tenant. Records were left unchanged; ownership must be established from trusted evidence before any replay.`
          );
        }
      }

      // 2. Inspect invoices with DRAFT document status. Financial operations
      // retain the existing zero-blind-retry verification boundary.
      if (db && db.invoices) {
        const draftInvoices = await db.invoices
          .where('documentStatus')
          .equals('DRAFT')
          .toArray()
          .catch(() => []);

        interruptedDraftsFound = draftInvoices.length;

        for (const draft of draftInvoices) {
          if (draft.transactionUuid) {
            const check = await recoveryCoordinator.verifyFinancialOperationCommitted(
              draft.id,
              draft.transactionUuid
            );

            if (check.committed) {
              await db.invoices.update(draft.id, { documentStatus: 'POSTED' });
              recoveredCount++;
              await observabilityService.recordRecovery(
                'RESTORE_STATE',
                'SUCCESS',
                ctx,
                `Invoice ${draft.id} restored to POSTED state after crash recovery verification.`
              );
            } else if (check.status === 'UNKNOWN') {
              unconfirmedFinancialCount++;
              reconciliationsRequiredCount++;
              await observabilityService.recordRecovery(
                'MANUAL_INTERVENTION',
                'RECONCILIATION_REQUIRED',
                ctx,
                `Invoice ${draft.id} commitment state is unknown. Marked for reconciliation.`
              );
            }
          }
        }
      }

      const summary: CrashRecoveryResult = {
        interruptedSyncsFound,
        unownedLegacyOutboxCount,
        interruptedDraftsFound,
        unconfirmedFinancialCount,
        recoveredCount,
        reconciliationsRequiredCount,
        timestamp: new Date().toISOString()
      };

      if (recoveredCount > 0 || reconciliationsRequiredCount > 0) {
        await observabilityService.recordRecovery(
          'RESTORE_STATE',
          reconciliationsRequiredCount > 0 ? 'RECONCILIATION_REQUIRED' : 'SUCCESS',
          ctx,
          `Bootstrap crash recovery complete. Recovered: ${recoveredCount}, Reconciliations required: ${reconciliationsRequiredCount}`
        );
      }

      return summary;
    } catch (error: any) {
      await observabilityService.recordError(
        error,
        ctx,
        'DATABASE',
        'WARNING'
      );

      return {
        interruptedSyncsFound: 0,
        unownedLegacyOutboxCount: 0,
        interruptedDraftsFound: 0,
        unconfirmedFinancialCount: 0,
        recoveredCount: 0,
        reconciliationsRequiredCount: 0,
        timestamp: new Date().toISOString()
      };
    }
  }
}

export const crashRecoveryManager = CrashRecoveryManager.getInstance();
