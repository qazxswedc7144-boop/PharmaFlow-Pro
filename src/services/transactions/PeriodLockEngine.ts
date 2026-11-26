import Dexie from 'dexie';
import { db, getCurrentUserSession } from '@/core/db';
import { PeriodLockedError, ErrorManager } from '@/core/errors';
import { AccountingPeriodSyncService } from '@/features/accounting/services/AccountingPeriodSyncService';

export interface VerifiedPeriodSnapshot {
  readonly tenantId: string;
  readonly periodId: string;
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly checkedDateStr: string;
  readonly isLocked: boolean;
  readonly verifiedAt: number;
}

const VERIFIED_PERIOD_SNAPSHOTS = new WeakSet<VerifiedPeriodSnapshot>();
const PERIOD_VERIFICATION_TTL_MS = 60_000;

export class PeriodLockEngine {
  private static assertNoActiveDexieTransaction(action: string): void {
    if ((Dexie as any).currentTransaction) {
      throw new Error(
        `ACCOUNTING_PERIOD_NETWORK_IN_TRANSACTION_FORBIDDEN: Cannot perform ${action} inside an active Dexie transaction.`
      );
    }
  }

  private static parseValidDate(dateStr: string): Date {
    const date = new Date(dateStr);
    if (typeof dateStr !== 'string' || !dateStr.trim() || !Number.isFinite(date.getTime())) {
      throw new Error('ACCOUNTING_PERIOD_DATE_INVALID: تاريخ العملية المحاسبية غير صالح.');
    }
    return date;
  }

  /**
   * Performs an authoritative, fail-closed server period lookup BEFORE opening
   * a Dexie transaction and returns an immutable, unforgeable snapshot that can
   * be asserted synchronously inside the transaction without network I/O.
   */
  static async verifyPeriodForTransaction(
    dateStr: string,
    expectedTenantId?: string
  ): Promise<VerifiedPeriodSnapshot> {
    try {
      this.assertNoActiveDexieTransaction('CHECK_PERIOD_LOCK');
      const date = this.parseValidDate(dateStr);

      const sessionTenantId = getCurrentUserSession().tenantId?.trim();
      if (!sessionTenantId) {
        throw new Error(
          'TRUSTED_TENANT_CONTEXT_REQUIRED: Accounting period verification requires an active tenant.'
        );
      }
      if (expectedTenantId && sessionTenantId !== expectedTenantId) {
        throw new Error(
          'CROSS_TENANT_VIOLATION: Accounting period verification tenant does not match the active session.'
        );
      }

      const periods = await AccountingPeriodSyncService.getPeriods({ forceRefresh: true });
      const matchingPeriods = periods.filter((period) => {
        const legacy = period as any;
        const start = new Date(period.Start_Date || period.startDate || legacy.start_date || '');
        const end = new Date(period.End_Date || period.endDate || legacy.end_date || '');
        return (
          Number.isFinite(start.getTime()) &&
          Number.isFinite(end.getTime()) &&
          date >= start &&
          date <= end
        );
      });

      if (matchingPeriods.length === 0) {
        throw new Error(
          'ACCOUNTING_PERIOD_NOT_CONFIGURED: لا توجد فترة محاسبية معتمدة تغطي تاريخ العملية.'
        );
      }
      if (matchingPeriods.length !== 1) {
        throw new Error(
          'ACCOUNTING_PERIOD_AMBIGUOUS: تتداخل أكثر من فترة محاسبية مع تاريخ العملية.'
        );
      }

      const matchingPeriod = matchingPeriods[0];
      if (!matchingPeriod) throw new Error('ACCOUNTING_PERIOD_NOT_CONFIGURED');

      const legacy = matchingPeriod as any;
      const start = new Date(
        matchingPeriod.Start_Date || matchingPeriod.startDate || legacy.start_date || ''
      );
      const end = new Date(
        matchingPeriod.End_Date || matchingPeriod.endDate || legacy.end_date || ''
      );
      const isLocked =
        matchingPeriod.Is_Locked === true ||
        matchingPeriod.isLocked === true ||
        legacy.is_locked === true;

      const snapshot: VerifiedPeriodSnapshot = Object.freeze({
        tenantId: sessionTenantId,
        periodId: String(matchingPeriod.id || legacy.clientId || ''),
        periodStartMs: start.getTime(),
        periodEndMs: end.getTime(),
        checkedDateStr: dateStr,
        isLocked,
        verifiedAt: Date.now(),
      });
      VERIFIED_PERIOD_SNAPSHOTS.add(snapshot);
      return snapshot;
    } catch (error) {
      const normalizedError = ErrorManager.handleError(error, {
        module: 'ACCOUNTING',
        action: 'CHECK_PERIOD_LOCK',
        showToast: false,
      });
      // A failed authoritative lookup must never be interpreted as an open period.
      throw normalizedError;
    }
  }

