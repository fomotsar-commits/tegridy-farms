import { useEffect, useRef, type ReactNode, type Ref } from 'react';
import { describeTreasury, formatSol, formatTokenAmount } from '../../../lib/launcher/solana/curve';
import { ImpactRows, Notice, Row } from './ui';
import { DIVIDER, bpsPercent, fractionToBps, sharePercent } from './uiFormat';
import { feeSplit } from '../../../lib/solana/cpswap/venue';
import { feeRateText, formatSolPrice } from '../../../lib/solana/lp/format';
import type { FeeSplitView, PreparedTx, SolanaCluster, TokenRole, TxKind, TxOutcome, TxSigner, TxSummary, TxViewApi } from './ports';
import type { TxFlow } from './useTxFlow';

// What the user sees between pressing a Review button and the chain's answer.
// Every word here is about THIS transaction, and the numbers come from the
// prepared transaction, never from the form the user typed into.
//
// Screen readers: this view replaces the panel's form, so the button that had focus
// is gone. Each step moves focus to its own heading or notice (tabIndex -1), which
// also reads it out. Progress notes are role="status"; an outcome that needs the
// user's attention (refused, not sent, not confirmed) is role="alert". A review that
// goes stale moves focus to the alert saying so. A button whose work is running
// (Check again) stays focusable and says so in a status line, instead of switching
// off under the keyboard.

const SOL = (l: bigint) => `${formatSol(l)} SOL`;
const signedSol = (l: bigint) => `${l < 0n ? '-' : '+'}${SOL(l < 0n ? -l : l)}`;
function tokenText(v: bigint, d: number | null, maxFractionDigits?: number): string {
  const f = formatTokenAmount(v, d, maxFractionDigits);
  return f.isBaseUnits ? `${f.text} (base units)` : f.text;
}

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
    case 'create':
      return s.openingBuy ? s.openingBuy.quote.lamportsIn : null;
    case 'lp-deposit':
    case 'lp-withdraw':
      return s.quoted.sol;
    case 'lp-create':
      return s.put.sol;
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

// A bound the program enforces, or a count of pool shares, is printed to its last
// digit: rounding "at most" down, or "you get" either way, would misstate it.
const solExact = (l: bigint) => `${formatSol(l, 9)} SOL`;
const unitsExact = (v: bigint, d: number) => tokenText(v, d, d);

function poolKindText(s: LpSummary): string {
  switch (s.origin) {
    case 'launch-pool':
      return 'Launch pool: opened by the launch program at graduation';
    case 'standard':
      return s.config ? `Standard address for fee tier ${s.config.index}` : 'Standard address for its fee tier';
    case 'other':
      return 'Its own address';
  }
}

function feeTierText(config: LpSummary['config']): string {
  if (!config) return 'not read';
  return `${config.index}: traders pay ${feeRateText(config.tradeFeeRate)} a trade; LPs keep ${feeSplit(config).lpKeepsPct.toFixed(3)}% of each trade`;
}

/** A share of the pool, said as a percentage; a real share that rounds to nothing says so. */
function shareText(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return 'none';
  return pct < 0.01 ? '<0.01%' : `${pct.toFixed(2)}%`;
}

