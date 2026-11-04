
import { db, getCurrentUserSession } from '@/core/db';
import { CashFlow } from '@/types';

/**
 * CashFlow Repository - إدارة سجلات النقدية والسندات
 */
export const CashFlowRepository = {
  // Fix: Returns Promise<CashFlow[]>
  getAll: async (): Promise<CashFlow[]> => {
    return await db.getCashFlow();
  },

  // Fix: Made async and awaited db call
  getVouchers: async (): Promise<CashFlow[]> => {
    const cashflow = await db.getCashFlow();
    return cashflow.filter(h => h.notes?.includes('سند'));
  },

  /**
   * تسجيل حركة نقدية جديدة
   */
  record: async (
    type: 'دخل' | 'خرج',
    category: string,
    amount: number,
    name: string,
    notes?: string,
    context?: { userId?: string; cashboxId?: string }
  ) => {
    const session = getCurrentUserSession();
    const userId = context?.userId ?? session.userId;
    const assignedUser = userId
      ? await db.users.get(userId).catch(() => undefined)
      : undefined;
    const id = db.generateId('CF');
    const entry: CashFlow = {
      id,
      transaction_id: id,
      date: new Date().toISOString(),
      type,
      category,
      name,
      amount,
      notes,
      branchId: session.branchId || 'MAIN',
      userId,
      cashboxId: context?.cashboxId ?? assignedUser?.cashboxId
    };
    return await db.recordCashFlow(entry);
  }
};
