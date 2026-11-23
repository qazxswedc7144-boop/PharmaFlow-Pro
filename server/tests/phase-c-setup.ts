import { vi } from 'vitest';

// Phase C only: keep production transport untouched while supplying the authoritative
// open accounting-period response required by in-memory workflow tests.
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

  if (pathname === '/api/accounting/periods') {
    const tenantId = new Headers(init?.headers).get('X-Tenant-ID') || 'anonymous';
    const periodId = `phase-c-open-period-${tenantId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
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

  return originalFetch(input, init);
});
