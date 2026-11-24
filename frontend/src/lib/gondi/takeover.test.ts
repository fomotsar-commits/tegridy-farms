// @vitest-environment node
//
// The takeover window is the loan contract's own setting (MultiSourceLoan.getMinLockPeriod, basis
// points of the term at each end), which the venue's Safe can change at once for open loans too.
// The site printed "15% to 85%" as if it were fixed; it now says what the chain says, and with no
// read it gives no number (read on mainnet 2026-11-14: 1500).
import { describe, expect, it } from 'vitest';
import { borrowerTakeoverLine, lenderTakeoverLine, takeoverWindow } from './takeover';

describe('takeoverWindow', () => {
  it('reads the setting as the share of the term at each end', () => {
    expect(takeoverWindow(1500n)).toEqual({ kind: 'window', from: '15%', to: '85%' });
    expect(takeoverWindow(2000n)).toEqual({ kind: 'window', from: '20%', to: '80%' });
    expect(takeoverWindow(1250n)).toEqual({ kind: 'window', from: '12.5%', to: '87.5%' });
    expect(takeoverWindow(1205n)).toEqual({ kind: 'window', from: '12.05%', to: '87.95%' });
    expect(takeoverWindow(0n)).toEqual({ kind: 'window', from: '0%', to: '100%' });
  });

  it('half the term or more locked at each end leaves no window', () => {
    expect(takeoverWindow(5000n)).toEqual({ kind: 'none' });
    expect(takeoverWindow(10_000n)).toEqual({ kind: 'none' });
  });

  it('no read, or a value the contract cannot hold, is no number: unread, or reading while it is on its way', () => {
    for (const v of [undefined, null, 1500, '1500', -1n, 10_001n]) expect(takeoverWindow(v)).toEqual({ kind: 'unread' });
    expect(takeoverWindow(undefined, true)).toEqual({ kind: 'reading' });
  });
});

describe('what each side is told', () => {
  it('a setting of 0 is said as any time, not "from 0% to 100%"', () => {
    expect(lenderTakeoverLine(takeoverWindow(0n))).toMatch(/^At any time in a loan's term, another lender can take the loan over/);
    expect(borrowerTakeoverLine(takeoverWindow(0n))).toMatch(/^At any time in the term, another lender can take this loan over/);
    expect(lenderTakeoverLine(takeoverWindow(0n))).not.toMatch(/0%/);
  });

  it('a window read from the chain is printed, with where it comes from and who can move it', () => {
    const lender = lenderTakeoverLine(takeoverWindow(2000n));
    expect(lender).toBe(
      "From 20% to 80% of a loan's term, another lender can take the loan over at a lower rate without asking you or the borrower. You then get your WETH back plus the interest so far, less the venue's share of that interest. That window is the loan contract's setting, read just now. The venue's Safe can change it at once, for open loans too.",
    );
    const borrower = borrowerTakeoverLine(takeoverWindow(1500n));
    expect(borrower).toMatch(/^From 15% to 85% of the term, another lender can take this loan over at a lower rate without asking you\./);
    expect(borrower).toContain('The loan then has a new number and its deadline can only move later.');
    expect(borrower).toContain("The venue's Safe can change it at once, for open loans too.");
  });

  it('no read: the takeover is still said, with no figure, and why', () => {
    for (const line of [lenderTakeoverLine(takeoverWindow(undefined)), borrowerTakeoverLine(takeoverWindow(undefined))]) {
      expect(line).not.toMatch(/\d+%/);
      expect(line).toMatch(/^For part of (a loan's|the) term, another lender can take (the|this) loan over/);
      expect(line).toContain("That part of the term is the loan contract's setting, and it could not be read just now, so no number is shown.");
    }
    expect(lenderTakeoverLine(takeoverWindow(undefined, true))).toContain('still being read');
  });

  it('no window: says so, and that the Safe can change it', () => {
    expect(lenderTakeoverLine(takeoverWindow(6000n))).toBe(
      "Right now the loan contract lets no other lender take a loan over. That is the loan contract's setting, read just now. The venue's Safe can change it at once, for open loans too.",
    );
    expect(borrowerTakeoverLine(takeoverWindow(6000n))).toMatch(/^Right now the loan contract lets no other lender take this loan over\./);
  });

  it('no em dash', () => {
    for (const w of [takeoverWindow(1500n), takeoverWindow(undefined), takeoverWindow(9000n)]) {
      expect(lenderTakeoverLine(w)).not.toContain('—');
      expect(borrowerTakeoverLine(w)).not.toContain('—');
    }
  });
});
