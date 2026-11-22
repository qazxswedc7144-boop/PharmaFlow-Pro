import { db } from '@/core/db';
import { AccountingError } from '@/types';
import { PeriodLockEngine } from '@/services/transactions/PeriodLockEngine';

export class PeriodService {
  static async getCurrentPeriod() {
    const periods = await db.accountingPeriods.toArray();
    return periods[periods.length - 1];
  }

  async validatePeriod(dateStr: string): Promise<void> {
    if (typeof dateStr !== 'string' || dateStr.trim() === '' || !Number.isFinite(new Date(dateStr).getTime())) {
      throw new AccountingError('تاريخ الفترة المحاسبية غير صالح.');
    }

    await PeriodLockEngine.validateOperation(dateStr, 'عملية محاسبية');
  }
}

export const periodService = new PeriodService();
