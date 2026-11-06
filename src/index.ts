export type RoundingMode = 'floor' | 'ceil' | 'half-even' | 'half-up' | 'trunc';
export type LoanKind = 'level-payment' | 'equal-principal';

export interface LoanInput {
  /** Amount borrowed in the smallest currency unit (cents). */
  readonly principalCents: bigint | number;
  /** Nominal annual rate as a fraction: 0.06 or '0.06' means 6%. Finite, 0 to 10. */
  readonly annualRate: number | string;
  /** Number of payments, 1 to 1200. */
  readonly periods: number;
  /** Payments per year, 1 to 366. Defaults to 12. */
  readonly periodsPerYear?: number;
  /** Amount still owed after the last regular payment, paid with the final payment. */
  readonly balloonCents?: bigint | number;
  readonly kind?: LoanKind;
  /** Rounding for payment and per-period interest. Defaults to `half-even`. */
  readonly rounding?: RoundingMode;
  /** Label only; no conversion or minor-unit lookup is performed. */
  readonly currency?: string;
}

export interface LoanRow {
  readonly period: number;
  readonly paymentCents: bigint;
  readonly interestCents: bigint;
  readonly principalCents: bigint;
  readonly balanceCents: bigint;
}

export interface LoanSchedule {
  readonly currency: string | undefined;
  readonly kind: LoanKind;
  /** First scheduled payment (the level payment, or the first equal-principal payment). */
  readonly regularPaymentCents: bigint;
  /** Final payment minus the regular payment: rounding residue plus any balloon. */
  readonly finalAdjustmentCents: bigint;
  readonly totalPaymentCents: bigint;
  readonly totalInterestCents: bigint;
  readonly rows: readonly LoanRow[];
}

export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export type LoanErrorCode = 'invalid-input' | 'invalid-rate';

export class LoanError extends Error {
  readonly code: LoanErrorCode;
  constructor(code: LoanErrorCode, message: string) {
    super(message);
    this.name = 'LoanError';
    this.code = code;
  }
}

export const MAX_PERIODS = 1200;
export const MAX_RATE_FRACTION_DIGITS = 24;
const MAX_RATE = 10;
const MODES: readonly RoundingMode[] = ['floor', 'ceil', 'half-even', 'half-up', 'trunc'];

function divRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const negative = n < 0n;
  const away = negative ? q - 1n : q + 1n;
  const twice = (r < 0n ? -r : r) * 2n;
  switch (mode) {
    case 'trunc':
      return q;
    case 'floor':
      return negative ? away : q;
    case 'ceil':
      return negative ? q : away;
    case 'half-up':
      return twice >= d ? away : q;
    case 'half-even':
      return twice > d || (twice === d && q % 2n !== 0n) ? away : q;
  }
}

function cents(value: bigint | number, name: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new LoanError('invalid-input', `${name} must be a bigint or safe integer number of cents.`);
}

/**
 * Converts the shortest decimal form of a finite number (or a plain decimal string) to an exact
 * fraction. 0.06 becomes 6/100, not the nearest binary value.
 */
export function parseRate(rate: number | string): Rational {
  if (typeof rate === 'number' && !Number.isFinite(rate)) {
    throw new LoanError('invalid-rate', 'annualRate must be finite.');
  }
  const text = typeof rate === 'number' ? String(rate) : rate;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(typeof text === 'string' ? text : '');
  if (!match || (typeof rate === 'string' && match[3] !== undefined)) {
    throw new LoanError('invalid-rate', 'annualRate must be a non-negative plain decimal.');
  }
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0) - fraction.length;
  const digits = BigInt((match[1] ?? '0') + fraction);
  if (-exponent > MAX_RATE_FRACTION_DIGITS) {
    throw new LoanError(
      'invalid-rate',
      `annualRate needs more than ${MAX_RATE_FRACTION_DIGITS} fractional digits.`,
    );
  }
  if (exponent > 3)
    throw new LoanError('invalid-rate', 'annualRate exceeds the supported maximum.');
  const result: Rational =
    exponent >= 0
      ? { numerator: digits * 10n ** BigInt(exponent), denominator: 1n }
      : { numerator: digits, denominator: 10n ** BigInt(-exponent) };
  if (result.numerator > BigInt(MAX_RATE) * result.denominator) {
    throw new LoanError('invalid-rate', `annualRate must not exceed ${MAX_RATE} (1000%).`);
  }
  return result;
}

