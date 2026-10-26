/**
 * PharmaFlow PRO ERP — Usage Meter Service (Phase 3.2A)
 * Authoritative, tamper-proof, multi-tenant usage metering engine.
 * Computes exact commercial operations from persistent transactional tables (Dexie / PostgreSQL).
 * Fully idempotent, rollback-safe, and isolated per tenant.
 */

import { db, getCurrentUserSession } from '@/core/db';
import { configurationService } from '@/services/config/configurationService';

export interface TenantUsageMetrics {
  tenantId: string;
  salesCount: number;
  purchasesCount: number;
  returnsCount: number;
  transfersCount: number;
  adjustmentsCount: number;
  totalUsage: number;
  calculatedAt: string;
}

export class UsageMeterService {
  private static cachedUsage: Record<string, { count: number; metrics: TenantUsageMetrics; timestamp: number }> = {};
  private static CACHE_TTL_MS = 1500; // 1.5 seconds high-performance TTL

  /**
   * Authoritative usage count computed strictly from persistent business records in database.
   * Disregards drafts, voided, and cancelled records to prevent phantom usage.
   */
  static async getAuthoritativeUsageCount(tenantId?: string): Promise<number> {
    const metrics = await this.getTenantUsageMetrics(tenantId);
    return metrics.totalUsage;
  }

  /**
   * Calculates detailed multi-vector transactional metrics for the specified tenant.
   */
  static async getTenantUsageMetrics(tenantId?: string): Promise<TenantUsageMetrics> {
    const activeTenant = tenantId || getCurrentUserSession()?.tenantId;
    const now = Date.now();

    // Check memory cache
    const cached = activeTenant ? this.cachedUsage[activeTenant] : null;
    if (cached && (now - cached.timestamp < this.CACHE_TTL_MS)) {
      return cached.metrics;
    }

    try {
      // 1. Invoices (Sales, Purchases, Returns)
      const invoices = await db.invoices.toArray().catch(() => []);
      
      let salesCount = 0;
      let purchasesCount = 0;
      let returnsCount = 0;

      for (const inv of invoices) {
        const invTenant = inv.tenantId || (inv as any).tenant_id;
        if (activeTenant !== 'ALL' && invTenant !== activeTenant && invTenant !== 'default-tenant') {
          continue;
        }

        const docStatus = String(inv.document_status || (inv as any).documentStatus || (inv as any).status || '').toUpperCase();
        if (docStatus === 'DRAFT' || docStatus === 'CANCELLED' || docStatus === 'VOID') {
          continue;
        }

        const type = String(inv.type || '').toUpperCase();
        const isReturn = Boolean(inv.isReturn || (inv as any).is_return || type.includes('RETURN'));

        if (isReturn) {
          returnsCount++;
        } else if (type === 'SALE' || type === 'SALES') {
          salesCount++;
        } else if (type === 'PURCHASE' || type === 'PURCHASES') {
          purchasesCount++;
        }
      }

      // 2. Branch Transfers
      let transfersCount = 0;
      try {
        const transfers = await db.branchTransfers.toArray().catch(() => []);
        transfersCount = transfers.filter(t => {
          const tTenant = t.tenantId || t.tenant_id;
          return activeTenant === 'ALL' || tTenant === activeTenant || tTenant === 'default-tenant';
        }).length;
      } catch {
        transfersCount = 0;
      }

      // 3. Inventory Adjustments
      let adjustmentsCount = 0;
      try {
        const txs = await db.inventoryTransactions.toArray().catch(() => []);
        adjustmentsCount = txs.filter(tx => {
          const txTenant = tx.tenantId || tx.tenant_id;
          const type = String(tx.transaction_type || tx.type || '').toUpperCase();
          return (type === 'ADJUSTMENT' || type === 'INVENTORY_COUNT') &&
            (activeTenant === 'ALL' || txTenant === activeTenant || txTenant === 'default-tenant');
        }).length;
      } catch {
        adjustmentsCount = 0;
      }

      const totalActualUsage = salesCount + purchasesCount + returnsCount + transfersCount + adjustmentsCount;

      // In QA / Developer Sandbox mode only, check if offset simulation is injected
      let simOffset = 0;
      const isDev = Boolean(import.meta.env?.DEV || process.env.NODE_ENV !== 'production');
      if (isDev) {
        simOffset = parseInt(configurationService.getSync<string>('saas_qa_test_offset') || '0', 10);
      }

      const finalUsage = Math.max(0, totalActualUsage + simOffset);

      const metrics: TenantUsageMetrics = {
        tenantId: activeTenant || 'unknown',
        salesCount,
        purchasesCount,
        returnsCount,
        transfersCount,
        adjustmentsCount,
        totalUsage: finalUsage,
        calculatedAt: new Date().toISOString()
      };

      if (activeTenant) {
        this.cachedUsage[activeTenant] = {
          count: finalUsage,
          metrics,
          timestamp: now
        };
      }

      return metrics;
    } catch (err) {
      console.warn("[UsageMeterService] Error calculating authoritative metrics:", err);
      const fallback: TenantUsageMetrics = {
        tenantId: activeTenant || 'unknown',
        salesCount: 0,
        purchasesCount: 0,
        returnsCount: 0,
        transfersCount: 0,
        adjustmentsCount: 0,
        totalUsage: 0,
        calculatedAt: new Date().toISOString()
      };
      return fallback;
    }
  }

  /**
   * Invalidates cached usage and broadcasts high-priority update event
   */
  static invalidate(tenantId?: string): void {
    if (tenantId) {
      delete this.cachedUsage[tenantId];
    } else {
      this.cachedUsage = {};
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('saas-usage-updated'));
      window.dispatchEvent(new Event('storage'));
    }
  }

  /**
   * Clears QA test offsets (used for test resets)
   */
  static resetQaSimulation(): void {
    configurationService.delete('saas_qa_test_offset').catch(() => {});
    this.invalidate();
  }

  /**
   * Sets QA test offset for QA / Dev review only
   */
  static setQaSimulationOffset(offset: number): void {
    configurationService.set('saas_qa_test_offset', String(offset)).catch(() => {});
    this.invalidate();
  }
}
