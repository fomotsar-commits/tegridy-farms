import { useEffect, useId, useRef, type ReactNode, type Ref } from 'react';
import { describeTreasury, formatSol, formatTokenAmount } from '../../../lib/launcher/solana/curve';
import { ExplorerLink, ImpactRows, Notice, Row } from './ui';
import { DIVIDER, bpsPercent, fractionToBps, sharePercent } from './uiFormat';
import { CREATOR_FEE_SWITCH, feeSplit } from '../../../lib/solana/cpswap/venue';
import { feeRateText, formatSolPrice, tradeCostText } from '../../../lib/solana/lp/format';
import { TOO_NEW_WHY } from '../../../lib/solana/lp/ownPrice';
import { edgePercent } from '../../../lib/solana/route';
import type { FeeSplitView, NotSent, PreparedTx, SolanaCluster, TokenRole, TxKind, TxOutcome, TxSigner, TxSummary, TxViewApi } from './ports';
import { reviewLines } from './reviewLines';
import type { ReviewState, TxFlow } from './useTxFlow';
import { quoteCoin, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import type { PriceReference } from '../../../lib/solana/lp/poolHealth';

// What the user sees between pressing a Review button and the chain's answer.
// Every word here is about THIS transaction, and the numbers come from the
// prepared transaction, never from the form the user typed into.
//
// Screen readers: this view replaces the panel's form, so the button that had focus
// is gone. Each step moves focus to its own heading or notice (tabIndex -1), which
// also reads it out. Progress is role="status"; what needs attention (a refusal, an
// unconfirmed send, a review that changed or can no longer be signed) is role="alert"
// and takes focus. A button whose work is running stays focusable and says so in a
// status line, instead of switching off under the keyboard.

const SOL = (l: bigint) => `${formatSol(l)} SOL`;
const signedSol = (l: bigint) => `${l < 0n ? '-' : '+'}${SOL(l < 0n ? -l : l)}`;
function tokenText(v: bigint, d: number | null, maxFractionDigits?: number): string {
  const f = formatTokenAmount(v, d, maxFractionDigits);
  return f.isBaseUnits ? `${f.text} (base units)` : f.text;
}
/** $BAYLA always has 6 decimals, whatever the launch token's are. */
const BAYLA_DECIMALS = 6;
const baylaText = (v: bigint) => formatTokenAmount(v, BAYLA_DECIMALS, BAYLA_DECIMALS).text;

/** The amount a fee is measured against, in lamports, when the trade has one. */
function tradeLamports(s: TxSummary): bigint | null {
  switch (s.kind) {
    case 'buy':
      return s.quote.lamportsIn;
    case 'sell':
      return s.quote.lamportsOut;
    case 'pool-buy':
      return s.amountIn;
    case 'pool-sell':
      return s.quote.outAmount;
    case 'venue-swap':
      return !s.coin.native ? null : s.paysCoin ? s.amountIn : s.quoted.outAmount;
    case 'create':
      return s.openingBuy ? s.openingBuy.quote.lamportsIn : null;
    // A pool paired with USDC or BAYLA moves none of the trade in SOL, so a fee has
    // nothing in lamports to be measured against: it is shown as its own amount.
    case 'lp-deposit':
    case 'lp-withdraw':
      return s.quote.native ? s.quoted.quote : null;
    case 'lp-create':
      return s.quote.native ? s.put.quote : null;
    default:
      return null;
  }
}

/**
 * How the trade fee is scheduled to split. Not an upper bound per leg: when the
 * creator's wallet would be left below rent, the program pays the creator's share to
 * the platform instead, so the platform can receive the whole fee. The trader never
 * pays more than the fee.
 */
function FeeSplitRows({ split }: { split: FeeSplitView }) {
  return (
    <>
      <Row label="…creator's share" value={SOL(split.creator)} />
      <Row label="…platform's share" value={SOL(split.platform)} />
      <p className="text-white/40 text-[10px]">
        If the creator&apos;s wallet holds too little SOL to receive its share, that share goes to the platform instead.
      </p>
    </>
  );
}

/** Takes `never`, so a summary kind with no rows below does not compile. */
function noRowsFor(_summary: never): null {
  return null;
}

export function SummaryRows({
  summary,
  decimals,
  display,
}: {
  summary: TxSummary;
  /** The launch mint's decimals, when read. `null` shows raw base units, never an assumed 9. */
  decimals: number | null;
  display: (s: string, max: number) => string;
}) {
  const tok = (v: bigint, d: number | null = decimals) => {
    const f = formatTokenAmount(v, d);
    return f.isBaseUnits ? `${f.text} (base units)` : f.text;
  };
  switch (summary.kind) {
    case 'create':
      return (
        <>
          <Row label="Name" value={display(summary.name, 32)} mono={false} />
          <Row label="Symbol" value={display(summary.symbol, 10)} />
          <Row label="Details link" value={summary.uri} />
          <Row label="Token address (mint)" value={summary.mint.toBase58()} />
          <Row label="Creator (you)" value={summary.creator.toBase58()} />
          <Row label="Decimals" value={String(summary.decimals)} />
          {summary.openingBuy ? (
            <>
              <Row label="Your opening buy: you pay" value={SOL(summary.openingBuy.quote.lamportsIn)} />
              <Row label="…of which trade fee" value={SOL(summary.openingBuy.quote.feeLamports)} />
              <Row label="You receive exactly" value={tok(summary.openingBuy.minTokensOut, 6)} />
            </>
          ) : (
            <Row label="Opening buy" value="none" mono={false} />
          )}
          <CreateReserveRows summary={summary} />
          <CreatePlantRows plant={summary.plant} />
        </>
      );
    case 'buy':
      return (
        <>
          <Row label="Token address (mint)" value={summary.mint.toBase58()} />
          {summary.fillsCurve && (
            <Notice tone="warn">
              This buy fills the curve, so this transaction can take at most {SOL(summary.maxLamportsIn)} of the{' '}
              {SOL(summary.requestedLamports)} you entered. The rest never leaves your wallet.
            </Notice>
          )}
          <Row label="You pay (at most)" value={SOL(summary.maxLamportsIn)} />
          <Row label="…of which trade fee" value={SOL(summary.quote.feeLamports)} />
          <FeeSplitRows split={summary.feeSplit} />
          <Row label="You receive (quoted)" value={tok(summary.quote.tokensOut)} />
          <Row label="You receive at least" value={tok(summary.minTokensOut)} />
          <ImpactRows bps={summary.priceImpactBps} />
        </>
      );
    case 'sell':
      return (
        <>
          <Row label="Token address (mint)" value={summary.mint.toBase58()} />
          <Row label="You sell" value={tok(summary.tokensIn)} />
          <Row label="You receive (quoted)" value={SOL(summary.quote.lamportsOut)} />
          <Row label="Trade fee" value={SOL(summary.quote.feeLamports)} />
          <FeeSplitRows split={summary.feeSplit} />
          <Row label="You receive at least" value={SOL(summary.minLamportsOut)} />
          <ImpactRows bps={summary.priceImpactBps} />
        </>
      );
    case 'migrate':
      return (
        <>
          <Row label="Token address (mint)" value={summary.mint.toBase58()} />
          <Row label="Pool it opens" value={summary.pool.toBase58()} />
          <Notice>
            Finishing graduation moves the curve&apos;s SOL and unsold tokens into the pool and burns the pool&apos;s
            LP tokens. Anyone can do it. You pay the transaction fees shown below. The rent for the accounts it opens
            for you is paid back to you inside the same transaction.
          </Notice>
        </>
      );
    case 'pool-buy':
    case 'pool-sell': {
      const buying = summary.kind === 'pool-buy';
      return (
        <>
          <Row label="Token address (mint)" value={summary.mint.toBase58()} />
          <Row label="Pool" value={summary.pool.toBase58()} />
          <Row label="You pay" value={buying ? SOL(summary.amountIn) : tok(summary.amountIn)} />
          <Row label="You receive (quoted)" value={buying ? tok(summary.quote.outAmount) : SOL(summary.quote.outAmount)} />
          <Row label="You receive at least" value={buying ? tok(summary.minimumAmountOut) : SOL(summary.minimumAmountOut)} />
          <Row
            label="Pool fee (inside what you pay)"
            value={buying ? SOL(summary.quote.result.tradeFee) : tok(summary.quote.result.tradeFee)}
          />
          <PoolCreatorFeeRow quote={summary.quote} buying={buying} sol={SOL} tok={tok} />
          <ImpactRows bps={fractionToBps(summary.quote.priceImpact)} />
          <Notice>
            {buying
              ? 'Your SOL is wrapped into a token account for the swap'
              : 'The pool pays out wrapped SOL'}
            {summary.unwrapsWsol
              ? ', and that account is closed at the end, so you get plain SOL back.'
              : '. You already had a wrapped SOL account, so it is left open with its balance.'}
          </Notice>
        </>
      );
    }
    case 'venue-swap':
      return <VenueSwapRows summary={summary} />;
    case 'lp-deposit':
      return <LpDepositRows summary={summary} />;
    case 'lp-withdraw':
      return <LpWithdrawRows summary={summary} />;
    case 'lp-create':
      return <LpCreateRows summary={summary} />;
    default:
      // A new kind of transaction is a compile error here until it has rows.
      return noRowsFor(summary);
  }
}

/**
 * The platform reserve a new launch pays in its own create transaction, and the
 * rent the creator pays for the treasury's token account. Every value comes from
 * the prepared transaction: the recipient is global.fee_recipient as read from
 * chain, the amount is what the test run had to show arriving, and the rent was
 * read from the cluster. "A multisig" only when the recipient is the known vault.
 */
function CreateReserveRows({ summary }: { summary: Extract<TxSummary, { kind: 'create' }> }) {
  const r = summary.platformReserve;
  const rent = summary.treasuryAccountRent;
  const rentText =
    rent > 0n ? `${formatSol(rent, 9)} SOL (rent, read from the network just now)` : 'nothing: it already exists';
  if (!r) {
    return (
      <>
        <Row label="Platform reserve" value="none: the platform receives no tokens from this launch" mono={false} />
        <Row label="You pay for the treasury's token account" value={rentText} mono={false} />
      </>
    );
  }
  const treasury = describeTreasury(r.recipient);
  const amount = `${formatTokenAmount(r.amount, 6).text} (${bpsPercent(r.bps)} of the supply)`;
  return (
    <>
      <Row label="Platform reserve, paid in this transaction" value={amount} />
      <Row label="Sent to (platform treasury)" value={r.recipient.toBase58()} />
      <Row label="Into its token account" value={r.treasuryToken.toBase58()} />
      <Row label="You pay for that token account" value={rentText} mono={false} />
      <p className="text-white/55 text-[10px]">
        When this token is created, the platform receives {bpsPercent(r.bps)} of the supply, sent to {treasury.name}.
        {treasury.multisig
          ? ''
          : " This page cannot confirm that account is a multisig: it is not the platform's known Squads vault."}{' '}
        The program does not stop the treasury selling those tokens, including while the curve is live.
      </p>
    </>
  );
}

// ── liquidity ────────────────────────────────────────────────────────────────
// Every value below comes from the prepared transaction: the maxima and minima are
// decoded from its bytes, the amounts were worked out from the read it was built
// on. A row never falls back to a value the panel was typed into.

type LpSummary = Extract<TxSummary, { kind: 'lp-deposit' | 'lp-withdraw' }>;
/** Any liquidity summary: each one names the pool's pairing coin (`quote`). */
type AnyLpSummary = Extract<TxSummary, { kind: 'lp-deposit' | 'lp-withdraw' | 'lp-create' }>;
const isLpSummary = (s: TxSummary): s is AnyLpSummary => s.kind === 'lp-deposit' || s.kind === 'lp-withdraw' || s.kind === 'lp-create';

// A bound the program enforces, or a count of pool shares, is printed to its last
// digit: rounding "at most" down, or "you get" either way, would misstate it.
const solExact = (l: bigint) => `${formatSol(l, 9)} SOL`;
const unitsExact = (v: bigint, d: number) => tokenText(v, d, d);
/**
 * An amount of a pool's pairing coin, in that coin's own decimals: "about" (the page's
 * usual rounding) and exact (to the last digit). SOL is `SOL` / `solExact`, to the
 * character; USDC and BAYLA are printed with their own 6 decimals and symbol.
 */
const coinAbout = (v: bigint, q: QuoteCoin) => (q.native ? SOL(v) : `${formatTokenAmount(v, q.decimals).text} ${q.symbol}`);
const coinExact = (v: bigint, q: QuoteCoin) => (q.native ? solExact(v) : `${formatTokenAmount(v, q.decimals, q.decimals).text} ${q.symbol}`);

function poolKindText(s: Pick<LpSummary, 'origin' | 'config'>): string {
  switch (s.origin) {
    case 'launch-pool':
      return 'Launch pool: opened by the launch program at graduation';
    case 'standard':
      return s.config ? `Standard address for fee tier ${s.config.index}` : 'Standard address for its fee tier';
    case 'other':
      return 'Its own address';
  }
}

/**
 * The pool's tier and what a trade on the pool costs: the trade fee, plus the creator fee
 * when the pool's own switch is on (`enableCreatorFee`, read with the pool while preparing).
 */
function feeTierText(config: LpSummary['config'], enableCreatorFee: boolean): string {
  if (!config) return 'not read';
  return `${config.index}: traders pay ${tradeCostText(config, enableCreatorFee)}; LPs keep ${feeSplit(config).lpKeepsPct.toFixed(3)}% of each trade`;
}

/** A share of the pool, said as a percentage; a real share that rounds to nothing says so. */
function shareText(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return 'none';
  return pct < 0.01 ? '<0.01%' : `${pct.toFixed(2)}%`;
}

/**
 * A price further than 3% from what it was checked against (poolHealth.ts
 * `PRICE_TOLERANCE`; a test pins the two together). It no longer stops a deposit or an
 * opening, so the price row must not read as a check that passed: it says so in words.
 */
const OFF_PRICE = 'That is off by more than 3%.';

/** What a pool's price was checked against, as the review's price row says it. A Record, so a new reference must say. */
const CHECKED_AGAINST: Readonly<Record<PriceReference, string>> = {
  outside: 'the outside price (Jupiter), read just now',
  'own-average': 'its own average over the last 30 minutes',
  'launch-pool': 'the launch pool’s price, read just now',
};

function priceText(p: Extract<TxSummary, { kind: 'lp-deposit' }>['price']): string {
  switch (p.state) {
    case 'agrees': {
      const d = (Math.abs(p.diff) * 100).toFixed(1);
      return p.against === 'own-average' ? `${d}% from ${CHECKED_AGAINST[p.against]}` : `${d}% ${p.diff >= 0 ? 'above' : 'below'} ${CHECKED_AGAINST[p.against]}`;
    }
    case 'disagrees': {
      const gap = `${(Math.abs(p.diff) * 100).toFixed(1)}% ${p.diff >= 0 ? 'above' : 'below'}`;
      return `${gap} ${CHECKED_AGAINST[p.against]}. ${OFF_PRICE}`;
    }
    case 'no-trades-yet':
      return 'nobody has traded since the launch program opened it';
    case 'too-new':
      // A launch pool with no route and too short a record: built for, with a warning.
      return `not checked against anything: ${TOO_NEW_WHY}`;
    case 'empty-pool':
      return 'not checked: the pool is empty';
    case 'no-market':
      // The token's. When it is the pairing coin Jupiter has no price for, `pricedText` says so, with the coin's name.
      return 'not checked against anything: Jupiter has no market price for this token';
    case 'skipped':
    case 'unread':
      return `not checked (${p.detail})`;
  }
}

/**
 * Who Jupiter has no price for when it ANSWERED "no route": the token, or the pool's
 * pairing coin (owner ruling 2026-10-07). With the coin the token HAS a price, so the row
 * names the coin and never says "this token". The words are poolHealth.ts
 * `noPriceClause`'s, and a test pins the two together.
 */
const noPriceClause = (of: 'token' | 'coin', q: QuoteCoin) =>
  of === 'coin' ? `Jupiter has no price for ${q.symbol} right now` : 'Jupiter has no market price for this token';

/** `priceText` for a pool whose pairing coin is known: the one answer that must name the coin does. */
function pricedText(p: Extract<TxSummary, { kind: 'lp-deposit' }>['price'], q: QuoteCoin): string {
  return p.state === 'no-market' && p.of === 'coin' ? `not checked against anything: ${noPriceClause('coin', q)}` : priceText(p);
}

type PriceGap = NonNullable<Extract<TxSummary, { kind: 'lp-deposit' }>['priceGap']>;
/**
 * What a price that is off is estimated to cost at the amounts going in, in the pool's
 * OWN coin and that coin's decimals (the builder gives base units of the coin, never
 * lamports for a USDC or BAYLA pool). An estimate that could not be worked out is said
 * as that, never shown as 0.
 */
const gapCostText = (g: PriceGap, q: QuoteCoin) =>
  g.lossQuote === null ? 'could not be worked out' : `up to about ${coinExact(g.lossQuote, q)} of what you put in`;

/**
 * What the builder says must be read before this is signed (`summary.warnings`: a price
 * that is off and what it may cost, no market price, a copied name, a freezable token).
 * Only adding and opening carry any. A removal never does: nothing here may give someone
 * a reason to wait before taking their money out.
 *
 * What the pool's pairing coin itself adds to the risks (quotes.ts `risk`: Circle can
 * freeze a pool's USDC account) is one of them, said last. It was a plain notice far down
 * the rows, so a clean USDC review had no warnings box and its heading was described by
 * nothing: someone moving by keyboard reached Sign without hearing it (review, 2026-10-04).
 * Here it is read out when the review opens, like a token its creator can freeze. It is
 * said once: the rows below do not repeat it.
 */
function reviewWarnings(s: TxSummary): string[] {
  if (s.kind !== 'lp-deposit' && s.kind !== 'lp-create') return [];
  return s.quote.risk ? [...s.warnings, s.quote.risk] : s.warnings;
}

/**
 * The warnings, first on the review, above every row: on a phone the review is two screens
 * long, and a warning at the foot of it is read after the decision is made. The review's
 * heading is described by them, so a screen reader says them when the review opens.
 */
function ReviewWarnings({ id, warnings }: { id: string; warnings: string[] }) {
  return (
    <div id={id} className="space-y-1" data-testid="tx-review-warnings">
      <Notice tone="warn">Read these warnings first. Nothing here stops you signing, and each one is a risk to what you put in:</Notice>
      <ul className="list-disc pl-4 text-amber-300/90 space-y-0.5 [overflow-wrap:anywhere]">
        {warnings.map((w, i) => (
          <li key={`${i}:${w}`}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

function LpPoolRows({ summary }: { summary: LpSummary }) {
  return (
    <>
      <Row label="Pool" value={summary.pool.toBase58()} />
      <Row label="Pool kind" value={poolKindText(summary)} mono={false} />
      <Row label="Token (mint)" value={summary.tokenMint.toBase58()} />
    </>
  );
}

function LpDepositRows({ summary: s }: { summary: Extract<TxSummary, { kind: 'lp-deposit' }> }) {
  const tok = (v: bigint) => tokenText(v, s.tokenDecimals);
  const q = s.quote;
  const limited =
    s.limitedByBalance === 'token'
      ? ' (all the tokens you have)'
      : s.limitedByBalance === 'quote'
        ? q.native ? ' (all the SOL you can spend)' : ` (all the ${q.symbol} you have)`
        : '';
  const unused = s.max.quote > s.quoted.quote ? s.max.quote - s.quoted.quote : 0n;
  return (
    <>
      <LpPoolRows summary={s} />
      <Row label="Fee tier" value={feeTierText(s.config, s.enableCreatorFee)} mono={false} />
      <Row label="Paired with" value={q.symbol} mono={false} />
      <Row label="You put in about" value={`${coinAbout(s.quoted.quote, q)} and ${tok(s.quoted.token)} tokens`} mono={false} />
      <Row label="At most" value={`${coinExact(s.max.quote, q)} and ${unitsExact(s.max.token, s.tokenDecimals)} tokens${limited}`} mono={false} />
      <Row label="You get" value={`${unitsExact(s.lpAmount, s.lpDecimals)} pool shares, exactly`} mono={false} />
      <Row label="Your share of the pool" value={`${shareText(s.sharePct.before)} → ${shareText(s.sharePct.after)}`} />
      <Row label="Price check" value={pricedText(s.price, q)} mono={false} />
      {s.priceGap && <Row label="Estimated cost of that gap" value={gapCostText(s.priceGap, q)} mono={false} />}
      <Row label="Pool fee to add" value="none" mono={false} />
      {s.tokenWarnings.length > 0 && (
        <div className="space-y-1">
          <Notice tone="warn">Read these about this token first:</Notice>
          <ul className="list-disc pl-4 text-amber-300/90 space-y-0.5 [overflow-wrap:anywhere]">
            {s.tokenWarnings.map((w) => (
              <li key={w.code}>{w.text}</li>
            ))}
          </ul>
        </div>
      )}
      {s.notices.map((n) => (
        <Notice key={n} tone="warn">
          {n}
        </Notice>
      ))}
      <Notice>
        {!q.native
          ? `Your ${q.symbol} is spent straight from your own ${q.symbol} account. Nothing is wrapped, and what the pool does not use never leaves that account.`
          : s.unwrapsWsol
            ? 'Your SOL is wrapped into a token account for the deposit, and the account is closed at the end, so anything not used comes back as plain SOL.'
            : `You already hold ${formatSol(s.wsolHeldBefore, 9)} wrapped SOL. None of it is spent. Up to ${solExact(unused)} of this deposit that the pool does not use stays in that account as wrapped SOL; your wallet app can unwrap it.`}
      </Notice>
    </>
  );
}

function LpWithdrawRows({ summary: s }: { summary: Extract<TxSummary, { kind: 'lp-withdraw' }> }) {
  const tok = (v: bigint) => tokenText(v, s.tokenDecimals);
  const shares = (v: bigint) => unitsExact(v, s.lpDecimals);
  const ofYours = sharePercent(s.lpAmount, s.heldBefore);
  const q = s.quote;
  return (
    <>
      <LpPoolRows summary={s} />
      <Row label="Paired with" value={q.symbol} mono={false} />
      <Row label="Pool shares you give back" value={`${shares(s.lpAmount)}${ofYours ? ` (${ofYours} of yours)` : ''}`} mono={false} />
      {s.all && <Notice>This is all of your share in this pool.</Notice>}
      <Row label="You get about" value={`${coinAbout(s.quoted.quote, q)} and ${tok(s.quoted.token)} tokens`} mono={false} />
      <Row label="You get at least" value={`${coinExact(s.min.quote, q)} and ${unitsExact(s.min.token, s.tokenDecimals)} tokens`} mono={false} />
      <Row label="You keep" value={s.keep > 0n ? `${shares(s.keep)} pool shares` : 'none in this pool'} mono={false} />
      <Row
        words
        label="The tokens arrive in"
        value={`${s.tokenAccount.toBase58()}${
          s.tokenAccountRent > 0n
            ? ` (opened for you; its deposit of ${solExact(s.tokenAccountRent)} stays in that account)`
            : ''
        }`}
      />
      {/* The coin decides which row this is, not the account: a USDC pool never says "The SOL arrives", even when its summary names no account. */}
      {q.native ? (
        <Row label="The SOL arrives" value={s.unwrapsWsol ? 'as plain SOL' : 'as wrapped SOL in the account you already hold'} mono={false} />
      ) : s.quoteAccount ? (
        <Row
          words
          label={`The ${q.symbol} arrives in`}
          value={`${s.quoteAccount.address.toBase58()}${
            s.quoteAccount.rent > 0n ? ` (opened for you; its deposit of ${solExact(s.quoteAccount.rent)} stays in that account)` : ''
          }`}
        />
      ) : (
        <Row label={`The ${q.symbol} arrives in`} value={`your own ${q.symbol} account (its address was not read)`} mono={false} />
      )}
      <Row label="Pool fee to take out" value="none" mono={false} />
      {s.notices.map((n) => (
        <Notice key={n} tone="warn">
          {n}
        </Notice>
      ))}
    </>
  );
}

/** What a live mint authority allows, said once more where a pool is about to be opened. */
const mintAuthorityLine = (q: QuoteCoin) => `Whoever holds that mint authority can make new tokens at any time and sell them into your pool for its ${q.symbol}.`;

/**
 * The opening price against the market, from the fresh check made while preparing. An
 * opening is built when that check agrees, and also when the price is off or there is no
 * market price at all (owner ruling 2026-10-04). Neither of those two is a check that
 * passed, and the row says which it is.
 */
function openingPriceText(p: Extract<TxSummary, { kind: 'lp-create' }>['price'], q: QuoteCoin): string {
  if ((p.state === 'agrees' || p.state === 'disagrees') && p.against === 'outside') {
    const d = (Math.abs(p.diff) * 100).toFixed(1);
    const line = `1 token = ${formatSolPrice(p.pool)} ${q.symbol}. Market (Jupiter, read just now): ${formatSolPrice(p.reference)} ${q.symbol}, ${d}% ${p.diff >= 0 ? 'above' : 'below'}`;
    return p.state === 'disagrees' ? `${line}. ${OFF_PRICE}` : line;
  }
  // The opening price is still said: with no market, it is the only price there is. It
  // names what has no price: the token, or the coin the pool is paired with.
  if (p.state === 'no-market') {
    return `1 token = ${formatSolPrice(p.pool)} ${q.symbol}. ${noPriceClause(p.of, q)}, so there is nothing to compare it with: you are setting the price yourself`;
  }
  return pricedText(p, q);
}

/** Opening a pool. Every value from the prepared transaction: the amounts from its bytes, the fee and rents as read while preparing. */
function LpCreateRows({ summary: s }: { summary: Extract<TxSummary, { kind: 'lp-create' }> }) {
  const tok = (v: bigint) => tokenText(v, s.tokenDecimals);
  const shares = (v: bigint) => unitsExact(v, s.lpDecimals);
  // The pool's share count less what the opener gets: the program's locked part.
  const lockedShares = s.supply - s.lpAmount;
  const pct = s.supply > 0n ? Number((s.lpAmount * 1_000_000n) / s.supply) / 10_000 : 0;
  const q = s.quote;
  return (
    <>
      <Row label="Pool" value={s.pool.toBase58()} />
      <Row
        label="Pool kind"
        value={
          s.origin === 'standard'
            ? 'Standard address for fee tier 1'
            : 'Its own address: the standard address is taken, so this pool gets a new address made in this browser'
        }
        mono={false}
      />
      <Row label="Token (mint)" value={s.tokenMint.toBase58()} />
      <Row label="Paired with" value={q.symbol} mono={false} />
      {/* Opened with cp-swap's `initialize`, which switches the new pool's creator fee off. */}
      <Row label="Fee tier" value={feeTierText(s.config, CREATOR_FEE_SWITCH.publicOpen)} mono={false} />
      {/* Sentences break only between words (mono={false}); only an address row breaks anywhere. */}
      <Row label="You put in" value={`${coinExact(s.put.quote, q)} and ${unitsExact(s.put.token, s.tokenDecimals)} tokens, exactly`} mono={false} />
      <Row label="Opening price" value={openingPriceText(s.price, q)} mono={false} />
      {s.priceGap && <Row label="Estimated cost of that gap" value={gapCostText(s.priceGap, q)} mono={false} />}
      <Row label="Opens for trading" value="At once (one second after it lands)" mono={false} />
      <Row
        label="Fee to open the pool"
        value={`${solExact(s.createFee)}, paid to the team's vault (into ${s.feeReceiver.toBase58()}, the account the pool program fixes); not refundable`}
        mono={false}
      />
      <Row
        label="Account deposits that never come back"
        value={`${solExact(s.rents.neverRefunded)} (the pool, its price record, its share token and its two vaults; none can be closed)`}
        mono={false}
      />
      <Row label="Your pool-share account" value={`${solExact(s.rents.lpAccount)} (it comes back if you close that account later)`} mono={false} />
      <Row label="You get" value={`${shares(s.lpAmount)} pool shares, exactly`} mono={false} />
      <Row
        label="Locked in the pool forever"
        value={`${shares(lockedShares)} pool shares (${lockedShares.toString()} of the smallest unit), worth about ${coinAbout(s.locked.quote, q)} and ${tok(s.locked.token)} tokens at these amounts`}
        mono={false}
      />
      <Row label="Your share of the pool" value={shareText(pct)} mono={false} />
      {s.tokenWarnings.length > 0 && (
        <div className="space-y-1">
          <Notice tone="warn">Read these about this token first:</Notice>
          <ul className="list-disc pl-4 text-amber-300/90 space-y-0.5 [overflow-wrap:anywhere]">
            {s.tokenWarnings.map((w) => (
              <li key={w.code}>{w.text}</li>
            ))}
            {s.tokenWarnings.some((w) => w.code === 'mint-authority') && <li>{mintAuthorityLine(q)}</li>}
          </ul>
        </div>
      )}
      {s.notices.map((n) => (
        <Notice key={n} tone="warn">
          {n}
        </Notice>
      ))}
      <Notice>
        {!q.native
          ? `Your ${q.symbol} is spent straight from your own ${q.symbol} account. Nothing is wrapped. The fee to open and the account deposits are paid in SOL.`
          : s.unwrapsWsol
            ? 'Your SOL is wrapped into a token account for the opening, and that account is closed in the same transaction.'
            : `You already hold ${formatSol(s.wsolHeldBefore, 9)} wrapped SOL. None of it is spent.`}
      </Notice>
      {s.origin === 'other' && (
        <Notice tone="warn">
          Your wallet will show that this transaction needs a second signature. That is the new pool&apos;s own address: this
          page signs it after you, then forgets the key.
        </Notice>
      )}
    </>
  );
}

/**
 * How a venue swap's payout compares with what the aggregator was seen to pay while
 * preparing. "No route" is the aggregator's own answer; an aggregator that could not be
 * asked is said as that, never as having no route.
 */
function venueRouteText(s: Extract<TxSummary, { kind: 'venue-swap' }>): string {
  const a = s.aggregator;
  if (a.kind === 'no-route') return 'Jupiter has no route for this trade, so this pool is the only route';
  if (a.kind === 'unreachable') return 'Jupiter could not be asked just now, so this trade was not compared with it';
  if (a.kind === 'refused') {
    const failed = 'its transaction for this trade failed its test run, so it could not be sent';
    // By how much, against what THIS swap pays. A pool that has caught up since is not "more".
    if (a.out <= s.quoted.outAmount) return `Jupiter quoted no more than this pool pays, and ${failed}`;
    return `Jupiter quoted ${edgePercent(Number(a.out - s.quoted.outAmount) / Number(s.quoted.outAmount))} more, but ${failed}`;
  }
  const beside = a.when === 'now' ? 'Jupiter quoted just now' : 'the last quote Jupiter gave (it could not be asked again just now)';
  if (s.quoted.outAmount === a.out) return `the same as ${beside}, so the trade stays here`;
  return `${edgePercent(Number(s.quoted.outAmount - a.out) / Number(a.out))} more than ${beside}`;
}

/**
 * A swap in one of our pools from the swap page. The amounts are decoded from the
 * transaction; the pool, its tier and its pairing coin are from the read it was built on.
 * A token that is itself a pairing coin (BAYLA in a BAYLA and SOL pool) is named; any
 * other is "tokens", beside its mint.
 */
function VenueSwapRows({ summary: s }: { summary: Extract<TxSummary, { kind: 'venue-swap' }> }) {
  const q = s.coin;
  const tokenName = quoteCoin(s.tokenMint.toBase58())?.symbol ?? 'tokens';
  const tok = (v: bigint, exact = false) => `${exact ? unitsExact(v, s.tokenDecimals) : tokenText(v, s.tokenDecimals)} ${tokenName}`;
  const coin = (v: bigint, exact = false) => (exact ? coinExact(v, q) : coinAbout(v, q));
  const [pay, get] = s.paysCoin ? [coin, tok] : [tok, coin];
  return (
    <>
      <Row label="Pool" value={s.pool.toBase58()} />
      <Row label="Pool kind" value={poolKindText(s)} mono={false} />
      <Row label="Token (mint)" value={s.tokenMint.toBase58()} />
      <Row label="Paired with" value={q.symbol} mono={false} />
      <Row label="You pay" value={pay(s.amountIn, true)} />
      <Row label="You receive (quoted)" value={get(s.quoted.outAmount)} />
      <Row label="You receive at least" value={get(s.minimumAmountOut, true)} />
      <Row label="Pool fee (inside what you pay)" value={`${pay(s.quoted.result.tradeFee)} (${feeRateText(s.config.tradeFeeRate)})`} />
      <PoolCreatorFeeRow quote={s.quoted} buying={s.paysCoin} sol={(v) => coin(v)} tok={(v) => tok(v)} />
      {/* Measured against the pool's price before the trade, so the pool fee is inside it. */}
      <ImpactRows bps={fractionToBps(s.quoted.priceImpact)} label="Price impact (pool fee included)" />
      <Row label="Compared with Jupiter" value={venueRouteText(s)} mono={false} />
      {s.notices.map((n) => (
        <Notice key={n} tone="warn">
          {n}
        </Notice>
      ))}
      <Notice>
        {!q.native
          ? s.paysCoin
            ? `Your ${q.symbol} is spent straight from your own ${q.symbol} account. Nothing is wrapped.`
            : `The ${q.symbol} is paid straight into your own ${q.symbol} account. Nothing is wrapped.`
          : `${s.paysCoin ? 'Your SOL is wrapped into a token account for the swap' : 'The pool pays out wrapped SOL'}${
              s.unwrapsWsol
                ? ', and that account is closed at the end, so you get plain SOL back.'
                : '. You already had a wrapped SOL account, so it is left open with its balance.'
            }`}
      </Notice>
    </>
  );
}

/**
 * The plant this create pays (island ruling 2), read back out of the transaction itself:
 * half burned, half to the island's Workshop, both from the creator's own $BAYLA account.
 */
function CreatePlantRows({ plant }: { plant: Extract<TxSummary, { kind: 'create' }>['plant'] }) {
  const bayla = (v: bigint) => `${baylaText(v)} $BAYLA`;
  return (
    <>
      <Row label="Plant, in this transaction" value={bayla(plant.total)} mono={false} />
      <Row label="Burned" value={bayla(plant.burned)} mono={false} />
      <Row label="To the island's Workshop" value={bayla(plant.toWorkshop)} mono={false} />
      <Row label="Into its $BAYLA account" value={plant.workshopAccount.toBase58()} />
      <Row label="From your $BAYLA account" value={plant.from.toBase58()} />
    </>
  );
}

/**
 * One test-run token change, in words for whose it is and for what this kind of
 * transaction does with it. The plant's are always in $BAYLA; a pool's own pairing coin
 * is in that coin's decimals; every other account is in its own mint's decimals when the
 * builder knew them.
 */
function deltaRow(t: PreparedTx['simulated']['tokenDeltas'][number], prepared: PreparedTx, decimals: number | null) {
  const summary = prepared.summary;
  const sign = t.delta < 0n ? '-' : '+';
  const amount = t.delta < 0n ? -t.delta : t.delta;
  if (t.role === 'workshop') return { label: TEST_RUN_LABEL.workshop, value: `${sign}${baylaText(amount)} $BAYLA` };
  if (summary.kind === 'create' && t.role !== 'treasury' && t.mint.equals(summary.plant.mint)) {
    return { label: 'Test run: your $BAYLA changes by', value: `${sign}${baylaText(amount)}` };
  }
  // The pool's own coin (USDC, BAYLA) is known by its mint, not by the watch list's tag, and
  // both its name and its decimals come from the summary's coin. So a wrong or missing tag
  // cannot call it wrapped SOL, and a token with 9 decimals cannot make 250 USDC read as 0.25.
  // A swap from the swap page names its pool's coin the same way.
  const poolCoin = isLpSummary(summary) ? summary.quote : summary.kind === 'venue-swap' ? summary.coin : null;
  const coin = poolCoin && !poolCoin.native && t.mint.toBase58() === poolCoin.mint ? poolCoin : null;
  if (coin) return { label: `Test run: your ${coin.symbol} changes by`, value: `${sign}${tokenText(amount, coin.decimals)}` };
  return { label: testRunLabel(prepared.kind, t.role ?? 'token'), value: `${sign}${tokenText(amount, t.decimals ?? decimals)}` };
}

/**
 * The pool creator's cut, when the pool charges one. cp-swap takes it on top of the
 * trade fee: from what you pay, or from what you receive, depending on the pool.
 */
export function PoolCreatorFeeRow({
  quote,
  buying,
  sol,
  tok,
}: {
  quote: { result: { creatorFee: bigint }; creatorFeeOnInput: boolean };
  buying: boolean;
  sol: (v: bigint) => string;
  tok: (v: bigint) => string;
}) {
  const fee = quote.result.creatorFee;
  if (fee <= 0n) return null;
  const onInput = quote.creatorFeeOnInput;
  // Buying pays SOL and receives tokens; selling the other way round.
  const inSol = onInput === buying;
  return (
    <Row
      label={onInput ? 'Creator fee (on top, from what you pay)' : 'Creator fee (taken from what you receive)'}
      value={inSol ? sol(fee) : tok(fee)}
    />
  );
}

/** What each watched account's test-run line is called. No role = the signer's token. */
const TEST_RUN_LABEL: Record<TokenRole, string> = {
  treasury: 'Test run: the platform treasury receives',
  workshop: "Test run: the island's Workshop receives",
  token: 'Test run: your tokens change by',
  wsol: 'Test run: your wrapped SOL changes by',
  // Only for an account tagged as a pairing coin that is not the pool's own coin, which no
  // builder makes. The pool's own coin is named by `deltaRow`: "your USDC changes by".
  quote: 'Test run: your pairing coin changes by',
  lp: 'Test run: your pool shares change by',
};

/** The test-run line for an account, said for what this kind of transaction does with it. */
function testRunLabel(kind: TxKind, role: TokenRole): string {
  // An opening's `treasury` account is the pool program's fee account, owned by the team's vault.
  if (kind === 'lp-create' && role === 'treasury') return "Test run: the team's vault account gains, in SOL (the fee, plus any SOL that account was already holding)";
  return TEST_RUN_LABEL[role];
}

/** What the one-time account rent line is called, per kind. A Record, so a new kind must say. */
const RENT_ROW_LABEL: Record<TxKind, string> = {
  create: "One-time account rent (your token, its curve and vault, the treasury's token account, any token account of yours)",
  buy: 'One-time account rent',
  sell: 'One-time account rent',
  migrate: 'One-time account rent',
  'pool-buy': 'One-time account rent',
  'pool-sell': 'One-time account rent',
  'venue-swap': 'One-time deposit for your new token account (it stays in that account)',
  'lp-deposit': 'One-time deposit for your new token account (it stays in that account)',
  'lp-withdraw': 'One-time deposit for your new token account (it stays in that account)',
  'lp-create':
    "One-time account deposits: the new pool's own accounts (never returned) and your pool-share account (yours to close later)",
};

/**
 * The rent line's label for this transaction. Taking liquidity out of a USDC or BAYLA pool
 * can open the coin's own account as well as the token's (a SOL pool never keeps a new
 * account for its SOL), so the line names every account its amount pays for.
 */
function rentRowLabel(prepared: PreparedTx): string {
  const s = prepared.summary;
  if (s.kind === 'lp-withdraw' && !s.quote.native && s.quoteAccount && s.quoteAccount.rent > 0n) {
    return s.tokenAccountRent > 0n
      ? `One-time deposits for your new token account and your new ${s.quote.symbol} account (each stays in its own account)`
      : `One-time deposit for your new ${s.quote.symbol} account (it stays in that account)`;
  }
  return RENT_ROW_LABEL[prepared.kind];
}

export function FeeRows({ prepared, decimals }: { prepared: PreparedTx; decimals: number | null }) {
  const f = prepared.fees;
  const base = tradeLamports(prepared.summary);
  const share = base !== null && base > 0n ? sharePercent(f.priorityLamports, base) : null;
  return (
    <>
      <Row label="Network fee" value={SOL(f.baseLamports)} />
      <Row
        label="Priority fee"
        value={
          !f.priorityFeeRead
            ? 'none added'
            : `${SOL(f.priorityLamports)}${share ? ` (${share} of this trade)` : ''}`
        }
      />
      {!f.priorityFeeRead && (
        <Notice tone="warn">
          The current fee level could not be read, so no priority fee is added. It may take longer to land.
        </Notice>
      )}
      {f.newAccountRentLamports > 0n && (
        <Row label={rentRowLabel(prepared)} value={SOL(f.newAccountRentLamports)} />
      )}
      {prepared.kind === 'create' && (
        <p className="text-white/40 text-[10px]">
          The token details account&apos;s rent and the token details program&apos;s own fee are not in that line. The
          test run below includes everything.
        </p>
      )}
      <Row label="Test run: your SOL changes by" value={signedSol(prepared.simulated.signerLamportsDelta)} />
      {prepared.simulated.tokenDeltas
        .filter((t) => t.delta !== 0n)
        .map((t) => (
          <Row key={t.account.toBase58()} {...deltaRow(t, prepared, decimals)} />
        ))}
    </>
  );
}

const TITLES: Record<PreparedTx['kind'], string> = {
  create: 'Review your launch',
  buy: 'Review your buy',
  sell: 'Review your sell',
  migrate: 'Review: finish graduation',
  'pool-buy': 'Review your pool buy',
  'pool-sell': 'Review your pool sell',
  'venue-swap': 'Review your swap',
  'lp-deposit': 'Review: add liquidity',
  'lp-withdraw': 'Review: remove liquidity',
  'lp-create': 'Review: open a pool',
};

export function TxReview({
  prepared,
  decimals,
  display,
  extra,
  headingRef,
}: {
  prepared: PreparedTx;
  decimals: number | null;
  display: (s: string, max: number) => string;
  /** Anything the kind needs on top, such as the create flow's public-forever list. */
  extra?: ReactNode;
  /** Focus lands here when the review appears. */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const warnings = reviewWarnings(prepared.summary);
  const warningsId = useId();
  return (
    <div className="space-y-2" data-testid="tx-review">
      <h3 ref={headingRef} tabIndex={-1} aria-describedby={warnings.length > 0 ? warningsId : undefined} className="text-white font-semibold text-[12px] outline-none">
        {TITLES[prepared.kind]}
      </h3>
      {warnings.length > 0 && <ReviewWarnings id={warningsId} warnings={warnings} />}
      {extra}
      <SummaryRows summary={prepared.summary} decimals={decimals} display={display} />
      <div className="pt-2 space-y-1.5" style={DIVIDER}>
        <FeeRows prepared={prepared} decimals={prepared.kind === 'create' ? 6 : decimals} />
      </div>
      <Notice tone="good">Test run passed: the network ran this exact transaction without sending it.</Notice>
    </div>
  );
}

/** Beside the buttons: what a review that was built again says differently from the one being read. */
function ReviewChanged({ changed, boxRef }: { changed: NonNullable<ReviewState['replaced']>; boxRef: Ref<HTMLDivElement> }) {
  const k = changed.now.length;
  const g = changed.gone.length;
  const list = (items: string[]) => (
    <ul className="list-disc pl-4 space-y-0.5 [overflow-wrap:anywhere]">
      {items.map((line, i) => (
        <li key={`${i}:${line}`}>{line}</li>
      ))}
    </ul>
  );
  return (
    <div ref={boxRef} tabIndex={-1} role="alert" className="text-amber-300/90 space-y-1 outline-none" data-testid="tx-review-changed">
      {k === 0 && g === 0 ? (
        <p>
          This review was built again on fresh numbers, and this page cannot say it is the same as the one you were
          reading. Read it through again before you sign.
        </p>
      ) : (
        <>
          <p>
            This review was built again on fresh numbers.{' '}
            {k > 0
              ? `${k} ${k === 1 ? 'line reads' : 'lines read'} differently now:`
              : `${g === 1 ? 'This line is' : 'These lines are'} no longer on it:`}
          </p>
          {k > 0 && list(changed.now)}
          {k > 0 && g > 0 && <p>In place of:</p>}
          {g > 0 && list(changed.gone)}
          <p>Every other line reads as it did. Sign in wallet if this is still what you want.</p>
        </>
      )}
    </div>
  );
}

/** The line above the buttons: what Sign in wallet will do, or what it is doing. */
function signStatus(s: ReviewState): string {
  if (s.renewing) {
    return 'This review was too old to sign, so it is being built and test-run again on fresh numbers. Your wallet opens next only if every line still reads the same.';
  }
  if (s.checking) return 'Checking the network before your wallet opens…';
  if (s.expired) {
    return 'This review is too old to sign as it is. Sign in wallet builds it again on fresh numbers first: your wallet opens only if every line still reads the same. If any line reads differently, you are shown which.';
  }
  return 'Your wallet will show this transaction next. Sign only if it matches what is above.';
}

function SignatureRow({ signature }: { signature: string }) {
  return <Row label="Transaction signature" value={signature} />;
}

/** What a refused transaction cost: both fees are charged when the program refuses it. */
function feesSpentText(fees: PreparedTx['fees'] | null | undefined): string {
  if (!fees) return 'Nothing moved except the fees (the network fee and any priority fee).';
  const which = fees.priorityLamports > 0n ? 'the network fee and the priority fee' : 'the network fee';
  return `Nothing moved except the fees: ${SOL(fees.baseLamports + fees.priorityLamports)} (${which}).`;
}

/** What not to do while a sent transaction is unconfirmed: each kind's own risk in repeating it. */
function unknownLine(kind: TxKind | undefined): string {
  switch (kind) {
    case 'lp-withdraw':
      return 'It may still land. Taking liquidity out again now could take out more than you meant. Check again, or look it up on the explorer.';
    case 'lp-create':
      return 'It may still land. Opening a pool again now could open a second pool and pay the fee to open twice. Check again, or look it up on the explorer.';
    default:
      return 'It may still land. Sending again could make you pay twice. Check again, or look it up on the explorer.';
  }
}

const EXPIRED_TEXT ='Did not go through, and it can no longer go through. Nothing was charged. It is safe to try again.';

const NOT_SENT_COPY: Record<NotSent['stage'], string> = {
  gate: 'Not sent. The launch door did not open for this wallet, so nothing was uploaded, built or signed.',
  build: 'Not sent. We could not build this transaction.',
  simulate: 'Not sent. A test run of this transaction was refused, so we did not ask your wallet to sign it.',
  sign: 'Not sent. Your wallet did not sign it.',
  send: 'Not sent. The network turned it away before running it.',
};
/** A not-sent whose check could not run (NotSent.retry): no verdict on the transaction. */
const NOT_READ_COPY = 'Not sent. A check this transaction needs could not be run just now, so we did not ask your wallet to sign it. Asking again may work.';

export function TxOutcomeCard({
  outcome,
  explorerUrl,
  onRecheck,
  onReset,
  rechecking,
  boxRef,
  fees,
  checks = 0,
  kind,
}: {
  outcome: TxOutcome;
  /** `null` when there is no signature to link. */
  explorerUrl: string | null;
  onRecheck: () => void;
  onReset: () => void;
  rechecking: boolean;
  /** Focus lands here when the outcome appears. */
  boxRef?: Ref<HTMLDivElement>;
  /** The fees the transaction carried, so a refusal can say what it cost. */
  fees?: PreparedTx['fees'] | null;
  /** How many times Check again has answered. */
  checks?: number;
  /** What the transaction was for, when known: taking liquidity out again has its own risk to name. */
  kind?: TxKind;
}) {
  // Done is news; everything else needs the user to read it before acting.
  const a11y = {
    ref: boxRef,
    tabIndex: -1,
    role: outcome.status === 'confirmed' ? 'status' : 'alert',
    className: 'space-y-1.5 outline-none',
  } as const;
  switch (outcome.status) {
    case 'confirmed':
      return (
        <div {...a11y} data-testid="tx-outcome" data-status="confirmed">
          <Notice tone="good">Done. The network confirmed it.</Notice>
          <SignatureRow signature={outcome.signature} />
          {explorerUrl && <ExplorerLink href={explorerUrl} />}
          <button type="button" onClick={onReset} className="btn-secondary min-h-[44px] w-full py-2 text-[12px] mt-1">
            Close
          </button>
        </div>
      );
    case 'reverted':
      return (
        <div {...a11y} data-testid="tx-outcome" data-status="reverted">
          <Notice tone="bad">It did not go through. The network ran it and the program refused it.</Notice>
          {outcome.message && <Notice>{outcome.message}</Notice>}
          <Notice>{feesSpentText(fees)}</Notice>
          <SignatureRow signature={outcome.signature} />
          {explorerUrl && <ExplorerLink href={explorerUrl} />}
          <button type="button" onClick={onReset} className="btn-secondary min-h-[44px] w-full py-2 text-[12px] mt-1">
            Start over
          </button>
        </div>
      );
    case 'expired':
      return (
        <div {...a11y} data-testid="tx-outcome" data-status="expired">
          <Notice tone="warn">{EXPIRED_TEXT}</Notice>
          {outcome.signature && <SignatureRow signature={outcome.signature} />}
          <button type="button" onClick={onReset} className="btn-secondary min-h-[44px] w-full py-2 text-[12px] mt-1">
            Start over
          </button>
        </div>
      );
    case 'unknown':
      if (outcome.signature) {
        // The alert (what this is, what not to do) is read once, when it appears. What
        // each check found goes in the status line under it, so a new answer is read
        // out on its own, and pressing Check again does not re-read the whole alert.
        const found = rechecking
          ? 'Checking the network…'
          : checks > 0
            ? `Check ${checks}: ${outcome.message}`
            : outcome.message;
        return (
          <div className="space-y-1.5" data-testid="tx-outcome" data-status="unknown">
            <div ref={boxRef} tabIndex={-1} role="alert" className="space-y-1.5 outline-none">
              <Notice tone="warn">Sent, not confirmed yet. Do not retry until you check.</Notice>
              <Notice>{unknownLine(kind)}</Notice>
              <SignatureRow signature={outcome.signature} />
              {explorerUrl && <ExplorerLink href={explorerUrl} />}
            </div>
            <p role="status" className="text-white/55" data-testid="tx-check-result">
              {found}
            </p>
            <button
              type="button"
              // Not `disabled`: a button switched off under the keyboard drops focus to
              // the page. It stays focusable and does nothing while a check runs.
              aria-disabled={rechecking || undefined}
              onClick={() => {
                if (!rechecking) onRecheck();
              }}
              className={`btn-primary min-h-[44px] w-full py-2 text-[12px] mt-1 ${rechecking ? 'opacity-60' : ''}`}
            >
              Check again
            </button>
            <button type="button" onClick={onReset} className="btn-secondary min-h-[44px] w-full py-2 text-[12px]">
              I checked my wallet: start over
            </button>
          </div>
        );
      }
      return (
        <div {...a11y} data-testid="tx-outcome" data-status="unknown">
          <Notice tone="warn">We cannot tell whether this was sent.</Notice>
          <Notice>{outcome.message}</Notice>
          <button type="button" onClick={onReset} className="btn-secondary min-h-[44px] w-full py-2 text-[12px] mt-1">
            I checked my wallet: start over
          </button>
        </div>
      );
    case 'not-sent':
      return (
        <div {...a11y} data-testid="tx-outcome" data-status="not-sent">
          <Notice tone="warn">{outcome.retry ? NOT_READ_COPY : NOT_SENT_COPY[outcome.stage]}</Notice>
          {outcome.message && <Notice>{outcome.message}</Notice>}
          <Notice>Nothing was charged.</Notice>
          <button type="button" onClick={onReset} className="btn-secondary min-h-[44px] w-full py-2 text-[12px] mt-1">
            Start over
          </button>
        </div>
      );
  }
}

/**
 * The whole in-panel transaction flow: the building note, the review with its
 * Sign button, the waiting note, and the outcome. A panel renders this in place of
 * its form whenever the flow is not idle.
 */
export function TxFlowView({
  flow,
  api,
  cluster,
  decimals,
  signer,
  extraReview,
  preparingText,
}: {
  flow: TxFlow;
  /** `WriteApi` and `LpWriteApi` both satisfy it. */
  api: TxViewApi;
  cluster: SolanaCluster;
  decimals: number | null;
  /** `null` when no wallet that can sign is connected. */
  signer: TxSigner | null;
  extraReview?: ReactNode;
  /** What is happening while it builds, when that is more than building (the launch's upload request). */
  preparingText?: string;
}) {
  const s = flow.state;
  // One focus target per step. Moving focus both keeps keyboard users in place (the
  // form's button is gone) and makes a screen reader read the new step. Two reviews
  // are steps of their own: one that replaced the review being read (focus goes to
  // what reads differently, beside the buttons) and one whose Sign is switched off
  // (focus goes to the alert saying why; with Sign still on there is no such alert,
  // and focus stays where it is).
  const focusRef = useRef<HTMLElement | null>(null);
  const staleRef = useRef<HTMLParagraphElement | null>(null);
  const changedRef = useRef<HTMLDivElement | null>(null);
  const stepKey =
    s.step === 'outcome'
      ? `outcome:${s.outcome.status}`
      : s.step === 'review' && s.replaced
        ? `review:new:${s.replaced.n}`
        : s.step === 'review' && s.expired
          ? 'review:stale'
          : s.step;
  useEffect(() => {
    const target = stepKey === 'review:stale' ? staleRef : stepKey.startsWith('review:new:') ? changedRef : focusRef;
    target.current?.focus();
  }, [stepKey]);
  const setFocus = (el: HTMLElement | null) => {
    focusRef.current = el;
  };
  if (s.step === 'idle') return null;
  if (s.step === 'preparing') {
    return (
      <p ref={setFocus} tabIndex={-1} role="status" className="text-white/55 outline-none">
        {preparingText ?? 'Building the transaction and test-running it on the network…'}
      </p>
    );
  }
  if (s.step === 'review') {
    // Too old to sign, and its build may not run twice (the launch): only Start over is left.
    const dead = s.expired && !s.renewable;
    const working = s.checking || s.renewing;
    // The panel's `extraReview` is its own and does not come from the prepared
    // transaction, so the lines compared are the review's alone.
    const lines = (p: PreparedTx) => reviewLines(<TxReview prepared={p} decimals={decimals} display={api.meta.displaySafe} />);
    return (
      <div className="space-y-3">
        <TxReview
          prepared={s.prepared}
          decimals={decimals}
          display={api.meta.displaySafe}
          extra={extraReview}
          headingRef={setFocus}
        />
        {s.replaced && <ReviewChanged changed={s.replaced} boxRef={changedRef} />}
        {dead ? (
          <p ref={staleRef} tabIndex={-1} role="alert" className="text-amber-300/90 outline-none">
            This quote is too old to sign: the network would soon refuse it. Start over for a fresh one.
          </p>
        ) : signer === null ? (
          <Notice tone="warn">Connect a wallet that can sign to continue.</Notice>
        ) : (
          // One status line, changed in place so it is read out: the waits between Sign
          // and the wallet (the block height read, a stale review built again), and what
          // Sign will do on a review that is too old to sign as it is.
          <p role="status" className={s.expired ? 'text-amber-300/90' : 'text-white/40 text-[10px]'}>
            {signStatus(s)}
          </p>
        )}
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            className={`btn-primary min-h-[44px] w-full py-2.5 text-[13px] disabled:opacity-60 ${working ? 'opacity-60' : ''}`}
            disabled={dead || signer === null}
            aria-disabled={working || undefined}
            onClick={() => signer && !working && flow.confirm(signer, lines)}
          >
            Sign in wallet
          </button>
          <button type="button" className="btn-secondary min-h-[44px] w-full py-2.5 text-[13px]" onClick={flow.reset}>
            {s.expired ? 'Start over' : 'Cancel'}
          </button>
        </div>
      </div>
    );
  }
  if (s.step === 'submitting') {
    return (
      <p ref={setFocus} tabIndex={-1} role="status" className="text-white/55 outline-none">
        Waiting for your wallet. Approve the transaction there to send it.
      </p>
    );
  }
  if (s.step === 'sent') {
    const url = api.explorerTxUrl(s.signature, cluster);
    return (
      <div ref={setFocus} tabIndex={-1} role="status" className="space-y-1.5 outline-none" data-testid="tx-sent">
        <Notice>Sent. Waiting for the network to confirm it. This can take up to two minutes.</Notice>
        <Notice tone="warn">
          Do not send it again. If you leave or reload, this browser keeps a note of it, and the page checks it when you
          come back.
        </Notice>
        <SignatureRow signature={s.signature} />
        <ExplorerLink href={url} />
      </div>
    );
  }
  const sig = 'signature' in s.outcome ? s.outcome.signature : '';
  return (
    <TxOutcomeCard
      outcome={s.outcome}
      explorerUrl={sig ? api.explorerTxUrl(sig, cluster) : null}
      onRecheck={() => void flow.recheck()}
      onReset={flow.reset}
      rechecking={s.rechecking}
      boxRef={setFocus}
      fees={s.prepared?.fees ?? null}
      checks={s.checks ?? 0}
      kind={s.prepared?.kind}
    />
  );
}
