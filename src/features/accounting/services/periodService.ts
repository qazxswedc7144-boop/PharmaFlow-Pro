
import { AccountingPeriodRepository } from '@/database/repositories/AccountingPeriodRepository';
import { AccountingError } from '@/types';
import { BackupService } from '@/services/backupService';
import { PeriodLockEngine } from '@/services/transactions/PeriodLockEngine';

/**
 * Period Service - نظام حماية الفترات المحاسبية (Accounting Period Locking)
 * مسؤول عن منع العمليات المالية في التواريخ المقفلة
 */
export const periodService = {
  /**
   * التحقق من صلاحية التاريخ للعمليات (الحارس المركزي)
   * يطبق القاعدة: يمنع التعديل/الحذف إلا للمسؤول (Admin Override)
   * @throws AccountingError إذا كان التاريخ مغلقاً والمستخدم ليس مسؤولاً
   */
  validatePeriod: async (date: string): Promise<void> => {
    try {
      await PeriodLockEngine.validateOperation(date, 'عملية محاسبية');
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.includes('SECURITY_BLOCK')) {
        throw new AccountingError(errMsg);
      }
      throw error;
    }
  },

  /**
   * جلب كافة الفترات المحاسبية
   */
  getPeriods: async () => await AccountingPeriodRepository.getAll(),

  /** إنشاء فترة محاسبية جديدة عبر الخادم */
  createPeriod: async (startDate: string, endDate: string) =>
    await AccountingPeriodRepository.createPeriod(startDate, endDate),

  /** إعادة فتح فترة محاسبية بصلاحية إدارية */
  openPeriod: async (periodId: string) =>
    await AccountingPeriodRepository.openPeriod(periodId),

  /**
   * إغلاق فترة مالية بشكل نهائي
   */
  closePeriod: async (periodId: string, userId: string) => {
    // PHASE 3 — AUTO BACKUP RULES
    await BackupService.createBackup(`Auto Backup before Closing Period #${periodId}`, 'PRE_PERIOD_CLOSE', false);
    await AccountingPeriodRepository.closePeriod(periodId, userId);
  }
};
