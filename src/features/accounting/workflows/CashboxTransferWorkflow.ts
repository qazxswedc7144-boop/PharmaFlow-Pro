import { db, getCurrentUserSession } from '@/core/db';
import { AccountingRepository } from '@/database/repositories/AccountingRepository';
import { AccountingEntry, JournalLine } from '@/types';
import { PeriodLockEngine } from '@/services/transactions/PeriodLockEngine';

export interface CashboxTransferInput {
  sourceCashboxId: string;
  destinationCashboxId: string;
  amount: number;
  date: string;
  notes?: string;
  tenantId: string;
  branchId: string;
  transactionUuid: string;
}

export interface CashboxTransferResult {
  transactionUuid: string;
  journalId: string;
  alreadyProcessed: boolean;
}

export class CashboxTransferWorkflow {
  public readonly id = 'accounting.cashbox.transfer';
  public readonly name = 'تحويل داخلي بين الصناديق';

  async execute(input: CashboxTransferInput): Promise<CashboxTransferResult> {
    const amount = Number(input.amount);
    if (!input.sourceCashboxId || !input.destinationCashboxId) {
      throw new Error('يجب تحديد صندوق المصدر وصندوق الوجهة.');
    }
    if (input.sourceCashboxId === input.destinationCashboxId) {
      throw new Error('لا يمكن التحويل من الصندوق إلى نفسه.');
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('مبلغ التحويل يجب أن يكون رقماً أكبر من صفر.');
    }
    if (!Number.isFinite(Math.round(amount * 100) / 100) || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
      throw new Error('مبلغ التحويل يجب ألا يتجاوز منزلتين عشريتين.');
    }
    if (!input.date || Number.isNaN(new Date(input.date).getTime())) {
      throw new Error('تاريخ التحويل غير صالح.');
    }
    const assertActiveSession = () => {
      const session = getCurrentUserSession();
      if (!session.tenantId || !session.branchId) {
        throw new Error('فشلت العملية: لا توجد جلسة مستخدم نشطة أو صلاحيات كافية.');
      }
      if (input.tenantId !== session.tenantId || input.branchId !== session.branchId) {
        console.error('[SECURITY] Cashbox transfer attempt with mismatched session context:', {
          requestedTenantId: input.tenantId,
          requestedBranchId: input.branchId,
          activeTenantId: session.tenantId,
          activeBranchId: session.branchId
        });
        throw new Error('خطأ أمني: سياق المؤسسة أو الفرع غير مطابق للجلسة النشطة.');
      }
    };
    assertActiveSession();
    if (!input.transactionUuid?.trim()) {
      throw new Error('معرّف العملية مطلوب لضمان العزل ومنع التكرار.');
    }

    await PeriodLockEngine.validateOperation(input.date, 'التحويل بين الصناديق');
    // Revalidate after the asynchronous period check, before opening the write transaction.
    assertActiveSession();

    return db.safeTransaction(
      'rw',
      ['cashboxes', 'accounts', 'journalEntries', 'journalLines'],
      async (tx) => {
        // A session can change while asynchronous work is in flight; fail closed inside the transaction too.
        assertActiveSession();
        const cashboxes = tx.table('cashboxes');
        const accounts = tx.table('accounts');
        const entries = tx.table('journalEntries');

        const [source, destination] = await Promise.all([
          cashboxes.get(input.sourceCashboxId),
          cashboxes.get(input.destinationCashboxId)
        ]);

        if (!source || !destination) throw new Error('أحد الصندوقين المحددين غير موجود.');
        if (source.isActive === false || destination.isActive === false) {
          throw new Error('لا يمكن التحويل من صندوق معطل أو إلى صندوق معطل.');
        }
        for (const box of [source, destination]) {
          if (box.tenantId !== input.tenantId) {
            throw new Error('الصندوق لا يحمل مؤسسة مطابقة للمؤسسة الحالية أو أنه خارج نطاقها.');
          }
          if (box.branchId !== input.branchId) {
            throw new Error('التحويل الداخلي يتطلب صندوقين تابعين للفرع المحدد.');
          }
          if (!box.accountId) throw new Error(`الصندوق "${box.name}" غير مرتبط بحساب محاسبي.`);
        }
        if (source.accountId === destination.accountId) {
          throw new Error('الصندوقان مرتبطان بالحساب نفسه؛ لا يمكن إنشاء تحويل محاسبي صحيح بينهما.');
        }

        const [sourceAccount, destinationAccount] = await Promise.all([
          accounts.get(source.accountId),
          accounts.get(destination.accountId)
        ]);
        for (const account of [sourceAccount, destinationAccount]) {
          if (!account || account.isActive === false || account.type !== 'ASSET') {
            throw new Error('يجب ربط كل صندوق بحساب أصول نشط وصالح.');
          }
          if (account.tenantId !== input.tenantId) {
            throw new Error('أحد الحسابات المرتبطة لا يحمل مؤسسة مطابقة أو أنه خارج نطاق المؤسسة الحالية.');
          }
          if (account.branchId && account.branchId !== input.branchId) {
            throw new Error('أحد الحسابات المرتبطة لا يتبع الفرع المحدد للتحويل.');
          }
        }

        // Final context check immediately before any accounting write.
        assertActiveSession();
        const journalId = input.transactionUuid;
        const existing = await entries.get(journalId);
        if (existing) {
          const sameOperation =
            existing.sourceType === 'CASHBOX_TRANSFER' &&
            existing.sourceId === input.transactionUuid &&
            existing.tenantId === input.tenantId &&
            existing.branchId === input.branchId &&
            (existing as any).sourceCashboxId === source.id &&
            (existing as any).destinationCashboxId === destination.id &&
            Number((existing as any).transferAmount) === amount &&
            existing.date === input.date;
          if (!sameOperation) {
            throw new Error('IDEMPOTENCY_CONFLICT: معرّف العملية مستخدم مسبقاً لبيانات تحويل مختلفة.');
          }
          return { transactionUuid: input.transactionUuid, journalId, alreadyProcessed: true };
        }

        // Cash is an asset with a debit-normal balance. Never post a transfer
        // that would drive the source cashbox below zero.
        const sourceBalance = Number(sourceAccount.balance);
        if (!Number.isFinite(sourceBalance) || sourceBalance + 0.000001 < amount) {
          throw new Error('رصيد صندوق المصدر غير كافٍ لإتمام التحويل.');
        }

        const now = new Date().toISOString();
        const lines: JournalLine[] = [
          {
            id: `${journalId}-L1`, lineId: `${journalId}-L1`, entryId: journalId,
            accountId: destinationAccount.id, accountCode: destinationAccount.code,
            accountName: destinationAccount.name, debit: amount, credit: 0,
            type: 'DEBIT', amount, description: input.notes || 'تحويل وارد بين الصناديق'
          },
          {
            id: `${journalId}-L2`, lineId: `${journalId}-L2`, entryId: journalId,
            accountId: sourceAccount.id, accountCode: sourceAccount.code,
            accountName: sourceAccount.name, debit: 0, credit: amount,
            type: 'CREDIT', amount, description: input.notes || 'تحويل صادر بين الصناديق'
          }
        ];

        const entry: AccountingEntry = {
          id: journalId,
          date: input.date,
          description: input.notes?.trim() || `تحويل داخلي من ${source.name} إلى ${destination.name}`,
          referenceId: input.transactionUuid,
          sourceId: input.transactionUuid,
          sourceType: 'CASHBOX_TRANSFER',
          status: 'Posted',
          tenantId: input.tenantId,
          branchId: input.branchId,
          createdAt: now,
          lines,
          ...( {
            transactionUuid: input.transactionUuid,
            sourceCashboxId: source.id,
            destinationCashboxId: destination.id,
            transferAmount: amount
          } as any)
        };

        assertActiveSession();
        await AccountingRepository.addEntry(entry, tx, assertActiveSession);
        return { transactionUuid: input.transactionUuid, journalId, alreadyProcessed: false };
      }
    );
  }
}

export const cashboxTransferWorkflow = new CashboxTransferWorkflow();
