import { describe, expect, it } from 'vitest';
import {
  getArchiveDateValue,
  getCurrentYearArchiveRange,
  isArchiveDateWithinRange,
  resolveArchiveDateRange,
  toArchiveDateKey
} from './archiveDateFilters';

describe('archive date filters', () => {
  it('uses the invoice date separately from the record creation date', () => {
    const invoice = {
      date: '2026-11-21',
      createdAt: '2026-11-26T08:30:00.000Z'
    };

    expect(getArchiveDateValue(invoice, 'DOCUMENT')).toBe('2026-11-21');
    expect(getArchiveDateValue(invoice, 'CREATED')).toBe('2026-11-26T08:30:00.000Z');
  });

  it('does not substitute the invoice date when the creation timestamp is absent', () => {
    expect(getArchiveDateValue({ date: '2026-11-21' }, 'CREATED')).toBeUndefined();
  });

  it('normalizes daily ranges inclusively', () => {
    expect(resolveArchiveDateRange({
      basis: 'DOCUMENT',
      granularity: 'DAY',
      start: '2026-04-05',
      end: '2026-04-19'
    })).toEqual({ start: '2026-04-05', end: '2026-04-19' });
  });

  it('expands monthly ranges to the complete first and last months', () => {
    expect(resolveArchiveDateRange({
      basis: 'DOCUMENT',
      granularity: 'MONTH',
      start: '2026-05',
      end: '2026-06'
    })).toEqual({ start: '2026-05-01', end: '2026-06-30' });
  });

  it('expands annual ranges to complete calendar years', () => {
    expect(resolveArchiveDateRange({
      basis: 'CREATED',
      granularity: 'YEAR',
      start: '2020',
      end: '2026'
    })).toEqual({ start: '2020-01-01', end: '2026-12-31' });
  });

  it('rejects reversed or incomplete ranges', () => {
    expect(resolveArchiveDateRange({
      basis: 'DOCUMENT',
      granularity: 'DAY',
      start: '2026-04-20',
      end: '2026-04-19'
    })).toBeNull();
    expect(resolveArchiveDateRange({
      basis: 'DOCUMENT',
      granularity: 'DAY',
      start: '',
      end: '2026-04-19'
    })).toBeNull();
  });

  it('includes both range boundaries and excludes dates outside the range', () => {
    const range = { start: '2026-04-05', end: '2026-04-19' };
    expect(isArchiveDateWithinRange('2026-04-05', range)).toBe(true);
    expect(isArchiveDateWithinRange('2026-04-19T23:59:59', range)).toBe(true);
    expect(isArchiveDateWithinRange('2026-04-20', range)).toBe(false);
  });

  it('uses the local current calendar year for the default archive range', () => {
    expect(getCurrentYearArchiveRange(new Date(2026, 10, 21))).toEqual({
      start: '2026-01-01',
      end: '2026-11-21'
    });
  });

  it('normalizes date strings without shifting the calendar day', () => {
    expect(toArchiveDateKey('2026/11/21')).toBe('2026-11-21');
  });
});