  /**
   * Verifies before opening a Dexie transaction that the date is covered by an
   * authoritative open period. Throws PeriodLockedError immediately if locked.
   */
  static async verifyOpenPeriodForTransaction(
    dateStr: string,
    expectedTenantId?: string,
    operationName?: string
  ): Promise<VerifiedPeriodSnapshot> {
    const snapshot = await this.verifyPeriodForTransaction(dateStr, expectedTenantId);
    if (snapshot.isLocked) {
      const formattedDate = dateStr ? dateStr.split('T')[0] : '';
      const action = operationName ? `إجراء "${operationName}"` : 'إجراء المعاملة';
      throw new PeriodLockedError({
        message: `Period locked for date ${formattedDate}. Cannot perform ${action}.`,
        arabicMessage: `الفترة المحاسبية لتاريخ (${formattedDate}) مغلقة. لا يمكن ${action} في فترة مغلقة.`,
        module: 'ACCOUNTING',
        metadata: { dateStr, operationName, periodId: snapshot.periodId },
      });
    }
    return snapshot;
  }

  /**
   * Synchronous, zero-I/O assertion for use inside active Dexie transactions.
   * Rejects missing, forged, cross-tenant, expired, or out-of-range snapshots.
   */
  static assertVerifiedPeriodSnapshot(
    snapshot: VerifiedPeriodSnapshot | undefined,
    expected: { tenantId: string; dateStr: string }
  ): VerifiedPeriodSnapshot {
    if (!snapshot || typeof snapshot !== 'object' || !VERIFIED_PERIOD_SNAPSHOTS.has(snapshot)) {
      throw new Error(
        'ACCOUNTING_PERIOD_VERIFICATION_REQUIRED: A fresh pre-transaction PeriodLockEngine verification snapshot is required inside a Dexie transaction.'
      );
    }

    if (!expected.tenantId || snapshot.tenantId !== expected.tenantId) {
      throw new Error(
        'CROSS_TENANT_VIOLATION: Verified accounting period snapshot does not match the transaction tenant.'
      );
    }

    const ageMs = Date.now() - snapshot.verifiedAt;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > PERIOD_VERIFICATION_TTL_MS) {
      throw new Error(
        'ACCOUNTING_PERIOD_VERIFICATION_EXPIRED: Verified accounting period snapshot has expired and cannot authorize this transaction.'
      );
    }

    const date = this.parseValidDate(expected.dateStr);
    const dateMs = date.getTime();
    if (dateMs < snapshot.periodStartMs || dateMs > snapshot.periodEndMs) {
      throw new Error(
        'ACCOUNTING_PERIOD_VERIFICATION_DATE_MISMATCH: Transaction date falls outside the verified accounting period snapshot.'
      );
    }

    return snapshot;
  }

  static async isPeriodLocked(dateStr: string): Promise<boolean> {
    const snapshot = await this.verifyPeriodForTransaction(dateStr);
    return snapshot.isLocked;
  }

  static async lockPeriod(periodId: string) {
    return await AccountingPeriodSyncService.setLocked(periodId, true);
  }

  static async validateOperation(dateStr: string, operationName?: string) {
    const isLocked = await this.isPeriodLocked(dateStr);
    if (isLocked) {
      const formattedDate = dateStr ? dateStr.split('T')[0] : '';
      const action = operationName ? `إجراء "${operationName}"` : 'إجراء المعاملة';
      throw new PeriodLockedError({
        message: `Period locked for date ${formattedDate}. Cannot perform ${action}.`,
        arabicMessage: `الفترة المحاسبية لتاريخ (${formattedDate}) مغلقة. لا يمكن ${action} في فترة مغلقة.`,
        module: 'ACCOUNTING',
        metadata: { dateStr, operationName },
      });
    }
    return true;
  }

  static async seedDefaultPeriod() {
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) {
      console.warn('[PeriodLockEngine] Skipping seedDefaultPeriod: No active tenant session.');
      return;
    }

    const count = await db.accountingPeriods.count();
    if (count === 0) {
      const now = new Date();
      await db.accountingPeriods.add({
        id: `DEFAULT-PERIOD-${tenantId}`,
        tenantId,
        Start_Date: new Date(now.getFullYear(), 0, 1).toISOString(),
        End_Date: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999).toISOString(),
        Is_Locked: false
      });
    }
  }
}