function priceText(p: Extract<TxSummary, { kind: 'lp-deposit' }>['price']): string {
  switch (p.state) {
    case 'agrees':
    case 'disagrees': {
      const d = (Math.abs(p.diff) * 100).toFixed(1);
      return p.against === 'outside'
        ? `${d}% ${p.diff >= 0 ? 'above' : 'below'} the outside price (Jupiter), read just now`
        : `${d}% from its own average over the last 30 minutes`;
    }
    case 'no-trades-yet':
      return 'nobody has traded since the launch program opened it';
    case 'empty-pool':
      return 'not checked: the pool is empty';
    case 'skipped':
    case 'unread':
      return `not checked (${p.detail})`;
  }
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
  const limited =
    s.limitedByBalance === 'token' ? ' (all the tokens you have)' : s.limitedByBalance === 'sol' ? ' (all the SOL you can spend)' : '';
  const unused = s.max.sol > s.quoted.sol ? s.max.sol - s.quoted.sol : 0n;
  return (
    <>
      <LpPoolRows summary={s} />
      <Row label="Fee tier" value={feeTierText(s.config)} mono={false} />
      <Row label="You put in about" value={`${SOL(s.quoted.sol)} and ${tok(s.quoted.token)} tokens`} />
      <Row label="At most" value={`${solExact(s.max.sol)} and ${unitsExact(s.max.token, s.tokenDecimals)} tokens${limited}`} />
      <Row label="You get" value={`${unitsExact(s.lpAmount, s.lpDecimals)} pool shares, exactly`} />
      <Row label="Your share of the pool" value={`${shareText(s.sharePct.before)} → ${shareText(s.sharePct.after)}`} />
      <Row label="Price check" value={priceText(s.price)} mono={false} />
      <Row label="Pool fee to add" value="none" mono={false} />
      {s.tokenWarnings.length > 0 && (
        <div className="space-y-1">
          <Notice tone="warn">Read these about this token first:</Notice>
          <ul className="list-disc pl-4 text-amber-300/90 space-y-0.5">
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
        {s.unwrapsWsol
          ? 'Your SOL is wrapped into a token account for the deposit, and the account is closed at the end, so anything not used comes back as plain SOL.'
          : `You already hold ${formatSol(s.wsolHeldBefore, 9)} wrapped SOL. It is left exactly as it is. Up to ${solExact(unused)} of this deposit that the pool does not use stays in that account as wrapped SOL; your wallet app can unwrap it.`}
      </Notice>
    </>
  );
}

function LpWithdrawRows({ summary: s }: { summary: Extract<TxSummary, { kind: 'lp-withdraw' }> }) {
  const tok = (v: bigint) => tokenText(v, s.tokenDecimals);
  const shares = (v: bigint) => unitsExact(v, s.lpDecimals);
  const ofYours = sharePercent(s.lpAmount, s.heldBefore);
  return (
    <>
      <LpPoolRows summary={s} />
      <Row label="Pool shares you give back" value={`${shares(s.lpAmount)}${ofYours ? ` (${ofYours} of yours)` : ''}`} />
      {s.all && <Notice>This is all of your share in this pool.</Notice>}
      <Row label="You get about" value={`${SOL(s.quoted.sol)} and ${tok(s.quoted.token)} tokens`} />
      <Row label="You get at least" value={`${solExact(s.min.sol)} and ${unitsExact(s.min.token, s.tokenDecimals)} tokens`} />
      <Row label="You keep" value={s.keep > 0n ? `${shares(s.keep)} pool shares` : 'none in this pool'} />
      <Row
        label="The tokens arrive in"
        value={`${s.tokenAccount.toBase58()}${
          s.tokenAccountRent > 0n
            ? ` (opened for you; its deposit of ${solExact(s.tokenAccountRent)} stays in that account)`
            : ''
        }`}
      />
      <Row label="The SOL arrives" value={s.unwrapsWsol ? 'as plain SOL' : 'as wrapped SOL in the account you already hold'} mono={false} />
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
const MINT_AUTHORITY_LINE = 'Whoever holds it can make new tokens at any time and sell them into your pool for its SOL.';

/** The opening price against the market, from the check that passed while preparing. */
function openingPriceText(p: Extract<TxSummary, { kind: 'lp-create' }>['price']): string {
  if ((p.state === 'agrees' || p.state === 'disagrees') && p.against === 'outside') {
    const d = (Math.abs(p.diff) * 100).toFixed(1);
    return `1 token = ${formatSolPrice(p.pool)} SOL. Market (Jupiter, read just now): ${formatSolPrice(p.reference)} SOL, ${d}% ${p.diff >= 0 ? 'above' : 'below'}`;
  }
  return priceText(p);
}

/** Opening a pool. Every value from the prepared transaction: the amounts from its bytes, the fee and rents as read while preparing. */
function LpCreateRows({ summary: s }: { summary: Extract<TxSummary, { kind: 'lp-create' }> }) {
  const tok = (v: bigint) => tokenText(v, s.tokenDecimals);
  const shares = (v: bigint) => unitsExact(v, s.lpDecimals);
  // The pool's share count less what the opener gets: the program's locked part.
  const lockedShares = s.supply - s.lpAmount;
  const pct = s.supply > 0n ? Number((s.lpAmount * 1_000_000n) / s.supply) / 10_000 : 0;
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
      <Row label="Fee tier" value={feeTierText(s.config)} mono={false} />
      {/* Sentences break only between words (mono={false}); only an address row breaks anywhere. */}
      <Row label="You put in" value={`${solExact(s.put.sol)} and ${unitsExact(s.put.token, s.tokenDecimals)} tokens, exactly`} mono={false} />
      <Row label="Opening price" value={openingPriceText(s.price)} mono={false} />
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
        value={`${shares(lockedShares)} pool shares (${lockedShares.toString()} of the smallest unit), worth about ${SOL(s.locked.sol)} and ${tok(s.locked.token)} tokens at these amounts`}
        mono={false}
      />
      <Row label="Your share of the pool" value={shareText(pct)} mono={false} />
      {s.tokenWarnings.length > 0 && (
        <div className="space-y-1">
          <Notice tone="warn">Read these about this token first:</Notice>
          <ul className="list-disc pl-4 text-amber-300/90 space-y-0.5">
            {s.tokenWarnings.map((w) => (
              <li key={w.code}>{w.text}</li>
            ))}
            {s.tokenWarnings.some((w) => w.code === 'mint-authority') && <li>{MINT_AUTHORITY_LINE}</li>}
          </ul>
        </div>
      )}
      {s.notices.map((n) => (
        <Notice key={n} tone="warn">
          {n}
        </Notice>
      ))}
      <Notice>
        {s.unwrapsWsol
          ? 'Your SOL is wrapped into a token account for the opening, and that account is closed in the same transaction.'
          : `You already hold ${formatSol(s.wsolHeldBefore, 9)} wrapped SOL. It is left exactly as it is.`}
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
  token: 'Test run: your tokens change by',
  wsol: 'Test run: your wrapped SOL changes by',
  lp: 'Test run: your pool shares change by',
};

/** The test-run line for an account, said for what this kind of transaction does with it. */
function testRunLabel(kind: TxKind, role: TokenRole): string {
  // An opening's `treasury` account is the pool program's fee account, owned by the team's vault.
  if (kind === 'lp-create' && role === 'treasury') return "Test run: the fee to open arrives at the team's vault (SOL)";
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
  'lp-deposit': 'One-time deposit for your new token account (it stays in that account)',
  'lp-withdraw': 'One-time deposit for your new token account (it stays in that account)',
  'lp-create':
    "One-time account deposits: the new pool's own accounts (never returned) and your pool-share account (yours to close later)",
};

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
        <Row label={RENT_ROW_LABEL[prepared.kind]} value={SOL(f.newAccountRentLamports)} />
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
          <Row
            key={t.account.toBase58()}
            label={testRunLabel(prepared.kind, t.role ?? 'token')}
            // Each account in its own mint's decimals when the builder knew them.
            value={`${t.delta < 0n ? '-' : '+'}${tokenText(t.delta < 0n ? -t.delta : t.delta, t.decimals ?? decimals)}`}
          />
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
  return (
    <div className="space-y-2" data-testid="tx-review">
      <h3 ref={headingRef} tabIndex={-1} className="text-white font-semibold text-[12px] outline-none">
        {TITLES[prepared.kind]}
      </h3>
      {extra}
      <SummaryRows summary={prepared.summary} decimals={decimals} display={display} />
      <div className="pt-2 space-y-1.5" style={DIVIDER}>
        <FeeRows prepared={prepared} decimals={prepared.kind === 'create' ? 6 : decimals} />
      </div>
      <Notice tone="good">Test run passed: the network ran this exact transaction without sending it.</Notice>
    </div>
  );
}

function ExplorerLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="underline text-white/80">
      View on the explorer
    </a>
  );
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

const NOT_SENT_COPY: Record<'build' | 'simulate' | 'sign' | 'send', string> = {
  build: 'Not sent. We could not build this transaction.',
  simulate: 'Not sent. A test run of this transaction was refused, so we did not ask your wallet to sign it.',
  sign: 'Not sent. Your wallet did not sign it.',
  send: 'Not sent. The network turned it away before running it.',
};

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
          <Notice tone="warn">{NOT_SENT_COPY[outcome.stage]}</Notice>
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
  // form's button is gone) and makes a screen reader read the new step. A review
  // going stale is a step of its own: its Sign button is switched off, so focus
  // moves to the alert that says why.
  const focusRef = useRef<HTMLElement | null>(null);
  const staleRef = useRef<HTMLParagraphElement | null>(null);
  const stepKey =
    s.step === 'outcome' ? `outcome:${s.outcome.status}` : s.step === 'review' && s.expired ? 'review:stale' : s.step;
  useEffect(() => {
    (stepKey === 'review:stale' ? staleRef.current : focusRef.current)?.focus();
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
    return (
      <div className="space-y-3">
        <TxReview
          prepared={s.prepared}
          decimals={decimals}
          display={api.meta.displaySafe}
          extra={extraReview}
          headingRef={setFocus}
        />
        {s.expired ? (
          <p ref={staleRef} tabIndex={-1} role="alert" className="text-amber-300/90 outline-none">
            This quote is too old to sign: the network would soon refuse it. Start over for a fresh one.
          </p>
        ) : signer === null ? (
          <Notice tone="warn">Connect a wallet that can sign to continue.</Notice>
        ) : (
          // A status line: between Sign and the wallet opening, the block height is read
          // (up to a few seconds), and this says so instead of nothing changing.
          <p role="status" className="text-white/40 text-[10px]">
            {s.checking
              ? 'Checking the network before your wallet opens…'
              : 'Your wallet will show this transaction next. Sign only if it matches what is above.'}
          </p>
        )}
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            className={`btn-primary min-h-[44px] w-full py-2.5 text-[13px] disabled:opacity-60 ${s.checking ? 'opacity-60' : ''}`}
            disabled={s.expired || signer === null}
            aria-disabled={s.checking || undefined}
            onClick={() => signer && !s.checking && flow.confirm(signer)}
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
