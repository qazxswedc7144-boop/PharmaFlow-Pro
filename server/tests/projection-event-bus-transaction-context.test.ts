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

  it('does not process or persist an event when the ambient business transaction rolls back', async () => {
    const projectSpy = vi.spyOn(ReportProjector, 'project').mockResolvedValue();
    const queueErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let eventId: number | undefined;

    await expect(
      db.transaction('rw', db.projectionEvents, async () => {
        await ProjectionEventBus.publish('TEST_ROLLBACK_BOUNDARY', 'AGGREGATE-ROLLBACK', {
          test: true
        });

        const pending = await db.projectionEvents.orderBy('id').last();
        eventId = pending?.id;
        expect(pending?.status).toBe('PENDING');

        throw new Error('force business transaction rollback');
      })
    ).rejects.toThrow('force business transaction rollback');

    expect(eventId).toBeTypeOf('number');
    expect(await db.projectionEvents.get(eventId!)).toBeUndefined();
    expect(await db.projectionCheckpoints.get('report-projector')).toBeUndefined();
    expect(projectSpy).not.toHaveBeenCalled();
    expect(queueErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[ProjectionEventBus] Global queue processing failure'),
      expect.anything()
    );
  });

  it('fails closed when an ambient transaction cannot write the projection event store', async () => {
    const queueErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      db.transaction('rw', db.projectionCheckpoints, async () => {
        await ProjectionEventBus.publish('TEST_MISSING_STORE', 'AGGREGATE-MISSING-STORE', {
          test: true
        });
      })
    ).rejects.toThrow();

    expect(await db.projectionEvents.count()).toBe(0);
    expect(await db.projectionCheckpoints.count()).toBe(0);
    expect(queueErrorSpy).toHaveBeenCalledWith(
      '[ProjectionEventBus] Failed to publish projection event:',
      expect.anything()
    );
  });
});
