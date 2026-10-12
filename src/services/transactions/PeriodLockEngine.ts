
import { db } from '@/core/db';
import { PeriodLockedError, ErrorManager } from '@/core/errors';

export class PeriodLockEngine {
  static async isPeriodLocked(dateStr: string): Promise<boolean> {
    try {
      const date = new Date(dateStr);
      const periods = await db.accountingPeriods.toArray();
      const matchingPeriod = periods.find(p => {
        const start = new Date(p.Start_Date);
        const end = new Date(p.End_Date);
        return date >= start && date <= end;
      });
      return matchingPeriod ? matchingPeriod.Is_Locked : false;
    } catch (error) {
      ErrorManager.handleError(error, { module: 'ACCOUNTING', action: 'CHECK_PERIOD_LOCK', showToast: false });
      return false;
    }
  }

  static async lockPeriod(periodId: string) {
    return await db.accountingPeriods.update(periodId, { Is_Locked: true, Locked_At: new Date().toISOString() });
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
    const count = await db.accountingPeriods.count();
    if (count === 0) {
      const now = new Date();
      await db.accountingPeriods.add({
        id: 'DEFAULT-PERIOD',
        Start_Date: new Date(now.getFullYear(), 0, 1).toISOString(),
        End_Date: new Date(now.getFullYear(), 11, 31).toISOString(),
        Is_Locked: false
      });
    }
  }
}
