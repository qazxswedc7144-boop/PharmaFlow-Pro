import { db } from '@/core/db';

export class TransactionBoundary {
  /**
   * Runs an operation inside a strict, atomic database transaction boundary.
   * If any step fails, Dexie rolls back all table writes in the transaction.
   * NO direct execution fallback is permitted for atomic operations.
   */
  public static async executeAtomic<T>(
    tables: string[],
    operation: (tx: any) => Promise<T>
  ): Promise<T> {
    const existingNames: string[] =
      typeof (db as any).getExistingTableNames === 'function'
        ? (db as any).getExistingTableNames()
        : (db.tables || []).map((t: any) => t.name);

    // FIX 1: صحيحة الفلترة بدون إعادة إضافة الجداول
    const validTables = tables.filter((t) => existingNames.includes(t));

    if (validTables.length === 0) {
      throw new Error(
        '[TransactionBoundary] No valid transaction tables found in schema scope.'
      );
    }

    // FIX 2: لا يوجد fallback — التنفيذ الحصري عبر Transaction
    return await (db as any).safeTransaction('rw', validTables, async (tx: any) => {
      return await operation(tx);
    });
  }
}
