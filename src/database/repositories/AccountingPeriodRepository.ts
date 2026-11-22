import { AccountingPeriod } from '@/types';
import { AccountingPeriodSyncService } from '@/features/accounting/services/AccountingPeriodSyncService';

export const AccountingPeriodRepository = {
  getAll: async (): Promise<AccountingPeriod[]> => {
    return await AccountingPeriodSyncService.getPeriods();
  },

  getActivePeriod: async (): Promise<AccountingPeriod | undefined> => {
    const all = await AccountingPeriodSyncService.getPeriods();
    return all.find((period) => !period.Is_Locked && !period.isLocked);
  },

  isDateClosed: async (dateStr: string): Promise<boolean> => {
    const date = new Date(dateStr);
    if (!dateStr?.trim() || !Number.isFinite(date.getTime())) {
      throw new Error('ACCOUNTING_PERIOD_DATE_INVALID: تاريخ العملية المحاسبية غير صالح.');
    }
    const periods = await AccountingPeriodSyncService.getPeriods();
    const matches = periods.filter((period) => {
      const legacy = period as any;
      const start = new Date(period.Start_Date || period.startDate || legacy.start_date || '');
      const end = new Date(period.End_Date || period.endDate || legacy.end_date || '');
      return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) &&
        date >= start && date <= end;
    });
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? 'ACCOUNTING_PERIOD_NOT_CONFIGURED: لا توجد فترة محاسبية تغطي التاريخ.'
        : 'ACCOUNTING_PERIOD_AMBIGUOUS: توجد فترات محاسبية متداخلة.');
    }
    const matchingPeriod = matches[0];
    if (!matchingPeriod) throw new Error('ACCOUNTING_PERIOD_NOT_CONFIGURED');
    const legacy = matchingPeriod as any;
    return matchingPeriod.Is_Locked === true || matchingPeriod.isLocked === true || legacy.is_locked === true;
  },

  closePeriod: async (periodId: string, _userId: string) => {
    await AccountingPeriodSyncService.setLocked(periodId, true);
  },

  openPeriod: async (periodId: string) => {
    await AccountingPeriodSyncService.setLocked(periodId, false);
  },

  createPeriod: async (startDate: string, endDate: string) => {
    return await AccountingPeriodSyncService.createPeriod(startDate, endDate);
  }
};
