import { useCallback, useMemo, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { formatSol, parseDecimalToBaseUnits } from '../../../lib/launcher/solana/curve/format';
import { displaySafe } from '../../../lib/launchMetadata/validate';
import { sortMints, type AmmConfigView } from '../../../lib/solana/cpswap/program';
import { CREATOR_FEE_SWITCH, feeSplit } from '../../../lib/solana/cpswap/venue';
import { LOCKED_LP, feeReserveFor, planCreate, solSetAside, spendableSol, type CreatePlan, type CreateProblem } from '../../../lib/solana/lp/liquidityMath';
import { arbitrageLoss, assessOpening, matchMarket, mostBothAtMarket, openingSolPerToken } from '../../../lib/solana/lp/opening';
import type { OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { PRICE_TOLERANCE } from '../../../lib/solana/lp/poolHealth';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { formatSolPrice, tradeCostText } from '../../../lib/solana/lp/format';
import { Notice, Row } from '../curve/ui';
import { baseUnitsToInput } from '../curve/uiFormat';
import { TxFlowView } from '../curve/TxFlowView';
import { WalletNeeded } from '../curve/WalletNeeded';
import { useReturnFocus, useTxFlow, type OnSettled } from '../curve/useTxFlow';
import type { LpOpenGate, LpWriteApi, TierState, TierTerms } from '../curve/ports';
import { LpAmountPair, type LpSide } from './LpAmountPair';
import { LpBeforeYouOpen, LpReviewDisclosure } from './LpDisclosures';
import { PanelFrame } from './PanelFrame';
import { LOCKED_SHARES_TEXT, cannotFundText, sharePct, solAbout, solExact, tokensAbout, unitsExact, useDebounced, useFlowReports, useSettledAlert, useWalletFacts } from './panelKit';
import { createHeld, type CreateAdvice, type CreateOffer } from './offers';
import { useLpWrites, type LpWrites } from './useLpWrites';

const SOL_DECIMALS = 9;
const LP_DECIMALS = 9;
const MINT_AUTHORITY_LINE = 'Whoever holds it can make new tokens at any time and sell them into your pool for its SOL.';
const TOLERANCE_PCT = PRICE_TOLERANCE * 100;

// The same words as the builder's refusals (write/createPool.ts CREATE_COPY), said here
// before Review. The builder is not imported: this file is in the page's own bundle, and
// the write layer loads only through lpWriteApi.ts. The locked part is said in 9
// decimals, as every share count on this page is.
const TOO_SMALL = `Too small: the pool program keeps ${LOCKED_SHARES_TEXT} in every new pool forever, and this opening would not cover them. Put in more of either side.`;
const lockTooLarge = (pct: string) =>
  `Too small to be worth it: the ${LOCKED_SHARES_TEXT} the pool program keeps forever would be ${pct}% of this pool. Put in more, so that part is 0.1% or less.`;

/**
 * Why an open panel's Review is off when its card no longer offers an opening. 'held'
 * has its own line, and an unready tier has the tier's line.
 */
function offerOffLine(offer: CreateOffer): string | null {
  switch (offer) {
    case 'offer':
    case 'held':
      return null;
    default:
      return 'Opening a pool is off right now (the card above says why), so Review is off here.';
  }
}

/**
 * What an opening here adds to, said next to Review while the card offers one. A pool
 * that already exists never switches Review off: the opener is told, and chooses.
 */
function adviceLine(advice: CreateAdvice['kind']): string | null {
  switch (advice) {
    case 'none':
      return null;
    case 'opened-here':
      return 'You opened a pool for this token just now. Opening again makes a second, separate pool and pays the fee to open again.';
    case 'exists':
      return 'This token already has a pool that passes the checks (the card above names it). Opening here makes a separate pool: it does not share that pool’s liquidity or fees.';
  }
}
const rentBand = (most: string) =>
  `That would leave your wallet with too little SOL to pay the fee to open, the account deposits and stay open on the network. The most you can put in from this wallet is ${most}.`;

/** The locked part as a percent of the pool: three significant digits, more whenever three would read as 0.1 or less. */
function lockPct(supply: bigint): string {
  const x = (Number(LOCKED_LP) / Number(supply)) * 100;
  let digits = 3;
  let shown = Number(x.toPrecision(digits));
  while (shown <= 0.1 && digits < 15) shown = Number(x.toPrecision(++digits));
  return String(shown);
}

const gapText = (diff: number) => `${(Math.abs(diff) * 100).toFixed(1)}% ${diff >= 0 ? 'above' : 'below'}`;

const terms = (c: AmmConfigView): TierTerms => ({
  createPoolFee: c.createPoolFee,
  tradeFeeRate: c.tradeFeeRate,
  protocolFeeRate: c.protocolFeeRate,
  fundFeeRate: c.fundFeeRate,
  creatorFeeRate: c.creatorFeeRate,
});

/**
 * Open a new pool for one token on the public fee tier, in place inside its card
 * (SPEC_S2_CREATE 4.3). The person types both sides; the boxes never move each other.
 * Everything shown before Review is worked out from what the page read, for the preview
 * only: Review reads the tier, the fee account, the token, the market price and the
 * wallet again, and builds from those (write/createPool.ts `prepareLpCreate`).
 */
export function CreatePoolPanel(p: {
  mint: string;
  safety: TokenSafety;
  decimals: number | null;
  outside: OutsidePrice | null;
  outsideAt: number | null;
  tier: TierState | null;
  /** Whether the search found anything at the standard tier-1 address. Prepare decides for good. */
  standard: 'empty' | 'taken';
  /** The card's answer now. An open panel obeys it: Review only while it is `offer`. */
  offer: CreateOffer;
  /**
   * The pool the card points to first, if any. It never switches Review off: a panel left
   * open after its own opening, or after someone else's, says so next to Review instead.
   */
  advice: CreateAdvice['kind'];
  /** The card's inputs are being read again: Review waits for the new answer. */
  reading: boolean;
  onClose: () => void;
  onReread: () => void;
}) {
  const writes = useLpWrites();
  const gate = writes?.gate?.kind === 'open' ? writes.gate : null;
  if (!writes || !writes.api || !gate) return null;
  return <CreateInner {...p} writes={writes} api={writes.api} gate={gate} />;
}

function CreateInner({
  mint,
  safety,
  decimals,
  outside,
  outsideAt,
  tier,
  standard,
  offer,
  advice,
  reading,
  onClose,
  onReread,
  writes,
  api,
  gate,
}: Parameters<typeof CreatePoolPanel>[0] & { writes: LpWrites; api: LpWriteApi; gate: LpOpenGate }) {
  // The terms shown are the last ones read as ready. A re-read that finds the tier
  // changed shows the new terms; one that finds it gone keeps the panel (and any outcome
  // on it) and switches Review off.
  const readyConfig = tier?.kind === 'ready' ? tier.config : null;
  const [shownConfig, setShownConfig] = useState<AmmConfigView | null>(readyConfig);
  if (readyConfig && readyConfig !== shownConfig) setShownConfig(readyConfig);
  const config = readyConfig ?? shownConfig;

  const tokenProgram = safety.kind === 'read' && safety.facts?.program === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  const quoteIsToken0 = useMemo(() => sortMints(new PublicKey(WSOL_MINT), new PublicKey(mint)).token0.toBase58() === WSOL_MINT, [mint]);
  const signer = writes.signerState.kind === 'ready' ? writes.signerState.signer : null;
  const [factsNonce, setFactsNonce] = useState(0);
  const facts = useWalletFacts(writes, signer?.publicKey ?? null, { tokenMint: mint, tokenProgram, lpMint: null, opening: true }, factsNonce);

  const [boxes, setBoxes] = useState<{ sol: string; token: string }>({ sol: '', token: '' });
  const [driving, setDriving] = useState<LpSide | null>(null);

  const lastOutcome = useRef<string | null>(null);
  const { pending, remember, refreshCreateFacts } = writes;
  const onSettled = useCallback<OnSettled>(
    (outcome, prepared, sentSignature) => {
      lastOutcome.current = outcome.status;
      pending.record(outcome, prepared, sentSignature);
      if (outcome.status === 'confirmed' && prepared?.summary.kind === 'lp-create') {
        remember(prepared.summary.pool.toBase58(), prepared.summary.tokenMint.toBase58());
      }
    },
    [pending, remember],
  );
  const flow = useTxFlow(api, writes.rpc, onSettled, pending.sent);
  const { target: reviewRef, fallback: headingRef } = useReturnFocus(flow.state.step);
  const reread = useCallback(() => {
    setFactsNonce((n) => n + 1);
    // A refusal before signing is often "the terms changed": read the tier again too.
    if (lastOutcome.current === 'not-sent') refreshCreateFacts();
    // Opened: the amounts it opened with are spent. Nothing here may be reviewed again.
    if (lastOutcome.current === 'confirmed') {
      setBoxes({ sol: '', token: '' });
      setDriving(null);
    }
  }, [refreshCreateFacts]);
  useFlowReports(writes, flow.state.step, flow.locked, reread);

  const dec = decimals ?? 0;
  const sideDecimals = (s: LpSide) => (s === 'sol' ? SOL_DECIMALS : dec);
  const parse = (s: LpSide): bigint | null => {
    const t = boxes[s].trim();
    if (t === '' || (s === 'token' && decimals === null)) return null;
    return parseDecimalToBaseUnits(t, sideDecimals(s));
  };
  const solRaw = parse('sol');
  const tokRaw = parse('token');
  const bad = (s: LpSide) => boxes[s].trim() !== '' && (s === 'sol' ? solRaw : tokRaw) === null && !(s === 'token' && decimals === null);

  // What the wallet can put in, after the fee to open, the pool's own account deposits,
  // the pool-share account and two signatures' fees. Unread is null, never 0.
  const neverRefunded = facts?.kind === 'ok' ? (facts.rents.neverRefunded ?? null) : null;
  const lpRent = facts?.kind === 'ok' ? facts.rents.tokenAccount165 : null;
  const band =
    facts?.kind === 'ok' && config && neverRefunded !== null
      ? {
          walletFloor: facts.rents.walletFloor,
          feeReserve: feeReserveFor(2),
          lpAccountRent: facts.rents.tokenAccount165,
          wsolCreateRent: facts.wsol.exists ? 0n : facts.rents.tokenAccount165,
          alsoPaid: config.createPoolFee + neverRefunded,
        }
      : null;
  const availableSol = facts?.kind === 'ok' && band ? spendableSol({ lamports: facts.lamports, ...band }) : null;
  const setAside = band ? solSetAside(band) : null;
  const availableToken = facts?.kind === 'ok' ? (facts.token?.amount ?? 0n) : null;
  // Said before anything is typed: a wallet that can put nothing in is not left with a greyed-out Review.
  const cannotOpen = cannotFundText({
    doing: 'open a pool',
    forWhat: 'the fee to open, the account deposits and network fees',
    lamports: facts?.kind === 'ok' ? facts.lamports : null,
    setAside,
    availableSol,
    availableToken,
  });
  const market = outside?.kind === 'ok' ? outside.solPerToken : null;

  const both = solRaw !== null && tokRaw !== null && solRaw > 0n && tokRaw > 0n;
  const free = both ? planCreate({ quoteIsToken0, sol: solRaw, token: tokRaw, availableSol: null, availableToken: null }) : null;
  const preview: CreatePlan | null = free && !('problem' in free) ? free : null;
  const planned = both ? planCreate({ quoteIsToken0, sol: solRaw, token: tokRaw, availableSol, availableToken }) : null;
  const problem: CreateProblem | null = planned && 'problem' in planned ? planned : null;
  const check = assessOpening({ tokenMint: mint, sol: solRaw ?? 0n, token: tokRaw ?? 0n, tokenDecimals: decimals, outside, safety });
  const opening = both && decimals !== null ? openingSolPerToken(solRaw, tokRaw, decimals) : null;

  const setSide = (side: LpSide, v: bigint) => setBoxes((b) => ({ ...b, [side]: baseUnitsToInput(v, sideDecimals(side)) }));
  const onType = (side: LpSide, text: string) => {
    setBoxes((b) => ({ ...b, [side]: text }));
    setDriving(side);
  };
  const keep: LpSide | null = driving && (driving === 'sol' ? solRaw : tokRaw) ? driving : solRaw ? 'sol' : tokRaw ? 'token' : null;
  const matchTo = (k: LpSide | null) => {
    if (!k || market === null || decimals === null) return;
    const amount = k === 'sol' ? solRaw : tokRaw;
    if (!amount) return;
    const other = matchMarket({ keep: k, amount, solPerToken: market, tokenDecimals: decimals });
    if (other === null) return;
    setSide(k === 'sol' ? 'token' : 'sol', other);
    setDriving(k);
  };
  const canMatch = keep !== null && market !== null && decimals !== null;
  const mostBoth =
    availableSol !== null && availableToken !== null && market !== null && decimals !== null
      ? mostBothAtMarket({ spendableSol: availableSol, tokenBalance: availableToken, solPerToken: market, tokenDecimals: decimals })
      : null;
  const applyMostBoth = () => {
    if (!mostBoth) return;
    setBoxes({ sol: baseUnitsToInput(mostBoth.sol, SOL_DECIMALS), token: baseUnitsToInput(mostBoth.token, dec) });
  };

  // ── hints ──
  const tok = (v: bigint) => tokensAbout(v, dec);
  const hintFor = (side: LpSide): string => {
    if (!signer) return 'Connect a wallet to see what you can put in.';
    if (!facts) return 'Reading your wallet…';
    if (facts.kind === 'unread') return `You have: could not read (${facts.detail})`;
    if (side === 'token') return `You have ${unitsExact(availableToken ?? 0n, dec)} tokens.`;
    return availableSol === null
      ? `You have ${solExact(facts.lamports)}.`
      : `You have ${solExact(facts.lamports)}. Up to ${solExact(availableSol)} can go in after the fee to open, the account deposits and network fees.`;
  };
  const parseError = (side: LpSide) =>
    bad(side) ? (side === 'sol' ? 'That is not a SOL amount (at most 9 decimals).' : `That is not an amount this token can hold (at most ${dec} decimals).`) : null;

  // ── the problems line: one sentence ──
  let problemText = '';
  let fix: { label: string; run: () => void } | null = null;
  if (both && check.price.state === 'disagrees' && market !== null && decimals !== null) {
    const loss = arbitrageLoss({ sol: solRaw, token: tokRaw, tokenDecimals: decimals, marketSolPerToken: market });
    problemText = `Your opening price is ${gapText(check.price.diff)} the market price. Bots would trade against your pool as soon as it opens, taking about ${solAbout(BigInt(Math.round(loss)))} of what you put in. Pools opened from this site must start within ${TOLERANCE_PCT}% of the market.`;
    fix = { label: 'Match the market price', run: () => matchTo(keep) };
  } else if (problem?.problem === 'too-small') {
    problemText = TOO_SMALL;
  } else if (problem?.problem === 'lock-too-large') {
    problemText = lockTooLarge(lockPct(problem.supply));
  } else if (problem?.problem === 'overflow') {
    problemText = 'The amounts are too large for one transaction.';
  } else if (problem?.problem === 'over-balance' && problem.side === 'sol') {
    problemText = rentBand(solExact(problem.have));
    const have = problem.have;
    if (have > 0n) fix = { label: `Use ${solExact(have)}`, run: () => setSide('sol', have) };
  } else if (problem?.problem === 'over-balance' && problem.side === 'token') {
    problemText = `You have ${tok(problem.have)}; this needs ${tok(problem.need)}.`;
    if (mostBoth) fix = { label: 'Use the most both balances allow', run: applyMostBoth };
  }

  // ── the preview ──
  const fee = config?.createPoolFee ?? null;
  const status = useDebounced(
    preview && opening !== null ? `You would open the pool at 1 token = ${formatSolPrice(opening)} SOL and get ${unitsExact(preview.lp, LP_DECIMALS)} pool shares.` : '',
  );
  // Read out once typing settles, never on every keystroke (its numbers change with each digit).
  const alertText = useSettledAlert(problemText);
  const held = createHeld(pending.notes);
  const blockedByOther = writes.busy && flow.state.step === 'idle';
  const canReview =
    !!signer &&
    !!config &&
    readyConfig !== null &&
    decimals !== null &&
    both &&
    !!planned &&
    !problem &&
    check.verdict === 'allowed' &&
    !held &&
    offer === 'offer' &&
    !reading &&
    !flow.locked &&
    !blockedByOther;
  const review = () => {
    if (!canReview || !signer || !config || solRaw === null || tokRaw === null) return;
    void flow.prepare(() =>
      api.prepareLpCreate(writes.rpc, gate, writes.readers, {
        owner: signer.publicKey,
        tokenMint: new PublicKey(mint),
        sol: solRaw,
        token: tokRaw,
        shown: { terms: terms(config), standard },
      }),
    );
  };

  const warnings = safety.kind === 'read' && safety.verdict === 'warn' ? safety.warnings : [];
  const callsItself =
    safety.kind === 'read' && safety.verdict !== 'blocked' && (safety.name || safety.symbol)
      ? `${displaySafe(safety.name ?? '', 32)} (${displaySafe(safety.symbol ?? '', 12)})`
      : null;
  const wsolKept = facts?.kind === 'ok' && facts.wsol.exists && facts.wsol.amount > 0n;
  const confirmedPool =
    flow.state.step === 'outcome' && flow.state.outcome.status === 'confirmed' && flow.state.prepared?.summary.kind === 'lp-create'
      ? flow.state.prepared.summary.pool.toBase58()
      : null;
  // A pressed Read again for the market price: what the line said before, until the new answer is in.
  const marketKey = outside === null ? 'none' : outside.kind === 'ok' ? `ok:${outside.solPerToken}` : `${outside.kind}:${outside.detail}`;
  const [askedMarket, setAskedMarket] = useState<string | null>(null);
  const [saidMarket, setSaidMarket] = useState<'same' | 'changed' | null>(null);
  if (askedMarket !== null && !reading) {
    setAskedMarket(null);
    setSaidMarket(askedMarket === marketKey ? 'same' : 'changed');
  }
  const readMarketAgain = () => {
    if (reading) return;
    setAskedMarket(marketKey);
    setSaidMarket(null);
    onReread();
  };
  const priceState = check.price.state === 'agrees' || check.price.state === 'disagrees' || check.price.state === 'empty' ? check.price.state : 'unread';
  const readAt = outsideAt === null ? '' : `, read ${new Date(outsideAt).toLocaleTimeString('en-GB', { hour12: false })}`;

  return (
    <PanelFrame testId="lp-create-panel" title="Open a pool for this token" headingRef={headingRef}>
      <div className="space-y-1.5">
        <Row label="Token" value={mint} />
        {callsItself && (
          <>
            <Row label="Calls itself" value={callsItself} mono={false} />
            <p className="text-white/55">Check this is the token you mean: compare the address with the one its project publishes. Names can be copied.</p>
          </>
        )}
        {/* Opened with cp-swap's `initialize`, so the new pool never charges the tier's creator fee. */}
        <Row
          label="Fee tier"
          value={config ? `1: traders pay ${tradeCostText(config, CREATOR_FEE_SWITCH.publicOpen)}; LPs keep ${feeSplit(config).lpKeepsPct.toFixed(3)}% of each trade` : 'not read'}
          mono={false}
        />
        <Row label="Fee to open" value={fee === null ? 'not read' : `${formatSol(fee, 9)} SOL, paid to the team's vault (read just now)`} mono={false} />
        <Row
          label="Pool address"
          value={standard === 'empty' ? 'the standard address for fee tier 1' : 'a new address of its own (the standard address is already taken)'}
          mono={false}
        />
      </div>
      <LpBeforeYouOpen fee={fee ?? 0n} neverRefunded={neverRefunded} />
      {readyConfig === null && flow.state.step === 'idle' && (
        <Notice tone="warn">The public fee tier is not ready to open pools right now (see the card above), so Review is off.</Notice>
      )}
      {readyConfig !== null && flow.state.step === 'idle' && offerOffLine(offer) && <Notice tone="warn">{offerOffLine(offer)}</Notice>}
      {readyConfig !== null && flow.state.step === 'idle' && offer === 'offer' && adviceLine(advice) && (
        <div data-testid="lp-create-advice">
          <Notice tone="warn">{adviceLine(advice)}</Notice>
        </div>
      )}
      {confirmedPool && (
        <Notice>
          Your pool is open at <span className="font-mono break-all">{confirmedPool}</span>. Swaps can start one second after it landed.
        </Notice>
      )}
      {flow.state.step !== 'idle' ? (
        <TxFlowView
          flow={flow}
          api={api}
          cluster={gate.cfg.cluster}
          decimals={decimals}
          signer={signer}
          extraReview={<LpReviewDisclosure kind="create" />}
          preparingText="Reading the fee tier, the token and the market price again, then test-running your opening on the network…"
        />
      ) : (
        <>
          {warnings.length > 0 && (
            <div className="space-y-1">
              <Notice tone="warn">Read these about this token first:</Notice>
              <ul className="list-disc pl-4 text-amber-300/90 space-y-0.5">
                {warnings.map((w) => (
                  <li key={w.code}>{w.text}</li>
                ))}
                {warnings.some((w) => w.code === 'mint-authority') && <li>{MINT_AUTHORITY_LINE}</li>}
              </ul>
            </div>
          )}
          <div className="space-y-2" data-testid="lp-create-market">
            <p>
              {market !== null
                ? `Market price (Jupiter${readAt}): 1 token = ${formatSolPrice(market)} SOL.`
                : `Market price (Jupiter): could not be read (${outside && outside.kind !== 'ok' ? outside.detail : 'not read'}).`}
            </p>
            <button
              type="button"
              className="btn-secondary w-full sm:w-auto min-h-[44px] px-4 text-[13px] aria-disabled:opacity-60"
              aria-disabled={reading}
              onClick={readMarketAgain}
            >
              Read again
            </button>
            <p role="status" className="text-white/55 text-[11px]">
              {askedMarket !== null
                ? 'Reading the market price again…'
                : saidMarket === 'same'
                  ? 'Read again just now: the same answer.'
                  : saidMarket === 'changed'
                    ? 'Read again just now: the line above is new.'
                    : ''}
            </p>
          </div>
          <LpAmountPair
            sol={boxes.sol}
            token={boxes.token}
            driving={driving}
            tokenDecimals={decimals}
            linked={false}
            labels={{ sol: 'SOL to put in', token: 'Tokens to put in' }}
            onType={onType}
            onMax={(side) => {
              if (side === 'sol' && availableSol !== null) {
                setSide('sol', availableSol);
                setDriving('sol');
              }
              if (side === 'token' && availableToken !== null) {
                setSide('token', availableToken);
                setDriving('token');
              }
            }}
            canMax={{ sol: availableSol !== null, token: availableToken !== null && decimals !== null }}
            hints={{ sol: hintFor('sol'), token: hintFor('token') }}
            errors={{ sol: parseError('sol'), token: parseError('token') }}
          />
          <div className="space-y-2">
            <button
              type="button"
              className="btn-secondary w-full min-h-[44px] text-[13px] disabled:opacity-60"
              data-testid="lp-create-match"
              disabled={!canMatch}
              onClick={() => matchTo(keep)}
            >
              Match the market price
            </button>
            {mostBoth && (
              <button type="button" className="btn-secondary w-full min-h-[44px] text-[13px]" onClick={applyMostBoth}>
                Use the most both balances allow
              </button>
            )}
          </div>
          <p data-testid="lp-create-price" data-price={priceState}>
            {opening !== null && market !== null && (check.price.state === 'agrees' || check.price.state === 'disagrees')
              ? `Your opening price: 1 token = ${formatSolPrice(opening)} SOL. Market: ${formatSolPrice(market)} SOL. Yours is ${gapText(check.price.diff)} the market.${check.price.state === 'agrees' ? ' Close enough to the market.' : ''}`
              : opening !== null
                ? `Your opening price: 1 token = ${formatSolPrice(opening)} SOL. There is no market price to compare it with.`
                : 'Type both amounts to see your opening price.'}
          </p>
          {preview && config && (
            <div className="space-y-1.5" data-testid="lp-create-preview">
              <p className="text-white/45 text-[10px]">Worked out from what the page read; read and checked again when you press Review.</p>
              <Row label="You put in" value={`${solExact(solRaw ?? 0n)} and ${unitsExact(tokRaw ?? 0n, dec)} tokens, exactly`} mono={false} />
              <Row label="Fee to open" value={`${formatSol(config.createPoolFee, 9)} SOL, to the team's vault (not refundable)`} mono={false} />
              <Row
                label="Account deposits"
                value={
                  neverRefunded !== null && lpRent !== null
                    ? `about ${solAbout(neverRefunded)} kept by the pool's accounts forever, plus ${solExact(lpRent)} for your pool-share account (it comes back if you close that account later)`
                    : 'could not be read'
                }
                mono={false}
              />
              <Row label="You get" value={`${unitsExact(preview.lp, LP_DECIMALS)} pool shares`} mono={false} />
              <Row
                label="Locked in the pool forever"
                value={`${LOCKED_SHARES_TEXT}, worth about ${solExact(preview.locked.sol)} and ${unitsExact(preview.locked.token, dec)} tokens`}
                mono={false}
              />
              <Row label="Your share of the pool" value={sharePct(preview.lp, preview.supply)} mono={false} />
              <Row
                label="In all, from your wallet"
                value={
                  neverRefunded !== null && lpRent !== null
                    ? `about ${solAbout((solRaw ?? 0n) + config.createPoolFee + neverRefunded + lpRent)}, plus the network fee`
                    : 'could not be worked out (the account deposits could not be read)'
                }
                mono={false}
              />
              <Row label="Trading opens" value="right away" mono={false} />
            </div>
          )}
          <WalletNeeded state={writes.signerState} />
          {/* Always there, so a new problem is read out the moment it appears. */}
          <div className="space-y-2">
            <p role="alert" className="text-rose-300/90">
              {alertText}
            </p>
            {fix && (
              <button type="button" className="btn-secondary w-full min-h-[44px] text-[12px]" onClick={fix.run}>
                {fix.label}
              </button>
            )}
          </div>
          {cannotOpen && (
            <div data-testid="lp-create-cannot">
              <Notice tone="warn">{cannotOpen}</Notice>
            </div>
          )}
          {held && <Notice tone="warn">A pool you opened is not confirmed yet (see the top of this section), so opening another is off.</Notice>}
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              ref={reviewRef}
              type="button"
              className="btn-primary w-full min-h-[44px] text-[13px] disabled:opacity-60"
              disabled={!canReview}
              onClick={review}
            >
              Review: open the pool
            </button>
            <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" onClick={onClose}>
              Close
            </button>
          </div>
          <p className="text-white/40 text-[10px]">
            {wsolKept && facts?.kind === 'ok'
              ? `You already hold ${unitsExact(facts.wsol.amount, 9)} wrapped SOL. None of it is spent.`
              : 'Your SOL is wrapped into a token account for the opening, and that account is closed in the same transaction.'}
          </p>
        </>
      )}
      <p role="status" className="sr-only">
        {flow.state.step === 'idle' ? status : ''}
      </p>
    </PanelFrame>
  );
}
