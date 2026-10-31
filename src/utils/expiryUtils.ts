/**
 * Expiry Date Utilities for Pharmaceutical Inventory
 * Handles normalization, display formatting, and status calculations (expired / near expiry)
 */

export const normalizeToISODate = (dateStr?: string | null): string => {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const clean = dateStr.trim().replace(/\s+/g, '');
  if (!clean) return '';

  // Pattern 1: YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  const m1 = clean.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m1 && m1[1] && m1[2] && m1[3]) {
    const year = m1[1];
    const month = m1[2].padStart(2, '0');
    const day = m1[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // Pattern 2: DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY
  const m2 = clean.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m2 && m2[1] && m2[2] && m2[3]) {
    const year = m2[3];
    const month = m2[2].padStart(2, '0');
    const day = m2[1].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // Pattern 3: MM/YYYY or MM-YYYY or MM.YYYY
  const m3 = clean.match(/^(\d{1,2})[-/.](\d{4})$/);
  if (m3 && m3[1] && m3[2]) {
    const year = m3[2];
    const month = m3[1].padStart(2, '0');
    return `${year}-${month}-01`;
  }

  // Pattern 4: YYYY/MM or YYYY-MM or YYYY.MM
  const m4 = clean.match(/^(\d{4})[-/.](\d{1,2})$/);
  if (m4 && m4[1] && m4[2]) {
    const year = m4[1];
    const month = m4[2].padStart(2, '0');
    return `${year}-${month}-01`;
  }

  // Fallback: Check if Date parseable
  const d = new Date(clean);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  return clean;
};

export const formatExpiryDateDisplay = (dateStr?: string | null): string => {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const iso = normalizeToISODate(dateStr);
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length === 3) {
    return `${parts[0]}/${parts[1]}/${parts[2]}`;
  }
  return iso.replace(/-/g, '/');
};

export const formatDateDisplay = (dateStr: string): string => {
  if (!dateStr) return '';
  const parts = dateStr.includes('-') ? dateStr.split('-') : dateStr.split('/');
  if (parts.length === 3) {
    const year = parts[0] || '';
    const month = parseInt(parts[1] || '0', 10);
    const day = parseInt(parts[2] || '0', 10);
    return `${year}/${month}/${day}`;
  }
  return dateStr;
};

export interface ExpiryStatus {
  isExpired: boolean;
  isNearExpiry: boolean;
  label?: 'منتهي الصلاحية' | 'قريب الانتهاء';
}

export const getExpiryStatus = (expiryDate?: string | null): ExpiryStatus => {
  if (!expiryDate || typeof expiryDate !== 'string') {
    return { isExpired: false, isNearExpiry: false };
  }

  const iso = normalizeToISODate(expiryDate);
  if (!iso) return { isExpired: false, isNearExpiry: false };

  const parts = iso.split('-');
  if (parts.length !== 3) return { isExpired: false, isNearExpiry: false };

  const year = parseInt(parts[0] || '0', 10);
  const month = parseInt(parts[1] || '0', 10);
  const day = parseInt(parts[2] || '0', 10);

  const expiry = new Date(year, month - 1, day, 23, 59, 59, 999);
  if (isNaN(expiry.getTime())) {
    return { isExpired: false, isNearExpiry: false };
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  if (expiry < now) {
    return { isExpired: true, isNearExpiry: false, label: 'منتهي الصلاحية' };
  }

  const sixMonthsFromNow = new Date();
  sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);
  sixMonthsFromNow.setHours(23, 59, 59, 999);

  if (expiry <= sixMonthsFromNow) {
    return { isExpired: false, isNearExpiry: true, label: 'قريب الانتهاء' };
  }

  return { isExpired: false, isNearExpiry: false };
};

export const isValidExpiryDate = (dateStr?: string | null): boolean => {
  if (!dateStr || typeof dateStr !== 'string') return false;
  const iso = normalizeToISODate(dateStr);
  if (!iso) return false;
  const parts = iso.split('-');
  if (parts.length !== 3) return false;
  const year = parseInt(parts[0] || '0', 10);
  const month = parseInt(parts[1] || '0', 10);
  const day = parseInt(parts[2] || '0', 10);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  return true;
};
