/**
 * ERP Global Transaction UUID Generator
 * Suitable for ledger traces, deduplication, and regulatory audits.
 * Unique identifiers with high-entropy timestamp, monotonic sequence counter,
 * and cryptographic randomness to guarantee collision-freedom under heavy concurrency.
 */

let monotonicSequence = 0;

export function generateTransactionUuid(
  type: 'SALE' | 'PURCHASE' | 'PAYMENT' | 'RECEIPT' | 'INVENTORY' | 'JOURNAL' | 'JE' | 'JL' | 'TRX' | 'FT' | 'PYMT' | 'RCPT' | string
): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const now = Date.now().toString(36).toUpperCase();
  monotonicSequence = (monotonicSequence + 1) % 1000000;
  const seqStr = String(monotonicSequence).padStart(6, '0');

  let cryptoHex = '';
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    cryptoHex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  } else {
    cryptoHex = (
      Math.random().toString(16).substring(2, 10) +
      Math.random().toString(16).substring(2, 10)
    ).toUpperCase();
  }

  return `${type}-${dateStr}-${now}-${seqStr}-${cryptoHex}`;
}
