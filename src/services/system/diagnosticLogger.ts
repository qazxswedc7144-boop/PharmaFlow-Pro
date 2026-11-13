import { TokenProvider } from '@/services/auth/tokenProvider';

export interface DiagnosticLogInput {
  operation: string;
  tenantId?: string;
  userId?: string;
  context?: Record<string, unknown>;
}

export interface DiagnosticLogRecord {
  id: string;
  timestamp: string;
  operation: string;
  errorName: string;
  errorMessage: string;
  errorStack: string;
  context: Record<string, unknown>;
  tenantId: string;
}

const RETENTION_LIMIT = 50;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_STACK_LENGTH = 4000;

function getErrorDetails(error: unknown) {
  const value = error as any;
  return {
    errorName: String(value?.name || 'Error').slice(0, 120),
    errorMessage: String(value?.message || error || 'Unknown error').slice(0, MAX_MESSAGE_LENGTH),
    errorStack: String(value?.stack || '').slice(0, MAX_STACK_LENGTH)
  };
}

function createId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to a collision-resistant local identifier.
  }
  return `diag-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Best-effort local diagnostics. Logging must never replace or mask the
 * original business-operation error.
 */
export async function writeDiagnosticLog(
  database: any,
  error: unknown,
  input: DiagnosticLogInput
): Promise<void> {
  try {
    const session = TokenProvider.getCurrentSession();
    const user = session?.user as any;
    const tenantId = String(input.tenantId || session?.tenantId || user?.tenantId || user?.tenant_id || '').trim();
    if (!tenantId || !database?.diagnosticLogs) return;

    const userId = String(input.userId || user?.id || user?.user_id || '').trim();
    const details = getErrorDetails(error);
    const context = {
      ...(input.context || {}),
      tenantId,
      ...(userId ? { userId } : {})
    };
    const record: DiagnosticLogRecord = {
      id: createId(),
      timestamp: new Date().toISOString(),
      operation: String(input.operation || 'UNKNOWN').slice(0, 120),
      ...details,
      context,
      tenantId
    };

    const table = database.diagnosticLogs;
    await database.transaction('rw', table, async () => {
      await table.add(record);
      const tenantRows = await table.where('tenantId').equals(tenantId).sortBy('timestamp');
      if (tenantRows.length > RETENTION_LIMIT) {
        const expiredIds = tenantRows
          .slice(0, tenantRows.length - RETENTION_LIMIT)
          .map((row: DiagnosticLogRecord) => row.id);
        await table.bulkDelete(expiredIds);
      }
    });
  } catch (loggingError) {
    // Deliberately swallow only the diagnostic write failure; preserve caller error.
    console.warn('[DiagnosticLogger] Could not persist diagnostic record:', loggingError);
  }
}

export async function readDiagnosticLogs(
  database: any,
  tenantId: string,
  limit = RETENTION_LIMIT
): Promise<DiagnosticLogRecord[]> {
  if (!tenantId || !database?.diagnosticLogs) return [];
  const boundedLimit = Math.max(1, Math.min(RETENTION_LIMIT, Math.floor(limit)));
  const rows = await database.diagnosticLogs
    .where('tenantId')
    .equals(tenantId)
    .sortBy('timestamp');
  return rows.slice(-boundedLimit).reverse();
}
