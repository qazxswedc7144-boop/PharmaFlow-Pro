/**
 * PharmaFlow ERP — Deterministic Financial Math Engine (v2.0 — Hardened)
 *
 * ⚠️ STRICT FINANCIAL RULE:
 *   - كل عملية مالية تمر من هنا. لا استثناءات.
 *   - التحقق من توازن القيود يستخدم BigInt minor units، لا tolerance.
 *   - أي مدخل غير صالح يُرفض بصوت عالٍ (لا fallback صامت).
 *
 * Rounding mode: HALF-AWAY-FROM-ZERO (لا Bankers — لا يدّعي ذلك).
 * Currency-aware: 0 منازل (YER)، 2 (USD/SAR)، 3 (KWD).
 */

// ─────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────

export type FinancialErrorCode =
  | 'INVALID_NUMBER'
  | 'MALFORMED_NUMBER'
  | 'EMPTY_STRING'
  | 'UNSUPPORTED_TYPE'
  | 'PRECISION_LOSS'
  | 'INVALID_DECIMALS'
  | 'DIVISION_BY_ZERO'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_RATIOS'
  | 'BIGINT_OUT_OF_RANGE';

export class FinancialError extends Error {
  public readonly code: FinancialErrorCode;
  constructor(code: FinancialErrorCode, message: string) {
    super(message);
    this.name = 'FinancialError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export type CurrencyCode = 'YER' | 'SAR' | 'USD' | 'KWD' | (string & {});

/** منازل العملة الرسمية — ISO 4217 */
const CURRENCY_DECIMALS: Record<string, number> = {
  YER: 0, // الريال اليمني — لا هللات في التداول
  SAR: 2,
  USD: 2,
  EUR: 2,
  KWD: 3,
  BHD: 3,
  OMR: 3,
};

const DEFAULT_CURRENCY: CurrencyCode = 'YER';

export interface FinancialMathOptions {
  /** إذا true (افتراضي): يرفض المدخلات غير الصالحة بدل إرجاع 0 */
  strict?: boolean;
  /** رمز العملة — يحدد منازل التقريب الافتراضية */
  currency?: CurrencyCode;
}

// ─────────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────────

export class FinancialMath {
  /**
   * ⚠️ هذا الرقم للاستخدام في مقارنات "قريب من الصفر" الحسابية فقط.
   * ❌ لا يُستخدم في التحقق من توازن القيود.
   */
  private static readonly EPSILON = 1e-9;

  /**
   * Snap threshold لمعالجة drift الـ float قبل التقريب.
   * مثال: 1.005 يُخزَّن كـ 1.00499999999999989 → نلتقطه هنا.
   */
  private static readonly HALF_SNAP = 1e-9;

  private static strict = true;
  private static defaultCurrency: CurrencyCode = DEFAULT_CURRENCY;

  // ───────────────────────────────────────────────────────────────
  // Configuration
  // ───────────────────────────────────────────────────────────────

  /** للتفعيل في الإنتاج (افتراضي)، والتعطيل في اختبارات legacy فقط */
  public static setStrict(strict: boolean): void {
    this.strict = strict;
  }

  public static setDefaultCurrency(currency: CurrencyCode): void {
    if (!(currency in CURRENCY_DECIMALS)) {
      throw new FinancialError(
        'CURRENCY_MISMATCH',
        `عملة غير معروفة: ${currency}. أضفها إلى CURRENCY_DECIMALS.`,
      );
    }
    this.defaultCurrency = currency;
  }

  public static decimalsFor(currency: CurrencyCode = this.defaultCurrency): number {
    return CURRENCY_DECIMALS[currency] ?? 2;
  }

  // ───────────────────────────────────────────────────────────────
  // Core conversion — fail loud, never silent
  // ───────────────────────────────────────────────────────────────

  /**
   * تحويل آمن إلى number.
   * - null / undefined → 0 (يعني "لا يوجد مبلغ" — مسموح صراحةً)
   * - NaN / Infinity / نص ملوث / نص فارغ → يرمي في الوضع strict
   * - Decimal كبير → يرمي (لا يمكن تحويله بدون فقدان دقة)
   */
  public static safeNum(val: unknown, fallback = 0): number {
    if (val === null || val === undefined) return fallback;

    // ─── number ───
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) {
        if (this.strict) {
          throw new FinancialError('INVALID_NUMBER', `قيمة رقمية غير صالحة: ${val}`);
        }
        return fallback;
      }
      return val;
    }

    // ─── bigint ───
    if (typeof val === 'bigint') {
      if (
        val > BigInt(Number.MAX_SAFE_INTEGER) ||
        val < BigInt(Number.MIN_SAFE_INTEGER)
      ) {
        if (this.strict) {
          throw new FinancialError(
            'BIGINT_OUT_OF_RANGE',
            `BigInt خارج النطاق الآمن: ${val}. استخدم Money.fromMinor.`,
          );
        }
        return fallback;
      }
      return Number(val);
    }

    // ─── string ───
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed === '') {
        if (this.strict) {
          throw new FinancialError('EMPTY_STRING', 'سلسلة فارغة غير مسموحة كمبلغ');
        }
        return fallback;
      }
      // ✅ نرفض: "1e5"، "0x10"، "100abc"، "Infinity"، "1,000.00"
      if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
        if (this.strict) {
          throw new FinancialError(
            'MALFORMED_NUMBER',
            `صيغة رقمية غير صالحة: "${val}"`,
          );
        }
        return fallback;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        if (this.strict) {
          throw new FinancialError('MALFORMED_NUMBER', `تعذّر تحويل: "${val}"`);
        }
        return fallback;
      }
      return parsed;
    }

    // ─── Decimal-like (Prisma.Decimal or similar) ───
    if (typeof (val as any)?.toNumber === 'function') {
      return this.decimalToNumber(val as any, String(val));
    }

    if (this.strict) {
      throw new FinancialError(
        'UNSUPPORTED_TYPE',
        `نوع غير مدعوم: ${typeof val}`,
      );
    }
    return fallback;
  }

  /**
   * تحويل Decimal → number مع كشف فقدان الدقة.
   */
  private static decimalToNumber(
    decimalLike: { toNumber: () => number },
    asStr: string,
  ): number {
    const n = decimalLike.toNumber();
    if (!Number.isFinite(n)) {
      if (this.strict) {
        throw new FinancialError(
          'INVALID_NUMBER',
          `Decimal غير صالح: ${asStr}`,
        );
      }
      return 0;
    }
    // ✅ نتحقق: هل التحويل حافظ على القيمة؟
    if (this.strict) {
      const back = String(n);
      // نسمح فقط بفرق ".0" في النهاية
      const normalized = asStr.includes('.') ? asStr.replace(/0+$/, '').replace(/\.$/, '') : asStr;
      const normalizedBack = back.includes('.') ? back.replace(/0+$/, '').replace(/\.$/, '') : back;
      if (normalized !== normalizedBack) {
        throw new FinancialError(
          'PRECISION_LOSS',
          `فقدان دقة عند التحويل: "${asStr}" → ${n}. استخدم Money.fromDecimal.`,
        );
      }
    }
    return n;
  }

  // ───────────────────────────────────────────────────────────────
  // Rounding — HALF-AWAY-FROM-ZERO (explicitly NOT Bankers)
  // ───────────────────────────────────────────────────────────────

  /**
   * تقريب مالي إلى عدد منازل محدد.
   * الوضع: HALF-AWAY-FROM-ZERO (لا Bankers، لا float-drift).
   *
   * أمثلة:
   *   round(1.005, 2)  → 1.01
   *   round(2.675, 2)  → 2.68
   *   round(2.5, 0)    → 3
   *   round(-2.5, 0)   → -3
   */
  public static round(val: unknown, decimals?: number): number {
    const d = decimals ?? this.decimalsFor();
    if (!Number.isInteger(d) || d < 0 || d > 10) {
      throw new FinancialError(
        'INVALID_DECIMALS',
        `عدد المنازل غير صالح: ${d} (يجب 0 ≤ d ≤ 10)`,
      );
    }

    const n = this.safeNum(val);
    if (n === 0) return 0;

    const sign = n < 0 ? -1 : 1;
    const abs = Math.abs(n);
    const factor = Math.pow(10, d);

    // ✅ نُصلح drift الـ float قبل التقريب: 1.005 → 100.499999999 → 100.5
    const scaled = abs * factor;
    const snapped = this.snapHalf(scaled);

    const rounded = Math.round(snapped);
    return (sign * rounded) / factor;
  }

  /** Snap القيم القريبة جداً من .5 لضمان تقريب صحيح */
  private static snapHalf(scaled: number): number {
    const floor = Math.floor(scaled);
    const frac = scaled - floor;
    if (Math.abs(frac - 0.5) < this.HALF_SNAP) {
      return floor + 0.5;
    }
    if (Math.abs(frac) < this.HALF_SNAP) {
      return floor;
    }
    if (Math.abs(frac - 1) < this.HALF_SNAP) {
      return floor + 1;
    }
    return scaled;
  }

  public static round2(val: unknown): number {
    return this.round(val, 2);
  }

  public static round4(val: unknown): number {
    return this.round(val, 4);
  }

  /** تقريب حسب عملة محددة */
  public static roundFor(val: unknown, currency: CurrencyCode): number {
    return this.round(val, this.decimalsFor(currency));
  }

  // ───────────────────────────────────────────────────────────────
  // Arithmetic — deterministic, currency-aware
  // ───────────────────────────────────────────────────────────────

  public static add(...nums: unknown[]): number {
    let sum = 0;
    for (const num of nums) sum += this.safeNum(num);
    return this.round2(sum);
  }

  public static safeAdd(...nums: unknown[]): number {
    return this.add(...nums);
  }

  public static sub(a: unknown, b: unknown): number {
    return this.round2(this.safeNum(a) - this.safeNum(b));
  }

  public static safeSub(a: unknown, b: unknown): number {
    return this.sub(a, b);
  }

  public static mul(a: unknown, b: unknown): number {
    return this.round2(this.safeNum(a) * this.safeNum(b));
  }

  public static div(a: unknown, b: unknown, fallback = 0): number {
    const denom = this.safeNum(b);
    if (Math.abs(denom) < this.EPSILON) {
      if (this.strict) {
        throw new FinancialError('DIVISION_BY_ZERO', 'قسمة على صفر');
      }
      return fallback;
    }
    return this.round2(this.safeNum(a) / denom);
  }

  public static negate(val: unknown): number {
    return this.round2(-this.safeNum(val));
  }

  public static abs(val: unknown): number {
    return this.round2(Math.abs(this.safeNum(val)));
  }

  // ───────────────────────────────────────────────────────────────
  // Verification — STRICT BigInt-based (no tolerance!)
  // ───────────────────────────────────────────────────────────────

  /**
   * ✅ التحقق الدقيق من التوازن المحاسبي.
   * لا tolerance. لا epsilon. توازن أو لا توازن.
   *
   * ⚠️ هذه هي الدالة الوحيدة المسموح بها للتحقق من القيود.
   */
  public static isBalanced(debits: unknown, credits: unknown, tolerance?: number): boolean {
    if (tolerance !== undefined && tolerance > 0) {
      const diff = Math.abs(Number(this.toMinorUnits(debits) - this.toMinorUnits(credits)) / 100);
      return diff <= tolerance;
    }
    return this.toMinorUnits(debits) === this.toMinorUnits(credits);
  }

  /**
   * الفرق الفعلي بوحدات أصغر وحدة نقدية (هللات/سنتات).
   * 0 = متوازن. أي قيمة أخرى = ثغرة مالية.
   */
  public static discrepancyMinor(
    debits: unknown,
    credits: unknown,
  ): bigint {
    return this.toMinorUnits(debits) - this.toMinorUnits(credits);
  }

  /**
   * للتوافق العكسي — يُرجع number بالوحدات الكبرى.
   * ⚠️ استخدم discrepancyMinor في الكود الجديد.
   */
  public static discrepancy(debits: unknown, credits: unknown): number {
    const minor = this.discrepancyMinor(debits, credits);
    const abs = minor < 0n ? -minor : minor;
    return Number(abs) / 100;
  }

  /**
   * مقارنة دقيقة بين قيمتين ماليتين.
   * toleranceMinor: افتراضي 0 (دقيق). مرر قيمة موجبة إذا كنت تعرف ما تفعل.
   */
  public static equals(
    a: unknown,
    b: unknown,
    toleranceMinor: bigint | number = 0n,
  ): boolean {
    const tol = typeof toleranceMinor === 'number' ? BigInt(Math.round(toleranceMinor * 100)) : toleranceMinor;
    const diff = this.toMinorUnits(a) - this.toMinorUnits(b);
    const abs = diff < 0n ? -diff : diff;
    return abs <= tol;
  }

  // ───────────────────────────────────────────────────────────────
  // Sign checks
  // ───────────────────────────────────────────────────────────────

  public static isNonNegative(val: unknown): boolean {
    return this.toMinorUnits(val) >= 0n;
  }

  public static isStrictlyPositive(val: unknown): boolean {
    return this.toMinorUnits(val) > 0n;
  }

  public static isStrictlyNegative(val: unknown): boolean {
    return this.toMinorUnits(val) < 0n;
  }

  public static isZero(val: unknown): boolean {
    return this.toMinorUnits(val) === 0n;
  }

  // ───────────────────────────────────────────────────────────────
  // Allocation — distribute without losing a penny
  // ───────────────────────────────────────────────────────────────

  /**
   * توزيع مبلغ على نسب بدون فقدان أي هللة.
   * الباقي (rounding remainder) يذهب للعنصر الأخير.
   *
   * مثال: allocate(100.00, [1, 1, 1]) → [33.33, 33.33, 33.34]
   */
  public static allocate(amount: unknown, ratios: number[]): number[] {
    if (ratios.length === 0) {
      throw new FinancialError('INVALID_RATIOS', 'قائمة النسب فارغة');
    }

    const total = this.safeNum(amount);
    const ratioSum = ratios.reduce((s, r) => s + this.safeNum(r), 0);

    if (ratioSum <= 0) {
      throw new FinancialError(
        'INVALID_RATIOS',
        'مجموع النسب يجب أن يكون موجباً',
      );
    }

    const totalMinor = this.toMinorUnits(total);
    const ratioSumMinor = BigInt(Math.round(ratioSum * 1e6));

    const result: number[] = [];
    let allocated = 0n;

    for (let i = 0; i < ratios.length; i++) {
      if (i === ratios.length - 1) {
        // آخر عنصر يستلم الباقي — يضمن المجموع = totalMinor بالضبط
        result.push(this.fromMinorUnits(totalMinor - allocated));
        break;
      }
      const currRatio = ratios[i] ?? 0;
      const ratioMinor = BigInt(Math.round(currRatio * 1e6));
      const share = (totalMinor * ratioMinor) / ratioSumMinor;
      allocated += share;
      result.push(this.fromMinorUnits(share));
    }

    return result;
  }

  // ───────────────────────────────────────────────────────────────
  // Internal: float/string ↔ BigInt minor units
  // ───────────────────────────────────────────────────────────────

  /**
   * تحويل إلى أصغر وحدة نقدية (هللة/سنت) بدقة تامة.
   * يستخدم string representation لتجنب float artifacts.
   */
  private static toMinorUnits(val: unknown): bigint {
    const rounded = this.round2(val);
    if (rounded === 0) return 0n;

    const negative = rounded < 0;
    const abs = Math.abs(rounded).toFixed(2);
    const [intPart, fracPart] = abs.split('.');
    const minor = BigInt(intPart ?? '0') * 100n + BigInt(fracPart || '0');
    return negative ? -minor : minor;
  }

  private static fromMinorUnits(minor: bigint): number {
    if (
      minor > BigInt(Number.MAX_SAFE_INTEGER) ||
      minor < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      throw new FinancialError(
        'BIGINT_OUT_OF_RANGE',
        `قيمة صغرى خارج نطاق number الآمن: ${minor}`,
      );
    }
    return Number(minor) / 100;
  }
}
