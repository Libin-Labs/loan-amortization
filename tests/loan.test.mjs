import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildLoanSchedule, regularPaymentCents, parseRate, LoanError } from '../dist/esm/index.js';

const loan = (extra = {}) => ({
  principalCents: 10_000_000n,
  annualRate: 0.06,
  periods: 360,
  ...extra,
});

test('known level payments match published amortization figures', () => {
  assert.equal(regularPaymentCents(loan()), 59955n); // 100,000 at 6%, 30 years
  assert.equal(
    regularPaymentCents(loan({ principalCents: 20_000_000n, annualRate: 0.045 })),
    101337n,
  );
  assert.equal(
    regularPaymentCents({ principalCents: 120_000n, annualRate: 0, periods: 12 }),
    10000n,
  );
});

test('level payment agrees with a floating-point oracle within one cent', () => {
  for (const [p, rate, n, y] of [
    [250_000_00, 0.0375, 180, 12],
    [5_000_00, 0.12, 24, 12],
    [99_999_99, 0.0725, 84, 12],
    [1_000_00, 0.05, 52, 52],
  ]) {
    const r = rate / y;
    const oracle = (p * r) / (1 - (1 + r) ** -n);
    const got = regularPaymentCents({
      principalCents: p,
      annualRate: rate,
      periods: n,
      periodsPerYear: y,
    });
    assert.ok(Math.abs(Number(got) - oracle) <= 1, `${p} ${rate} ${n}: ${got} vs ${oracle}`);
  }
});

test('schedule invariants: principal sums to the loan, balance ends at zero, totals tie out', () => {
  for (const extra of [
    {},
    { balloonCents: 3_000_000n },
    { kind: 'equal-principal' },
    { rounding: 'floor' },
    { annualRate: 0 },
    { periods: 1 },
  ]) {
    const input = loan({ principalCents: 12_345_678n, ...extra });
    const s = buildLoanSchedule(input);
    assert.equal(s.rows.length, input.periods ?? 360);
    assert.equal(
      s.rows.reduce((t, r) => t + r.principalCents, 0n),
      12_345_678n,
    );
    assert.equal(s.rows.at(-1).balanceCents, 0n);
    assert.equal(s.totalPaymentCents, 12_345_678n + s.totalInterestCents);
    let balance = 12_345_678n;
    for (const row of s.rows) {
      balance -= row.principalCents;
      assert.equal(row.balanceCents, balance);
      assert.equal(row.paymentCents, row.interestCents + row.principalCents);
    }
  }
});

test('balloon leaves the requested balance before the final payment', () => {
  const s = buildLoanSchedule(
    loan({ principalCents: 20_000_000n, periods: 60, balloonCents: 5_000_000n }),
  );
  const before = s.rows.at(-2).balanceCents;
  const afterRegular = before - (s.regularPaymentCents - s.rows.at(-1).interestCents);
  assert.ok(afterRegular >= 4_999_900n && afterRegular <= 5_000_100n, String(afterRegular));
  assert.equal(s.rows.at(-1).principalCents, before);
  assert.ok(s.finalAdjustmentCents > 4_900_000n && s.finalAdjustmentCents < 5_100_000n);
  // balloon equal to principal is interest-only
  const io = buildLoanSchedule({
    principalCents: 1_200_000n,
    annualRate: 0.06,
    periods: 12,
    balloonCents: 1_200_000n,
  });
  assert.equal(io.regularPaymentCents, 6000n);
  assert.ok(io.rows.slice(0, -1).every((r) => r.principalCents === 0n));
});

test('equal-principal and zero-rate schedules are exact by hand', () => {
  const s = buildLoanSchedule({
    principalCents: 100_000n,
    annualRate: 0.12,
    periods: 4,
    kind: 'equal-principal',
  });
  assert.deepEqual(
    s.rows.map((r) => [r.principalCents, r.interestCents, r.paymentCents]),
    [
      [25000n, 1000n, 26000n],
      [25000n, 750n, 25750n],
      [25000n, 500n, 25500n],
      [25000n, 250n, 25250n],
    ],
  );
  const z = buildLoanSchedule({ principalCents: 1003n, annualRate: 0, periods: 3 });
  assert.deepEqual(
    z.rows.map((r) => r.paymentCents),
    [334n, 334n, 335n],
  );
  assert.equal(z.totalInterestCents, 0n);
  const r = buildLoanSchedule({
    principalCents: 10n,
    annualRate: 0,
    periods: 3,
    kind: 'equal-principal',
  });
  assert.deepEqual(
    r.rows.map((x) => x.principalCents),
    [4n, 3n, 3n],
  );
});

test('rounding policy is explicit and changes interest as documented', () => {
  const base = { principalCents: 100_001n, annualRate: 0.0725, periods: 6 };
  const floor = buildLoanSchedule({ ...base, rounding: 'floor' });
  const ceil = buildLoanSchedule({ ...base, rounding: 'ceil' });
  assert.equal(floor.rows[0].interestCents, (100_001n * 725n) / 120_000n);
  assert.equal(ceil.rows[0].interestCents, floor.rows[0].interestCents + 1n);
  assert.throws(() => buildLoanSchedule({ ...base, rounding: 'nearest' }), LoanError);
});

test('rate parsing is exact, finite, and bounded', () => {
  assert.deepEqual(parseRate(0.06), { numerator: 6n, denominator: 100n });
  assert.deepEqual(parseRate('0.0525'), { numerator: 525n, denominator: 10000n });
  assert.deepEqual(parseRate(1e-7), { numerator: 1n, denominator: 10_000_000n });
  assert.deepEqual(parseRate(2), { numerator: 2n, denominator: 1n });
  for (const bad of [
    -0.01,
    NaN,
    Infinity,
    10.5,
    '1e-2',
    '-1',
    '',
    '0.1234567890123456789012345',
    1e21,
  ]) {
    assert.throws(
      () => parseRate(bad),
      (e) => e instanceof LoanError && e.code === 'invalid-rate',
      String(bad),
    );
  }
});

test('malformed and out-of-bound inputs throw', () => {
  const ok = loan();
  for (const bad of [
    { principalCents: 0n },
    { principalCents: -5 },
    { principalCents: 1.5 },
    { principalCents: '100' },
    { periods: 0 },
    { periods: 1201 },
    { periods: 2.5 },
    { periodsPerYear: 0 },
    { periodsPerYear: 367 },
    { balloonCents: -1n },
    { balloonCents: 10_000_001n },
    { kind: 'interest-only' },
    { annualRate: NaN },
  ]) {
    assert.throws(
      () => buildLoanSchedule({ ...ok, ...bad }),
      LoanError,
      JSON.stringify(bad, (k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
    );
  }
});

test('largest supported schedule completes and CJS matches ESM', () => {
  const s = buildLoanSchedule({ principalCents: 10n ** 15n, annualRate: 0.0725, periods: 1200 });
  assert.equal(s.rows.length, 1200);
  assert.equal(s.rows.at(-1).balanceCents, 0n);
  const cjs = createRequire(import.meta.url)('@lp-labs/loan-amortization');
  assert.equal(cjs.regularPaymentCents(loan()), 59955n);
});
