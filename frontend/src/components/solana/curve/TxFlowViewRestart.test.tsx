// The review of a restart (restart.ts, `prepareLpRestart`): an add whose summary carries
// `restart`. It says the price the pool is set to, what tops it up and stays in it for good,
// the shares kept, and the check-back. The pool's old price is never checked or said: the
// restart sets it.
import { describe, expect, it } from 'vitest';
import { TxReview } from './TxFlowView';
import { reviewLines } from './reviewLines';
import { KEY, prepared } from './fakeWriteApi.fixture';
import { lpDepositSummary } from '../lp/fakeLpWriteApi.fixture';

// 0.01 SOL into mainnet's dead SOL / TBB pool at Jupiter's 39.83 units a lamport.
const RESTART = {
  perToken: 0.0000251,
  topUp: { quote: 18n, token: 867n },
  costQuote: 40n,
  checkLp: 2_778n,
  checkMin: { quote: 990n, token: 39_400n },
  checkOut: { quote: 1_000n, token: 39_830n },
  keep: 25_000_000n,
};

function text() {
  const s = lpDepositSummary(KEY(30), KEY(31), { restart: RESTART, lpAmount: RESTART.keep + RESTART.checkLp });
  return reviewLines(<TxReview prepared={prepared(s, { kind: 'lp-restart' })} decimals={6} display={(x) => x} />);
}
const lines = () => text().lines;

describe('the review of a restart', () => {
  it('is headed as a restart', () => {
    expect(lines()[0]).toBe('Review: restart this pool');
  });

  it('says the price, what goes in for good, the shares kept and the check-back', () => {
    const got = lines();
    const has = (re: RegExp) => expect(got.some((l) => re.test(l)), `${re}\n${got.join('\n')}`).toBe(true);
    has(/^Also goes in, for good: 0\.000000018 SOL and 0\.000867 tokens \(worth under 0\.0001 SOL\), to set the pool to that price\. They stay in the pool: nobody can take them out\.$/);
    has(/^You get: 0\.025 pool shares, exactly$/);
    has(/^Check-back: 0\.000002778 pool shares come straight back out, as at least 0\.00000099 SOL and 0\.0394 tokens\. If the pool changed by more than your tolerance before this runs, it fails and nothing goes in\.$/);
  });

  // A line read against the market, as a deposit's price check is: a rebuild compares it as one (useTxFlow).
  it('says the price it restarts at among the market lines, and checks no price of the pool’s own', () => {
    const t = text();
    expect(t.market).toEqual(['Restarts at: 1 token = 0.0000251 SOL, Jupiter’s price read just now']);
    const got = t.lines;
    expect(got.some((l) => l.startsWith('Price check:'))).toBe(false);
    expect(got.some((l) => l.startsWith('You get: 0.025002778'))).toBe(false);
  });

  it('an ordinary add keeps its price check and its shares', () => {
    const s = lpDepositSummary(KEY(30), KEY(31));
    const t = reviewLines(<TxReview prepared={prepared(s)} decimals={6} display={(x) => x} />);
    expect(t.lines[0]).toBe('Review: add liquidity');
    expect(t.market.some((l) => l.startsWith('Price check:'))).toBe(true);
    expect([...t.lines, ...t.market].some((l) => l.startsWith('Restarts at:') || l.startsWith('Check-back:'))).toBe(false);
  });
});

