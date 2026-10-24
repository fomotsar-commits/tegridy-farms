import { formatSol, formatTokenAmount } from '../../../lib/launcher/solana/curve';
import { formatSolPrice } from '../../../lib/solana/lp/format';
import { feeSplit } from '../../../lib/solana/clmm/feeText';
import { rangeVenueEarns } from '../../../lib/solana/clmm/venueEarns';
import { Notice, Row } from './ui';
import type { RangeSummary } from './ports';
import { rewardAmount } from '../range/rangeText';

/**
 * The review of a range-position transaction. Every amount is the prepared transaction's:
 * maxima and minima decoded from its bytes, the rest from the builder's own fresh read.
 * What the position earns, and that it earns nothing out of range, is said on every review.
 */

const coinText = (v: bigint, decimals: number, symbol: string, native: boolean) =>
  native ? `${formatSol(v, 9)} SOL` : `${formatTokenAmount(v, decimals, decimals).text} ${symbol}`;

export function RangeRows({ summary: s }: { summary: RangeSummary }) {
  const l = s.poolLine;
  const q = l.quote;
  const venue = rangeVenueEarns(l, l.feeCeiling);
  const fee = feeSplit(l, l.feeCeiling).fee;
  const token = (v: bigint) => `${formatTokenAmount(v, l.tokenDecimals, l.tokenDecimals).text} tokens`;
  const coin = (v: bigint) => coinText(v, q.decimals, q.symbol, q.native);
  const both = (a: { token: bigint; quote: bigint }) => `${token(a.token)} and ${coin(a.quote)}`;
  const range = `${formatSolPrice(s.range.minPrice)} to ${formatSolPrice(s.range.maxPrice)} ${q.symbol} per token`;
  const holds =
    s.range.holds === 'both'
      ? 'In range now: it earns while the price stays inside it.'
      : s.range.holds === 'token-only'
        ? 'Above this pool’s price now, holding the token only: it earns nothing until the price rises into it.'
        : `Below this pool’s price now, holding ${q.symbol} only: it earns nothing until the price falls into it.`;
  return (
    <>
      <Row label="Range pool" value={l.pool.toBase58()} />
      <Row label="Token (mint)" value={l.tokenMint.toBase58()} />
      <Row label="Paired with" value={q.symbol} mono={false} />
      <Row
        label="Swap fee"
        value={`${fee} of each swap through your range. Positions in range share what the venue does not keep: it keeps ${venue.cut}, read from the pool's fee tier.`}
        mono={false}
      />
      {/* Anything but the agreed split is said once, in bold, at the top of the review (TxFlowView). */}
      {!venue.elsewhere && <Notice>{venue.where}</Notice>}
      <Row label="Range" value={range} mono={false} />
      <Notice tone={s.range.holds === 'both' ? 'info' : 'warn'}>{holds} Out of range, a position earns nothing.</Notice>
      {s.kind === 'range-open' ? (
        <>
          <Row label="You put in about" value={both(s.quoted)} mono={false} />
          <Row label="At most" value={both(s.max)} mono={false} />
          <Row label="You get" value="one position NFT. Whoever holds it can take this position out." mono={false} />
          <Notice>
            {!q.native
              ? `Your ${q.symbol} is spent straight from your own ${q.symbol} account.`
              : s.unwrapsWsol
                ? 'Your SOL is wrapped for the deposit and the account is closed at the end, so anything not used comes back as plain SOL.'
                : 'Your SOL is wrapped for the deposit, and anything not used stays in your wrapped-SOL account.'}
          </Notice>
        </>
      ) : (
        <>
          <Row label="Position" value={s.position.toBase58()} />
          <Row label="Taking out" value={s.percent > 0 ? `${s.percent}% of its liquidity` : s.rewards?.length === 0 ? 'no liquidity: the fees only' : 'no liquidity: the fees and rewards only'} mono={false} />
          {s.percent > 0 && <Row label="You get about" value={both(s.quoted)} mono={false} />}
          {s.percent > 0 && <Row label="At least" value={both(s.min)} mono={false} />}
          <Row label="Fees it has earned" value={s.fees ? both(s.fees) : 'could not be worked out just now; they are paid out in full all the same'} mono={false} />
          {s.rewards === null ? (
            <Row label="Rewards it pays" value="could not be worked out just now; what it is owed is paid out all the same" mono={false} />
          ) : (
            s.rewards.length > 0 && <Row label="Rewards it pays" value={s.rewards.map((r) => rewardAmount(r.amount, r.decimals, r.mint.toBase58())).join(' and ')} mono={false} />
          )}
          {s.kind === 'range-close' && (
            <Notice>The position&apos;s NFT is burned and its record closed, and their deposits come back to you.</Notice>
          )}
          {q.native && (
            <Notice>
              {s.unwrapsWsol ? 'SOL comes back as plain SOL.' : 'SOL comes back into your wrapped-SOL account, which you already had.'}
            </Notice>
          )}
        </>
      )}
      {/* The accounts' notices: own lines. An opening's price warnings are said first, above every row (TxFlowView). */}
      {s.notices.map((n) => (
        <Notice key={n} tone="warn">
          {n}
        </Notice>
      ))}
    </>
  );
}
