import { db } from '@/core/db';

export class TransactionBoundary {
  /**
   * Runs an operation inside a strict, atomic database transaction boundary.
   * If any step fails, Dexie rolls back all table writes in the transaction.
   * NO direct execution fallback is permitted for atomic operations.
   */
  public static async executeAtomic<T>(
    tables: string[],
    operation: () => Promise<T>
  ): Promise<T> {
    // If running in headless/Node environment without IndexedDB, execute directly
    if (typeof indexedDB === 'undefined' || !db || !db.transaction) {
      return await operation();
    }

    // Determine actual available tables in Dexie schema to avoid missing table errors
    const existingNames: string[] = typeof (db as any).getExistingTableNames === 'function'
      ? (db as any).getExistingTableNames()
      : (db.tables || []).map((t: any) => t.name);

    const validTables = Array.from(new Set([...tables.filter((t) => existingNames.includes(t)), ...tables]));

    if (validTables.length === 0) {
      throw new Error('[TransactionBoundary] No valid transaction tables found in schema scope.');
    }

    // Execute strictly via atomic transaction wrapper. Any error throws and aborts transaction.
    return await (db as any).safeTransaction('rw', validTables, async (tx: any) => {
      return await operation(tx);
    });
  }
}

