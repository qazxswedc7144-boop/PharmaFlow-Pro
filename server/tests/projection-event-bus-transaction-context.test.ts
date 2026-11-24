import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/core/db';
import {
  ProjectionEventBus,
  ReportProjector
} from '@/services/system/ProjectionEventBus';

describe('ProjectionEventBus Dexie transaction boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits for an ambient business transaction to commit and processes outside its table scope', async () => {
    await db.projectionEvents.clear();
    await db.projectionCheckpoints.clear();

    const projectSpy = vi.spyOn(ReportProjector, 'project').mockResolvedValue();
    const queueErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let eventId: number | undefined;

    // Deliberately include only projectionEvents. The real voucher workflow
    // writes this store but does not include projectionCheckpoints in its scope.
    await db.transaction('rw', db.projectionEvents, async () => {
      await ProjectionEventBus.publish('TEST_TRANSACTION_BOUNDARY', 'AGGREGATE-1', {
        test: true
      });

      const pending = await db.projectionEvents.orderBy('id').last();
      eventId = pending?.id;

      expect(pending?.status).toBe('PENDING');
      expect(projectSpy).not.toHaveBeenCalled();
    });

    expect(eventId).toBeTypeOf('number');

    await vi.waitFor(async () => {
      const processed = await db.projectionEvents.get(eventId!);
      expect(processed?.status).toBe('PROCESSED');
    }, { timeout: 3000 });

    expect(projectSpy).toHaveBeenCalledTimes(1);
    expect(queueErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[ProjectionEventBus] Global queue processing failure'),
      expect.anything()
    );

    const checkpoint = await db.projectionCheckpoints.get('report-projector');
    expect(checkpoint?.sequence).toBe(eventId);
  });
});