interface Normalized {
  principal: bigint;
  balloon: bigint;
  periods: number;
  a: bigint;
  b: bigint;
  kind: LoanKind;
  mode: RoundingMode;
}

function normalize(input: LoanInput): Normalized {
  const principal = cents(input.principalCents, 'principalCents');
  const balloon = cents(input.balloonCents ?? 0n, 'balloonCents');
  if (principal <= 0n) throw new LoanError('invalid-input', 'principalCents must be positive.');
  if (balloon < 0n || balloon > principal) {
    throw new LoanError('invalid-input', 'balloonCents must be between 0 and the principal.');
  }
  const periods = input.periods;
  if (!Number.isInteger(periods) || periods < 1 || periods > MAX_PERIODS) {
    throw new LoanError('invalid-input', `periods must be an integer from 1 to ${MAX_PERIODS}.`);
  }
  const perYear = input.periodsPerYear ?? 12;
  if (!Number.isInteger(perYear) || perYear < 1 || perYear > 366) {
    throw new LoanError('invalid-input', 'periodsPerYear must be an integer from 1 to 366.');
  }
  const kind = input.kind ?? 'level-payment';
  if (kind !== 'level-payment' && kind !== 'equal-principal') {
    throw new LoanError('invalid-input', 'Unknown loan kind.');
  }
  const mode = input.rounding ?? 'half-even';
  if (!MODES.includes(mode)) throw new LoanError('invalid-input', 'Unknown rounding mode.');
  const rate = parseRate(input.annualRate);
  return {
    principal,
    balloon,
    periods,
    a: rate.numerator,
    b: rate.denominator * BigInt(perYear),
    kind,
    mode,
  };
}

function levelPayment(n: Normalized): bigint {
  if (n.a === 0n) return divRound(n.principal - n.balloon, BigInt(n.periods), n.mode);
  // r = a/b. payment = (P(1+r)^n - B) r / ((1+r)^n - 1), evaluated exactly over b^n.
  const growth = (n.b + n.a) ** BigInt(n.periods);
  const base = n.b ** BigInt(n.periods);
  return divRound((n.principal * growth - n.balloon * base) * n.a, n.b * (growth - base), n.mode);
}

/** Level payment in cents (the first payment for `equal-principal`). */
export function regularPaymentCents(input: LoanInput): bigint {
  const n = normalize(input);
  if (n.kind === 'level-payment') return levelPayment(n);
  return buildLoanSchedule(input).regularPaymentCents;
}

export function buildLoanSchedule(input: LoanInput): LoanSchedule {
  const n = normalize(input);
  const level = n.kind === 'level-payment' ? levelPayment(n) : 0n;
  const amortized = n.principal - n.balloon;
  const base = amortized / BigInt(n.periods);
  const extra = Number(amortized % BigInt(n.periods));
  const rows: LoanRow[] = [];
  let balance = n.principal;
  let totalPayment = 0n;
  let totalInterest = 0n;
  for (let period = 1; period <= n.periods; period += 1) {
    const interest = divRound(balance * n.a, n.b, n.mode);
    let principal: bigint;
    if (period === n.periods) principal = balance;
    else if (n.kind === 'level-payment') principal = level - interest;
    else principal = base + (period <= extra ? 1n : 0n);
    if (principal > balance) principal = balance;
    balance -= principal;
    const payment = interest + principal;
    totalPayment += payment;
    totalInterest += interest;
    rows.push(
      Object.freeze({
        period,
        paymentCents: payment,
        interestCents: interest,
        principalCents: principal,
        balanceCents: balance,
      }),
    );
  }
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  return Object.freeze({
    currency: input.currency,
    kind: n.kind,
    regularPaymentCents: first.paymentCents,
    finalAdjustmentCents: last.paymentCents - first.paymentCents,
    totalPaymentCents: totalPayment,
    totalInterestCents: totalInterest,
    rows: Object.freeze(rows),
  });
}
