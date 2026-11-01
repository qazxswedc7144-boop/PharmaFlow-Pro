
import { db } from '@/core/db';
import { FaultService } from '@/services/integrity/FaultService';

export class TransactionService {
  private static activeTransactions: Set<string> = new Set();
  private static processedUuids: Set<string> = new Set();

  /**
   * Begins a transaction for a specific resource ID.
   * Enforces resource isolation without causing global database lock starvation.
   */
  static async begin(resourceId: string): Promise<boolean> {
    if (this.activeTransactions.has(resourceId)) {
      console.warn(`[TransactionLock] Refusing begin for ${resourceId}: Resource active.`);
      return false;
    }
    
    this.activeTransactions.add(resourceId);
    return true;
  }

  /**
   * Commits a transaction.
   */
  static async commit(resourceId: string) {
    this.activeTransactions.delete(resourceId);
  }

  /**
   * Rolls back a transaction.
   */
  static async rollback(resourceId: string, error: any) {
    this.activeTransactions.delete(resourceId);
    FaultService.logTransactionFault('TRANSACTION_MANAGER', `Rollback triggered for ${resourceId}`, { resourceId }, error);
  }

  /**
   * Verifies if a transaction UUID is already processed to ensure idempotency.
   */
  static async ensureIdempotency(transactionUuid?: string): Promise<void> {
    if (!transactionUuid) return;

    // 1. Memory Check
    if (this.processedUuids.has(transactionUuid)) {
      throw new Error("⚠️ تم التقاط نقرة متكررة! هذه العملية قيد الحفظ أو تم حفظها بنجاح بالفعل.");
    }

    // 2. Persistent Database Lookups
    try {
      const existingInvoicesCount = await db.invoices.where('transactionUuid').equals(transactionUuid).count();
      if (existingInvoicesCount > 0) {
        throw new Error("⚠️ عملية مكررة! هذا المستند تم تسجيله وترحيله إلى الدفاتر بنجاح بالرمز التعريفي الفريد.");
      }
    } catch (e: any) {
      if (e?.message?.includes("عملية مكررة")) {
        throw e;
      }
      // Fail-safe: if tables not fully bound, memory check is enough
    }
  }

  /**
   * Registers a transaction UUID as successfully completed.
   */
  static registerCompletedUuid(transactionUuid?: string): void {
    if (transactionUuid) {
      this.processedUuids.add(transactionUuid);
    }
  }

  /**
   * Safe execution wrapper for critical operations.
   * Runs the operation within a scoped atomic Dexie transaction.
   * @param resourceId Resource key or document ID
   * @param operation Atomic operations sequence
   * @param transactionUuid Optional correlation ID for tracing
   * @param tables Explicit array of table names to lock (prevents locking entire DB)
   */
  static async runSafe<T>(
    resourceId: string, 
    operation: (tx?: any) => Promise<T>, 
    transactionUuid?: string,
    tables?: string[]
  ): Promise<T> {
    // Register correlation ID if present
    if (transactionUuid) {
      await this.ensureIdempotency(transactionUuid);
    }

    // If we are already inside an active Dexie transaction or if this resource is active in nested execution, reuse context
    if ((db.db as any)?.currentTransaction || this.activeTransactions.has(resourceId)) {
      return await db.runTransaction(async (tx) => {
        const result = await operation(tx);
        if (transactionUuid) {
          this.registerCompletedUuid(transactionUuid);
        }
        return result;
      }, tables, 'rw');
    }

    const started = await this.begin(resourceId);
    if (!started) {
      throw new Error("⚠️ العملية قيد المعالجة حالياً من قِبل نظام الأمان، يرجى الانتظار... ⏳");
    }

    try {
      const result = await db.runTransaction(async (tx) => {
        const res = await operation(tx);
        if (transactionUuid) {
          this.registerCompletedUuid(transactionUuid);
        }
        return res;
      }, tables, 'rw');
      await this.commit(resourceId);
      return result;
    } catch (error) {
      await this.rollback(resourceId, { error, transactionUuid });
      throw error;
    }
  }
}
