import { db, getCurrentUserSession } from '@/core/db';
import { unifiedTransport } from '@/shared/network/transport/unifiedTransport';
import { AccountingPeriod } from '@/types';

type ServerAccountingPeriod = {
  id: string;
  clientId: string;
  startDate: string;
  endDate: string;
  isLocked: boolean;
  lockedBy?: string | null;
  lockedAt?: string | null;
};

type PeriodsResponse = {
  success: boolean;
  periods: ServerAccountingPeriod[];
};

const CACHE_TTL_MS = 2000;

export class AccountingPeriodSyncService {
  private static cache: {
    tenantId: string;
    expiresAt: number;
    periods: AccountingPeriod[];
  } | null = null;

  static invalidate(tenantId?: string): void {
    if (!tenantId || this.cache?.tenantId === tenantId) this.cache = null;
  }

  private static getTenantId(): string {
    const tenantId = getCurrentUserSession().tenantId?.trim();
    if (!tenantId) throw new Error('TRUSTED_TENANT_CONTEXT_REQUIRED: Accounting periods require an active tenant.');
    return tenantId;
  }

  private static async fetchServerPeriods(): Promise<ServerAccountingPeriod[]> {
    const response = await unifiedTransport.get<PeriodsResponse>('/api/accounting/periods', {
      profile: 'FINANCIAL',
      retries: 1,
    });
    if (!response?.success || !Array.isArray(response.periods)) {
      throw new Error('ACCOUNTING_PERIOD_RESPONSE_INVALID: The server did not return an authoritative period list.');
    }
    return response.periods;
  }

  private static toLocalPeriod(period: ServerAccountingPeriod, tenantId: string): AccountingPeriod {
    return {
      id: period.clientId,
      tenantId,
      Start_Date: period.startDate,
      End_Date: period.endDate,
      Is_Locked: period.isLocked,
      Locked_By: period.lockedBy || undefined,
      Locked_At: period.lockedAt || undefined,
      lastModified: period.lockedAt || new Date().toISOString(),
    } as AccountingPeriod;
  }

  private static async hydrateLocalCache(
    periods: ServerAccountingPeriod[],
    tenantId: string
  ): Promise<AccountingPeriod[]> {
    const localPeriods = periods.map((period) => this.toLocalPeriod(period, tenantId));
    await db.transaction('rw', db.accountingPeriods, async () => {
      const existing = await db.accountingPeriods.where('tenantId').equals(tenantId).toArray();
      const retainedIds = new Set(localPeriods.map((period) => period.id));
      const staleIds = existing
        .filter((period) => !retainedIds.has(period.id))
        .map((period) => period.id);
      if (staleIds.length) await db.accountingPeriods.bulkDelete(staleIds);
      if (localPeriods.length) await db.accountingPeriods.bulkPut(localPeriods);
    });
    return localPeriods;
  }

  private static async bootstrapFromTenantLocalPeriods(
    tenantId: string
  ): Promise<ServerAccountingPeriod[]> {
    const local = await db.getAccountingPeriods();
    const tenantPeriods = local.filter((period) => period.tenantId === tenantId);
    if (!tenantPeriods.length) {
      throw new Error('ACCOUNTING_PERIOD_NOT_CONFIGURED: No tenant-owned local accounting periods are available for initial synchronization.');
    }

    const payload = tenantPeriods.map((period) => {
      const clientId = String(period.id || '').trim();
      const legacy = period as any;
      const startDate = String(period.Start_Date || period.startDate || legacy.start_date || '').trim();
      const endDate = String(period.End_Date || period.endDate || legacy.end_date || '').trim();
      const start = new Date(startDate);
      const end = new Date(endDate);
      if (!clientId || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) {
        throw new Error('ACCOUNTING_PERIOD_LOCAL_DATA_INVALID: A local accounting period has an invalid ID or date range.');
      }
      return {
        clientId,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        isLocked: period.Is_Locked === true || period.isLocked === true || legacy.is_locked === true,
      };
    });

    try {
      await unifiedTransport.post('/api/accounting/periods/bootstrap', { periods: payload }, {
        profile: 'FINANCIAL',
        retries: 0,
      });
    } catch (error: any) {
      // Another administrator/device may have completed the one-time bootstrap.
      // Re-read canonical server state only for the expected already-initialized conflict.
      if (error?.status !== 409) throw error;
    }
    return await this.fetchServerPeriods();
  }

  static async getPeriods(options: { forceRefresh?: boolean } = {}): Promise<AccountingPeriod[]> {
    const tenantId = this.getTenantId();
    if (!options.forceRefresh && this.cache?.tenantId === tenantId && this.cache.expiresAt > Date.now()) {
      return this.cache.periods;
    }

    // No offline fallback: a stale local "open" flag cannot authorize a financial
    // operation when the authoritative server lock state cannot be verified.
    let periods = await this.fetchServerPeriods();
    if (periods.length === 0) {
      periods = await this.bootstrapFromTenantLocalPeriods(tenantId);
    }
    if (periods.length === 0) {
      throw new Error('ACCOUNTING_PERIOD_NOT_CONFIGURED: The tenant has no authoritative accounting period.');
    }

    const localPeriods = await this.hydrateLocalCache(periods, tenantId);
    this.cache = {
      tenantId,
      periods: localPeriods,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    return localPeriods;
  }

  static async createPeriod(startDate: string, endDate: string): Promise<string> {
    const tenantId = this.getTenantId();
    const clientId = db.generateId('PER');
    await unifiedTransport.post('/api/accounting/periods', {
      clientId,
      startDate: new Date(startDate).toISOString(),
      endDate: new Date(endDate).toISOString(),
      isLocked: false,
    }, { profile: 'FINANCIAL' });
    this.invalidate(tenantId);
    await this.getPeriods({ forceRefresh: true });
    return clientId;
  }

  static async setLocked(clientId: string, isLocked: boolean): Promise<void> {
    const tenantId = this.getTenantId();
    if (!clientId?.trim()) throw new Error('ACCOUNTING_PERIOD_ID_REQUIRED');
    await unifiedTransport.patch(
      `/api/accounting/periods/${encodeURIComponent(clientId)}/${isLocked ? 'lock' : 'unlock'}`,
      {},
      { profile: 'FINANCIAL' }
    );
    this.invalidate(tenantId);
    await this.getPeriods({ forceRefresh: true });
  }
}
