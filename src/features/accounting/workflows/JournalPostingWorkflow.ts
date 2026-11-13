import { BusinessWorkflow, SyncContract, WorkflowContext } from '@/core/workflow';
import { db } from '@/core/db';
import { AccountingEntry, JournalLine } from '@/types';
import { PeriodLockEngine } from '@/services/transactions/PeriodLockEngine';
import { integrityVerifier } from '@/services/integrity/integrityVerifier';

export interface JournalPostingInput {
  date: string;
  description: string;
  reference?: string;
  lines: Array<{
    accountId: string;
    accountCode?: string;
    accountName?: string;
    debit: number;
    credit: number;
    memo?: string;
  }>;
}

export interface JournalPostingResult {
  journalId: string;
  entry: AccountingEntry;
}

export class JournalPostingWorkflow implements BusinessWorkflow<JournalPostingInput, JournalPostingResult> {
  public id = 'accounting.journal.post';
  public name = 'ترحيل قيد محاسبي يدوي';
  public operationType = 'JOURNAL_POSTING';
  /** Documentation-only sync metadata; not consumed by the execution pipeline in V-30A. */
  public syncContract: SyncContract = {
    entityType: 'JOURNAL_ENTRY',
    operation: 'CREATE',
    buildPayload: (result) => result as Record<string, unknown>
  };
  public requiredPermissions = ['accounting.journal.create', 'accounting.post'];
  public tables = [
    'journalEntries', 'journalLines', 'accounts', 'auditLogs',
    'idempotencyKeys', 'projectionEvents'
  ];

  public async validateInput(input: JournalPostingInput): Promise<void> {
    if (!input.lines || input.lines.length < 2) {
      throw new Error('القيد المحاسبي يجب أن يحتوي على طرفين على الأقل (مدين ودائن)');
    }

    let totalDebit = 0;
    let totalCredit = 0;

    for (const line of input.lines) {
      if (!line.accountId) {
        throw new Error('جميع أطراف القيد المحاسبي يجب أن تحوي حُساباً محدداً');
      }
      totalDebit += Number(line.debit || 0);
      totalCredit += Number(line.credit || 0);
    }

    // Strict Debit = Credit Validation
    const diff = Math.abs(totalDebit - totalCredit);
    if (diff > 0.001) {
      throw new Error(
        `القيد غير متزن محاسبياً! مجموع المدين: ${totalDebit.toFixed(2)} ≠ مجموع الدائن: ${totalCredit.toFixed(2)}`
      );
    }
  }

  public async validateBusinessRules(input: JournalPostingInput): Promise<void> {
    await PeriodLockEngine.validateOperation(input.date, 'ترحيل قيد يدوي');
  }

  public async executeDomainSteps(
    input: JournalPostingInput,
    ctx: WorkflowContext
  ): Promise<JournalPostingResult> {
    const journalId = db.generateId('JE');

    const mappedLines: JournalLine[] = input.lines.map((l, index) => {
      const debit = Number(l.debit || 0);
      const credit = Number(l.credit || 0);
      return {
        id: `${journalId}-L${index + 1}`,
        lineId: `${journalId}-L${index + 1}`,
        entryId: journalId,
        accountId: l.accountId,
        accountCode: l.accountCode || l.accountId,
        accountName: l.accountName || '',
        debit,
        credit,
        type: debit >= credit ? 'DEBIT' : 'CREDIT',
        amount: Math.max(debit, credit),
        description: l.memo || input.description
      };
    });

    const entry: AccountingEntry = {
      id: journalId,
      date: input.date,
      description: input.description,
      referenceId: input.reference || ctx.idempotencyKey,
      sourceId: input.reference || ctx.idempotencyKey || journalId,
      sourceType: 'JOURNAL_WORKFLOW',
      status: 'Posted',
      lines: mappedLines,
      createdAt: new Date().toISOString()
    };

    const signedEntry = await integrityVerifier.signEntry(entry);
    await db.saveAccountingEntry(signedEntry);

    // Update account balances
    for (const line of signedEntry.lines) {
      const netChange = line.debit - line.credit;
      await db.updateAccountBalance(line.accountId, netChange);
    }

    return {
      journalId,
      entry: signedEntry
    };
  }
}

export const journalPostingWorkflow = new JournalPostingWorkflow();
