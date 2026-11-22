import { db, getCurrentUserSession } from '@/core/db';
import { PeriodLockedError, ErrorManager } from '@/core/errors';
import { AccountingPeriodSyncService } from '@/features/accounting/services/AccountingPeriodSyncService';

export class PeriodLockEngine {
  static async isPeriodLocked(dateStr: string): Promise<boolean> {
    try {
      const date = new Date(dateStr);
      if (typeof dateStr !== 'string' || !dateStr.trim() || !Number.isFinite(date.getTime())) {
        throw new Error('ACCOUNTING_PERIOD_DATE_INVALID: تاريخ العملية المحاسبية غير صالح.');
      }

      const periods = await AccountingPeriodSyncService.getPeriods();
      const matchingPeriods = periods.filter((period) => {
        const legacy = period as any;
        const start = new Date(period.Start_Date || period.startDate || legacy.start_date || '');
        const end = new Date(period.End_Date || period.endDate || legacy.end_date || '');
        return Number.isFinite(start.getTime()) &&
          Number.isFinite(end.getTime()) &&
          date >= start &&
          date <= end;
      });

      if (matchingPeriods.length === 0) {
        throw new Error('ACCOUNTING_PERIOD_NOT_CONFIGURED: لا توجد فترة محاسبية معتمدة تغطي تاريخ العملية.');
      }
      if (matchingPeriods.length !== 1) {
        throw new Error('ACCOUNTING_PERIOD_AMBIGUOUS: تتداخل أكثر من فترة محاسبية مع تاريخ العملية.');
      }
      const legacy = matchingPeriods[0] as any;
      return matchingPeriods[0].Is_Locked === true || matchingPeriods[0].isLocked === true || legacy.is_locked === true;
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
