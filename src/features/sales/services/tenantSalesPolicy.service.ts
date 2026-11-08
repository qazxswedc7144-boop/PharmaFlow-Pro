import { db } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import type { LocalSalesPolicy } from './localSalesPricing.service';

export interface CachedTenantSalesPolicy extends LocalSalesPolicy {
  cachedAt: string;
}

export const TenantSalesPolicyService = {
  async refresh(tenantId: string): Promise<CachedTenantSalesPolicy> {
    const session = TokenProvider.getCurrentSession();
    if (!session.isAuthenticated || !session.token || session.tenantId !== tenantId) {
      throw new Error('SALES_POLICY_AUTH_CONTEXT_MISMATCH');
    }

    const response = await fetch('/api/invoices/sales-policy', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${session.token}`,
        Accept: 'application/json'
      },
      credentials: 'same-origin'
    });

    if (!response.ok) {
      throw new Error(`SALES_POLICY_FETCH_FAILED:${response.status}`);
    }

    const payload = await response.json();
    const policy = payload?.policy;
    if (!payload?.success || !policy || policy.tenantId !== tenantId) {
      throw new Error('SALES_POLICY_RESPONSE_INVALID');
    }

    const cached: CachedTenantSalesPolicy = {
      tenantId,
      maxDiscountPercent: String(policy.maxDiscountPercent ?? '0'),
      taxRatePercent: String(policy.taxRatePercent ?? '0'),
      taxMode: policy.taxMode,
      updatedAt: String(policy.updatedAt || new Date().toISOString()),
      cachedAt: new Date().toISOString()
    };

    if (!['NONE', 'EXCLUSIVE', 'INCLUSIVE'].includes(cached.taxMode)) {
      throw new Error('SALES_POLICY_RESPONSE_INVALID');
    }

    await db.tenantSalesPolicies.put(cached);
    return cached;
  },

  async getForTenant(tenantId: string): Promise<CachedTenantSalesPolicy> {
    if (!tenantId) throw new Error('TRUSTED_TENANT_CONTEXT_REQUIRED');

    const cached = await db.tenantSalesPolicies.get(tenantId);
    const isOnline = typeof navigator !== 'undefined' && navigator.onLine !== false;

    if (isOnline) {
      try {
        return await this.refresh(tenantId);
      } catch (error) {
        if (cached) return cached;
        throw error;
      }
    }

    if (cached && cached.tenantId === tenantId) return cached;
    throw new Error('SALES_POLICY_UNAVAILABLE_OFFLINE');
  }
};
