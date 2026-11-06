# @lp-labs/loan-amortization

Exact fixed-rate loan schedules in integer cents. Payments and interest are computed with `bigint`
rational arithmetic and rounded once per figure with a rounding mode you choose, so there is no
floating-point drift. Supports level payments, equal-principal repayment, balloon amounts, and zero
rates.

## Install

```bash
npm install @lp-labs/loan-amortization
```

ES2022 ESM and CommonJS builds ship with TypeScript declarations. There are no runtime dependencies.

## Quickstart

```js
import { buildLoanSchedule, regularPaymentCents } from '@lp-labs/loan-amortization';

const loan = { principalCents: 10_000_000n, annualRate: 0.06, periods: 360 };
if (regularPaymentCents(loan) !== 59955n) throw new Error('unexpected payment');

const schedule = buildLoanSchedule({ ...loan, balloonCents: 2_000_000n, currency: 'USD' });
console.log(schedule.regularPaymentCents, schedule.finalAdjustmentCents, schedule.rows.length);
```

## API

```ts
type RoundingMode = 'floor' | 'ceil' | 'half-even' | 'half-up' | 'trunc';
type LoanKind = 'level-payment' | 'equal-principal';
interface LoanInput {
  principalCents: bigint | number;
  annualRate: number | string;
  periods: number;
  periodsPerYear?: number;
  balloonCents?: bigint | number;
  kind?: LoanKind;
  rounding?: RoundingMode;
  currency?: string;
}
interface LoanRow {
  period: number;
  paymentCents: bigint;
  interestCents: bigint;
  principalCents: bigint;
  balanceCents: bigint;
}
interface LoanSchedule {
  currency: string | undefined;
  kind: LoanKind;
  regularPaymentCents: bigint;
  finalAdjustmentCents: bigint;
  totalPaymentCents: bigint;
  totalInterestCents: bigint;
  rows: readonly LoanRow[];
}
interface Rational {
  numerator: bigint;
  denominator: bigint;
}
type LoanErrorCode = 'invalid-input' | 'invalid-rate';
class LoanError extends Error {
  readonly code: LoanErrorCode;
}

const MAX_PERIODS: 1200;
const MAX_RATE_FRACTION_DIGITS: 24;
function parseRate(rate: number | string): Rational;
function regularPaymentCents(input: LoanInput): bigint;
function buildLoanSchedule(input: LoanInput): LoanSchedule;
```

### How figures are computed

- The periodic rate is `annualRate / periodsPerYear`, taken as an exact fraction of the decimal text
  of the rate (`0.06` means exactly 6/100, not its binary approximation).
- Level payment: `(P(1+r)^n - B) * r / ((1+r)^n - 1)` evaluated exactly, then rounded once. A zero
  rate uses `(P - B) / n`.
- Each period's interest is `balance * r` rounded with your mode. Principal is payment minus interest.
- Equal-principal: `(P - B)` is split evenly; leftover cents go one each to the earliest periods.
- The final period always clears the remaining balance, so the last payment absorbs accumulated
  rounding residue and any balloon. `finalAdjustmentCents` reports its difference from the first
  payment.
- `balloonCents` is the amount left after the last regular payment and is paid with the final payment.

## Customization

Choose `kind`, `rounding`, `periodsPerYear` (1 to 366), and `balloonCents`. `currency` is only echoed
back; cents are whatever minor unit you decide.

## Errors and boundaries

Everything invalid throws `LoanError` (`invalid-input`, `invalid-rate`): non-positive principal,
balloon outside `[0, principal]`, `periods` outside 1 to 1200, non-finite, negative, or over-10
(1000%) rates, rates with more than 24 fractional digits, and unknown modes.

## Performance

Payment evaluation raises integers to the power of `periods`; the 1200-period maximum with typical
rates completes in milliseconds. Rates with many fractional digits make the integers larger.

## Honest scope

This is arithmetic, not financial advice. It does not model day-count conventions, APR, fees,
irregular dates, variable rates, prepayments, or any lender's or jurisdiction's rounding rules.
Compare the output with your lender's official disclosure before relying on it.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
