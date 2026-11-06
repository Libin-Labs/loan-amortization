import { regularPaymentCents, parseRate, LoanError } from '@lp-labs/loan-amortization';

const payment: bigint = regularPaymentCents({
  principalCents: 5000,
  annualRate: '0.1',
  periods: 6,
});
const denominator: bigint = parseRate('0.1').denominator;
const code: string = new LoanError('invalid-input', 'x').code;
void [payment, denominator, code];
