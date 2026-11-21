export type ArchiveDateBasis = 'DOCUMENT' | 'CREATED';
export type ArchiveDateGranularity = 'DAY' | 'MONTH' | 'YEAR';

export interface ArchiveDateFilter {
  basis: ArchiveDateBasis;
  granularity: ArchiveDateGranularity;
  start: string;
  end: string;
}

export interface ArchiveDateRange {
  start: string;
  end: string;
}

const toDateKey = (year: number, month: number, day: number): string =>
  `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;

export const toArchiveDateKey = (value: unknown): string | null => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return toDateKey(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  if (typeof value === 'number') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return toDateKey(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
  }

  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const datePrefix = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text);
  if (datePrefix) {
    const year = Number(datePrefix[1]);
    const month = Number(datePrefix[2]);
    const day = Number(datePrefix[3]);
    const candidate = new Date(year, month - 1, day);
    if (
      candidate.getFullYear() !== year ||
      candidate.getMonth() !== month - 1 ||
      candidate.getDate() !== day
    ) return null;
    return toDateKey(year, month, day);
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return toDateKey(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
};

export const getArchiveDateValue = (
  invoice: Record<string, unknown>,
  basis: ArchiveDateBasis
): unknown => basis === 'CREATED'
  ? invoice.createdAt ?? invoice.created_at ?? invoice.Created_At
  : invoice.date ?? invoice.Date;

export const resolveArchiveDateRange = (
  filter: ArchiveDateFilter
): ArchiveDateRange | null => {
  if (!filter.start || !filter.end) return null;

  let start: string;
  let end: string;

  if (filter.granularity === 'DAY') {
    const startKey = toArchiveDateKey(filter.start);
    const endKey = toArchiveDateKey(filter.end);
    if (!startKey || !endKey) return null;
    start = startKey;
    end = endKey;
  } else if (filter.granularity === 'MONTH') {
    const startMatch = /^(\d{4})-(\d{2})$/.exec(filter.start);
    const endMatch = /^(\d{4})-(\d{2})$/.exec(filter.end);
    if (!startMatch || !endMatch) return null;
    const startYear = Number(startMatch[1]);
    const startMonth = Number(startMatch[2]);
    const endYear = Number(endMatch[1]);
    const endMonth = Number(endMatch[2]);
    if (startMonth < 1 || startMonth > 12 || endMonth < 1 || endMonth > 12) return null;
    start = toDateKey(startYear, startMonth, 1);
    end = toDateKey(endYear, endMonth, new Date(endYear, endMonth, 0).getDate());
  } else {
    if (!/^\d{4}$/.test(filter.start) || !/^\d{4}$/.test(filter.end)) return null;
    const startYear = Number(filter.start);
    const endYear = Number(filter.end);
    if (startYear < 1 || endYear < 1) return null;
    start = toDateKey(startYear, 1, 1);
    end = toDateKey(endYear, 12, 31);
  }

  return start <= end ? { start, end } : null;
};

export const getCurrentYearArchiveRange = (now: Date = new Date()): ArchiveDateRange => ({
  start: toDateKey(now.getFullYear(), 1, 1),
  end: toDateKey(now.getFullYear(), now.getMonth() + 1, now.getDate())
});

export const isArchiveDateWithinRange = (
  value: unknown,
  range: ArchiveDateRange
): boolean => {
  const dateKey = toArchiveDateKey(value);
  return Boolean(dateKey && dateKey >= range.start && dateKey <= range.end);
};
