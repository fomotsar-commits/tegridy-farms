import { formatSol, formatTokenAmount } from '../../../lib/launcher/solana/curve';
import { formatSolPrice } from '../../../lib/solana/lp/format';
import { tokenTicker } from '../../../lib/solana/lp/identity';
import { feeSplit } from '../../../lib/solana/clmm/feeText';
import { rangeVenueEarns } from '../../../lib/solana/clmm/venueEarns';
import { Notice, Row } from './ui';
import type { RangeCreateSummary, RangeSummary } from './ports';

/**
 * The review of a range-position transaction. Every amount is the prepared transaction's:
 * maxima and minima decoded from its bytes, the rest from the builder's own fresh read.
 * What the position earns, and that it earns nothing out of range, is said on every review.
 */

const coinText = (v: bigint, decimals: number, symbol: string, native: boolean) =>
  native ? `${formatSol(v, 9)} SOL` : `${formatTokenAmount(v, decimals, decimals).text} ${symbol}`;

/** A coin by its ticker and its whole address (owner, 2026-10-22): a ticker alone can be copied. */
export const coinNamed = (mint: string) => `${tokenTicker(mint) ?? 'Unknown token'} · ${mint}`;

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
          <Row label="Taking out" value={s.percent === 0 ? 'no liquidity: the fees only' : `${s.percent}% of its liquidity`} mono={false} />
          {s.percent > 0 && <Row label="You get about" value={both(s.quoted)} mono={false} />}
          {s.percent > 0 && <Row label="At least" value={both(s.min)} mono={false} />}
          <Row label="Fees it has earned" value={s.fees ? both(s.fees) : 'could not be worked out just now; they are paid out in full all the same'} mono={false} />
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

/**
 * A new pool and its first position. What opening it costs comes first, the fee to the vault
 * and the deposits that never come back, then how a position in it earns, then the position.
 */
export function RangeCreateRows({ summary: s }: { summary: RangeCreateSummary }) {
  const l = s.poolLine;
  const q = l.quote;
  const venue = rangeVenueEarns(l, l.feeCeiling);
  const split = feeSplit(l, l.feeCeiling);
  const ticker = tokenTicker(l.tokenMint.toBase58());
  const per = `${q.symbol} per ${ticker ?? 'token'}`;
  const token = (v: bigint) => `${formatTokenAmount(v, l.tokenDecimals, l.tokenDecimals).text} ${ticker ?? 'tokens'}`;
  const sol = (v: bigint) => `${formatSol(v, 9)} SOL`;
  return (
    <>
      <Row label="New range pool" value={l.pool.toBase58()} />
      <Row label="Token" value={coinNamed(l.tokenMint.toBase58())} />
      <Row label="Paired with" value={coinNamed(q.mint)} />
      <Row label="Opening price" value={`${formatSolPrice(s.startPrice)} ${per}`} mono={false} />
      {(s.price.state === 'agrees' || s.price.state === 'disagrees') && (
        <Row label="Market price (Jupiter), read just now" value={`${formatSolPrice(s.price.reference)} ${per}`} mono={false} />
      )}
      <Row label="Fee to open the pool" value={`${sol(s.createFee)}, to the venue’s vault (${s.feeReceiver.toBase58()}). Not refunded.`} mono={false} />
      <Row
        label="Deposits that never come back"
        value={`${sol(s.neverBack)}: the pool, its two vaults, its price record, its far-band map and its new price bands. A pool cannot be closed.`}
        mono={false}
      />
      <Row label="Deposits back when you close your position" value={`${sol(s.backOnClose)}: its record, its NFT and the NFT’s account.`} mono={false} />
      <Row
        label="How a position earns"
        value={`Positions whose range the price is in share ${split.lpOfFee} of each ${split.fee} swap fee (${split.lpOfSwap} of the swap), split by how much liquidity each has there. The venue keeps ${venue.cut}.`}
        mono={false}
      />
      {/* Anything but the agreed split is said once, in bold, at the top of the review (TxFlowView). */}
      {!venue.elsewhere && <Notice>{venue.where}</Notice>}
      <Notice tone="warn">Trading opens the moment the pool exists, and its opening price can never be set again.</Notice>
      <Row label="Your range" value={`${formatSolPrice(s.range.minPrice)} to ${formatSolPrice(s.range.maxPrice)} ${per}`} mono={false} />
      <Notice tone={s.range.holds === 'both' ? 'info' : 'warn'}>
        {s.range.holds === 'both'
          ? 'The opening price is inside your range: it earns from the first swap.'
          : 'The opening price is outside your range: it earns nothing until the price moves into it.'}{' '}
        Out of range, a position earns nothing.
      </Notice>
      <Row label="You put in" value={`${token(s.max.token)} and ${coinText(s.max.quote, q.decimals, q.symbol, q.native)}, exactly`} mono={false} />
      <Row label="You get" value="one position NFT. Whoever holds it can take this position out." mono={false} />
      <Notice>
        {!q.native
          ? `Your ${q.symbol} is spent straight from your own ${q.symbol} account. The fee and the deposits are paid in SOL.`
          : s.unwrapsWsol
            ? 'Your SOL is wrapped for the deposit and the account is closed at the end.'
            : 'Your SOL is wrapped for the deposit, and anything not used stays in your wrapped-SOL account.'}
      </Notice>
      <Notice>
        One transaction: the pool and your position land together, or neither does. If someone opens this pool first, yours is refused and only the
        network fee is spent.
      </Notice>
      {s.notices.map((n) => (
        <Notice key={n} tone="warn">
          {n}
        </Notice>
      ))}
    </>
  );
}
