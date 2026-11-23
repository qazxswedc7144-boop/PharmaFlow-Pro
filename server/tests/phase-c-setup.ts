import { vi } from 'vitest';
import { TokenProvider } from '@/services/auth/tokenProvider';

// Phase C only: replace HTTP boundaries required by in-memory workflow tests.
// No production transport, authorization, accounting, or inventory code is mocked.
const originalFetch = globalThis.fetch.bind(globalThis);

vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const requestUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  const pathname = requestUrl.startsWith('http')
    ? new URL(requestUrl).pathname
    : requestUrl.split('?')[0];
  const headers = new Headers(init?.headers);
  const session = TokenProvider.getCurrentSession();
  const tenantId = headers.get('X-Tenant-ID') || headers.get('x-tenant-id') || session.tenantId || '';
  const branchId = headers.get('X-Branch-ID') || headers.get('x-branch-id') || session.branchId || '';

  if (pathname === '/api/accounting/periods') {
    const scopedTenant = tenantId || 'anonymous';
    const periodId = `phase-c-open-period-${scopedTenant.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    return new Response(JSON.stringify({
      success: true,
      periods: [{
        id: periodId,
        clientId: periodId,
        startDate: '2000-01-01T00:00:00.000Z',
        endDate: '2100-12-31T23:59:59.999Z',
        isLocked: false,
        lockedBy: null,
        lockedAt: null
      }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (pathname === '/api/auth/branch-context') {
    if (!tenantId || !branchId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'TRUSTED_BRANCH_CONTEXT_REQUIRED'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      success: true,
      data: {
        id: branchId,
        code: branchId,
        name: 'Phase C Test Branch',
        tenantId,
        isActive: true
      },
      contextCorrected: false
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (pathname === '/api/invoices/sales-policy') {
    if (!session.isAuthenticated || !session.token || !session.tenantId) {
      return new Response(JSON.stringify({ success: false, error: 'TENANT_REQUIRED' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      success: true,
      policy: {
        tenantId: session.tenantId,
        maxDiscountPercent: '100',
        taxRatePercent: '0',
        taxMode: 'NONE',
        updatedAt: '2026-11-23T00:00:00.000Z'
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Do not let an unconfigured relative API call hang on network retries.
  if (pathname.startsWith('/api/')) {
    throw new Error(`Unexpected API request in Phase C test harness: ${pathname}`);
  }

  return originalFetch(input, init);
});
