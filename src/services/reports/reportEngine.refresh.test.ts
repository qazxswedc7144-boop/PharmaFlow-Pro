import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportEngine } from './reportEngine';
import { reportCache } from '@features/reports/services/reportCacheService';

describe('ReportEngine background refresh', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('defers report cache refresh to a later event-loop turn', async () => {
    vi.useFakeTimers();
    const purge = vi.spyOn(reportCache, 'purge');
    reportEngine.scheduleRefresh();

    expect(purge).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(purge).toHaveBeenCalledTimes(1);
  });
});
