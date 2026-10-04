import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { formatSol, parseDecimalToBaseUnits } from '../../../lib/launcher/solana/curve/format';
import { displaySafe } from '../../../lib/launchMetadata/validate';
import { sortMints, type AmmConfigView } from '../../../lib/solana/cpswap/program';
import { CREATOR_FEE_SWITCH, feeSplit } from '../../../lib/solana/cpswap/venue';
import { LOCKED_LP, feeReserveFor, planCreate, solSetAside, spendableSol, type CreatePlan, type CreateProblem } from '../../../lib/solana/lp/liquidityMath';
import { arbitrageLoss, assessOpening, matchMarket, mostBothAtMarket, openingPricePerToken } from '../../../lib/solana/lp/opening';
import { priceInQuote, type OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { PRICE_TOLERANCE } from '../../../lib/solana/lp/poolHealth';
import { SOL_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { formatSolPrice, tradeCostText } from '../../../lib/solana/lp/format';
import { Notice, Row } from '../curve/ui';
import { SHADOW, TOGGLE_CLS, baseUnitsToInput } from '../curve/uiFormat';
import { TxFlowView } from '../curve/TxFlowView';
import { WalletNeeded } from '../curve/WalletNeeded';
import { useReturnFocus, useTxFlow, type OnSettled } from '../curve/useTxFlow';
import type { LpOpenGate, LpWriteApi, TierState, TierTerms } from '../curve/ports';
import { FundingNextStep } from './FundingNextStep';
import { LpAmountPair, type LpSide } from './LpAmountPair';
import { CoinRiskNotice, LpBeforeYouOpen, LpReviewDisclosure } from './LpDisclosures';
import { PanelFrame } from './PanelFrame';
import { LOCKED_SHARES_TEXT, NOTES_BELOW, cannotFundText, coinAbout, coinExact, reviewOffWhy, sharePct, solAbout, solExact, tokensAbout, unitsExact, useDebounced, useFlowReports, useSettledAlert, useWalletFacts } from './panelKit';
import { createHeld, type CreateOffer, type PairFacts } from './offers';
import { useLpWrites, type LpWrites } from './useLpWrites';

const LP_DECIMALS = 9;
/** What a live mint authority can do to the new pool: the pool holds the pairing coin, so that is what is at risk. */
const mintAuthorityLine = (coin: QuoteCoin) => `Whoever holds it can make new tokens at any time and sell them into your pool for its ${coin.symbol}.`;
const TOLERANCE_PCT = PRICE_TOLERANCE * 100;

// The same words as the builder's refusals (write/createPool.ts CREATE_COPY), said here
// before Review. The builder is not imported: this file is in the page's own bundle, and
// the write layer loads only through lpWriteApi.ts. The locked part is said in 9
// decimals, as every share count on this page is.
const TOO_SMALL = `Too small: the pool program keeps ${LOCKED_SHARES_TEXT} in every new pool forever, and this opening would not cover them. Put in more of either side.`;
const lockTooLarge = (pct: string) =>
  `Too small to be worth it: the ${LOCKED_SHARES_TEXT} the pool program keeps forever would be ${pct}% of this pool. Put in more, so that part is 0.1% or less.`;

/** A token that can be paired with nothing (SOL itself) still draws the form, on SOL, with Review off elsewhere. */
const NO_PAIR: PairFacts = { coin: SOL_QUOTE, advice: { kind: 'none' }, hasPool: false, standard: 'empty' };

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
 *
 * It follows the CHOSEN coin: a pool paired with SOL is not a pool to add to for someone
 * opening the first USDC pool, so it is not said to them. `named` puts the coin in the
 * sentence: always for a coin that is not SOL, and for SOL once another coin has a pool
 * of its own to point to (then "a pool" would not say which).
 */
function adviceLine(pair: PairFacts, named: boolean): string | null {
  const a = named ? `a ${pair.coin.symbol} pool` : 'a pool';
  switch (pair.advice.kind) {
    case 'none':
      return null;
    case 'opened-here':
      return `You opened ${a} for this token just now. Opening again makes a second, separate pool and pays the fee to open again.`;
    case 'exists':
      return `This token already has ${a} that passes the checks (the card above names it). Opening here makes a separate pool: it does not share that pool’s liquidity or fees.`;
  }
}

/**
 * For a coin that is not SOL and has no pool yet: that this would be the first pool
 * paired with it. A cut pool list (offers.ts `poolListCut`) never says "the first": a
 * pool that was not read may be paired with this coin.
 */
function firstLine(pair: PairFacts, cut: boolean): string | null {
  if (pair.coin.native || pair.hasPool || pair.advice.kind !== 'none') return null;
  const coin = pair.coin.symbol;
  return cut
    ? `None of the pools read for this token is paired with ${coin}. This token has more pools than our pool index lists, so one that was not read may be.`
    : `No pool pairs this token with ${coin} yet. Yours would be the first.`;
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

/** One price read, as one string: two reads that give the same string said the same thing. */
const priceKey = (p: OutsidePrice | null) => (p === null ? 'none' : p.kind === 'ok' ? `ok:${p.solPerToken}` : `${p.kind}:${p.detail}`);

/**
 * Open a new pool for one token on the public fee tier, in place inside its card
 * (SPEC_S2_CREATE 4.3). The person types both sides; the boxes never move each other.
 * Everything shown before Review is worked out from what the page read, for the preview
 * only: Review reads the tier, the fee account, the token, the market price and the
 * wallet again, and builds from those (write/createPool.ts `prepareLpCreate`).
 *
 * THE PAIRING COIN. The opener chooses what the token is paired with (quotes.ts: SOL,
 * USDC or BAYLA, as far as the token allows). Everything on the coin's side is in THAT
 * coin: its box is parsed and printed in the coin's own decimals, the wallet is read for
 * it, the market price is the token's price in it, and the pool to add to first and the
 * standard address are that pair's own. Nothing read or typed for one coin is ever shown
 * under another: a change of coin empties the boxes and drops the old coin's answers.
 * The fee to open, the account deposits and the network fee are SOL whatever the coin.
 */
export function CreatePoolPanel(p: {
  mint: string;
  safety: TokenSafety;
  decimals: number | null;
  /** The TOKEN's market price, in SOL. A coin that is not SOL has its own price read here. */
  outside: OutsidePrice | null;
  outsideAt: number | null;
  tier: TierState | null;
  /**
   * One entry per coin this token can be paired with, SOL first (offers.ts `pairFacts`):
   * that pair's own pool to add to first, and whether its standard address is free.
   * Neither ever switches Review off. The pool to add to is said next to Review instead,
   * for the coin that is chosen.
   */
  pairs: readonly PairFacts[];
  /** The pool index cut its list: a new pool is then never called "the first". */
  cut: boolean;
  /** The card's answer now. An open panel obeys it: Review only while it is `offer`. */
  offer: CreateOffer;
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
  pairs,
  cut,
  offer,
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

  // The coin the pool is paired with. It starts on SOL, the first in rank order.
  const [picked, setPicked] = useState<string | null>(null);
  const pair = pairs.find((x) => x.coin.mint === picked) ?? pairs[0] ?? NO_PAIR;
  const coin = pair.coin;

  const tokenProgram = safety.kind === 'read' && safety.facts?.program === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  const quoteIsToken0 = useMemo(() => sortMints(new PublicKey(coin.mint), new PublicKey(mint)).token0.toBase58() === coin.mint, [mint, coin.mint]);
  const signer = writes.signerState.kind === 'ready' ? writes.signerState.signer : null;
  const [factsNonce, setFactsNonce] = useState(0);
  // Asked for the chosen coin. The answer is kept only for the coin it was asked about,
  // so right after a change of coin this is null ("reading"), never the other coin's.
  const facts = useWalletFacts(writes, signer?.publicKey ?? null, { tokenMint: mint, tokenProgram, lpMint: null, opening: true, quote: coin }, factsNonce);

  const [boxes, setBoxes] = useState<{ quote: string; token: string }>({ quote: '', token: '' });
  const [driving, setDriving] = useState<LpSide | null>(null);

  // ── the coin's own market price ──
  // The page has the TOKEN's price in SOL. A pool paired with USDC or BAYLA is priced in
  // that coin, which takes the coin's own price in SOL too: read here, when the coin is
  // chosen, and again whenever the card reads its own inputs again (so the two prices are
  // of one moment). SOL needs none. The answer is kept with the coin it is for.
  const [coinAsk, setCoinAsk] = useState(0);
  const [seenReading, setSeenReading] = useState(reading);
  if (seenReading !== reading) {
    setSeenReading(reading);
    if (reading) setCoinAsk((n) => n + 1);
  }
  const coinKey = coin.native ? null : `${coin.mint}#${coinAsk}`;
  const [coinPrice, setCoinPrice] = useState<{ key: string; mint: string; price: OutsidePrice } | null>(null);
  const { readers } = writes;
  useEffect(() => {
    if (!coinKey) return;
    let live = true;
    const done = (price: OutsidePrice) => {
      if (live) setCoinPrice({ key: coinKey, mint: coin.mint, price });
    };
    readers.outsidePrice(coin.mint, coin.decimals).then(done, (e: unknown) => done({ kind: 'unread', detail: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [readers, coinKey, coin.mint, coin.decimals]);
  // Only ever the chosen coin's own price: another coin's is not a price of this one.
  const coinOutside = !coin.native && coinPrice?.mint === coin.mint ? coinPrice.price : null;
  // Being read, for the first time or again: Review waits for the answer.
  const coinReading = !coin.native && coinPrice?.key !== coinKey;

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
      setBoxes({ quote: '', token: '' });
      setDriving(null);
    }
  }, [refreshCreateFacts]);
  useFlowReports(writes, flow.state.step, flow.locked, reread);

  // Every amount on the coin's side is in the CHOSEN coin's decimals: 9 for SOL, 6 for
  // USDC and BAYLA. Read in another coin's, a typed 50 would be a thousand times off.
  const dec = decimals ?? 0;
  const sideDecimals = (s: LpSide) => (s === 'quote' ? coin.decimals : dec);
  const parse = (s: LpSide): bigint | null => {
    const t = boxes[s].trim();
    if (t === '' || (s === 'token' && decimals === null)) return null;
    return parseDecimalToBaseUnits(t, sideDecimals(s));
  };
  const quoteRaw = parse('quote');
  const tokRaw = parse('token');
  const bad = (s: LpSide) => boxes[s].trim() !== '' && (s === 'quote' ? quoteRaw : tokRaw) === null && !(s === 'token' && decimals === null);

  // What the wallet must keep back in SOL: the fee to open, the pool's own account
  // deposits, the pool-share account and two signatures' fees. A SOL opening also opens a
  // wrapped-SOL account; any other coin wraps nothing. Unread is null, never 0.
  const neverRefunded = facts?.kind === 'ok' ? (facts.rents.neverRefunded ?? null) : null;
  const lpRent = facts?.kind === 'ok' ? facts.rents.tokenAccount165 : null;
  const lamports = facts?.kind === 'ok' ? facts.lamports : null;
  const band =
    facts?.kind === 'ok' && config && neverRefunded !== null
      ? {
          walletFloor: facts.rents.walletFloor,
          feeReserve: feeReserveFor(2),
          lpAccountRent: facts.rents.tokenAccount165,
          wsolCreateRent: coin.native && !facts.wsol.exists ? facts.rents.tokenAccount165 : 0n,
          alsoPaid: config.createPoolFee + neverRefunded,
        }
      : null;
  const setAside = band ? solSetAside(band) : null;
  // What can go in on the coin's side. SOL: what is left after everything above. Any
  // other coin: the wallet's balance of that coin, from its own account for it (no account
  // there is a real 0; an answer with no coin read in it is unread, never 0).
  const availableQuote =
    facts?.kind !== 'ok' ? null : coin.native ? (band ? spendableSol({ lamports: facts.lamports, ...band }) : null) : facts.coin ? facts.coin.amount : null;
  // A coin that is not SOL puts no SOL in, but the wallet's SOL must still cover the costs
  // (the write layer's own rule, `lamports < setAside`). Short of it, Review is off.
  const solShort = !coin.native && lamports !== null && setAside !== null && lamports < setAside;
  const availableToken = facts?.kind === 'ok' ? (facts.token?.amount ?? 0n) : null;
  // Said before anything is typed: a wallet that can put nothing in is not left with a greyed-out Review.
  const cannotOpen = cannotFundText({
    doing: 'open a pool',
    forWhat: 'the fee to open, the account deposits and network fees',
    quote: coin,
    lamports,
    setAside,
    availableQuote,
    availableToken,
  });
  // The token's market price in the chosen coin: Jupiter's SOL price for SOL, and that
  // over the coin's own SOL price for any other coin. Null while either is not read.
  const quoted = outside ? priceInQuote(outside, coin, coinOutside) : null;
  const market = quoted?.kind === 'ok' ? quoted.perToken : null;

  const both = quoteRaw !== null && tokRaw !== null && quoteRaw > 0n && tokRaw > 0n;
  const free = both ? planCreate({ quoteIsToken0, quote: quoteRaw, token: tokRaw, availableQuote: null, availableToken: null }) : null;
  const preview: CreatePlan | null = free && !('problem' in free) ? free : null;
  const planned = both ? planCreate({ quoteIsToken0, quote: quoteRaw, token: tokRaw, availableQuote, availableToken }) : null;
  const problem: CreateProblem | null = planned && 'problem' in planned ? planned : null;
  const check = assessOpening({ tokenMint: mint, quote: coin, quoteAmount: quoteRaw ?? 0n, token: tokRaw ?? 0n, tokenDecimals: decimals, outside, coinOutside, safety });
  const opening = both && decimals !== null ? openingPricePerToken(quoteRaw, tokRaw, decimals, coin) : null;

  const setSide = (side: LpSide, v: bigint) => setBoxes((b) => ({ ...b, [side]: baseUnitsToInput(v, sideDecimals(side)) }));
  const onType = (side: LpSide, text: string) => {
    setBoxes((b) => ({ ...b, [side]: text }));
    setDriving(side);
  };
  const keep: LpSide | null = driving && (driving === 'quote' ? quoteRaw : tokRaw) ? driving : quoteRaw ? 'quote' : tokRaw ? 'token' : null;
  const matchTo = (k: LpSide | null) => {
    if (!k || market === null || decimals === null) return;
    const amount = k === 'quote' ? quoteRaw : tokRaw;
    if (!amount) return;
    const other = matchMarket({ keep: k, amount, pricePerToken: market, tokenDecimals: decimals, quote: coin });
    if (other === null) return;
    setSide(k === 'quote' ? 'token' : 'quote', other);
    setDriving(k);
  };
  const canMatch = keep !== null && market !== null && decimals !== null;
  const mostBoth =
    availableQuote !== null && availableToken !== null && market !== null && decimals !== null
      ? mostBothAtMarket({ spendableQuote: availableQuote, tokenBalance: availableToken, pricePerToken: market, tokenDecimals: decimals, quote: coin })
      : null;
  const applyMostBoth = () => {
    if (!mostBoth) return;
    setBoxes({ quote: baseUnitsToInput(mostBoth.quote, coin.decimals), token: baseUnitsToInput(mostBoth.token, dec) });
  };

  // ── hints ──
  const tok = (v: bigint) => tokensAbout(v, dec);
  const hintFor = (side: LpSide): string => {
    if (!signer) return 'Connect a wallet to see what you can put in.';
    if (!facts) return 'Reading your wallet…';
    if (facts.kind === 'unread') return `You have: could not read (${facts.detail})`;
    if (side === 'token') return `You have ${unitsExact(availableToken ?? 0n, dec)} tokens.`;
    if (coin.native) {
      return availableQuote === null
        ? `You have ${solExact(facts.lamports)}.`
        : `You have ${solExact(facts.lamports)}. Up to ${solExact(availableQuote)} can go in after the fee to open, the account deposits and network fees.`;
    }
    return availableQuote === null ? `You have: could not read (this wallet’s ${coin.symbol} was not read)` : `You have ${coinExact(availableQuote, coin)}.`;
  };
  const parseError = (side: LpSide) =>
    bad(side)
      ? side === 'quote'
        ? `That is not a ${coin.symbol} amount (at most ${coin.decimals} decimals).`
        : `That is not an amount this token can hold (at most ${dec} decimals).`
      : null;

  // ── the problems line: one sentence ──
  let problemText = '';
  let fix: { label: string; run: () => void } | null = null;
  if (both && check.price.state === 'disagrees' && market !== null && decimals !== null) {
    const loss = arbitrageLoss({ quoteAmount: quoteRaw, token: tokRaw, tokenDecimals: decimals, marketPricePerToken: market, quote: coin });
    problemText = `Your opening price is ${gapText(check.price.diff)} the market price. Bots would trade against your pool as soon as it opens, taking about ${coinAbout(BigInt(Math.round(loss)), coin)} of what you put in. Pools opened from this site must start within ${TOLERANCE_PCT}% of the market.`;
    fix = { label: 'Match the market price', run: () => matchTo(keep) };
  } else if (problem?.problem === 'too-small') {
    problemText = TOO_SMALL;
  } else if (problem?.problem === 'lock-too-large') {
    problemText = lockTooLarge(lockPct(problem.supply));
  } else if (problem?.problem === 'overflow') {
    problemText = 'The amounts are too large for one transaction.';
  } else if (problem?.problem === 'over-balance' && problem.side === 'quote') {
    // SOL: what is left after the costs. Any other coin: the wallet's balance of it.
    problemText = coin.native ? rentBand(solExact(problem.have)) : `You have ${coinExact(problem.have, coin)}; this needs ${coinExact(problem.need, coin)}.`;
    const have = problem.have;
    // The coin side now drives: left on the token side, "Match the market price" put the
    // coin straight back over the limit and the two fixes undid each other for ever.
    if (have > 0n) {
      fix = {
        label: `Use ${coinExact(have, coin)}`,
        run: () => {
          setSide('quote', have);
          setDriving('quote');
        },
      };
    }
  } else if (problem?.problem === 'over-balance' && problem.side === 'token') {
    problemText = `You have ${tok(problem.have)}; this needs ${tok(problem.need)}.`;
    if (mostBoth) fix = { label: 'Use the most both balances allow', run: applyMostBoth };
  }

  // ── the preview ──
  const fee = config?.createPoolFee ?? null;
  const status = useDebounced(
    preview && opening !== null ? `You would open the pool at 1 token = ${formatSolPrice(opening)} ${coin.symbol} and get ${unitsExact(preview.lp, LP_DECIMALS)} pool shares.` : '',
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
    !solShort &&
    !held &&
    offer === 'offer' &&
    !reading &&
    !coinReading &&
    !flow.locked &&
    !blockedByOther;
  const review = () => {
    if (!canReview || !signer || !config || quoteRaw === null || tokRaw === null) return;
    void flow.prepare(() =>
      api.prepareLpCreate(writes.rpc, gate, writes.readers, {
        owner: signer.publicKey,
        tokenMint: new PublicKey(mint),
        // The chosen coin, and its amount in that coin's own base units.
        quoteMint: new PublicKey(coin.mint),
        quote: quoteRaw,
        token: tokRaw,
        shown: { terms: terms(config), standard: pair.standard },
      }),
    );
  };

  const warnings = safety.kind === 'read' && safety.verdict === 'warn' ? safety.warnings : [];
  const walletReady = writes.signerState.kind === 'ready';
  // An amount that does not parse has its own line under its box: it is not "type both amounts".
  const reviewWhy = reviewOffWhy({ hasWallet: !!signer, cannot: cannotOpen !== null, hasAmounts: both || bad('quote') || bad('token'), amountsWord: 'both amounts' });
  // A coin whose own price is missing: which price it is, said beside the Review it switches off.
  const coinPriceWhy = coin.native
    ? null
    : coinOutside === null || coinReading
      ? `Review is off while the price of ${coin.symbol} is read: your opening price is checked in ${coin.symbol}.`
      : coinOutside.kind !== 'ok'
        ? `Review is off: the price of ${coin.symbol} could not be read, so your opening price cannot be checked in ${coin.symbol}. Press Read the market price again.`
        : null;
  const callsItself =
    safety.kind === 'read' && safety.verdict !== 'blocked' && (safety.name || safety.symbol)
      ? `${displaySafe(safety.name ?? '', 32)} (${displaySafe(safety.symbol ?? '', 12)})`
      : null;
  const wsolKept = coin.native && facts?.kind === 'ok' && facts.wsol.exists && facts.wsol.amount > 0n;
  const confirmedPool =
    flow.state.step === 'outcome' && flow.state.outcome.status === 'confirmed' && flow.state.prepared?.summary.kind === 'lp-create'
      ? flow.state.prepared.summary.pool.toBase58()
      : null;
  // A pressed Read again for the market price: what the line said before, until the new
  // answer is in. For a coin that is not SOL the answer is both prices.
  const marketKey = coin.native ? priceKey(outside) : `${priceKey(outside)}|${coin.mint}:${priceKey(coinOutside)}`;
  const priceReading = reading || coinReading;
  const [askedMarket, setAskedMarket] = useState<string | null>(null);
  const [saidMarket, setSaidMarket] = useState<'same' | 'changed' | null>(null);
  if (askedMarket !== null && !priceReading) {
    setAskedMarket(null);
    setSaidMarket(askedMarket === marketKey ? 'same' : 'changed');
  }
  const readMarketAgain = () => {
    if (priceReading) return;
    setAskedMarket(marketKey);
    setSaidMarket(null);
    onReread();
  };
  const chooseCoin = (next: QuoteCoin) => {
    if (next.mint === coin.mint) return;
    setPicked(next.mint);
    // An amount typed for one coin is never carried into another: 50 is 50 SOL in one and
    // 50 USDC in the next, and the token amount beside it was matched to the old coin.
    setBoxes({ quote: '', token: '' });
    setDriving(null);
    // What the last Read again found was about the old coin's market price.
    setAskedMarket(null);
    setSaidMarket(null);
  };
  const priceState = check.price.state === 'agrees' || check.price.state === 'disagrees' || check.price.state === 'empty' ? check.price.state : 'unread';
  const readAt = outsideAt === null ? '' : `, read ${new Date(outsideAt).toLocaleTimeString('en-GB', { hour12: false })}`;
  // The token's price was read, so what is missing for a market price in this coin is the coin's own.
  const marketLine =
    market !== null
      ? `Market price (Jupiter${readAt}): 1 token = ${formatSolPrice(market)} ${coin.symbol}.`
      : coin.native || outside?.kind !== 'ok'
        ? `Market price (Jupiter): could not be read (${outside && outside.kind !== 'ok' ? outside.detail : 'not read'}).`
        : coinOutside === null
          ? `Market price in ${coin.symbol}: reading the price of ${coin.symbol} from Jupiter…`
          : `Market price in ${coin.symbol}: could not be worked out (${quoted && quoted.kind !== 'ok' ? quoted.detail : 'not read'}).`;
  const pairLabel = useId();
  const pairName = useId();
  // SOL keeps its plain words until another coin has a pool to point to as well.
  const named = !coin.native || pairs.filter((x) => x.advice.kind !== 'none').length > 1;
  const advice = adviceLine(pair, named);
  const first = firstLine(pair, cut);

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
      </div>
      {readyConfig === null && flow.state.step === 'idle' && (
        <Notice tone="warn">The public fee tier is not ready to open pools right now (see the card above), so Review is off.</Notice>
      )}
      {readyConfig !== null && flow.state.step === 'idle' && offerOffLine(offer) && <Notice tone="warn">{offerOffLine(offer)}</Notice>}
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
          {/* First on the form: everything under it is in the coin chosen here. */}
          {pairs.length > 1 ? (
            <div role="radiogroup" aria-labelledby={pairLabel} data-testid="lp-create-pair" data-coin={coin.symbol}>
              <span id={pairLabel} className="text-white text-[11px] block mb-1.5" style={SHADOW}>
                Pair with
              </span>
              {/* Real radio buttons: one Tab stop, and the arrow keys move the choice. The
                  whole label is the 44px target. `relative` keeps the input inside it. */}
              <div className="flex gap-2">
                {pairs.map(({ coin: q }) => (
                  <label
                    key={q.mint}
                    className={`${TOGGLE_CLS} relative flex items-center justify-center gap-2 px-3 cursor-pointer focus-within:ring-2 focus-within:ring-white/70`}
                    style={{ background: q.mint === coin.mint ? 'rgba(45,139,78,0.45)' : 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.18)' }}
                  >
                    <input type="radio" name={pairName} value={q.symbol} checked={q.mint === coin.mint} onChange={() => chooseCoin(q)} />
                    <span className="text-[13px] font-semibold">{q.symbol}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : (
            // Nothing to choose: the coin is said, and no group is drawn.
            <Row label="Paired with" value={`${coin.symbol}: this site pairs this token with ${coin.symbol} only`} mono={false} />
          )}
          <CoinRiskNotice coin={coin} />
          {!coin.native && (
            <p data-testid="lp-create-paid-in-sol">
              The fee to open{fee === null ? '' : ` (${formatSol(fee, 9)} SOL)`}, the account deposits and the network fee are paid in SOL, whatever
              the pool is paired with.{setAside !== null && lamports !== null ? ` This wallet needs about ${solAbout(setAside)} for them and has ${solExact(lamports)}.` : ''}{' '}
              Only your {coin.symbol} and your tokens go into the pool.
            </p>
          )}
          {readyConfig !== null && offer === 'offer' && advice && (
            <div data-testid="lp-create-advice">
              <Notice tone="warn">{advice}</Notice>
            </div>
          )}
          {readyConfig !== null && offer === 'offer' && first && (
            <div data-testid="lp-create-first">
              <Notice>{first}</Notice>
            </div>
          )}
          {warnings.length > 0 && (
            <div className="space-y-1">
              <Notice tone="warn">Read these about this token first:</Notice>
              <ul className="list-disc pl-4 text-amber-300/90 space-y-0.5">
                {warnings.map((w) => (
                  <li key={w.code}>{w.text}</li>
                ))}
                {warnings.some((w) => w.code === 'mint-authority') && <li>{mintAuthorityLine(coin)}</li>}
              </ul>
            </div>
          )}
          {/* First on the form: no wallet yet, or a wallet that cannot pay for an opening. */}
          {!walletReady && <WalletNeeded state={writes.signerState} />}
          {cannotOpen && (
            <div data-testid="lp-create-cannot" className="text-[13px] leading-relaxed space-y-1">
              <Notice tone="warn">{cannotOpen}</Notice>
              <FundingNextStep
                coin={coin}
                needsSol={coin.native ? availableQuote === 0n : solShort}
                needsCoin={!coin.native && availableQuote === 0n}
                needsToken={availableToken === 0n}
                mint={mint}
                wallet={signer?.publicKey.toBase58() ?? null}
              />
            </div>
          )}
          <div className="space-y-2" data-testid="lp-create-market">
            <p>{marketLine}</p>
          </div>
          <LpAmountPair
            coin={coin}
            quote={boxes.quote}
            token={boxes.token}
            driving={driving}
            tokenDecimals={decimals}
            linked={false}
            labels={{ quote: `${coin.symbol} to put in`, token: 'Tokens to put in' }}
            onType={onType}
            onMax={(side) => {
              if (side === 'quote' && availableQuote !== null) {
                setSide('quote', availableQuote);
                setDriving('quote');
              }
              if (side === 'token' && availableToken !== null) {
                setSide('token', availableToken);
                setDriving('token');
              }
            }}
            canMax={{ quote: availableQuote !== null, token: availableToken !== null && decimals !== null }}
            hints={{ quote: hintFor('quote'), token: hintFor('token') }}
            errors={{ quote: parseError('quote'), token: parseError('token') }}
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
            {/* Under the boxes: above them, on a phone, it stood between the price and the first box. */}
            <div className="space-y-2" data-testid="lp-create-market-again">
              <button
                type="button"
                className="btn-secondary w-full min-h-[44px] px-4 text-[13px] aria-disabled:opacity-60"
                aria-disabled={priceReading}
                onClick={readMarketAgain}
              >
                Read the market price again
              </button>
              <p role="status" className="text-white/55 text-[11px]">
                {askedMarket !== null
                  ? 'Reading the market price again…'
                  : saidMarket === 'same'
                    ? 'Read again just now: the same answer.'
                    : saidMarket === 'changed'
                      ? 'Read again just now: the market price above is new.'
                      : ''}
              </p>
            </div>
          </div>
          <p data-testid="lp-create-price" data-price={priceState}>
            {opening !== null && market !== null && (check.price.state === 'agrees' || check.price.state === 'disagrees')
              ? `Your opening price: 1 token = ${formatSolPrice(opening)} ${coin.symbol}. Market: ${formatSolPrice(market)} ${coin.symbol}. Yours is ${gapText(check.price.diff)} the market.${check.price.state === 'agrees' ? ' Close enough to the market.' : ''}`
              : opening !== null
                ? `Your opening price: 1 token = ${formatSolPrice(opening)} ${coin.symbol}. There is no market price to compare it with.`
                : 'Type both amounts to see your opening price.'}
          </p>
          {preview && config && (
            <div className="space-y-1.5" data-testid="lp-create-preview">
              <p className="text-white/45 text-[10px]">Worked out from what the page read; read and checked again when you press Review.</p>
              <Row label="You put in" value={`${coinExact(quoteRaw ?? 0n, coin)} and ${unitsExact(tokRaw ?? 0n, dec)} tokens, exactly`} mono={false} />
              <Row label="Fee to open" value={`${formatSol(config.createPoolFee, 9)} SOL, to the team's vault (not refundable)`} mono={false} />
              <Row
                label="Account deposits"
                value={
                  neverRefunded !== null && lpRent !== null
                    ? `about ${solAbout(neverRefunded)} kept by the pool's accounts forever, plus ${solExact(lpRent)} for your pool-share account (it comes back if you close that account later)`
                    : signer
                      ? 'could not be read'
                      : 'read once a wallet is connected (the fee tiers list on this page has the amount)'
                }
                mono={false}
              />
              <Row label="You get" value={`${unitsExact(preview.lp, LP_DECIMALS)} pool shares`} mono={false} />
              <Row
                label="Locked in the pool forever"
                value={`${LOCKED_SHARES_TEXT}, worth about ${coinExact(preview.locked.quote, coin)} and ${unitsExact(preview.locked.token, dec)} tokens`}
                mono={false}
              />
              <Row label="Your share of the pool" value={sharePct(preview.lp, preview.supply)} mono={false} />
              <Row
                label="In all, from your wallet"
                value={
                  neverRefunded !== null && lpRent !== null
                    ? coin.native
                      ? `about ${solAbout((quoteRaw ?? 0n) + config.createPoolFee + neverRefunded + lpRent)}, plus the network fee`
                      : // Two coins leave the wallet, and they are never added together.
                        `${coinExact(quoteRaw ?? 0n, coin)}, and about ${solAbout(config.createPoolFee + neverRefunded + lpRent)} for the fee to open and the account deposits, plus the network fee`
                    : signer
                      ? 'could not be worked out (the account deposits could not be read)'
                      : 'worked out once a wallet is connected'
                }
                mono={false}
              />
              <Row label="Trading opens" value="right away" mono={false} />
            </div>
          )}
          {walletReady && <WalletNeeded state={writes.signerState} />}
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
          {held && <Notice tone="warn">A pool you opened is not confirmed yet (see the top of this section), so opening another is off.</Notice>}
          <p className="text-white/60">{NOTES_BELOW}</p>
          {!canReview && reviewWhy && (
            <p className="text-amber-300/90 text-[12px]" data-testid="lp-review-why">
              {reviewWhy}
            </p>
          )}
          {coinPriceWhy && (
            <p className="text-amber-300/90 text-[12px]" data-testid="lp-create-coin-price">
              {coinPriceWhy}
            </p>
          )}
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              ref={reviewRef}
              type="button"
              className="btn-primary w-full min-h-[44px] text-[13px] disabled:opacity-60 disabled:grayscale"
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
            {!coin.native
              ? `Your ${coin.symbol} is spent straight from your own ${coin.symbol} account. Nothing is wrapped.`
              : wsolKept && facts?.kind === 'ok'
                ? `You already hold ${unitsExact(facts.wsol.amount, 9)} wrapped SOL. None of it is spent.`
                : 'Your SOL is wrapped into a token account for the opening, and that account is closed in the same transaction.'}
          </p>
        </>
      )}
      <div className="space-y-1.5" data-testid="lp-create-terms">
        {/* Opened with cp-swap's `initialize`, so the new pool never charges the tier's creator fee. */}
        <Row
          label="Fee tier"
          value={config ? `1: traders pay ${tradeCostText(config, CREATOR_FEE_SWITCH.publicOpen)}; LPs keep ${feeSplit(config).lpKeepsPct.toFixed(3)}% of each trade` : 'not read'}
          mono={false}
        />
        <Row label="Fee to open" value={fee === null ? 'not read' : `${formatSol(fee, 9)} SOL, paid to the team's vault (read just now)`} mono={false} />
        {/* Each pair has its own standard address: this row is the chosen coin's. */}
        <Row
          label="Pool address"
          value={pair.standard === 'empty' ? 'the standard address for fee tier 1' : 'a new address of its own (the standard address is already taken)'}
          mono={false}
        />
      </div>
      <LpBeforeYouOpen fee={fee ?? 0n} neverRefunded={neverRefunded} walletConnected={!!signer} coin={coin} />
      <p role="status" className="sr-only">
        {flow.state.step === 'idle' ? status : ''}
      </p>
    </PanelFrame>
  );
}
