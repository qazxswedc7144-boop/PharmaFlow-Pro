import { AccountingError } from '@/types';
import { PeriodLockEngine } from '@/services/transactions/PeriodLockEngine';

export class PeriodService {
  async validatePeriod(dateStr: string): Promise<void> {
    if (typeof dateStr !== 'string' || dateStr.trim() === '' || !Number.isFinite(new Date(dateStr).getTime())) {
      throw new AccountingError('تاريخ الفترة المحاسبية غير صالح.');
    }

    await PeriodLockEngine.validateOperation(dateStr, 'عملية محاسبية');
  }
}

export const periodService = new PeriodService();
