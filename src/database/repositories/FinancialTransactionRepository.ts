import { db } from '@/core/db';
import { FinancialTransaction } from '@/types';
import { authService } from '@features/auth/services/authService';
import { useAuthStore } from '@/store/authStore';
import { generateTransactionUuid } from '@/utils/uuid';

/**
 * FinancialTransaction Repository - مركز التحكم في الحركات المالية (Phase 11 Update)
 */
export const FinancialTransactionRepository = {
  
  getAll: async (): Promise<FinancialTransaction[]> => {
    return await db.financialTransactions.orderBy('Transaction_Date').reverse().toArray();
  },

  getById: async (id: string): Promise<FinancialTransaction | undefined> => {
    return await db.financialTransactions.get(id);
  },

  getByReference: async (refId: string, tx?: any, tenantId?: string, branchId?: string): Promise<FinancialTransaction[]> => {
    if (!refId) return [];
    const table = tx?.financialTransactions ?? db.financialTransactions;
    let query = table.where('Reference_ID').equals(refId);
    
    if (tenantId) {
      query = query.and(t => t.tenantId === tenantId);
    }
    
    if (branchId) {
      query = query.and(t => t.branchId === branchId);
    }
    
    return await query.toArray();
  },

  /**
   * تسجيل حركة مالية مركزية جديدة (Unique Transaction Registry)
   */
  record: async (data: Omit<FinancialTransaction, 'Transaction_ID' | 'Created_At' | 'Created_By' | 'lastModified' | 'Transaction_Date' | 'Paid_Amount'> & { Transaction_Date?: string; Paid_Amount?: number; id?: string; tenantId?: string; branchId?: string }, tx?: any): Promise<string> => {
    const user = authService.getCurrentUser();
    const id = data.id || generateTransactionUuid('TRX');
    const now = new Date().toISOString();

    let tenantId = (data as any).tenantId;
    let branchId = (data as any).branchId;

    if (!tenantId || tenantId === 'default' || tenantId === 'default-tenant' || tenantId === 'tenant-default' || tenantId === 'main') {
      const authState = useAuthStore.getState();
      const currentUser = authState.user;
      tenantId = (currentUser as any)?.tenantId || (currentUser as any)?.tenant_id || authState.tenantId || null;
    }

    if (!branchId || branchId === 'main' || branchId === 'default' || branchId === 'default-branch' || branchId === 'BRH-DEFAULT') {
      const authState = useAuthStore.getState();
      const currentUser = authState.user;
      branchId = (currentUser as any)?.branchId || (currentUser as any)?.branch_id || authState.branchId || null;
    }

    if (!tenantId || tenantId === 'default' || tenantId === 'default-tenant' || tenantId === 'tenant-default' || tenantId === 'main') {
      throw new Error('FAIL_CLOSED: تسجيل الحركة المالية يتطلب سياق مؤسسة موثوق (Trusted Tenant Context Required).');
    }

    if (!branchId || branchId === 'main' || branchId === 'default' || branchId === 'default-branch' || branchId === 'BRH-DEFAULT') {
      throw new Error('FAIL_CLOSED: تسجيل الحركة المالية يتطلب فرع موثوق للمؤسسة (Trusted Branch Context Required).');
    }
    
    const transaction: FinancialTransaction = {
      ...data,
      id: id,
      Transaction_ID: id,
      Paid_Amount: data.Paid_Amount || data.Amount || 0, 
      Transaction_Date: data.Transaction_Date || now,
      Created_At: now,
      Created_By: user?.User_Email || 'SYSTEM',
      lastModified: now,
      tenantId,
      branchId
    } as FinancialTransaction;

    const ftsTbl = tx ? tx.table('financialTransactions') : db.financialTransactions;
    await ftsTbl.put(transaction);
    
    await db.addAuditLog(
      'CREATE', 
      'VOUCHER',
      transaction.Reference_ID, 
      `تم تسجيل مبلغ مسدد بقيمة ${transaction.Paid_Amount.toLocaleString()} د.إ (${transaction.Transaction_Type}) لجهة: ${transaction.Entity_Name}`,
      tx
    );

    return id;
  },

  /**
   * إبطال/عكس الحركات المالية المرتبطة بمرجع معين (Non-Destructive Reversal)
   */
  reverseTransactions: async (refId: string, tx?: any, idempotencyKey?: string, tenantId?: string, branchId?: string): Promise<void> => {
    const table = tx?.financialTransactions ?? db.financialTransactions;
    const transactions = await FinancialTransactionRepository.getByReference(refId, tx, tenantId, branchId);
    const now = new Date().toISOString();
    
    // Target ONLY active transactions that haven't been reversed yet
    const activeTxs = transactions.filter(t => !t.isDeleted && !(t as any).isReversal && !(t as any).reversedBy);
    
    console.log(`[FinancialTransactionRepository] Found ${transactions.length} total FTs, ${activeTxs.length} are active for document ${refId} (Tenant: ${tenantId || 'GLOBAL'}, Branch: ${branchId || 'GLOBAL'})`);

    for (const trx of activeTxs) {
      const reversalId = idempotencyKey ? `FT-REV-${trx.id}-${idempotencyKey}` : `FT-REV-${trx.id}`;
      
      // التحقق من وجود العكس مسبقاً لضمان Idempotency (استخدام الجدول المرتبط بالمعاملة لضمان الرؤية)
      const existingRev = await table.get(reversalId);
      if (existingRev) {
        console.log(`[FinancialTransactionRepository] Reversal FT ${reversalId} already exists (idempotent skip)`);
        continue;
      }

      const reversal: FinancialTransaction = {
        ...trx,
        id: reversalId,
        Transaction_ID: reversalId,
        Direction: trx.Direction === 'Debit' ? 'Credit' : 'Debit',
        Notes: `عكس حركة ${trx.Transaction_ID} للمستند #${refId}`,
        Transaction_Date: now,
        Created_At: now,
        lastModified: now,
        isReversal: true, // وسم لتمييز القيود العكسية
        reversalOf: trx.id, // ربط صريح بالحركة الأصلية
        isDeleted: false
      } as any;

      await table.put(reversal);

      // تعليم الحركة الأصلية كملغاة/معكوسة مع بقائها في السجل
      await table.update(trx.id, {
        isDeleted: true,
        lastModified: now,
        reversedBy: reversalId
      });
      console.log(`[FinancialTransactionRepository] REVERSED: FT ${trx.id} linked to new reversal ${reversalId}`);
    }
  },

  /**
   * حذف أو إلغاء حركة (Logical Delete)
   */
  cancelTransaction: async (refId: string, tx?: any): Promise<void> => {
    const table = tx?.financialTransactions ?? db.financialTransactions;
    const transactions = await FinancialTransactionRepository.getByReference(refId, tx);
    const now = new Date().toISOString();
    for (const trx of transactions) {
      if (trx.isDeleted) continue;
      await table.update(trx.id, {
        isDeleted: true,
        lastModified: now
      });
    }
  }
};
