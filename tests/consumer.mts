import { buildLoanSchedule, type LoanInput, type LoanSchedule } from '@lp-labs/loan-amortization';

const input: LoanInput = {
  principalCents: 100_000n,
  annualRate: 0.05,
  periods: 12,
  kind: 'equal-principal',
};
const schedule: LoanSchedule = buildLoanSchedule(input);
const total: bigint = schedule.totalInterestCents;
void total;
