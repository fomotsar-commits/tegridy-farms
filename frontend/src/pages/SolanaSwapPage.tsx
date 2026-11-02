// Polyfill MUST load before any @solana/* import (jupiter.ts / providers pull
// in web3.js) — keep this the very first import in this lazy chunk's entry.
import '../lib/solanaPolyfill';
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import { PublicKey, VersionedTransaction, type Connection } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { ArtImg } from '../components/ArtImg';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { FeatureNotDeployed } from '../components/ui/FeatureNotDeployed';
import { FinePrint } from '../components/ui/FinePrint';
import { CoinName } from '../components/ui/CoinName';
import { tick } from '../lib/tick';
import { SolanaProviders } from '../components/solana/SolanaProviders';
import { SolanaConnectButton } from '../components/solana/SolanaConnectButton';
import { ChainSwitch } from '../components/swap/ChainSwitch';
import { SolanaRouteLine } from '../components/swap/SolanaRouteLine';
import { IslandBasketSolana } from '../components/swap/IslandBasketSolana';
import { isRangeCandidate, useSolanaRoute } from '../components/swap/useSolanaRoute';
import type { TxSummary } from '../components/solana/curve/ports';
import { useVenueSwap } from '../components/swap/useVenueSwap';
import { useReturnFocus, type OnSettled } from '../components/solana/curve/useTxFlow';
import { holdReload } from '../lib/reloadHold';
import { isSolanaFeeConfigured, isSolanaSwapLive, SOLANA_PLATFORM_FEE_BPS, SOL_MINT, USDC_MINT } from '../lib/solana';
import {
  PAY_WITH_TOKENS,
  BUY_TOKENS,
  SOL,
  USDC,
  USDT,
  BAYLA,
  LEGACY_TOKEN_PROGRAM,
  LST_TOKENS,
  findSolToken,
  isUnverified,
  isVenueCoin,
  needsRiskAck,
  withVenueCoinsFirst,
  isRiskAcked,
  rememberRiskAck,
  forgetRiskAck,
  searchTokens,
  looksLikeMint,
  resolveMint,
  fetchTrending,
  iconSrc,
  rememberToken,
  getRecentTokens,
  getFavoriteTokens,
  toggleFavoriteToken,
  isFavoriteToken,
  type SolToken,
  type TrendingCategory,
  type TrendingInterval,
} from '../lib/solanaTokenList';
import {
  getQuote,
  NoRouteError,
  buildSwapTransaction,
  pickFeeMint,
  getUsdPrices,
  routeLabels,
  getShield,
  simulateSwap,
  swapCarriesPlatformFee,
  quoteHasPlatformFee,
  createTriggerOrder,
  getTriggerOrders,
  cancelTriggerOrder,
  orderKeyOf,
  createRecurringOrder,
  getRecurringOrders,
  cancelRecurringOrder,
  recurringOrderKeyOf,
  type RecurringOrder,
  toBaseUnits,
  fromBaseUnits,
  limitTakingAmount,
  MAX_PRIORITY_LAMPORTS,
  type PriorityLevel,
  type JupiterQuote,
  type ShieldWarning,
  type TriggerOrder,
} from '../lib/jupiter';
import { prepareJupiterSwap, refusalWhy, refusedSaid, NO_SITE_FEE_ROUTE_COPY, NOT_TEST_RUN_COPY, type PreparedJupiterSwap } from '../lib/solana/swap/jupiterFeeRetry';
import { OWN_ROUTE_COPY, freshDecision, ownPoolNowWins, prepareOwnPoolSwap, within } from '../lib/solana/swap/ownPoolRoute';
import { whileJupiterBusy } from '../lib/solana/swap/jupiterBusy';
import { tokenFromChain } from '../lib/solana/swap/chainToken';
import { browserRpc } from '../lib/launcher/solana/curve/rpc';
import { withReadCommitment } from '../components/solana/curve/confirmedRpc';
import { applySlippage } from '../lib/launcher/solana/curve/math';
import { tradeCostText } from '../lib/solana/lp/format';
import { siteNamed } from '../lib/solana/lp/identity';
import { perMillionPercent } from '../lib/solana/clmm/feeText';
import { isFeeOnInput } from '../lib/solana/clmm/program';
import { quietEnding } from '../components/swap/quietSwap';
import { checkDcaPair, dcaToken2022Copy, DCA_MIN_PER_BUY_USD, DCA_UNREAD_COPY, DCA_UNREAD_NOTE, type DcaPairCheck } from '../lib/solana/swap/dcaPair';
import { CHECK_KEEPS_FAILING, HELD_NOT_SENT, LOST_ANSWER_TITLE, OWN_POOL_REVIEW_OFFER, lostAnswerCopy, nothingSentCopy } from '../lib/solana/swap/walletCopy';
import { jupiterLastValidAtMost } from '../lib/solana/swap/jupiterNote';
import { blockhashSeen, recentBlockhashOf, type NoteBlockhash } from '../lib/solana/blockhashWindow';
import type { AggregatorSeen } from '../lib/launcher/solana/write/types';
import { readSendThrow } from '../lib/solana/walletThrow';
import { noteKey, readPendingTrades, swapPendingScope } from '../components/solana/curve/pendingTrade';
import { fractionToBps, impactWarning } from '../components/solana/curve/uiFormat';
import { SiteFeeRow } from '../components/swap/SiteFeeRow';
import { TokenDetail } from '../components/solana/TokenDetail';
import { PairChart } from '../components/solana/PairChart';
import { PairAverageLine, type PairAverageTrade } from '../components/solana/PairAverageLine';
import { ClockLine } from '../components/ClockLine';
import { bungalowByAddress, getActiveBungalow } from '../lib/bungalows';
import { markLanded } from '../lib/landed';
import { openingBuyMint } from '../lib/solanaOpeningPair';
import { setLastBuy } from '../lib/heat/lastBuy';
import { recordActivity, getActivity, timeAgo } from '../lib/solanaActivity';
import { pollConfirm } from '../lib/solana/confirm';
import { surfaceUnconfirmedTx } from '../lib/txErrors';

// The review of a swap in our own pool, and the note of one not confirmed yet: its own
// chunk, asked for only when one of them is on screen.
const loadVenueSwapFlow = () => import('../components/swap/VenueSwapFlow');
const VenueSwapFlow = lazy(loadVenueSwapFlow);

/** How long Buy waits for our pools to be read again before it goes on with the route on screen. */
const OWN_CHECK_MS = 4_000;

/**
 * A quote on screen younger than this is built as shown: the press does not ask Jupiter
 * again (the site's free key is one request a second for every visitor together). Its
 * minimum is the trader's floor on chain and the test run still runs on it. One press per
 * quote: the press after asks afresh.
 */
const SHOWN_QUOTE_FRESH_MS = 10_000;

// A press's quote and build, each asked again while Jupiter refuses the call (jupiterBusy.ts).
const pressQuote = whileJupiterBusy((p: Parameters<typeof getQuote>[0]) => getQuote(p));
const pressBuild = whileJupiterBusy((p: Parameters<typeof buildSwapTransaction>[0]) => buildSwapTransaction(p));

const SLIPPAGE_PRESETS = [50, 100, 300]; // bps

/** The pay field's amounts in one press when SOL is paid, beside MAX (island answer twenty-four). */
const SOL_CHIPS = ['0.05', '0.5'] as const;
const CHIP_CLS = 'min-h-[44px] px-3 rounded-lg text-[11px] font-semibold text-white';
const CHIP_STYLE = { background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.12)' } as const;

// Priority-fee levels for the swap build ("Speed"). The lamport ceiling is
// hard-capped in lib/jupiter.ts and disclosed under the chips.
const SPEED_LEVELS: { level: PriorityLevel; label: string }[] = [
  { level: 'medium', label: 'Normal' },
  { level: 'high', label: 'Fast' },
  { level: 'veryHigh', label: 'Turbo' },
];

// Amount fields are type="text" + inputMode="decimal", never type="number":
// an iOS locale keypad emits ',' which type=number surfaces as an EMPTY value
// (the field looks full while baseAmount stays null and the CTA is stuck on
// "Enter an amount"), and desktop wheel-scroll over a focused number input
// silently mutates a financial amount. Accept only a plain decimal string and
// normalize ',' to '.' so toBaseUnits sees what the user meant.
function acceptAmountInput(v: string, set: (s: string) => void): void {
  const n = v.replace(',', '.');
  // Unambiguous shape (the dot is REQUIRED before the second digit run):
  // `\d*\.?\d*` lets the engine split a long digit run at every position,
  // which CodeQL rightly flags as polynomial backtracking on library input.
  if (/^\d*(?:\.\d*)?$/.test(n)) set(n);
}

function prettyAmount(s: string): string {
  if (!s.includes('.')) return s;
  const [w, f] = s.split('.');
  return `${w ?? '0'}.${(f ?? '').slice(0, 6)}`;
}

function shortSig(sig: string): string {
  return `${sig.slice(0, 6)}…${sig.slice(-6)}`;
}

function intervalLabel(secs: number): string {
  if (secs === 3_600) return 'every hour';
  if (secs === 86_400) return 'every day';
  if (secs === 604_800) return 'every week';
  return `every ${secs}s`;
}

/** Completes "if it landed, ___" for a cancel we could not confirm. */
const CANCEL_REPEAT_COST = 'the order is already closed, so a second cancel will fail.';

/** How long a sent swap is watched before the page says it cannot tell (SPEC_S3). */
const SWAP_CONFIRM_TIMEOUT_MS = 90_000;

/**
 * Watch a sent transaction (polled, never subscribed: see lib/solana/confirm.ts).
 *
 * True once it confirmed. A revert the network reported throws, and each caller's
 * "failed" toast is right for that one. Anything short of either (a watch that ran out,
 * a status read that kept erroring) is NOT a failure: the transaction may still land,
 * and "failed" invites a second one that pays twice. That says "we can't tell, check
 * before you send it again" with the signature, and returns false.
 *
 * `repeatCost` completes "if it landed, ___" in the caller's own terms.
 *
 * The DCA and limit senders use this. The instant swap reads the same poller itself
 * (handleSwap), because it has more to say on each ending: the same warning here, plus
 * a row in recent activity and, for a revert, the signature and a link.
 */
async function confirmSent(connection: Connection, sig: string, repeatCost: string): Promise<boolean> {
  const { outcome } = await pollConfirm(connection, sig);
  if (outcome === 'confirmed') return true;
  if (outcome === 'reverted') throw new Error('Transaction failed on-chain');
  surfaceUnconfirmedTx(toast, { hash: sig, explorerUrl: `https://solscan.io/tx/${sig}`, repeatCost });
  return false;
}

interface TokenPickerProps {
  title: string;
  featured: SolToken[];
  onSelect: (t: SolToken) => void;
  onClose: () => void;
}

/** A throw from the wallet's sendTransaction, kept apart from every other throw of a press. */
class WalletThrew extends Error {
  readonly thrown: unknown;
  constructor(thrown: unknown) {
    super('The wallet did not hand back a signature');
    this.thrown = thrown;
  }
}

/** The wallet signs and sends; a throw from it is marked as the wallet's. */
async function viaWallet(send: () => Promise<string>): Promise<string> {
  try {
    return await send();
  } catch (e) {
    throw new WalletThrew(e);
  }
}

/**
 * Says a press's throw when it was the wallet's, as every Solana write says it
 * (lib/solana/walletThrow.ts): a cancel, a wallet that never signed, or an answer that
 * did not come back, which may have been sent. `did` completes "whether ___".
 * 'other': not the wallet's, the caller says it.
 */
function sayWalletThrew(err: unknown, did: string): 'other' | 'not-sent' | 'unsure' {
  if (!(err instanceof WalletThrew)) return 'other';
  const t = readSendThrow(err.thrown);
  if (t.kind === 'declined') toast.info('Not sent', { description: t.message });
  else if (t.kind === 'not-signed') toast.error('Not sent', { description: t.message });
  else toast.warning(LOST_ANSWER_TITLE, { description: lostAnswerCopy(t.reason, did) });
  return t.kind === 'unsure' ? 'unsure' : 'not-sent';
}

/** A throw's own words on one line, for inside "(...)". */
function thrownWords(err: unknown): string {
  const s = (err instanceof Error ? err.message : String(err ?? '')).replace(/\s+/g, ' ').trim();
  if (!s) return 'no reason was given';
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** SOL and the dollar coins: what a trader cashes a token out into, and what the token picker opens on. */
const MAJORS: readonly SolToken[] = [SOL, USDC, USDT];
const CASH_MINTS: ReadonlySet<string> = new Set(MAJORS.map((t) => t.mint));

/** A token paid for cash is a sale of that token. Everything else is a buy of what is received. */
function sideWords(pay: SolToken, buy: SolToken): { verb: 'Buy' | 'Sell'; done: 'Bought' | 'Sold'; symbol: string } {
  const selling = CASH_MINTS.has(buy.mint) && !CASH_MINTS.has(pay.mint);
  return selling ? { verb: 'Sell', done: 'Sold', symbol: pay.symbol } : { verb: 'Buy', done: 'Bought', symbol: buy.symbol };
}

type RowBadge = { label: string; tone: 'amber' | 'red' | 'green' };

function riskBadges(t: SolToken): RowBadge[] {
  const out: RowBadge[] = [];
  // The venue's own coin is known by its mint, so it says that and not "Unverified".
  // Only a coin Jupiter verifies gets no mark at all: SOL and USDC need none.
  if (isVenueCoin(t.mint) && isUnverified(t)) out.push({ label: `This venue’s ${t.symbol}`, tone: 'green' });
  else if (isUnverified(t)) out.push({ label: 'Unverified', tone: 'amber' });
  if (t.tokenProgram && t.tokenProgram !== LEGACY_TOKEN_PROGRAM) out.push({ label: 'Token-2022', tone: 'amber' });
  // Amber rather than red on a curated mint: USDC really can freeze, and saying
  // so is right — but it is a known property of the asset, not a warning sign.
  // Same mint-address-keyed check as the Shield exemption; never symbol-matched.
  if (t.audit?.freezeAuthorityDisabled === false) {
    out.push({ label: 'Can freeze', tone: findSolToken(t.mint) ? 'amber' : 'red' });
  }
  return out;
}

/**
 * Is this warning EXPECTED for this specific mint, rather than a red flag?
 *
 * A regulated stablecoin's freeze authority is a documented property of USDC,
 * not a honeypot signal. Painting it the same red as a genuine one on an unknown
 * mint is alarm-fatigue calibration: a user who sees red on the safest pair on
 * the venue learns that red means nothing, and then ignores it on the pair where
 * it means everything.
 *
 * KEYED BY MINT ADDRESS ONLY, via findSolToken's `t.mint === mint`. Never by
 * symbol or name — a spoofed "USDC" must not be able to inherit this exemption,
 * which is exactly the vector a symbol-matched allowlist would open.
 *
 * Scope is deliberately narrow: only HAS_FREEZE_AUTHORITY, only for a curated
 * mint. Honeypot, transfer-hook and transfer-fee warnings are never exempted,
 * and an uncurated mint is never exempted for anything.
 */
function isExpectedAuthority(w: ShieldWarning, mint: string): boolean {
  return w.type === 'HAS_FREEZE_AUTHORITY' && Boolean(findSolToken(mint));
}

/**
 * The one place a Shield warning's colour is decided.
 *
 * This used to be duplicated inline at three render sites as a bare
 * `/warn|crit|danger/i.test(w.severity)`, none of which knew about the exemption
 * that dangerousShield had applied to the very same warning — so the ack gate
 * correctly treated USDC's freeze authority as benign while the text above it
 * was painted red. Same input, two answers, on the venue's default pair.
 */
function shieldIsAlarming(w: ShieldWarning, mint: string): boolean {
  if (isExpectedAuthority(w, mint)) return false;
  return /warn|crit|danger/i.test(w.severity);
}

// Whether a mint's Shield warnings should FORCE the "swap anyway" ack. Jupiter
// only emits info/warning severities (no critical tier), so we gate on warning+
// — but a curated stablecoin/LST's expected freeze authority (USDC/USDT/LST) is
// benign and shouldn't nag, while honeypot / transfer-hook / transfer-fee
// warnings still gate.
function dangerousShield(warnings: ShieldWarning[], mint: string): boolean {
  return warnings.some((w) => {
    if (!/warn|crit|danger|high|severe/i.test(w.severity)) return false;
    if (isExpectedAuthority(w, mint)) return false;
    return true;
  });
}

/** A Shield warning that still knows which mint it came from. */
export type MintedShieldWarning = ShieldWarning & { mint: string };

// Token icon via the CSP-safe weserv proxy, falling back to an initials avatar
// on missing/broken images (we never load arbitrary token-image hosts directly;
// the one exception, Irys, is named in iconSrc and in img-src).
function TokenAvatar({ token, size = 28 }: { token: SolToken; size?: number }) {
  const [errored, setErrored] = useState(false);
  const src = errored ? '' : iconSrc(token.logoURI);
  const px = `${size}px`;
  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setErrored(true)}
        className="rounded-full flex-shrink-0 object-cover"
        style={{ width: px, height: px, background: 'var(--color-purple-25)' }}
      />
    );
  }
  return (
    <div
      className="rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
      style={{ width: px, height: px, background: 'var(--color-purple-25)' }}
    >
      {token.symbol.slice(0, 3)}
    </div>
  );
}

/**
 * Sibling presses, never nested (invalid HTML): the row picks, the coin's name copies its whole
 * address (CoinName, island answer twenty-four), the star toggles the favorite. The name lies on
 * the row's first line, which the row's own press leaves empty for it. A coin the site does not
 * name itself keeps its whole address under it: a head and a tail can be grinded (identity.ts).
 */
function TokenRow({ t, onSelect }: { t: SolToken; onSelect: (t: SolToken) => void }) {
  const badges = riskBadges(t);
  const [fav, setFav] = useState(() => isFavoriteToken(t.mint));
  return (
    <div className="relative w-full flex items-start rounded-lg hover:bg-white/5 transition-colors" data-token-row={t.mint}>
      <button
        type="button"
        onClick={() => onSelect(t)}
        className="flex-1 flex items-start gap-3 px-3 py-2 text-left min-w-0 min-h-[44px]"
      >
        <div className="mt-2 flex-shrink-0">
          <TokenAvatar token={t} size={28} />
        </div>
        <div className="min-w-0 flex-1 pt-11">
          {/* The row's press is named for its coin too: the name in view belongs to the copy press. */}
          <span className="sr-only">{t.verified === true ? `${t.symbol} Verified` : t.symbol}</span>
          <div className="text-white/50 text-[11px] truncate">{t.name}</div>
          {!siteNamed(t.mint) && <div className="text-white/45 text-[10px] font-mono break-all">{t.mint}</div>}
          {badges.length > 0 && (
            <div className="flex gap-1 flex-wrap mt-0.5">
              {badges.map((b) => (
                <span
                  key={b.label}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${b.tone === 'red' ? 'bg-red-500/20 text-red-300' : b.tone === 'green' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}`}
                >
                  {b.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </button>
      <div className="absolute top-2 left-[52px] right-11 flex items-center gap-1.5 min-w-0 pointer-events-none">
        <CoinName name={t.symbol} address={t.mint} className="pointer-events-auto min-w-0" nameClassName="text-white text-[13px] truncate" />
        {t.verified === true && <span className="text-success text-[10px]" title="Verified on Jupiter" aria-hidden="true">✓</span>}
      </div>
      <button
        type="button"
        onClick={() => setFav(toggleFavoriteToken(t))}
        aria-pressed={fav}
        aria-label={fav ? `Remove ${t.symbol} from favorites` : `Add ${t.symbol} to favorites`}
        className="mt-2 px-3 py-2.5 min-h-[44px] text-[15px] flex-shrink-0"
        style={{ color: fav ? 'var(--color-stan)' : 'rgba(255,255,255,0.35)' }}
      >
        {fav ? '★' : '☆'}
      </button>
    </div>
  );
}

function TokenPicker({ title, featured, onSelect, onClose }: TokenPickerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SolToken[] | null>(null); // null = show featured
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape to close + focus management: focus the search box on open, trap Tab
  // within the dialog, and restore focus to the trigger on close (mirrors the
  // TopNav drawer's a11y pattern).
  // The parent mounts this with an INLINE arrow, so a bare `[onClose]` dep tore
  // this setup down and re-ran it on EVERY parent render: the cleanup restored
  // focus to the opener and the setup re-focused the panel, yanking the caret
  // away from whoever was typing (and churning the scroll-lock save/restore).
  // Hold the latest callback in a ref so the setup below is mount-scoped.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    // Lock the page under the dialog — without this, scroll chaining past the
    // results list (or a swipe on the backdrop) scrolls the page, and closing
    // returns focus to a trigger that may have scrolled off-screen. Mirrors
    // the wallet-adapter modal's own body lock.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCloseRef.current(); return; }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !panelRef.current.contains(active)) { last.focus(); e.preventDefault(); }
      } else {
        if (active === last || !panelRef.current.contains(active)) { first.focus(); e.preventDefault(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-scoped on purpose; onClose is read through onCloseRef
  }, []);

  // Debounced token search — matches symbol, name, OR a pasted mint address.
  // All setState runs inside the deferred timeout/promise callbacks (never the
  // synchronous effect body) so it can't trigger cascading renders.
  useEffect(() => {
    const q = query.trim();
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      if (!q) { setResults(null); setError(null); setLoading(false); return; }
      setLoading(true); setError(null);
      searchTokens(q, ctrl.signal)
        .then((r) => {
          if (ctrl.signal.aborted) return;
          const rows = withVenueCoinsFirst(r, q);
          setResults(rows); setLoading(false);
          setError(rows.length === 0 ? (looksLikeMint(q) ? 'Mint not found / not listed on Jupiter.' : 'No tokens found.') : null);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
          // The venue's own coins need no search to be found.
          setResults(withVenueCoinsFirst([], q)); setLoading(false); setError('Search is unavailable just now. Try again.');
        });
    }, q ? 350 : 0);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query]);

  const list = results ?? featured;
  // With nothing typed: SOL, USDC and USDT first (island answer twenty-four), under the venue's
  // BAYLA where the list leads with it (the Buy list, owner 2026-10-08); then Favorites, Recent
  // and Popular, each coin once. Remembered tokens still go through riskBadges like any row.
  const groups = results
    ? null
    : (() => {
        const top = [...(featured[0]?.mint === BAYLA.mint ? [featured[0]] : []), ...MAJORS];
        const seen = new Set(top.map((t) => t.mint));
        const favs = getFavoriteTokens().filter((t) => !seen.has(t.mint));
        for (const t of favs) seen.add(t.mint);
        const recents = getRecentTokens().filter((t) => !seen.has(t.mint));
        for (const t of recents) seen.add(t.mint);
        const popular = featured.filter((t) => !seen.has(t.mint));
        return [
          { label: null, tokens: top },
          { label: 'Favorites', tokens: favs },
          { label: 'Recent', tokens: recents },
          { label: 'Popular', tokens: popular },
        ].filter((g) => g.tokens.length > 0);
      })();

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      {/* max-h + own scroll: iPhone landscape gives ~340px of height, and a
          centered fixed-height panel clips the title and close button off the
          top with no way to reach them. The 16px search font is deliberate —
          anything smaller makes iOS Safari zoom the whole page on the
          programmatic focus above, and it never zooms back out. */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative z-10 w-full max-w-sm rounded-2xl p-4 outline-none max-h-[calc(100dvh-2rem)] overflow-y-auto"
        style={{ background: 'var(--color-bg-elevated)', border: '1px solid rgba(255,255,255,0.14)' }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white text-[14px] font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close token list" className="text-white/60 hover:text-white p-3 -m-2 text-[14px]">✕</button>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name / symbol, or paste a mint"
          aria-label="Search tokens"
          spellCheck={false}
          autoComplete="off"
          className="w-full mb-3 px-3 py-2 rounded-lg bg-black/50 text-white text-[16px] sm:text-[13px] outline-none"
          style={{ border: '1px solid rgba(255,255,255,0.14)' }}
        />
        <div className="space-y-1 max-h-[min(300px,45dvh)] overflow-y-auto overscroll-contain">
          {loading && <div className="px-3 py-2.5 text-white/50 text-[12px]">Searching…</div>}
          {!loading && groups
            ? groups.map((g) => (
                <div key={g.label ?? 'top'}>
                  {g.label && <p className="text-white/55 text-[10px] uppercase tracking-wide mb-1 px-1">{g.label}</p>}
                  {g.tokens.map((t) => <TokenRow key={t.mint} t={t} onSelect={onSelect} />)}
                </div>
              ))
            : !loading && list.map((t) => <TokenRow key={t.mint} t={t} onSelect={onSelect} />)}
          {!loading && error && <p className="px-3 py-2 text-amber-300 text-[12px]">{error}</p>}
        </div>
      </div>
    </div>
  );
}

// Connected wallet's balance for a token (SOL via getBalance; SPL via parsed
// token accounts). Reads through the proxied connection.
//
// Three answers, kept apart: a number that was READ (a real 0 included), a
// read still in flight, and UNREAD (the read threw, or an account came back
// without an amount). `raw` is null for the last two and with no wallet, so
// MAX and the insufficient guard stay off. `unread` is what lets a page say
// "could not be read" where it used to print a 0 nobody had read, which is
// exactly what an empty wallet looks like. `retry` reads again.
function useTokenBalance(token: SolToken): {
  raw: bigint | null;
  human: string | null;
  loading: boolean;
  unread: boolean;
  retry: () => void;
} {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [raw, setRaw] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [unread, setUnread] = useState(false);
  // Bumped by retry(): re-runs the read below for the same wallet and token.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!publicKey) { setRaw(null); setUnread(false); setLoading(false); return; }
    let cancelled = false;
    // Reset on EVERY re-run, not just disconnect: between a token switch and
    // the RPC response the old token's raw balance would otherwise feed MAX
    // and the insufficient guard in the NEW token's decimals (5 SOL raw ->
    // "5000" USDC). null hides MAX and skips the guard until the read lands.
    setRaw(null);
    setUnread(false);
    setLoading(true);
    (async () => {
      try {
        let amount: bigint;
        if (token.mint === SOL_MINT) {
          amount = BigInt(await connection.getBalance(publicKey));
        } else {
          const resp = await connection.getParsedTokenAccountsByOwner(publicKey, { mint: new PublicKey(token.mint) });
          amount = resp.value.reduce((sum, a) => {
            const v = (a.account.data.parsed as { info?: { tokenAmount?: { amount?: string } } } | undefined)?.info?.tokenAmount?.amount;
            // An account that came back without an amount is not an empty one:
            // the sum is not known, so the whole read counts as failed. Plain
            // digits only: BigInt('') is 0n and BigInt('0x10') is 16n, and
            // neither is an amount the RPC sent.
            if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new Error('a token account came back without an amount');
            return sum + BigInt(v);
          }, 0n);
        }
        if (!cancelled) setRaw(amount);
      } catch {
        if (!cancelled) { setRaw(null); setUnread(true); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [connection, publicKey, token.mint, token.decimals, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const human = raw === null ? null : fromBaseUnits(raw.toString(), token.decimals);
  return { raw, human, loading, unread, retry };
}

// Trending Solana tokens — drives one-click, fee-bearing buys (pay SOL → token).
function TrendingRail({ onPick }: { onPick: (t: SolToken) => void }) {
  const [category, setCategory] = useState<TrendingCategory>('toptrending');
  const [tokens, setTokens] = useState<SolToken[]>([]);
  const [loading, setLoading] = useState(true);
  const interval: TrendingInterval = '24h';

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    // setState in the deferred callback (not the synchronous effect body).
    const t = setTimeout(() => {
      setLoading(true);
      fetchTrending(category, interval, 12, ctrl.signal)
        .then((ts) => { if (!cancelled) { setTokens(ts); setLoading(false); } })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
          if (!cancelled) { setTokens([]); setLoading(false); }
        });
    }, 0);
    return () => { cancelled = true; ctrl.abort(); clearTimeout(t); };
  }, [category]);

  const CATS: { key: TrendingCategory; label: string }[] = [
    { key: 'toptrending', label: 'Trending' },
    { key: 'toptraded', label: 'Top Traded' },
    { key: 'toporganicscore', label: 'Top Organic' },
  ];

  if (!loading && tokens.length === 0) return null;

  return (
    <div className="mt-6">
      {/* Wraps: below about 335px the three choices go under the heading, not off the screen. */}
      <div className="flex flex-wrap items-center justify-between mb-2 gap-2">
        <h2 className="text-white text-[13px] font-semibold flex-shrink-0">Trending on Solana</h2>
        <div className="flex gap-1">
          {CATS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setCategory(c.key)}
              aria-pressed={category === c.key}
              className="px-2.5 py-2 rounded-md text-[10px] font-medium text-white transition-colors"
              style={{
                background: category === c.key ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                border: category === c.key ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[56px] rounded-xl animate-pulse" style={{ background: 'rgba(255,255,255,0.06)' }} />
            ))
          : tokens.map((t) => {
              const chg = t.priceChange24h;
              return (
                <button
                  key={t.mint}
                  type="button"
                  onClick={() => onPick(t)}
                  className="flex items-center gap-2 p-2.5 rounded-xl hover:bg-white/5 transition-colors text-left"
                  style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.10)' }}
                >
                  <TokenAvatar token={t} size={26} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="text-white text-[12px] font-medium truncate">{t.symbol}</span>
                      {t.verified === true && <span className="text-success text-[9px]" aria-label="Verified">✓</span>}
                    </div>
                    {typeof chg === 'number' && (
                      <span className={`text-[10px] font-mono ${chg >= 0 ? 'text-success' : 'text-red-300'}`}>
                        {chg >= 0 ? '+' : ''}{chg.toFixed(1)}%
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
      </div>
      <p className="text-white/55 text-[11px] mt-1.5">Trending data from Jupiter. Not an endorsement — verify before buying.</p>
    </div>
  );
}

// "Earn": buy a liquid-staking token, which is staked SOL that trades. The buy is the
// product. The platform fee is on Jupiter's route only: a buy in one of our pools pays
// that pool's own fee. Nothing here reads a staking rate, so no rate is printed: a card
// names its token, and the note says where the rate lives.
function EarnRail({ onPick }: { onPick: (t: SolToken) => void }) {
  return (
    <div className="mt-6" data-testid="solana-earn-rail">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-white text-[13px] font-semibold">Earn SOL staking yield</h2>
        <span className="text-white/60 text-[10px]">liquid staking · no lockup</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {LST_TOKENS.map((t) => (
          <button
            key={t.mint}
            type="button"
            onClick={() => onPick(t)}
            className="flex items-center gap-2 p-2.5 rounded-xl hover:bg-white/5 transition-colors text-left"
            style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.10)' }}
          >
            <TokenAvatar token={t} size={26} />
            <div className="min-w-0 flex-1">
              <div className="text-white text-[12px] font-medium truncate">{t.symbol}</div>
              <div className="text-white/70 text-[10px]">{t.name}</div>
            </div>
          </button>
        ))}
      </div>
      {/* One line: how the holder earns, and what the venue takes. The rest is small print. */}
      <p className="text-white/55 text-[11px] mt-1.5">
        Its SOL value is built to rise with staking rewards.{' '}
        {isSolanaFeeConfigured() ? `Platform fee: ${SOLANA_PLATFORM_FEE_BPS / 100}% via Jupiter.` : 'No platform fee.'}
      </p>
      <FinePrint summary="Details">
        <p>
          A liquid-staking token is staked SOL you can trade. Its value in SOL is built to rise as staking rewards
          are added. There is no lockup, and you can sell back to SOL at any time. This page reads no staking rate,
          so it shows none: each provider publishes its own.{' '}
          {isSolanaFeeConfigured()
            ? `A ${SOLANA_PLATFORM_FEE_BPS / 100}% fee applies when the buy goes through Jupiter. A buy in one of our pools pays that pool's own fee inside the quote, and no platform fee on top.`
            : 'No platform fee is charged on the buy.'}
        </p>
      </FinePrint>
    </div>
  );
}

// "Your recent activity" — what THIS venue submitted for the connected wallet,
// read from the per-wallet localStorage record at render time (any re-render
// after a new trade re-reads it). Venue-side record only, and says so.
function ActivityRail() {
  const { publicKey } = useWallet();
  const [open, setOpen] = useState(false);
  if (!publicKey) return null;
  const rows = open ? getActivity(publicKey.toBase58()) : [];
  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-left min-h-[40px]"
        style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.10)' }}
      >
        <span className="text-white text-[13px] font-semibold">Your recent activity</span>
        <span className="text-white/60 text-[11px]" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {rows.length === 0 ? (
            <p className="text-white/60 text-[11px] px-1">Nothing yet — trades you make here will be listed.</p>
          ) : (
            rows.map((e) => (
              <div key={e.sig} className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.10)' }}>
                <div className="min-w-0">
                  <div className="text-white/85 text-[11px] truncate">{e.summary}</div>
                  <div className="text-white/50 text-[9px]">{timeAgo(e.ts)} · this venue</div>
                </div>
                <a
                  href={`https://solscan.io/tx/${e.sig}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-white/60 text-[10px] hover:text-white flex-shrink-0 px-2 py-2.5 -my-2 underline underline-offset-2"
                >
                  Solscan
                </a>
              </div>
            ))
          )}
          <p className="text-white/55 text-[9px] px-1">
            Stored in this browser only — trades this venue submitted for this wallet, not full on-chain history.
          </p>
        </div>
      )}
    </div>
  );
}

/** A wallet's order list whose read did not answer: said as that, with a way to read it again. */
function OrdersUnread({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <p className="text-white/60 text-[11px]">
      {what} could not be read just now.{' '}
      <button type="button" onClick={onRetry} className="text-white underline hover:text-white/80 px-1 py-2.5 -my-2">Try again</button>
    </p>
  );
}

// DCA: Jupiter Recurring (time-based). Deposit once, keepers buy the pair on a fixed
// cadence, fee-off. Its program cannot take a Token-2022 token, so both mints' programs
// are read before anything is signed (lib/solana/swap/dcaPair.ts). Jupiter asks for at
// least $50 per buy: checked here only from a price the page read (`payUsd`).
function DcaTab({ payToken, buyToken, payUsd, shieldWarnings, needsAck, ack, setAck, onPickPay, onPickBuy }: {
  payToken: SolToken; buyToken: SolToken; payUsd: number | null;
  shieldWarnings: MintedShieldWarning[]; needsAck: boolean; ack: boolean; setAck: (v: boolean) => void;
  onPickPay: () => void; onPickBuy: () => void;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [totalAmount, setTotalAmount] = useState('');
  const [numBuys, setNumBuys] = useState(4);
  const [intervalSecs, setIntervalSecs] = useState(86_400);
  const [placing, setPlacing] = useState(false);
  // Null: the read did not answer (OrdersUnread), never an empty list.
  const [orders, setOrders] = useState<RecurringOrder[] | null>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const payBalance = useTokenBalance(payToken);

  const sameToken = payToken.mint === buyToken.mint;
  const totalBase = useMemo(() => toBaseUnits(totalAmount, payToken.decimals), [totalAmount, payToken.decimals]);
  // Per-buy display: the deposit is spent as inAmount/numberOfOrders per cycle.
  const perBuyHuman = useMemo(() => {
    if (!totalBase) return null;
    const per = BigInt(totalBase) / BigInt(numBuys);
    return per > 0n ? fromBaseUnits(per.toString(), payToken.decimals) : null;
  }, [totalBase, numBuys, payToken.decimals]);
  const insufficient = payBalance.raw !== null && totalBase !== null && BigInt(totalBase) > payBalance.raw;
  // Dollars per buy, only from a price the page read. Null: no figure, so nothing is held for it.
  const perBuyUsd = perBuyHuman !== null && payUsd !== null ? Number(perBuyHuman) * payUsd : null;
  const underMinimum = perBuyUsd !== null && Number.isFinite(perBuyUsd) && perBuyUsd < DCA_MIN_PER_BUY_USD;

  // Whether Jupiter's recurring program can take this pair, kept with the pair it was read for.
  // Null while the read for the pair on the form is out.
  const pairKey = `${payToken.mint}|${buyToken.mint}`;
  const [checked, setChecked] = useState<{ key: string; check: DcaPairCheck } | null>(null);
  const pairCheck = checked?.key === pairKey ? checked.check : null;
  const readPair = useCallback(
    () => checkDcaPair([payToken, buyToken], async (mints) =>
      (await connection.getMultipleAccountsInfo(mints.map((m) => new PublicKey(m)))).map((a) => a?.owner.toBase58() ?? null)),
    [connection, payToken, buyToken],
  );
  useEffect(() => {
    let cancelled = false;
    void readPair().then((check) => { if (!cancelled) setChecked({ key: pairKey, check }); });
    return () => { cancelled = true; };
  }, [readPair, pairKey]);
  const refused = pairCheck?.kind === 'token-2022' ? pairCheck.symbol : null;

  const loadOrders = useCallback(() => {
    if (!publicKey) { setOrders([]); return; }
    setOrdersLoading(true);
    getRecurringOrders(publicKey.toBase58())
      .then((o) => setOrders(o))
      .catch(() => setOrders(null))
      .finally(() => setOrdersLoading(false));
  }, [publicKey]);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  /** The signature once it confirmed; null when it was sent and we cannot tell (already said). */
  async function signSend(b64: string, repeatCost: string): Promise<string | null> {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const tx = VersionedTransaction.deserialize(bytes);
    // From the wallet's turn to the answer the page does not reload itself (lib/staleBuild.ts).
    const release = holdReload();
    try {
      const sig = await viaWallet(() => sendTransaction(tx, connection));
      return (await confirmSent(connection, sig, repeatCost)) ? sig : null;
    } finally {
      release();
    }
  }

  async function handlePlace() {
    if (!publicKey || !totalBase || sameToken) return;
    setPlacing(true);
    try {
      // Read again at the press, whatever the tab's own read said: nothing is built or signed until it answers "ok".
      const check = await readPair();
      setChecked({ key: pairKey, check });
      if (check.kind !== 'ok') {
        toast.error('DCA not started', { description: check.kind === 'token-2022' ? dcaToken2022Copy(check.symbol) : DCA_UNREAD_COPY });
        return;
      }
      const b64 = await createRecurringOrder({
        user: publicKey.toBase58(),
        inputMint: payToken.mint,
        outputMint: buyToken.mint,
        inAmount: totalBase,
        numberOfOrders: numBuys,
        intervalSeconds: intervalSecs,
      });
      const sig = await signSend(b64, 'starting it again opens a second DCA that deposits the same total again.');
      if (!sig) {
        // It may be running: clear the form so one more click does not start another.
        setTotalAmount('');
        loadOrders();
        return;
      }
      toast.success('DCA started', {
        description: shortSig(sig),
        action: { label: 'View', onClick: () => window.open(`https://solscan.io/tx/${sig}`, '_blank', 'noopener,noreferrer') },
      });
      recordActivity(publicKey.toBase58(), {
        sig,
        ts: Date.now(),
        kind: 'dca-place',
        summary: `DCA: ${prettyAmount(totalAmount)} ${payToken.symbol} → ${buyToken.symbol}, ${numBuys} buys ${intervalLabel(intervalSecs)}`,
      });
      setTotalAmount('');
      loadOrders();
    } catch (err) {
      const said = sayWalletThrew(err, 'the DCA was started');
      if (said === 'other') toast.error('Could not start the DCA', { description: (err as Error).message });
      if (said === 'unsure') {
        // It may be running: clear the form so one more click does not start another.
        setTotalAmount('');
        loadOrders();
      }
    } finally {
      setPlacing(false);
    }
  }

  async function handleCancel(o: RecurringOrder) {
    const key = recurringOrderKeyOf(o);
    if (!publicKey || !key) return;
    setCancelling(key);
    try {
      const sig = await signSend(await cancelRecurringOrder(publicKey.toBase58(), key), CANCEL_REPEAT_COST);
      if (!sig) { loadOrders(); return; }
      toast.success('DCA cancelled: unspent funds return to your wallet', { description: shortSig(sig) });
      recordActivity(publicKey.toBase58(), { sig, ts: Date.now(), kind: 'dca-cancel', summary: 'Cancelled a DCA' });
      loadOrders();
    } catch (err) {
      const said = sayWalletThrew(err, 'the DCA was cancelled');
      if (said === 'other') toast.error('Could not cancel', { description: (err as Error).message });
      if (said === 'unsure') loadOrders();
    } finally {
      setCancelling(null);
    }
  }

  const canPlace = !!publicKey && !!totalBase && !!perBuyHuman && !sameToken && !placing && !insufficient && !(needsAck && !ack) && refused === null && !underMinimum;
  // One amber line at a time, the one that matters most: a token Jupiter's program cannot
  // take comes first, since no amount fixes it.
  const amberLine =
    refused !== null ? dcaToken2022Copy(refused)
    : sameToken ? 'Pick two different tokens.'
    : insufficient ? `Insufficient ${payToken.symbol} balance.`
    : totalAmount.trim() !== '' && totalBase && !perBuyHuman ? 'Each buy rounds to zero. Raise the total or pick fewer buys.'
    : underMinimum && perBuyUsd !== null ? `Each buy is about $${perBuyUsd.toFixed(2)}, and Jupiter requires at least $${DCA_MIN_PER_BUY_USD} per buy.`
    : null;

  return (
    <>
      <div className="mb-1">
        <div className="flex items-center justify-between mb-2">
          <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Total to invest</span>
        </div>
        <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}>
          <button type="button" onClick={onPickPay} aria-haspopup="dialog" className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[40px] hover:bg-white/5 transition-colors">
            <span className="text-white font-medium text-[14px]">{payToken.symbol}</span>
            <span className="text-white/80" aria-hidden="true">▾</span>
          </button>
          <input type="text" inputMode="decimal" autoComplete="off" placeholder="0.0" aria-label={`Total ${payToken.symbol} to invest`} value={totalAmount} onChange={(e) => acceptAmountInput(e.target.value, setTotalAmount)} className="flex-1 bg-transparent text-right text-white text-[20px] font-mono outline-none min-w-0" />
        </div>
      </div>

      <div className="mt-3 mb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Buying</span>
        </div>
        <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}>
          <button type="button" onClick={onPickBuy} aria-haspopup="dialog" className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[40px] hover:bg-white/5 transition-colors">
            <span className="text-white font-medium text-[14px]">{buyToken.symbol}</span>
            <span className="text-white/80" aria-hidden="true">▾</span>
          </button>
          <div className="flex-1 flex items-center justify-end gap-2 text-[11px] text-white/70">
            <select value={numBuys} onChange={(e) => setNumBuys(Number(e.target.value))} aria-label="Number of buys" className="bg-black/40 text-white font-mono text-[16px] sm:text-[12px] outline-none rounded-md px-2 py-1.5" style={{ border: '1px solid rgba(255,255,255,0.12)' }}>
              {[2, 4, 6, 12, 24].map((n) => <option key={n} value={n}>{n} buys</option>)}
            </select>
            <select value={intervalSecs} onChange={(e) => setIntervalSecs(Number(e.target.value))} aria-label="Buy interval" className="bg-black/40 text-white font-mono text-[16px] sm:text-[12px] outline-none rounded-md px-2 py-1.5" style={{ border: '1px solid rgba(255,255,255,0.12)' }}>
              <option value={3_600}>hourly</option>
              <option value={86_400}>daily</option>
              <option value={604_800}>weekly</option>
            </select>
          </div>
        </div>
      </div>

      <div className="mb-3 text-[11px] space-y-1">
        {perBuyHuman && (
          <div className="flex items-center justify-between text-white/70">
            <span>Per buy</span>
            <span className="font-mono">{prettyAmount(perBuyHuman)} {payToken.symbol} {intervalLabel(intervalSecs)}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-white/70">
          <span>Platform fee</span>
          <span className="font-mono">None on DCA orders</span>
        </div>
        {amberLine !== null && (
          <p className="text-amber-300" data-testid={refused !== null ? 'dca-refused' : 'dca-warning'}>{amberLine}</p>
        )}
        {pairCheck?.kind === 'unread' && <p className="text-white/60">{DCA_UNREAD_NOTE}</p>}
        {shieldWarnings.map((w, i) => (
          <p key={`dsh-${i}`} className={`flex items-start gap-1 ${shieldIsAlarming(w, w.mint) ? 'text-red-300' : 'text-white/50'}`}>
            <span aria-hidden="true">⚠</span><span>{w.message}</span>
          </p>
        ))}
      </div>

      {needsAck && (
        <label className="flex items-start gap-2 mb-3 px-3 py-2.5 rounded-lg cursor-pointer" style={{ background: 'rgba(150,40,40,0.20)', border: '1px solid rgba(255,90,90,0.35)' }}>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 flex-shrink-0" />
          <span className="text-[11px] text-red-200">
            This pair carries a risk warning (an unverified token, or flagged by Jupiter Shield above). I understand and want to DCA into it anyway.
          </span>
        </label>
      )}

      {!publicKey ? (
        <SolanaConnectButton />
      ) : (
        <button type="button" onClick={() => void handlePlace()} disabled={!canPlace} className="btn-primary w-full py-2.5 text-[14px] disabled:opacity-50">
          {placing ? 'Starting…' : refused !== null ? `Not available for ${refused}` : !totalBase ? 'Enter a total amount' : insufficient ? `Insufficient ${payToken.symbol}` : !perBuyHuman ? 'Amount too small' : underMinimum ? `Under $${DCA_MIN_PER_BUY_USD} per buy` : 'Start the DCA'}
        </button>
      )}

      <p className="mt-3 text-center text-white/60 text-[10px]">
        Deposited up front. Cancel anytime; unspent funds come back. Jupiter requires at least ${DCA_MIN_PER_BUY_USD} per buy.
      </p>
      <FinePrint summary="How it works">
        <p>
          The full amount is deposited up front and spent automatically by Jupiter keepers, {numBuys} buys {intervalLabel(intervalSecs)}.
          No tab to keep open.
        </p>
      </FinePrint>

      {publicKey && (
        <div className="mt-4 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.10)' }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-white text-[12px] font-semibold">Active DCAs</span>
            <button type="button" onClick={loadOrders} className="text-white/60 text-[10px] hover:text-white px-2 py-2.5 -my-2">Refresh</button>
          </div>
          {ordersLoading ? (
            <p className="text-white/50 text-[11px]">Loading…</p>
          ) : orders === null ? (
            <OrdersUnread what="Your DCAs" onRetry={loadOrders} />
          ) : orders.length === 0 ? (
            <p className="text-white/60 text-[11px]">No active DCAs.</p>
          ) : (
            <div className="space-y-1.5">
              {orders.map((o, i) => {
                const key = recurringOrderKeyOf(o);
                const inTok = findSolToken(String(o.inputMint ?? ''));
                const outTok = findSolToken(String(o.outputMint ?? ''));
                // Human amounts only with KNOWN decimals — unknown tokens fall
                // back to the order key, never a guessed magnitude.
                const perCycle = o.inAmountPerCycle && inTok ? prettyAmount(fromBaseUnits(String(o.inAmountPerCycle), inTok.decimals)) : null;
                const freq = Number(o.cycleFrequency);
                const keyShort = key ? `${key.slice(0, 4)}…${key.slice(-4)}` : 'order';
                return (
                  <div key={key ?? i} className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.10)' }}>
                    <div className="min-w-0">
                      <div className="text-white/80 text-[11px] truncate">
                        {perCycle ? `Buy with ${perCycle} ${inTok?.symbol ?? '?'} ${Number.isFinite(freq) ? intervalLabel(freq) : ''} → ${outTok?.symbol ?? '?'}` : keyShort}
                      </div>
                      {perCycle && <div className="text-white/50 text-[9px] font-mono truncate">{keyShort}</div>}
                    </div>
                    <button type="button" onClick={() => void handleCancel(o)} disabled={!key || cancelling === key} className="text-red-300 text-[11px] hover:text-red-200 disabled:opacity-50 flex-shrink-0 px-2 py-2.5 -my-2">
                      {cancelling === key ? 'Cancelling…' : 'Cancel'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}

// Limit orders — Jupiter Trigger: real ON-CHAIN orders, filled by keepers (no tab
// to keep open, unlike the EVM browser-only Alerts). Shares the pair with swap.
// v1 ships fee-off (integrator fees need a referral-account setup).
function LimitTab({ payToken, buyToken, shieldWarnings, needsAck, ack, setAck, onPickPay, onPickBuy }: {
  payToken: SolToken; buyToken: SolToken;
  shieldWarnings: MintedShieldWarning[]; needsAck: boolean; ack: boolean; setAck: (v: boolean) => void;
  onPickPay: () => void; onPickBuy: () => void;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [sellAmount, setSellAmount] = useState('');
  const [price, setPrice] = useState('');
  const [expiryDays, setExpiryDays] = useState(7);
  const [placing, setPlacing] = useState(false);
  // Null: the read did not answer (OrdersUnread), never an empty list.
  const [orders, setOrders] = useState<TriggerOrder[] | null>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const payBalance = useTokenBalance(payToken);

  const sameToken = payToken.mint === buyToken.mint;
  const makingAmount = useMemo(() => toBaseUnits(sellAmount, payToken.decimals), [sellAmount, payToken.decimals]);
  // takingAmount = makingAmount × price in BigInt fixed-point (no float / no
  // exponential round-trip). price is the buyToken-per-1-payToken rate,
  // multiplied at FULL typed precision — see limitTakingAmount for why the
  // truncate-then-multiply shape silently floored the order rate.
  const takingAmount = useMemo(
    () => limitTakingAmount(makingAmount, price, payToken.decimals, buyToken.decimals),
    [makingAmount, price, payToken.decimals, buyToken.decimals],
  );
  const insufficient = payBalance.raw !== null && makingAmount !== null && BigInt(makingAmount) > payBalance.raw;

  const loadOrders = useCallback(() => {
    if (!publicKey) { setOrders([]); return; }
    setOrdersLoading(true);
    getTriggerOrders(publicKey.toBase58())
      .then((o) => setOrders(o))
      .catch(() => setOrders(null))
      .finally(() => setOrdersLoading(false));
  }, [publicKey]);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  /** The signature once it confirmed; null when it was sent and we cannot tell (already said). */
  async function signSend(b64: string, repeatCost: string): Promise<string | null> {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const tx = VersionedTransaction.deserialize(bytes);
    // From the wallet's turn to the answer the page does not reload itself (lib/staleBuild.ts).
    const release = holdReload();
    try {
      const sig = await viaWallet(() => sendTransaction(tx, connection));
      return (await confirmSent(connection, sig, repeatCost)) ? sig : null;
    } finally {
      release();
    }
  }

  async function handlePlace() {
    if (!publicKey || !makingAmount || !takingAmount || sameToken) return;
    setPlacing(true);
    try {
      const expiredAt = expiryDays > 0 ? Math.floor(Date.now() / 1000) + expiryDays * 86400 : undefined;
      const b64 = await createTriggerOrder({
        inputMint: payToken.mint,
        outputMint: buyToken.mint,
        maker: publicKey.toBase58(),
        makingAmount,
        takingAmount,
        expiredAt,
      });
      const sig = await signSend(b64, 'placing it again opens a second order that sells the same amount again.');
      if (!sig) {
        // It may be open: clear the form so one more click does not place another.
        setSellAmount(''); setPrice('');
        loadOrders();
        return;
      }
      toast.success('Limit order placed', {
        description: shortSig(sig),
        action: { label: 'View', onClick: () => window.open(`https://solscan.io/tx/${sig}`, '_blank', 'noopener,noreferrer') },
      });
      recordActivity(publicKey.toBase58(), {
        sig,
        ts: Date.now(),
        kind: 'limit-place',
        summary: `Limit: sell ${prettyAmount(sellAmount)} ${payToken.symbol} → ≈${prettyAmount(fromBaseUnits(takingAmount, buyToken.decimals))} ${buyToken.symbol}`,
      });
      setSellAmount(''); setPrice('');
      loadOrders();
    } catch (err) {
      const said = sayWalletThrew(err, 'the order was placed');
      if (said === 'other') toast.error('Could not place order', { description: (err as Error).message });
      if (said === 'unsure') {
        // It may be open: clear the form so one more click does not place another.
        setSellAmount(''); setPrice('');
        loadOrders();
      }
    } finally {
      setPlacing(false);
    }
  }

  async function handleCancel(o: TriggerOrder) {
    const key = orderKeyOf(o);
    if (!publicKey || !key) return;
    setCancelling(key);
    try {
      const sig = await signSend(await cancelTriggerOrder(publicKey.toBase58(), key), CANCEL_REPEAT_COST);
      if (!sig) { loadOrders(); return; }
      toast.success('Order cancelled', { description: shortSig(sig) });
      recordActivity(publicKey.toBase58(), {
        sig,
        ts: Date.now(),
        kind: 'limit-cancel',
        summary: 'Cancelled a limit order',
      });
      loadOrders();
    } catch (err) {
      const said = sayWalletThrew(err, 'the order was cancelled');
      if (said === 'other') toast.error('Could not cancel', { description: (err as Error).message });
      if (said === 'unsure') loadOrders();
    } finally {
      setCancelling(null);
    }
  }

  const canPlace = !!publicKey && !!makingAmount && !!takingAmount && !sameToken && !placing && !insufficient && !(needsAck && !ack);

  return (
    <>
      <div className="mb-1">
        <div className="flex items-center justify-between mb-2">
          <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>You Sell</span>
        </div>
        <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}>
          <button type="button" onClick={onPickPay} aria-haspopup="dialog" className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[40px] hover:bg-white/5 transition-colors">
            <span className="text-white font-medium text-[14px]">{payToken.symbol}</span>
            <span className="text-white/80" aria-hidden="true">▾</span>
          </button>
          <input type="text" inputMode="decimal" autoComplete="off" placeholder="0.0" aria-label={`Amount of ${payToken.symbol} to sell`} value={sellAmount} onChange={(e) => acceptAmountInput(e.target.value, setSellAmount)} className="flex-1 bg-transparent text-right text-white text-[20px] font-mono outline-none min-w-0" />
        </div>
      </div>

      <div className="mt-3 mb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>When 1 {payToken.symbol} =</span>
        </div>
        <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}>
          <button type="button" onClick={onPickBuy} aria-haspopup="dialog" className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[40px] hover:bg-white/5 transition-colors">
            <span className="text-white font-medium text-[14px]">{buyToken.symbol}</span>
            <span className="text-white/80" aria-hidden="true">▾</span>
          </button>
          <input type="text" inputMode="decimal" autoComplete="off" placeholder="0.0" aria-label={`Target price in ${buyToken.symbol}`} value={price} onChange={(e) => acceptAmountInput(e.target.value, setPrice)} className="flex-1 bg-transparent text-right text-white text-[20px] font-mono outline-none min-w-0" />
        </div>
      </div>

      <div className="mb-3 text-[11px] space-y-1">
        {takingAmount && (
          <div className="flex items-center justify-between text-white/70">
            <span>You receive (at limit)</span>
            <span className="font-mono">{prettyAmount(fromBaseUnits(takingAmount, buyToken.decimals))} {buyToken.symbol}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-white/70">
          <span>Expires</span>
          <select value={expiryDays} onChange={(e) => setExpiryDays(Number(e.target.value))} aria-label="Order expiry" className="bg-black/40 text-white font-mono text-[16px] sm:text-[12px] outline-none rounded-md px-2 py-1.5" style={{ border: '1px solid rgba(255,255,255,0.12)' }}>
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={0}>Never</option>
          </select>
        </div>
        {sameToken && <p className="text-amber-300">Pick two different tokens.</p>}
        {insufficient && <p className="text-amber-300">Insufficient {payToken.symbol} balance.</p>}
        {makingAmount && Number(price) > 0 && !takingAmount && <p className="text-amber-300">Receive amount rounds to zero — increase the amount or price.</p>}
        {shieldWarnings.map((w, i) => (
          <p key={`lsh-${i}`} className={`flex items-start gap-1 ${shieldIsAlarming(w, w.mint) ? 'text-red-300' : 'text-white/50'}`}>
            <span aria-hidden="true">⚠</span><span>{w.message}</span>
          </p>
        ))}
      </div>

      {needsAck && (
        <label className="flex items-start gap-2 mb-3 px-3 py-2.5 rounded-lg cursor-pointer" style={{ background: 'rgba(150,40,40,0.20)', border: '1px solid rgba(255,90,90,0.35)' }}>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 flex-shrink-0" />
          <span className="text-[11px] text-red-200">
            This pair carries a risk warning (an unverified token, or flagged by Jupiter Shield above). I understand and want to place this order anyway.
          </span>
        </label>
      )}

      {!publicKey ? (
        <SolanaConnectButton />
      ) : (
        <button type="button" onClick={() => void handlePlace()} disabled={!canPlace} className="btn-primary w-full py-2.5 text-[14px] disabled:opacity-50">
          {placing ? 'Placing…' : !makingAmount ? 'Enter an amount' : insufficient ? `Insufficient ${payToken.symbol}` : !price ? 'Enter a price' : !takingAmount ? 'Amount too small' : 'Place limit order'}
        </button>
      )}

      <p className="mt-3 text-center text-white/60 text-[10px]">
        Funds are reserved until fill, cancel, or expiry.
      </p>
      <FinePrint summary="How it works">
        <p>Real on-chain order, filled automatically by Jupiter keepers — no tab to keep open.</p>
      </FinePrint>

      {publicKey && (
        <div className="mt-4 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.10)' }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-white text-[12px] font-semibold">Open orders</span>
            <button type="button" onClick={loadOrders} className="text-white/60 text-[10px] hover:text-white px-2 py-2.5 -my-2">Refresh</button>
          </div>
          {ordersLoading ? (
            <p className="text-white/50 text-[11px]">Loading…</p>
          ) : orders === null ? (
            <OrdersUnread what="Your open orders" onRetry={loadOrders} />
          ) : orders.length === 0 ? (
            <p className="text-white/60 text-[11px]">No open orders.</p>
          ) : (
            <div className="space-y-1.5">
              {orders.map((o, i) => {
                const key = orderKeyOf(o);
                const fromTok = findSolToken(String(o.inputMint ?? ''));
                const toTok = findSolToken(String(o.outputMint ?? ''));
                // Only format a human amount when the token's REAL decimals are
                // known. The old `?? 9` guessed 9 for any non-curated token, so a
                // 6-decimal token (USDC etc.) rendered ~1000x wrong. Unknown →
                // null → the row falls back to the order key below, never a lie.
                const sell = o.makingAmount && fromTok ? prettyAmount(fromBaseUnits(String(o.makingAmount), fromTok.decimals)) : null;
                const buy = o.takingAmount && toTok ? prettyAmount(fromBaseUnits(String(o.takingAmount), toTok.decimals)) : null;
                const keyShort = key ? `${key.slice(0, 4)}…${key.slice(-4)}` : 'order';
                return (
                  <div key={key ?? i} className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.10)' }}>
                    <div className="min-w-0">
                      <div className="text-white/80 text-[11px] truncate">
                        {sell && buy ? `Sell ${sell} ${fromTok?.symbol ?? '?'} → ${buy} ${toTok?.symbol ?? '?'}` : keyShort}
                      </div>
                      {sell && buy && <div className="text-white/40 text-[9px] font-mono truncate">{keyShort}</div>}
                    </div>
                    <button type="button" onClick={() => void handleCancel(o)} disabled={!key || cancelling === key} className="text-red-300 text-[11px] hover:text-red-200 disabled:opacity-50 flex-shrink-0 px-2 py-2.5 -my-2">
                      {cancelling === key ? 'Cancelling…' : 'Cancel'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * The swap form. `home` is the home page's card (owner, 2026-10-16: swap, stake and add
 * liquidity right on the home): SOL to BAYLA to start, nothing read from the address (the
 * home's address is not a share link), no page header, no Limit or DCA tabs, no chart and
 * no rails. The trade itself, its route, its fee line and every check are this form's own.
 */
export function SolanaSwapInner({ home = false }: { home?: boolean } = {}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  // The address this form reads its opening pair and amount from: none on the home.
  const [linkSearch] = useState(() => {
    try {
      return home ? '' : window.location.search;
    } catch {
      return '';
    }
  });

  // ?in=<mint> presets the PAY side (share links). Same rules as ?out= below.
  const [payToken, setPayToken] = useState<SolToken>(() => {
    try {
      const inp = new URLSearchParams(linkSearch).get('in')?.trim();
      if (inp && looksLikeMint(inp)) {
        const known = findSolToken(inp);
        if (known) return known;
      }
    } catch { /* URL APIs unavailable — default stands */ }
    return SOL;
  });
  // The BUY side opens on openingBuyMint: a link's ?out=<mint>, else the Solana room's
  // coin, else $BAYLA. A curated mint resolves synchronously in this initializer;
  // any other resolves async below, with $BAYLA standing until it does.
  const [openingBuy] = useState(() => {
    try {
      // The home's card opens on BAYLA whatever room was last entered.
      return openingBuyMint(linkSearch, home ? null : getActiveBungalow());
    } catch { /* URL APIs unavailable — default stands */ }
    return BAYLA.mint;
  });
  const [buyToken, setBuyToken] = useState<SolToken>(() => findSolToken(openingBuy) ?? BAYLA);
  // ?amt=<decimal> presets the pay amount (token-denominated). Malformed
  // values fall back silently — a bad deep link must never break the page.
  const [amount, setAmount] = useState(() => {
    try {
      const amt = new URLSearchParams(linkSearch).get('amt')?.trim();
      // Same unambiguous-regex rule as acceptAmountInput (query strings are
      // attacker-length): the dot is anchored, so no polynomial backtracking.
      if (amt && /^(?:\d*\.)?\d+$/.test(amt) && /[1-9]/.test(amt)) return amt;
    } catch { /* default stands */ }
    return '';
  });
  const [slippageBps, setSlippageBps] = useState(50);
  // "Buy $50 of it" is the mental model most traders arrive with — usdMode
  // makes the pay input dollar-denominated, converted through the live
  // price/v3 quote (refreshed every 30s while the mode is on).
  const [usdMode, setUsdMode] = useState(false);
  // Priority-fee level for the swap build ("Speed"). Persisted per browser;
  // storage failures fall back to Fast (try/catch — private windows).
  const [speed, setSpeed] = useState<PriorityLevel>(() => {
    try {
      const s = localStorage.getItem('sol.speed');
      if (s === 'medium' || s === 'high' || s === 'veryHigh') return s;
    } catch { /* default stands */ }
    return 'high';
  });
  const [detailToken, setDetailToken] = useState<SolToken | null>(null);
  const [quote, setQuote] = useState<JupiterQuote | null>(null);
  // The no-fee quote on screen, if that is the one: the send path's re-quote after
  // Jupiter's 6014, or a quote of a pair where that was found. Compared by identity, so
  // any other quote landing ends it by itself.
  const [waivedQuote, setWaivedQuote] = useState<JupiterQuote | null>(null);
  const feeWaived = quote !== null && quote === waivedQuote;
  // Pairs (pay|buy) whose fee-bearing Jupiter transaction failed with its 6014, so the
  // no-fee one is what this site sends (swap/jupiterFeeRetry.ts). Kept for the pair, not
  // on one quote: every quote of it is the no-fee one until a fee-bearing build runs clean.
  const noFeePairs = useRef<Set<string>>(new Set());
  // The trade (pay|buy|amount, at its slippage, for its wallet) whose Jupiter transaction
  // failed its test run with one of our pools quoting it: its quote is no route for that
  // trade (useSolanaRoute). `why`: the cause that test run gave (refusalWhy). Dropped only
  // when a later test run of it answers and passes.
  const [refusedTrade, setRefusedTrade] = useState<{ key: string; why: string | null } | null>(null);
  // Presses in a row whose Jupiter test run could not run (a run that answers resets it). From
  // the second, the trade pressed (key) and Jupiter's quote for it (out) are kept: when one of
  // our pools quotes that trade, its review is offered (owner, 2026-10-14, D2).
  const uncheckedRun = useRef(0);
  const [ownOffer, setOwnOffer] = useState<{ key: string; out: bigint } | null>(null);
  // What a press through Jupiter is for, in words, kept from the press: the form can come to
  // show another trade under it (formNow), and the line under it must not name that one.
  const [throughJupiter, setThroughJupiter] = useState('');
  const [quoteLoading, setQuoteLoading] = useState(false);
  // Why there is no quote, when one was asked for and none came back.
  // 'no-route' is ONLY the quote service's own answer (lib/jupiter.ts
  // NoRouteError). Every other failure (a 429, a 502, a dropped request) is
  // 'unavailable': a quote that could not be fetched just now. That one is
  // never worded as "no route", which would tell the trader the token cannot
  // be bought here, and it comes with "Try again".
  const [quoteFail, setQuoteFail] = useState<'no-route' | 'unavailable' | null>(null);
  // Bumped by "Try again": asks for the same quote again, the form untouched.
  const [quoteAttempt, setQuoteAttempt] = useState(0);
  // When Jupiter answered each quote the form asked for (SHOWN_QUOTE_FRESH_MS).
  const quoteSeenAt = useRef(new WeakMap<JupiterQuote, number>());
  const [swapping, setSwapping] = useState(false);
  const [picker, setPicker] = useState<'pay' | 'buy' | null>(null);
  const [mode, setMode] = useState<'swap' | 'limit' | 'dca'>('swap');
  const [ack, setAck] = useState(false);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [shield, setShield] = useState<Record<string, ShieldWarning[]>>({});
  const payBalance = useTokenBalance(payToken);
  const retryPayBalance = payBalance.retry;

  const payPrice = prices[payToken.mint];
  // In USD mode the input holds dollars; derive the token amount through the
  // live price. toFixed keeps the float out of base-unit math — toBaseUnits
  // parses the resulting plain decimal string, exactly like typed input.
  const tokenAmount = useMemo(() => {
    if (!usdMode) return amount;
    const usd = Number(amount);
    if (!amount || !Number.isFinite(usd) || usd <= 0 || !payPrice) return '';
    return (usd / payPrice).toFixed(Math.min(payToken.decimals, 9));
  }, [usdMode, amount, payPrice, payToken.decimals]);
  const baseAmount = useMemo(() => toBaseUnits(tokenAmount, payToken.decimals), [tokenAmount, payToken.decimals]);
  const sameToken = payToken.mint === buyToken.mint;
  // The coins the address names that are still being looked up. Until they are, the form holds:
  // no quote is asked and the buy button is off, so a sized link (the Arbitrage card's Swap, with
  // ?amt=) is never quoted or sent on the default pair with that amount in it.
  const [linkPending, setLinkPending] = useState(() => {
    try {
      const search = new URLSearchParams(linkSearch);
      return [openingBuy, search.get('in')?.trim()].filter((m) => m && looksLikeMint(m) && !findSolToken(m)).length;
    } catch {
      return 0;
    }
  });
  const canQuote = baseAmount !== null && !sameToken && linkPending === 0;

  // The opening pair, continued: a NON-curated mint (a link's, or a room's coin) needs
  // the Jupiter lookup for authoritative decimals (never invent them). A coin Jupiter
  // does not list, or could not be asked about, is read from the chain instead (its mint
  // gives the decimals; swap/chainToken.ts): a link from one of our pools must open on
  // that pool's coin. Mount-once; a lookup that fails both ways leaves the honest default
  // in place — a bad deep link must never break the page. The curated cases were already
  // handled in the state initializers.
  // A coin neither could name is said (`linkMissed`): the form opened on another pair than was asked
  // for, by the link or by the room the visitor is in.
  const [linkMissed, setLinkMissed] = useState<{ mint: string; from: 'link' | 'room' } | null>(null);
  useEffect(() => {
    const search = new URLSearchParams(linkSearch);
    const ctrl = new AbortController();
    let live = true;
    const linkedOut = search.get('out')?.trim();
    for (const [mint, set, from] of [[openingBuy, setBuyToken, linkedOut === openingBuy ? 'link' : 'room'], [search.get('in')?.trim(), setPayToken, 'link']] as const) {
      if (!mint || !looksLikeMint(mint) || findSolToken(mint)) continue;
      resolveMint(mint, ctrl.signal)
        .catch(() => null)
        .then((t) => t ?? tokenFromChain(withReadCommitment(browserRpc(), 'confirmed'), mint))
        .then((t) => {
          if (!live) return;
          if (t) set(t);
          else setLinkMissed({ mint, from });
          setLinkPending((n) => Math.max(0, n - 1));
        })
        .catch(() => { /* honest default stands */ });
    }
    return () => {
      live = false;
      ctrl.abort();
    };
  }, [openingBuy, linkSearch]);

  // Tokens ticked while this pair is on screen: their box stays, so the tick can be taken back.
  const [tickedNow, setTickedNow] = useState<ReadonlySet<string>>(() => new Set());
  // Reset the unverified-token acknowledgement whenever the pair changes.
  useEffect(() => { setAck(false); setTickedNow(new Set()); }, [payToken.mint, buyToken.mint]);
  // The pair Jupiter Shield last ANSWERED for. A read in flight or one that failed is not an answer.
  const [shieldReadFor, setShieldReadFor] = useState<string | null>(null);

  // Debounced quote fetch.
  useEffect(() => {
    if (!canQuote || !baseAmount) {
      setQuote(null);
      setQuoteFail(null);
      setQuoteLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setQuoteLoading(true);
    setQuoteFail(null);
    // A quote for a DIFFERENT pair must not survive into the fetch window:
    // the details rows format its raw base units with the NEW buy token's
    // decimals and symbol ("min received 149250000" USDC-units rendered as
    // 1492.5 BONK). Same-pair re-quotes (amount/slippage edits) keep the old
    // numbers to avoid blanking the panel on every keystroke.
    setQuote((q) => (q && (q.inputMint !== payToken.mint || q.outputMint !== buyToken.mint) ? null : q));
    const t = setTimeout(() => {
      const noFee = noFeePairs.current.has(`${payToken.mint}|${buyToken.mint}`);
      getQuote({
        inputMint: payToken.mint,
        outputMint: buyToken.mint,
        amount: baseAmount,
        slippageBps,
        signal: ctrl.signal,
        ...(noFee ? { noPlatformFee: true } : {}),
      })
        .then((q) => {
          if (ctrl.signal.aborted) return;
          if (noFee) setWaivedQuote(q);
          quoteSeenAt.current.set(q, Date.now());
          setQuote(q); setQuoteFail(null); setQuoteLoading(false);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
          setQuote(null);
          // "No route" only when the quote service itself said so.
          setQuoteFail(err instanceof NoRouteError ? 'no-route' : 'unavailable');
          setQuoteLoading(false);
        });
    }, 400);
    return () => { clearTimeout(t); ctrl.abort(); };
    // quoteAttempt is here only so "Try again" re-runs this for the same form.
  }, [baseAmount, canQuote, payToken.mint, buyToken.mint, slippageBps, quoteAttempt]);

  // USD prices for the pay and receive legs, read again on a pair change. The 30 s
  // refresh in USD mode is further down: it waits while a trade is on its way. Outside
  // USD mode a price only labels amounts, so the read is the one every visitor shares at
  // the edge (up to 45 s old); in USD mode it sizes the trade and is read fresh.
  useEffect(() => {
    let cancelled = false;
    getUsdPrices([payToken.mint, buyToken.mint], undefined, { shared: !usdMode })
      .then((p) => { if (!cancelled) setPrices(p); })
      .catch(() => { /* USD context is best-effort */ });
    return () => { cancelled = true; };
  }, [payToken.mint, buyToken.mint, usdMode]);

  // Persist the speed choice (best-effort — private windows just don't keep it).
  useEffect(() => {
    try { localStorage.setItem('sol.speed', speed); } catch { /* convenience only */ }
  }, [speed]);

  // Jupiter Shield risk warnings for the pair (once per pair). Fail OPEN.
  useEffect(() => {
    let cancelled = false;
    const pair = `${payToken.mint}|${buyToken.mint}`;
    getShield([payToken.mint, buyToken.mint])
      .then((s) => { if (!cancelled) { setShield(s); setShieldReadFor(pair); } })
      .catch(() => { if (!cancelled) { setShield({}); setShieldReadFor(null); } });
    return () => { cancelled = true; };
  }, [payToken.mint, buyToken.mint]);

  // WHERE THIS TRADE GOES: our own pools quoted beside Jupiter, and whichever pays the
  // trader more; a tie stays here (lib/solana/route.ts). One decision, said by the route
  // line and executed by handleSwap.
  // No route either while the address's coin is still being looked up: our pools would be read, and a
  // line drawn, for the pair that stands meanwhile, not the one asked for.
  const amountInRaw = useMemo(() => (baseAmount === null || sameToken || linkPending > 0 ? null : BigInt(baseAmount)), [baseAmount, sameToken, linkPending]);
  const aggregatorQuote = useMemo(
    () => (quote ? { outAmount: quote.outAmount, priceImpactPct: quote.priceImpactPct } : null),
    [quote],
  );
  // The trade on the form: what a press was for.
  const formKey = `${payToken.mint}|${buyToken.mint}|${baseAmount ?? ''}`;
  // What a refusal of Jupiter's transaction is kept for: that trade, at that slippage, for
  // that wallet. Each is an input of the test run: with another, nothing was found.
  const refusalKey = `${formKey}|${slippageBps}|${publicKey?.toBase58() ?? ''}`;
  const route = useSolanaRoute({
    inputMint: payToken.mint, outputMint: buyToken.mint, amountInRaw, aggregatorQuote,
    aggregatorPending: quoteLoading, aggregatorRefused: refusedTrade?.key === refusalKey, retry: quoteAttempt,
  });
  const forgetPools = route.forget;

  // What a swap in our own pool was, kept from the press of Buy for when it settles:
  // the pair on the form can change under an open review (a pick from the rails below).
  // `owner` is the wallet it was built for: the only one that can sign it (submitPrepared).
  const ownTrade = useRef<{ owner: string; pay: string; buy: string; buyMint: string; amount: string; outDecimals: number; done: 'Bought' | 'Sold'; symbol: string } | null>(null);
  // The same, for the page to draw: the words of the trade pressed.
  const [pressed, setPressed] = useState<{ pay: string; buy: string; amount: string; outDecimals: number } | null>(null);
  const onOwnSettled = useCallback<OnSettled>(
    (outcome, prepared) => {
      const t = ownTrade.current;
      const sent = outcome.status === 'confirmed' || (outcome.status === 'unknown' && outcome.signature !== '');
      // Recorded for the wallet that signed it, whichever is connected when the chain answers.
      const wallet = t?.owner;
      const ownGot = ownSwapOut(prepared?.summary);
      if (ownGot !== null && t && wallet && sent) {
        const got = prettyAmount(fromBaseUnits(ownGot.toString(), t.outDecimals));
        const words = `≈${got} ${t.buy} with ${t.amount} ${t.pay}, in our own pool`;
        // Kept in "Your recent activity", as a Jupiter swap is, so the signature outlives the page.
        recordActivity(wallet, { sig: outcome.signature, ts: Date.now(), kind: 'swap', summary: outcome.status === 'confirmed' ? `Bought ${words}` : `Sent, not confirmed: ${words}` });
        // Bayla's line says "Done." for a minute (answer twenty-four, build 4).
        if (outcome.status === 'confirmed') markLanded('trade');
        const room = outcome.status === 'confirmed' ? bungalowByAddress('solana', t.buyMint) : null;
        if (room) setLastBuy({ hash: outcome.signature, symbol: room.symbol, tokenAddress: t.buyMint, chain: room.chain, buyer: wallet, atUnix: Math.floor(Date.now() / 1000) });
        // The form is cleared so the same buy is not one click away.
        setAmount('');
        setQuote(null);
        retryPayBalance();
      }
      // Whatever the answer, our pools are read again before they are quoted again: the
      // pool traded, or the press found it other than the read the line was drawn from.
      forgetPools();
      // Whatever the answer, the numbers under the form are asked for again.
      setQuoteAttempt((n) => n + 1);
    },
    [forgetPools, retryPayBalance],
  );
  const requote = useCallback(() => setQuoteAttempt((n) => n + 1), []);
  // The island order was opened: it buys a coin our pool wins in our pool, so it needs the swap code too.
  const [islandWantsOwn, setIslandWantsOwn] = useState(false);
  const wantOwnForIsland = useCallback(() => setIslandWantsOwn(true), []);
  const venueSwap = useVenueSwap({
    wanted: route.own === 'quoted' || islandWantsOwn,
    programId: route.venue?.kind === 'live' ? route.venue.programId : null,
    onSettled: onOwnSettled,
    onResolved: requote,
  });
  const flowState = venueSwap.flow.state;
  // Every swap in our pool stops on its review before the wallet is asked (owner, 2026-10-13).
  // An ending one line can say returns to the form by itself (components/swap/quietSwap.ts).
  const quiet = flowState.step === 'outcome' ? quietEnding(flowState.outcome) : null;
  // The review, or an ending with something to say, takes the form's place.
  const ownFlowOpen = flowState.step === 'review' || (flowState.step === 'outcome' && quiet === null);
  const ownBusy =
    flowState.step === 'preparing' ? 'Preparing…'
    : flowState.step === 'submitting' ? 'Confirm in your wallet…'
    : flowState.step === 'sent' ? 'Confirming…'
    : null;
  // A trade on its way, by either route: the wallet is asked for what was pressed, so
  // nothing on the form may change under it.
  const held = swapping || ownBusy !== null;
  // In USD mode the price is read every 30 s, so a stale one cannot mis-size the trade,
  // but never under a press: it would re-size the trade the press is holding.
  useEffect(() => {
    if (!usdMode || held) return;
    let cancelled = false;
    const iv = setInterval(() => {
      getUsdPrices([payToken.mint, buyToken.mint])
        .then((p) => { if (!cancelled) setPrices(p); })
        .catch(() => { /* USD context is best-effort */ });
    }, 30_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [usdMode, held, payToken.mint, buyToken.mint]);
  const { target: buyRef, fallback: headingRef } = useReturnFocus(ownFlowOpen ? flowState.step : 'idle');
  // The swap at the wallet or on its way to the chain, as built.
  const inFlightTx = flowState.step === 'review' || flowState.step === 'submitting' || flowState.step === 'sent' ? flowState.prepared : null;
  const inFlight = inFlightTx ? ownSwapView(inFlightTx.summary) : null;

  const { reset: resetOwn } = venueSwap.flow;
  const explorerOwn = venueSwap.api?.explorerTxUrl;
  const ownCluster = venueSwap.cfg?.cluster ?? 'mainnet';
  useEffect(() => {
    if (flowState.step !== 'outcome') return;
    const ending = quietEnding(flowState.outcome);
    if (!ending) return;
    const t = ownTrade.current;
    if (ending.kind === 'confirmed') {
      const out = ownSwapOut(flowState.prepared?.summary);
      const got = out !== null && t ? `≈${prettyAmount(fromBaseUnits(out.toString(), t.outDecimals))} ${t.buy} for ${t.amount} ${t.pay}` : shortSig(ending.signature);
      const url = explorerOwn ? explorerOwn(ending.signature, ownCluster) : `https://solscan.io/tx/${ending.signature}`;
      toast.success(t ? `${t.done} ${t.symbol}` : 'Swap confirmed', { description: got, action: { label: 'View', onClick: () => window.open(url, '_blank', 'noopener,noreferrer') } });
    } else if (ending.kind === 'not-signed') {
      toast.info('Not sent', { description: ending.message });
    } else {
      toast.error('Route changed', { description: ending.message });
    }
    resetOwn();
    // The button was switched off under the keyboard: hand focus back to it, without moving the page.
    requestAnimationFrame(() => {
      const b = buyRef.current;
      if (b && !b.disabled) b.focus({ preventScroll: true });
    });
  }, [flowState, explorerOwn, ownCluster, resetOwn, buyRef]);
  // A swap the connected wallet sent from this browser, by either route, in any tab, and
  // not confirmed yet holds Buy for that wallet until the chain answers (useVenueSwap).
  const pendingNote = venueSwap.pending.notes.length > 0;
  const { hold: holdNote, release: releaseNote, holdsNow } = venueSwap.pending;
  // A note that stands up while a review is open (another tab sent from this wallet) closes
  // it: the hold card takes its place. Not under a Sign already pressed: the send path
  // reads the notes again before the wallet (useVenueSwap).
  const reviewOpen = flowState.step === 'review' && !flowState.checking;
  useEffect(() => {
    if (!pendingNote || !reviewOpen) return;
    resetOwn();
    toast.info('Not sent', { description: HELD_NOT_SENT });
  }, [pendingNote, reviewOpen, resetOwn]);

  // The trade on the form, for a press that answers late (ownPoolTakesIt). Updated after
  // each render, never during one.
  const formNow = useRef(formKey);
  useEffect(() => {
    formNow.current = formKey;
  }, [formKey]);

  // Our pool takes the trade when the decision names it AND a swap in it can be
  // prepared here. When it cannot, the trade goes through Jupiter and the line says why.
  const ownChosen = route.decision?.chosen?.venue === 'own-pool' ? route.decision.chosen : null;
  // While Jupiter's transaction is being prepared or is at the wallet (`swapping`), the page
  // describes that trade: a pool read landing meanwhile does not turn the screen to our pool.
  const ownBest = ownChosen && !venueSwap.unavailable && !swapping ? (route.candidates.find((c) => c.poolAddress === ownChosen.poolAddress) ?? null) : null;
  // The swap code or its gate is still on its way.
  const ownPreparing = ownBest !== null && venueSwap.ready === null;

  // A figure only when a quote answered with one. A quote that was asked for
  // and did not come back is a dash (the same mark as an unread balance),
  // never a 0, which reads as "you would receive nothing". With no amount
  // typed nothing was asked, and the 0 stands. The figure is the route's: our
  // pool's quote when our pool takes the trade, Jupiter's otherwise.
  const shownOut = ownBest ? ownBest.outAmount.toString() : quote ? quote.outAmount : null;
  const outputDisplay = shownOut !== null
    ? prettyAmount(fromBaseUnits(shownOut, buyToken.decimals))
    : quoteFail ? '–' : '0';
  const rawImpact = ownBest ? ownBest.quote.priceImpact : Number(quote?.priceImpactPct);
  const priceImpact = Number.isFinite(rawImpact) ? Math.abs(rawImpact * 100) : null;
  const ownFloor = ownBest ? applySlippage(ownBest.outAmount, BigInt(slippageBps)) : null;
  // Said in view, never only inside the Details fold: a large move is not a detail.
  const impactNote = (quote || ownBest) && priceImpact !== null ? impactWarning(fractionToBps(priceImpact / 100)) : null;
  // The trade beside the 24h average: only figures for THIS amount (a same-pair re-quote keeps
  // the last amount's numbers on screen while it is asked for).
  const quoteIsForm = quote !== null && !quoteLoading && quote.inputMint === payToken.mint && quote.outputMint === buyToken.mint && quote.inAmount === baseAmount;
  const comparedOut = ownBest ? ownBest.outAmount.toString() : quoteIsForm ? quote.outAmount : null;
  const averageTrade: PairAverageTrade = {
    payMint: payToken.mint,
    buyMint: buyToken.mint,
    paySymbol: payToken.symbol,
    buySymbol: buyToken.symbol,
    payAmount: comparedOut !== null && baseAmount ? Number(baseAmount) / 10 ** payToken.decimals : null,
    buyAmount: comparedOut !== null ? Number(comparedOut) / 10 ** buyToken.decimals : null,
  };
  // The same line on our pool's review, from the review's own transaction.
  const reviewAverage = inFlight && pressed ? (
    <PairAverageLine
      testId="review-pair-average"
      trade={{
        payMint: inFlight.paysCoin ? inFlight.coin.mint : inFlight.tokenMint.toBase58(),
        buyMint: inFlight.paysCoin ? inFlight.tokenMint.toBase58() : inFlight.coin.mint,
        paySymbol: pressed.pay,
        buySymbol: pressed.buy,
        payAmount: Number(inFlight.amountIn) / 10 ** (inFlight.paysCoin ? inFlight.coin.decimals : inFlight.tokenDecimals),
        buyAmount: Number(inFlight.outAmount) / 10 ** (inFlight.paysCoin ? inFlight.tokenDecimals : inFlight.coin.decimals),
      }}
    />
  ) : null;
  const feePct = (SOLANA_PLATFORM_FEE_BPS / 100).toFixed(2);
  // The fee can only be collected on a pair touching SOL or USDC (pre-created
  // fee ATAs). Drive the UI off the SAME decision the quote/swap use.
  const feeMintForPair = isSolanaFeeConfigured() ? pickFeeMint(payToken.mint, buyToken.mint) : null;
  const feeMintSymbol = feeMintForPair === USDC_MINT ? 'USDC' : feeMintForPair === SOL_MINT ? 'SOL' : null;
  // Tagged with its origin mint: flattening the two lists used to discard which
  // token each warning described, which is why the render sites could not apply
  // the same per-mint exemption the ack gate already used.
  // Drawn on the form: every line about a token that asks for the tick, and any line
  // that is a real warning. A verified coin's ordinary notes (USDC can be frozen) are in
  // its About panel, and the venue's own coins are known by mint and draw none.
  const asksForTick = (mint: string) => needsRiskAck(mint === payToken.mint ? payToken : buyToken);
  const shieldWarnings: MintedShieldWarning[] = [
    ...(shield[payToken.mint] ?? []).map((w) => ({ ...w, mint: payToken.mint })),
    ...(shield[buyToken.mint] ?? []).map((w) => ({ ...w, mint: buyToken.mint })),
  ].filter((w) => !isVenueCoin(w.mint) && (asksForTick(w.mint) || shieldIsAlarming(w, w.mint)));
  // A dangerous line (honeypot / transfer hook / transfer fee / a freeze authority on a
  // mint that is not curated) forces the tick: see dangerousShield.
  const hasBlockingShield = [payToken.mint, buyToken.mint].some((mint) => !isVenueCoin(mint) && dangerousShield(shield[mint] ?? [], mint));
  // The tokens that ask for the tick because Jupiter has not verified them. The venue's
  // own coins never do (needsRiskAck), and a tick is remembered per token on this device.
  // A dangerous line is asked about every time: no remembered tick covers it, and none
  // stands in for a Shield answer that has not come (unread is not "nothing dangerous").
  const riskMints = [payToken, buyToken].filter(needsRiskAck).map((t) => t.mint);
  const shieldAnswered = shieldReadFor === `${payToken.mint}|${buyToken.mint}`;
  const tickRemembered = shieldAnswered && !hasBlockingShield && riskMints.length > 0 && riskMints.every((m) => isRiskAcked(m) && !tickedNow.has(m));
  const needsAck = (riskMints.length > 0 || hasBlockingShield) && !tickRemembered;
  const onAck = (checked: boolean) => {
    setAck(checked);
    setTickedNow((was) => new Set([...was, ...riskMints]));
    if (checked) rememberRiskAck(riskMints);
    else forgetRiskAck(riskMints);
  };
  const insufficient = payBalance.raw !== null && baseAmount !== null && BigInt(baseAmount) > payBalance.raw;

  const payUsd = (() => {
    const p = prices[payToken.mint];
    if (!p || !baseAmount) return null;
    const amt = Number(fromBaseUnits(baseAmount, payToken.decimals));
    return Number.isFinite(amt) ? amt * p : null;
  })();
  const receiveUsd = (() => {
    const p = prices[buyToken.mint];
    if (!p || shownOut === null) return null;
    const amt = Number(fromBaseUnits(shownOut, buyToken.decimals));
    return Number.isFinite(amt) ? amt * p : null;
  })();
  const fmtUsd = (n: number) => (n < 0.01 ? '<$0.01' : `~$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);

  // The pay field's one-press amounts: SOL's two while the field takes SOL, MAX on a balance that was read.
  const solChips = payToken.mint === SOL_MINT && !usdMode;
  const maxOn = payBalance.raw !== null && payBalance.raw > 0n;

  function handleMax() {
    if (payBalance.raw === null) return;
    let usable = payBalance.raw;
    if (payToken.mint === SOL_MINT) {
      // Leave ~0.01 SOL for tx fees + temporary wSOL-account rent.
      const reserve = 10_000_000n;
      usable = usable > reserve ? usable - reserve : 0n;
    }
    // MAX is token-denominated by definition — flip USD mode off so the
    // amount lands in the units the balance is actually held in.
    setUsdMode(false);
    setAmount(usable > 0n ? fromBaseUnits(usable.toString(), payToken.decimals) : '');
  }

  function handleShare() {
    // Mint + amount only — never the wallet address or a signature (no
    // personal data in query strings).
    const params = new URLSearchParams({ in: payToken.mint, out: buyToken.mint });
    if (tokenAmount && baseAmount) params.set('amt', tokenAmount);
    const url = `${window.location.origin}/solana?${params.toString()}`;
    navigator.clipboard.writeText(url).then(
      () => toast.success('Trade link copied', { description: `${payToken.symbol} → ${buyToken.symbol}` }),
      () => toast.error('Could not copy the link'),
    );
  }

  /**
   * The trade goes to our own pool: build it, test-run it and show its review. Every
   * number is read again when it is built, and the route is decided again on fresh
   * quotes from both venues (swap/ownPoolRoute.ts): if Jupiter pays more by then,
   * nothing is built. A review that went stale is built the same way again.
   */
  function startOwnSwap(unchecked?: bigint) {
    const ready = venueSwap.ready;
    if (!publicKey || !baseAmount || !ready || (!ownBest && unchecked === undefined)) return;
    setOwnOffer(null);
    const owner = publicKey;
    const amountIn = BigInt(baseAmount);
    const [inputMint, outputMint, bps] = [payToken.mint, buyToken.mint, slippageBps];
    let shownAggregatorOut: bigint | null = null;
    try {
      shownAggregatorOut = quote ? BigInt(quote.outAmount) : null;
    } catch { /* unparseable: it is asked again below */ }
    // A refusal kept for this trade: the quote on screen is of a transaction that failed its
    // test run. It holds our pool to nothing, and it stands until a test run passes, whether
    // or not the line is saying it (it does not while our pool quotes at least as much).
    const stands = refusedTrade?.key === refusalKey;
    const said = sideWords(payToken, buyToken);
    // The card for an ending that has to be read is its own chunk: asked for now, before
    // anything is signed, so it is never first fetched for a swap that was already sent.
    void loadVenueSwapFlow().catch(() => {});
    setPressed({ pay: payToken.symbol, buy: buyToken.symbol, amount: prettyAmount(tokenAmount), outDecimals: buyToken.decimals });
    const user = owner.toBase58();
    ownTrade.current = { owner: user, pay: payToken.symbol, buy: buyToken.symbol, buyMint: outputMint, amount: prettyAmount(tokenAmount), outDecimals: buyToken.decimals, done: said.done, symbol: said.symbol };
    const priority = speed;
    const buildIn = (pool: string, aggregator: AggregatorSeen) => {
      const args = {
        owner,
        pool: new PublicKey(pool),
        inputMint: new PublicKey(inputMint),
        outputMint: new PublicKey(outputMint),
        amountIn,
        slippageBps: BigInt(bps),
        aggregator,
      };
      // A range pool (shown only once the range program is deployed) has its own builder.
      return route.isRangePool(pool) ? ready.api.prepareRangeSwap(venueSwap.rpc, ready.gate, args) : ready.api.prepareVenueSwap(venueSwap.rpc, ready.gate, args);
    };
    void venueSwap.flow.prepare(
      async () => {
        // Offered after Jupiter's test run could not run press after press: our best pool, built
        // as it is, and its review says Jupiter's quote and why it was not sent.
        if (unchecked !== undefined) {
          const best = freshDecision((await route.refresh(amountIn)) ?? [], null).chosen;
          if (best?.venue !== 'own-pool' || !best.poolAddress) return { ok: false, outcome: { status: 'not-sent', stage: 'build', message: OWN_ROUTE_COPY.poolGone } };
          return buildIn(best.poolAddress, { kind: 'unchecked', out: unchecked });
        }
        // Jupiter's fresh quote, whether this site would send its transaction (null: not asked
        // yet), what its test run answered at this press (null: it did not answer), and the
        // cause of a refusal: this press's, or the one kept with a refusal that stands.
        const seen: { fresh: JupiterQuote | null; sends: boolean | null; verdict: 'passed' | 'refused' | null; why: string | null } =
          { fresh: null, sends: null, verdict: null, why: stands ? (refusedTrade?.why ?? null) : null };
        // A test run that could not run (law 8) found nothing: it refuses nothing, and it lifts
        // no refusal kept for this trade. `j` null: the transaction could not be built.
        const wouldSend = (j: PreparedJupiterSwap | null): boolean => {
          if (j?.status === 'ready') seen.verdict = 'passed';
          else if (j?.status === 'blocked' && !j.unchecked) {
            seen.verdict = 'refused';
            seen.why = refusalWhy(j, bps);
          } else return !stands;
          return seen.verdict === 'passed';
        };
        const jupiterTx = (fresh: JupiterQuote) =>
          prepareJupiterSwap(
            { getQuote: pressQuote, buildSwapTransaction: pressBuild, simulateSwap, swapCarriesPlatformFee },
            { fresh, shown: fresh, inputMint, outputMint, amount: baseAmount, slippageBps: bps, user, priority },
          );
        const built = await prepareOwnPoolSwap(
          {
            // What Jupiter's transaction FROM THIS SITE would pay. Its quote carries the
            // site fee; on a route where the fee cannot be taken the site sends the
            // no-fee transaction instead (jupiterFeeRetry.ts), which pays more. Which of
            // the two it is, is found the way the Jupiter path finds it: build and test-run.
            aggregatorOut: async () => {
              let fresh: JupiterQuote;
              try {
                fresh = await pressQuote({ inputMint, outputMint, amount: baseAmount, slippageBps: bps });
              } catch (e) {
                // "No route" is Jupiter's own answer: there is no other venue to hold the pool to.
                if (e instanceof NoRouteError) return null;
                throw e;
              }
              seen.fresh = fresh;
              const quotedOut = BigInt(fresh.outAmount);
              if (!swapCarriesPlatformFee(inputMint, outputMint)) return quotedOut;
              try {
                const j = await jupiterTx(fresh);
                seen.sends = wouldSend(j);
                // A refused transaction's quote still holds our pool to it while our pool
                // beats it; above our pool, aggregatorSends says it is no route.
                if (j.status === 'blocked') return quotedOut;
                // Kept for the pair pressed, whatever the form shows by now: its next quote is the no-fee one.
                if (j.status === 'moved' || j.siteFeeWaived) noFeePairs.current.add(`${inputMint}|${outputMint}`);
                else noFeePairs.current.delete(`${inputMint}|${outputMint}`);
                return BigInt(j.quote.outAmount);
              } catch {
                seen.sends = wouldSend(null);
                return quotedOut;
              }
            },
            // Asked only when Jupiter's quote would take the trade. With no site fee on the
            // pair its transaction has not been built yet: it is built and test-run now.
            aggregatorSends: async () => {
              if (seen.sends !== null || seen.fresh === null) return seen.sends ?? true;
              seen.sends = wouldSend(await jupiterTx(seen.fresh).catch(() => null));
              return seen.sends;
            },
            ownPools: async () => (await route.refresh(amountIn)) ?? [],
            prepare: (pool, aggregator) =>
              buildIn(
                pool,
                // The review says a refusal with its cause, and as an earlier press's when this press could not test again.
                aggregator.kind !== 'refused' ? aggregator
                  : { ...aggregator, ...(seen.verdict === 'refused' ? {} : { earlier: true as const }), ...(seen.why ? { why: seen.why } : {}) },
              ),
          },
          stands ? null : shownAggregatorOut,
          stands ? shownAggregatorOut : null,
        );
        // "Jupiter now pays more": with a refusal kept, that is only said once a test run of
        // its transaction answered and passed (wouldSend). The refusal is over, and its route
        // is on the line again.
        if (!built.ok && built.outcome.message === OWN_ROUTE_COPY.routeMoved) setRefusedTrade((r) => (r?.key === refusalKey ? null : r));
        // Nothing else here writes to the page: the form may hold another trade by now, and the
        // settle's re-quote puts Jupiter's no-fee route on screen when that is what took it.
        return built;
      },
      { repeatable: true },
    );
  }

  // Whether a press on Jupiter's route may end on our pool. Not when our pools were found
  // to hold nothing for this pair, and not when a swap in them cannot be prepared here:
  // the route would change to one that cannot run.
  const ownMayCompete = !venueSwap.unavailable && (route.own === 'quoted' || route.own === 'pending' || route.own === 'error');

  /**
   * THE ROUTE, HELD AT THE CLICK, with Jupiter on screen. If one of our pools, read
   * again at the click (`ownRead`), pays at least what the transaction about to be signed
   * would pay (`q`), `q` goes on screen so the line shows that route, and the trader
   * presses Buy on it. A read that fails or hangs changes nothing when a comparison was on
   * screen; with none on screen yet (our pools still being read), a read that does not
   * answer sends nothing.
   */
  async function ownPoolTakesIt(q: JupiterQuote, noSiteFee: boolean, pressedFor: string, ownRead: ReturnType<typeof route.refresh> | null): Promise<boolean> {
    if (!ownRead) return false;
    let aggregatorOut: bigint;
    try {
      aggregatorOut = BigInt(q.outAmount);
    } catch {
      return false;
    }
    // The press's render: no comparison with our pools was on screen.
    const unread = route.own === 'pending';
    // Null: the read did not answer in time, or could not read our pools.
    const own = await within(ownRead, OWN_CHECK_MS, null);
    // The trade on the form changed while our pools were read: the one pressed is not sent.
    if (formNow.current !== pressedFor) {
      toast.info('Not sent', { description: OWN_ROUTE_COPY.formChanged });
      return true;
    }
    if (own === null && unread) {
      toast.error('Route not checked', { description: OWN_ROUTE_COPY.notChecked });
      return true;
    }
    if (!(await ownPoolNowWins(async () => own ?? [], aggregatorOut))) return false;
    if (noSiteFee) setWaivedQuote(q);
    setQuote(q);
    toast.error('Route changed', { description: OWN_ROUTE_COPY.ownNowWins });
    return true;
  }

  /**
   * Jupiter's transaction for the trade pressed failed its test run, so it is not sent.
   * If one of our pools, read again at the click (`ownRead`), quotes that trade, the
   * refusal is kept for it: the line names our pool and why, and the next press builds
   * there. A read that fails or hangs, or a pool that cannot quote, leaves the press to
   * end as it did.
   */
  async function ownPoolInstead(why: string | null, ownRead: ReturnType<typeof route.refresh> | null): Promise<boolean> {
    if (!ownRead) return false;
    const own = await within(ownRead, OWN_CHECK_MS, null);
    if (!own?.length) return false;
    // Kept for the trade pressed, whatever the form shows by now, with the cause the test run gave.
    setRefusedTrade({ key: refusalKey, why });
    toast.error('Route changed', { description: why ? `${OWN_ROUTE_COPY.jupiterRefused} ${why}.` : OWN_ROUTE_COPY.jupiterRefused });
    return true;
  }

  async function handleSwap() {
    if (!publicKey || !baseAmount) return;
    // Our own pool pays at least as much as Jupiter: the trade goes there.
    if (ownBest) {
      startOwnSwap();
      return;
    }
    if (!quote) return;
    const shown = quote; // snapshot the exact quote the user clicked on
    // Did the trader click the NO-FEE re-quote (left on screen by a wallet
    // reject, a send error or a "moved" result)? Then `fresh` below, which is
    // fee-bearing, is about 0.5% under it by construction and is not the trade
    // being compared: see the two guards below.
    const shownWaived = feeWaived;
    // When Jupiter answered the quote clicked, taken once: the press after this one asks again.
    const shownAt = quoteSeenAt.current.get(shown);
    quoteSeenAt.current.delete(shown);
    // THE TRADE PRESSED. The form can come to show another while the press is on its way
    // (a link's token that lands late, a price that re-sizes a dollar amount). From then
    // on nothing is written or sent for the one pressed, whatever our pools hold: this is
    // asked after EVERY wait below (ownPoolTakesIt asks after its own), so none stands
    // between the last answer and the wallet.
    const pressedFor = formKey;
    const formMoved = () => {
      if (formNow.current === pressedFor) return false;
      toast.info('Not sent', { description: OWN_ROUTE_COPY.formChanged });
      return true;
    };
    const say = (q: JupiterQuote) =>
      setThroughJupiter(`${prettyAmount(tokenAmount)} ${payToken.symbol} for about ${prettyAmount(fromBaseUnits(q.outAmount, buyToken.decimals))} ${buyToken.symbol}`);
    say(shown);
    // Where the press stopped, for the words a throw is said in: before the wallet,
    // nothing was sent. The note a signature writes belongs to the wallet that signed.
    let step: 'quote' | 'build' = 'quote';
    let signed: string | null = null;
    let tradeWords = '';
    // Writes this press's note once the wallet has answered: by its signature, or null for an
    // answer that was lost (owner, 2026-10-14, D1). Set just before the wallet is asked.
    const press: { note: ((signature: string | null) => void) | null } = { note: null };
    const noteScope = swapPendingScope(publicKey.toBase58());
    setSwapping(true);
    // Until this swap is answered the page does not reload itself (lib/staleBuild.ts).
    const release = holdReload();
    try {
      // Our pools are read once for this press, from the click, while Jupiter is asked:
      // the read the route is held on (ownPoolTakesIt) and the one a refusal turns to
      // (ownPoolInstead). Each waits at most OWN_CHECK_MS for it from where it is needed.
      const ownRead = ownMayCompete ? route.refresh(BigInt(baseAmount)).catch(() => null) : null;
      const carriesFee = swapCarriesPlatformFee(payToken.mint, buyToken.mint);
      // Re-quote right before building so the on-chain min-out + routing match
      // the live market (the displayed quote may be seconds-to-minutes stale),
      // unless the quote clicked is seconds old and is the one this press would ask
      // for: the same trade, at this slippage, fee-bearing as the pair is.
      const shownIsFresh =
        shownAt !== undefined &&
        Date.now() - shownAt < SHOWN_QUOTE_FRESH_MS &&
        !shownWaived &&
        shown.inputMint === payToken.mint &&
        shown.outputMint === buyToken.mint &&
        shown.inAmount === baseAmount &&
        shown.swapMode === 'ExactIn' &&
        shown.slippageBps === slippageBps &&
        quoteHasPlatformFee(shown) === carriesFee;
      const fresh = shownIsFresh
        ? shown
        : await pressQuote({
            inputMint: payToken.mint,
            outputMint: buyToken.mint,
            amount: baseAmount,
            slippageBps,
          });
      if (formMoved()) return;
      // With no site fee on this pair, `fresh` is what Jupiter's transaction pays, so
      // the route is held on it before anything is built. With a fee it is held further
      // down, on the quote of the transaction that passed its test run.
      if (!carriesFee && (await ownPoolTakesIt(fresh, false, pressedFor, ownRead))) return;
      // DISPLAY-VS-SUBMIT GUARD (2026-07-24): the user consented to `shown`.
      // slippageBps protects the tx on-chain, but the re-quoted BASELINE itself
      // could be materially worse than what they saw. If `fresh` dropped beyond
      // their own slippage tolerance, don't silently execute on it — show the new
      // rate and make them swap again. Compared in BigInt base units (outAmount
      // is a raw integer string); falls through if either is unparseable.
      //
      // NOT run when the clicked quote is the no-fee one. A fee-bearing `fresh`
      // sits right on that quote's 0.50% floor before the market moves at all,
      // so this guard said "Price moved" when nothing had, and put the
      // fee-bearing numbers back on screen. The like-for-like check is the one
      // in prepareJupiterSwap: the no-fee RE-quote against max(fresh, shown).
      if (!shownWaived) {
        setQuote(fresh);
        say(fresh);
        try {
          const shownOut = BigInt(shown.outAmount);
          const floor = shownOut - (shownOut * BigInt(slippageBps)) / 10000n;
          if (BigInt(fresh.outAmount) < floor) {
            toast.error('Price moved', { description: `The quote dropped beyond your ${(slippageBps / 100).toFixed(2)}% slippage. Review the new rate and swap again.` });
            return;
          }
        } catch { /* unparseable amount — the pre-sign simulation below still guards */ }
      }
      // Build, then the test run: only a transaction that passed it goes to the wallet.
      // One that could not run sends nothing (law 8). Jupiter's own 6014 on a fee-bearing
      // build is answered by ONE no-fee rebuild that must pass too (jupiterFeeRetry.ts).
      step = 'build';
      const prepared = await prepareJupiterSwap(
        { getQuote: pressQuote, buildSwapTransaction: pressBuild, simulateSwap, swapCarriesPlatformFee },
        {
          fresh,
          shown,
          inputMint: payToken.mint,
          outputMint: buyToken.mint,
          amount: baseAmount,
          slippageBps,
          user: publicKey.toBase58(),
          priority: speed,
        },
      );
      if (formMoved()) return;
      // A test run that answered (passed, moved or refused) ends a run of presses it could not check.
      if (prepared.status !== 'blocked' || !prepared.unchecked) {
        uncheckedRun.current = 0;
        setOwnOffer(null);
      }
      if (prepared.status === 'blocked') {
        // A test run that could not run found nothing about the transaction: it was not
        // refused, so our pool is not offered for it and the press never says "would fail".
        if (prepared.unchecked) {
          uncheckedRun.current += 1;
          if (uncheckedRun.current < 2) {
            toast.error('Swap not checked', { description: NOT_TEST_RUN_COPY });
            return;
          }
          // Again: the fault is likely ours. Our pool's review is offered under Buy while one quotes this trade.
          toast.error('Swap not checked', { description: CHECK_KEEPS_FAILING });
          try {
            setOwnOffer({ key: refusalKey, out: BigInt(fresh.outAmount) });
          } catch { /* unparseable: nothing to compare the pool with, so nothing is offered */ }
          return;
        }
        // A refused transaction is no route, so our pool is offered, with the cause its test run gave.
        if (await ownPoolInstead(refusalWhy(prepared, slippageBps), ownRead)) return;
        // Only what the network wrote: `prepared.reason` can be a line a token's own program printed.
        toast.error('Swap would fail', { description: refusedSaid(prepared, slippageBps) });
        return;
      }
      // Jupiter's transaction would run: a refusal kept for this trade is over.
      if (prepared.status === 'ready') setRefusedTrade((r) => (r?.key === refusalKey ? null : r));
      // What the test run found is kept for the pair: its next quote asks for what Jupiter's transaction from this site pays.
      if (prepared.status === 'moved' || prepared.siteFeeWaived) noFeePairs.current.add(`${payToken.mint}|${buyToken.mint}`);
      else noFeePairs.current.delete(`${payToken.mint}|${buyToken.mint}`);
      if (prepared.status === 'moved') {
        // The no-fee re-quote is on screen now, labelled as such; nothing was sent.
        setWaivedQuote(prepared.quote);
        setQuote(prepared.quote);
        toast.error('Price moved', { description: `The quote dropped beyond your ${(slippageBps / 100).toFixed(2)}% slippage. Review the new rate and swap again.` });
        return;
      }
      const sent = prepared.quote;
      const feeWaivedOnSend = prepared.siteFeeWaived;
      if (carriesFee && (await ownPoolTakesIt(sent, feeWaivedOnSend, pressedFor, ownRead))) return;
      // A swap this wallet sent in another tab while this press was on its way holds it too.
      // From this read to the wallet's prompt nothing is awaited.
      if (holdsNow(noteScope)) {
        toast.info('Not sent', { description: HELD_NOT_SENT });
        return;
      }
      if (shownWaived && !feeWaivedOnSend) {
        // The trader clicked a quote that said "no site fee", and this time the
        // fee-bearing build simulates clean. That swap pays them less than the
        // one they clicked: show it, and let them choose it with their own click.
        setQuote(sent);
        toast.error('Quote changed', { description: 'The site fee can be taken on this route now, so you receive slightly less. Review the new rate and swap again.' });
        return;
      }
      if (feeWaivedOnSend) {
        // BEFORE the wallet opens: the amounts on the page become the re-quoted
        // ones, the fee row says there is none, and the trader is told why.
        // flushSync so that is already painted when the wallet prompt appears.
        flushSync(() => {
          setWaivedQuote(sent);
          setQuote(sent);
          say(sent);
        });
        toast.info(NO_SITE_FEE_ROUTE_COPY, {
          description: `You receive about ${prettyAmount(fromBaseUnits(sent.outAmount, buyToken.decimals))} ${buyToken.symbol}.`,
        });
      }
      const b64 = prepared.swapTransaction;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const tx = VersionedTransaction.deserialize(bytes);
      tradeWords = `≈${prettyAmount(fromBaseUnits(sent.outAmount, buyToken.decimals))} ${buyToken.symbol} with ${prettyAmount(tokenAmount)} ${payToken.symbol}${feeWaivedOnSend ? ' (no site fee on this route)' : ''}`;
      // Read after Jupiter built it, so its blockhash is older than this height (jupiterNote.ts).
      const lastValid: { at: number | null } = { at: null };
      const heightRead = jupiterLastValidAtMost(() => connection.getBlockHeight('confirmed')).then((h) => (lastValid.at = h));
      // Its own blockhash, seen valid now: later, the first proof that it can no longer land.
      const proof: { bh: NoteBlockhash | null } = { bh: null };
      const bhRead = blockhashSeen(connection, recentBlockhashOf(tx)).then((b) => (proof.bh = b));
      press.note = (signature) => {
        const sentAt = Date.now();
        const write = () =>
          holdNote({ kind: 'jupiter-swap', signature, lastValidBlockHeight: signature ? lastValid.at : null, blockhash: proof.bh, sentAt }, noteScope);
        write();
        // A read that lands after the note: the note learns when it can no longer land.
        const had = { at: lastValid.at, bh: proof.bh };
        void Promise.all([heightRead, bhRead]).then(() => {
          const learned = (signature !== null && had.at === null && lastValid.at !== null) || (had.bh === null && proof.bh !== null);
          if (learned && readPendingTrades(noteScope).some((n) => noteKey(n) === noteKey({ signature, sentAt }))) write();
        });
      };
      const sig = await viaWallet(() => sendTransaction(tx, connection));
      signed = sig;
      // A signature exists: the swap may be on chain. Its note holds Buy for this wallet,
      // in every tab of this site, until the chain answers for it (useVenueSwap).
      press.note(sig);
      toast.success('Swap submitted', { description: `${shortSig(sig)}. Confirming…` });
      // From here nothing below may say "failed" unless the chain itself said so.
      // pollConfirm (lib/solana/confirm.ts, the one poller the ladder and the DCA and
      // limit tabs also use) never throws; a timeout or an unreadable status is
      // 'unknown'. 90 s is SPEC_S3's wait for a swap.
      const view = { label: 'View', onClick: () => window.open(`https://solscan.io/tx/${sig}`, '_blank', 'noopener,noreferrer') };
      const { outcome } = await pollConfirm(connection, sig, SWAP_CONFIRM_TIMEOUT_MS);
      // Whatever the chain said, the wallet spent something: Balance, MAX and the
      // insufficient guard are read again, not left on the pre-trade figure.
      retryPayBalance();
      // Landed or refused: the chain answered, Buy is free. Unread: the note stays.
      if (outcome !== 'unknown') releaseNote(sig, noteScope);
      if (outcome === 'reverted') {
        toast.error('Swap refused on chain', { description: `${shortSig(sig)}. Only the network fee was spent.`, action: view });
        return;
      }
      if (outcome === 'unknown') {
        // The same "we can't tell, check before you send it again" the DCA and
        // limit tabs raise (confirmSent above). A swap that may have landed with
        // no site fee says that too: the waiver is never silent in a result.
        surfaceUnconfirmedTx(toast, {
          hash: sig,
          explorerUrl: `https://solscan.io/tx/${sig}`,
          repeatCost: `swapping again buys a second time.${feeWaivedOnSend ? ` ${NO_SITE_FEE_ROUTE_COPY}` : ''}`,
        });
        // Kept in "Your recent activity" so the signature outlives the toast,
        // and the form is cleared so the same buy is not one click away.
        recordActivity(publicKey.toBase58(), { sig, ts: Date.now(), kind: 'swap', summary: `Sent, not confirmed: ${tradeWords}` });
        setAmount('');
        setQuote(null);
        return;
      }
      const said = sideWords(payToken, buyToken);
      toast.success(`${said.done} ${said.symbol}`, {
        description: feeWaivedOnSend ? `${shortSig(sig)}. ${NO_SITE_FEE_ROUTE_COPY}` : shortSig(sig),
        action: view,
      });
      // WAVE SEVEN, element O: latch a buy that landed in a resident's token.
      // The five Solana rooms are mints, so the finder takes the chain word;
      // there is no numeric id for Solana anywhere in this app to pass instead.
      const room = bungalowByAddress('solana', buyToken.mint);
      if (room) {
        setLastBuy({
          hash: sig,
          symbol: room.symbol,
          tokenAddress: buyToken.mint,
          chain: room.chain,
          buyer: publicKey.toBase58(),
          atUnix: Math.floor(Date.now() / 1000),
        });
      }
      recordActivity(publicKey.toBase58(), {
        sig,
        ts: Date.now(),
        kind: 'swap',
        summary: `Bought ${tradeWords}`,
      });
      setAmount('');
      setQuote(null);
    } catch (err) {
      // The wallet's throw, in the words every Solana write uses for it. One that can come
      // after it signed is "we cannot tell", never "failed": the form is cleared so the
      // same buy is not one click away.
      const said = sayWalletThrew(err, `it sent ${tradeWords || 'this swap'}`);
      if (said === 'unsure') {
        // It may be out with no signature to look up: Buy is held for this wallet until its
        // blockhash can no longer land, 2 minutes at most (owner, 2026-10-14, D1).
        press.note?.(null);
        setAmount('');
        setQuote(null);
      } else if (said === 'other' && signed) {
        // After the signature: its note stands until the chain answers.
        surfaceUnconfirmedTx(toast, { hash: signed, explorerUrl: `https://solscan.io/tx/${signed}`, repeatCost: 'swapping again buys a second time.' });
      } else if (said === 'other') {
        // Stopped on a read before the wallet: nothing was sent, nothing failed, the form stands.
        toast.error('Not sent', {
          description: nothingSentCopy(step === 'quote' ? 'Jupiter’s price' : 'Jupiter’s transaction for this trade', thrownWords(err)),
        });
      }
    } finally {
      release();
      setSwapping(false);
    }
  }

  const words = sideWords(payToken, buyToken);
  const actionDisabled = (!quote && !ownBest) || quoteLoading || swapping || sameToken || (needsAck && !ack) || insufficient || ownPreparing || pendingNote || ownBusy !== null || linkPending > 0;
  // Jupiter's test run could not run press after press on this trade, and one of our pools
  // quotes it: its review is offered. The review runs its own test run before Sign.
  const offerOwn = ownOffer !== null && ownOffer.key === refusalKey && !ownBest && venueSwap.ready !== null
    && route.own === 'quoted' && route.candidates.length > 0 && !actionDisabled;
  // What the buy button says. "No route" only when the quote service said it AND our pools
  // were found to have nothing (none deployed, none for this pair, or none that can trade):
  // a read of our pools still out or failed, a quote that could not be fetched, two of the
  // same token, and the moment before the first quote is asked for each get their own words.
  const ownNone = route.own === 'absent' || route.own === 'not-searched' || route.own === 'unquotable';
  const ctaLabel = swapping ? 'Swapping…'
    : ownBusy !== null ? ownBusy
    : linkPending > 0 ? 'Looking up the coin…'
    : quoteLoading ? 'Fetching quote…'
    : !baseAmount ? 'Enter an amount'
    : sameToken ? 'Pick two different tokens'
    : insufficient ? `Insufficient ${payToken.symbol}`
    : ownPreparing ? 'Preparing…'
    : quote || ownBest ? `${words.verb} ${words.symbol}`
    : quoteFail === 'no-route' ? (ownNone ? 'No route' : route.own === 'pending' ? 'Checking our pools…' : route.own === 'error' ? 'Quote unavailable' : 'Not available here right now')
    : quoteFail === 'unavailable' ? 'Quote unavailable'
    : 'Fetching quote…';

  const Heading = home ? 'h2' : 'h1';
  return (
    <>
    {!home && <PageArtBackdrop pageId="solana-swap" />}
    {/* `relative` with no z-index on purpose: it paints above the backdrop by
        coming after it, without becoming a stacking context. A z-10 here would
        trap the token pickers below (z-[60]) under the tab strip (z-30). */}
    <div className={home ? 'relative' : 'relative max-w-md mx-auto px-4 py-8'}>
      {!home && <ChainSwitch />}
      <m.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className={home ? 'rounded-2xl p-4 relative overflow-hidden' : 'rounded-2xl p-5 relative overflow-hidden'}
        style={{ border: '1px solid rgba(255,255,255,0.12)' }}
      >
        <div className="absolute inset-0">
          <ArtImg pageId="swap" idx={2} alt="" loading="lazy" className="w-full h-full object-cover" />
          <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.87)' }} />
        </div>

        <div className="relative z-10">
          {/* Header */}
          <div className={home ? 'flex flex-wrap items-center justify-between gap-2 mb-3' : 'flex items-center justify-between mb-4'}>
            {/* On the home the card's network drop-down sits by its name, as /solana's sits above
                its card: the other three networks are /swap's. */}
            <div className={home ? 'flex items-center gap-2' : undefined}>
              <Heading ref={headingRef} tabIndex={-1} className={home ? 'heading-luxury text-xl text-white outline-none' : 'heading-luxury text-[18px] text-white outline-none'}>
                {home ? 'Swap' : 'Solana Swap'}
              </Heading>
              {home && <ChainSwitch at="/solana" />}
              {!home && <p className="text-white/60 text-[11px]">Buy Solana tokens through our own pools or Jupiter, whichever pays more.</p>}
              {/* The address's coin is still being looked up: the form holds until it is. */}
              {!home && linkPending > 0 && (
                <p role="status" data-testid="solana-link-pending" className="text-white/60 text-[11px]">
                  Looking up the coin in this link…
                </p>
              )}
              {/* A coin that neither Jupiter nor the chain could name: the form is on another pair, and says so. */}
              {!home && linkMissed && (
                <p role="status" data-testid="solana-link-miss" className="text-amber-300/90 text-[11px] [overflow-wrap:anywhere]">
                  {linkMissed.from === 'link' ? 'The coin in this link' : 'This room’s coin'} ({linkMissed.mint}) could not be looked up on Jupiter or on the chain, so this form
                  opened on {payToken.symbol} / {buyToken.symbol}.
                </p>
              )}
            </div>
            {publicKey ? (
              <span className="text-white/70 text-[11px] font-mono px-2 py-1 rounded-md" style={{ background: 'var(--color-purple-15)' }}>
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-success mr-1.5 align-middle" />
                {publicKey.toBase58().slice(0, 4)}…{publicKey.toBase58().slice(-4)}
              </span>
            ) : null}
          </div>

          {/* Mode tabs: not on the home's card, which is an instant swap only. */}
          {!home && (
          <div className="flex gap-1 mb-4">
            {(['swap', 'limit', 'dca'] as const).map((mTab) => (
              <button
                key={mTab}
                type="button"
                onClick={() => setMode(mTab)}
                aria-pressed={mode === mTab}
                disabled={held}
                className="flex-1 py-2.5 rounded-lg text-[12px] font-medium text-white transition-colors disabled:opacity-60"
                style={{
                  background: mode === mTab ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                  border: mode === mTab ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
                }}
              >
                {mTab === 'swap' ? 'Instant swap' : mTab === 'limit' ? 'Limit order' : 'DCA'}
              </button>
            ))}
          </div>
          )}

          {mode === 'swap' && ownFlowOpen ? (
            // A review that has to be read, or an ending with something to say, takes
            // the form's place until it is closed. Everything else leaves the form up.
            <Suspense fallback={<p role="status" className="text-white/55 text-[11px]">One moment…</p>}>
              <VenueSwapFlow swap={venueSwap} extraReview={reviewAverage} />
            </Suspense>
          ) : mode === 'swap' ? (
            <>
            {/* One amount split across every island coin on Solana (owner, 2026-10-18). */}
            <div className="flex justify-end mb-2">
              <IslandBasketSolana
                slippageBps={slippageBps}
                priority={speed}
                pending={venueSwap.pending}
                ownSwap={venueSwap.ready}
                wantOwnSwap={wantOwnForIsland}
                busy={held || pendingNote}
              />
            </div>
            {/* Held while a trade is on its way, by either route (`held`). */}
            <fieldset disabled={held} className="border-0 p-0 m-0 min-w-0">
          {/* You pay */}
          <div className="mb-1">
            <div className="flex items-center justify-between mb-2">
              <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
                You Pay
                <button
                  type="button"
                  onClick={() => { setUsdMode((v) => !v); setAmount(''); }}
                  disabled={!payPrice}
                  aria-pressed={usdMode}
                  title={payPrice ? 'Enter the amount in US dollars' : 'Price unavailable for this token'}
                  className="ml-1.5 px-2 py-2.5 -my-2 rounded font-semibold text-[11px] disabled:opacity-40"
                  style={{ color: usdMode ? 'var(--color-stan)' : 'rgba(255,255,255,0.6)' }}
                >
                  $ USD
                </button>
              </span>
              {publicKey && (
                <span className="text-white/60 text-[10px] font-mono">
                  {/* A number only when it was READ (a real 0 included). A read
                      that failed is a dash with a way to read again, the same
                      mark the EVM swap uses, never a 0 nobody read. */}
                  Balance: {payBalance.loading ? '…' : payBalance.human !== null ? prettyAmount(payBalance.human) : '–'}
                  {payBalance.unread && (
                    <button
                      type="button"
                      onClick={payBalance.retry}
                      aria-label={`Retry reading your ${payToken.symbol} balance`}
                      className="ml-1 px-2 py-2.5 -my-2 font-semibold"
                      style={{ color: 'var(--color-stan)' }}
                    >
                      Retry
                    </button>
                  )}
                </span>
              )}
            </div>
            {/* Amounts in one press, above the field: two SOL amounts when SOL is paid, and MAX on a balance that was read. */}
            {(solChips || maxOn) && (
              <div className="flex justify-end gap-1.5 mb-2">
                {solChips && SOL_CHIPS.map((sol) => (
                  <button key={sol} type="button" onClick={() => { tick(); setAmount(sol); }} className={CHIP_CLS} style={CHIP_STYLE}>
                    {sol} SOL
                  </button>
                ))}
                {maxOn && (
                  <button type="button" onClick={() => { tick(); handleMax(); }} className={CHIP_CLS} style={{ ...CHIP_STYLE, color: 'var(--color-stan)' }}>
                    MAX
                  </button>
                )}
              </div>
            )}
            <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}>
              <button
                type="button"
                onClick={() => setPicker('pay')}
                aria-haspopup="dialog"
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[40px] hover:bg-white/5 transition-colors"
              >
                <span className="text-white font-medium text-[14px]">{usdMode ? `$ → ${payToken.symbol}` : payToken.symbol}</span>
                <span className="text-white/80" aria-hidden="true">▾</span>
              </button>
              <input
                type="text" inputMode="decimal" autoComplete="off" placeholder="0.0"
                aria-label={usdMode ? `US dollars of ${payToken.symbol} to pay` : `Amount of ${payToken.symbol} to pay`}
                value={amount}
                onChange={(e) => acceptAmountInput(e.target.value, setAmount)}
                className="flex-1 bg-transparent text-right text-white text-[20px] font-mono outline-none min-w-0"
              />
            </div>
            {usdMode ? (
              <div className="flex items-center justify-between mt-1">
                <span className="flex gap-1">
                  {['10', '25', '100'].map((usd) => (
                    <button
                      key={usd}
                      type="button"
                      onClick={() => setAmount(usd)}
                      className="px-2 py-2 -my-1 rounded-md text-[10px] font-medium text-white"
                      style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.12)' }}
                    >
                      ${usd}
                    </button>
                  ))}
                </span>
                <span className="text-right text-white/55 text-[10px] font-mono">
                  {tokenAmount && baseAmount ? `≈ ${prettyAmount(tokenAmount)} ${payToken.symbol}` : ''}
                </span>
              </div>
            ) : (
              payUsd !== null && <div className="text-right text-white/55 text-[10px] mt-1 font-mono">{fmtUsd(payUsd)}</div>
            )}
          </div>

          {/* Flip pay/receive */}
          <div className="flex justify-center -my-1 relative z-10">
            <button
              type="button"
              onClick={() => { setPayToken(buyToken); setBuyToken(payToken); setAmount(''); }}
              aria-label="Flip pay and receive tokens"
              className="w-10 h-10 rounded-full flex items-center justify-center transition-transform hover:scale-105"
              style={{ background: 'var(--color-stan)', border: '2px solid rgba(255,255,255,0.95)', boxShadow: '0 4px 16px rgba(0,0,0,0.70), 0 0 0 4px rgba(6,12,26,0.85)' }}
            >
              <span className="text-white text-[16px] font-bold leading-none">&#8645;</span>
            </button>
          </div>

          {/* You receive */}
          <div className="mt-3 mb-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>You Receive</span>
              <span className="flex items-center">
                <button
                  type="button"
                  onClick={() => setDetailToken(buyToken)}
                  aria-haspopup="dialog"
                  aria-label={`About ${buyToken.symbol}: age, holders, authorities`}
                  className="text-white/60 text-[11px] hover:text-white px-2 py-2.5 -my-2"
                >
                  ⓘ {buyToken.symbol}
                </button>
                <button
                  type="button"
                  onClick={handleShare}
                  aria-label="Copy a link to this trade"
                  className="text-white/60 text-[10px] hover:text-white px-2 py-2.5 -my-2"
                >
                  Share
                </button>
              </span>
            </div>
            <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}>
              <button
                type="button"
                onClick={() => setPicker('buy')}
                aria-haspopup="dialog"
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[40px] hover:bg-white/5 transition-colors"
              >
                <span className="text-white font-medium text-[14px]">{buyToken.symbol}</span>
                <span className="text-white/80" aria-hidden="true">▾</span>
              </button>
              <div className="flex-1 text-right text-white text-[20px] font-mono font-medium" aria-live="polite" aria-atomic="true" data-testid="solana-receive">
                {quoteLoading ? (
                  <span className="inline-block w-24 h-5 rounded align-middle animate-pulse" style={{ background: 'rgba(255,255,255,0.18)' }} aria-label="Loading quote" />
                ) : outputDisplay}
              </div>
            </div>
            {receiveUsd !== null && <div className="text-right text-white/55 text-[10px] mt-1 font-mono">{fmtUsd(receiveUsd)}</div>}
          </div>

          {/* Slippage and speed: one line that says what they are set to, until it is opened. */}
          <details className="group mb-3 px-3 rounded-lg" style={{ background: 'rgba(0,0,0,0.60)', border: '1px solid rgba(255,255,255,0.12)' }}>
            <summary className="flex items-center justify-between min-h-[44px] cursor-pointer list-none text-white/80 text-[11px] [&::-webkit-details-marker]:hidden">
              <span>Slippage {(slippageBps / 100).toFixed(slippageBps % 100 === 0 ? 0 : 1)}% · Speed {SPEED_LEVELS.find((l) => l.level === speed)?.label ?? 'Fast'}</span>
              <span aria-hidden="true" className="text-white/50 transition-transform group-open:rotate-180">▾</span>
            </summary>
            <div className="pb-2.5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Slippage tolerance</span>
            </div>
            <div className="flex items-center gap-1.5">
              {SLIPPAGE_PRESETS.map((bps) => {
                const active = slippageBps === bps;
                return (
                  <button
                    key={bps}
                    type="button"
                    onClick={() => setSlippageBps(bps)}
                    aria-pressed={active}
                    className="flex-1 py-1.5 min-h-[40px] rounded-lg text-[11px] font-medium transition-all text-white"
                    style={{
                      background: active ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                      border: active ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
                    }}
                  >
                    {(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between mb-1.5 mt-3">
              <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Speed</span>
            </div>
            <div className="flex items-center gap-1.5">
              {SPEED_LEVELS.map(({ level, label }) => {
                const active = speed === level;
                return (
                  <button
                    key={level}
                    type="button"
                    onClick={() => setSpeed(level)}
                    aria-pressed={active}
                    className="flex-1 py-1.5 min-h-[40px] rounded-lg text-[11px] font-medium transition-all text-white"
                    style={{
                      background: active ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                      border: active ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {/* Speed is Jupiter's: a swap in our own pool sets its own, smaller fee. */}
            <p className="text-white/55 text-[10px] mt-1.5">
              Speed sets the priority fee on a Jupiter swap, up to {(MAX_PRIORITY_LAMPORTS / 1_000_000_000).toLocaleString('en-US', { maximumFractionDigits: 3 })} SOL. It helps a swap land when the network is busy.
            </p>
            </div>
          </details>

          {/* Where the trade goes, and why. Shown in EVERY state — including the
              ones where our own pool loses or does not exist — because a routing
              disclosure that only appears when the house wins is an advert. */}
          {ownBusy !== null ? (
            // The transaction's own figures, not the form's: the form's quote can be older.
            <p role="status" data-testid="own-swap-status" className="text-[10px] leading-relaxed mt-2 rounded-lg px-2.5 py-1.5 text-white/80" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.10)' }}>
              {inFlight && pressed
                ? `At your wallet: ${pressed.amount} ${pressed.pay} for ${prettyAmount(fromBaseUnits(inFlight.outAmount.toString(), pressed.outDecimals))} ${pressed.buy}, at least ${prettyAmount(fromBaseUnits(inFlight.minimumAmountOut.toString(), pressed.outDecimals))}.`
                : 'Checking both prices once more…'}
            </p>
          ) : swapping ? (
            <p role="status" data-testid="jupiter-swap-status" className="text-[10px] leading-relaxed mt-2 rounded-lg px-2.5 py-1.5 text-white/80" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.10)' }}>
              {`Through ${route.aggregatorLabel}: ${throughJupiter}.`}
            </p>
          ) : (
            <SolanaRouteLine route={route} ownUnavailable={venueSwap.unavailable} aggregatorFail={quoteFail} refusedWhy={route.aggregatorRefused ? (refusedTrade?.why ?? null) : null} />
          )}

          {/* Quote details */}
          <div className="mb-4 text-[11px] space-y-1">
            {!sameToken && <PairAverageLine trade={averageTrade} />}
            {ownBest ? (
              // Our own pool: no platform fee is added. Its own fee is inside the quote.
              <div className="flex items-center justify-between text-white/70" data-testid="own-pool-fee">
                <span>Pool fee (inside the quote)</span>
                <span className="font-mono">
                  {isRangeCandidate(ownBest)
                    ? `${perMillionPercent(ownBest.range.config.tradeFeeRate)} of ${isFeeOnInput(ownBest.range.pool.feeOn, payToken.mint === ownBest.range.pool.tokenMint0) ? 'what you pay' : 'what the pool pays out'}`
                    : ownBest.view.config ? tradeCostText(ownBest.view.config, ownBest.view.snapshot.pool.enableCreatorFee) : '–'}
                </span>
              </div>
            ) : (
              <SiteFeeRow feePct={feePct} feeMintSymbol={feeMintSymbol} waived={feeWaived} />
            )}
            {(quote || ownBest) && (
            <details className="group">
              <summary className="flex items-center justify-between min-h-[44px] -my-2 cursor-pointer list-none text-white/60 [&::-webkit-details-marker]:hidden">
                <span>Details</span>
                <span aria-hidden="true" className="text-white/50 transition-transform group-open:rotate-180">▾</span>
              </summary>
              <div className="space-y-1 pt-1">
            {priceImpact !== null && (
              <div className="flex items-center justify-between text-white/70">
                {/* Our pool's figure is worked out from its reserves, so its fee is in it. */}
                <span>{ownBest ? 'Price impact (pool fee included)' : 'Price impact'}</span>
                <span className="font-mono">{priceImpact < 0.01 ? '<0.01' : priceImpact.toFixed(2)}%</span>
              </div>
            )}
            {ownBest ? (
              ownFloor !== null && (
                <div className="flex items-center justify-between text-white/70">
                  <span>Minimum received</span>
                  <span className="font-mono">{prettyAmount(fromBaseUnits(ownFloor.toString(), buyToken.decimals))} {buyToken.symbol}</span>
                </div>
              )
            ) : quote && (
              <div className="flex items-center justify-between text-white/70">
                <span>Minimum received</span>
                <span className="font-mono">{prettyAmount(fromBaseUnits(quote.otherAmountThreshold, buyToken.decimals))} {buyToken.symbol}</span>
              </div>
            )}
            {ownBest && (
              <div className="flex items-center justify-between text-white/70">
                <span>Route</span>
                <span className="font-mono truncate ml-2" title={ownBest.poolAddress}>via our pool {ownBest.poolAddress.slice(0, 4)}…{ownBest.poolAddress.slice(-4)}</span>
              </div>
            )}
            {!ownBest && quote && routeLabels(quote).length > 0 && (
              <div className="flex items-center justify-between text-white/70">
                <span>Route</span>
                <span className="font-mono truncate ml-2" title={routeLabels(quote).join(' / ')}>via {routeLabels(quote).join(' / ')}</span>
              </div>
            )}
              </div>
            </details>
            )}
            {impactNote && (
              <p className={impactNote.tone === 'bad' ? 'text-red-300' : 'text-amber-300'} data-testid="solana-impact-warning">{impactNote.text}</p>
            )}
            {sameToken && <p className="text-amber-300">Pick two different tokens.</p>}
            {quoteFail === 'no-route' && !sameToken && ownNone && <p className="text-amber-300">No route for this pair / amount.</p>}
            {quoteFail === 'no-route' && !sameToken && route.own === 'error' && (
              <p className="text-amber-300">
                Our pools could not be read just now, so this is not a statement that the pair cannot be traded.
                <button
                  type="button"
                  onClick={() => {
                    // The held read is dropped, so our pools are read again, not quoted from it.
                    forgetPools();
                    setQuoteAttempt((n) => n + 1);
                  }}
                  className="ml-1 px-2 py-2.5 -my-2 font-semibold underline underline-offset-2"
                >
                  Try again
                </button>
              </p>
            )}
            {quoteFail === 'unavailable' && !sameToken && (
              <p className="text-amber-300" data-testid="solana-quote-unavailable">
                {/* With our pool quoting, the trade CAN go ahead: what is missing is the comparison. */}
                {ownBest
                  ? 'Jupiter could not be asked for a quote just now, so our pool was not compared with it.'
                  : 'Could not get a quote just now. This is not a statement that the pair cannot be traded.'}
                <button
                  type="button"
                  onClick={() => setQuoteAttempt((n) => n + 1)}
                  className="ml-1 px-2 py-2.5 -my-2 font-semibold underline underline-offset-2"
                >
                  Try again
                </button>
              </p>
            )}
            {amount.trim() !== '' && !baseAmount && !sameToken && <p className="text-amber-300">Enter a valid amount.</p>}
            {insufficient && <p className="text-amber-300">Insufficient {payToken.symbol} balance.</p>}
            {publicKey && payBalance.unread && (
              <p className="text-amber-300" data-testid="solana-balance-unread">
                Your {payToken.symbol} balance could not be read just now. This is not a statement that you hold none.
              </p>
            )}
            {shieldWarnings.map((w, i) => (
              <p key={`sh-${i}`} className={`flex items-start gap-1 ${shieldIsAlarming(w, w.mint) ? 'text-red-300' : 'text-white/50'}`}>
                <span aria-hidden="true">⚠</span><span>{w.message}</span>
              </p>
            ))}
          </div>

          {/* Risk acknowledgement — warn, don't block (any pair is allowed). */}
          {needsAck && (
            <label
              className="flex items-start gap-2 mb-3 px-3 py-2.5 rounded-lg cursor-pointer"
              style={{ background: 'rgba(150,40,40,0.20)', border: '1px solid rgba(255,90,90,0.35)' }}
            >
              <input type="checkbox" checked={ack} onChange={(e) => onAck(e.target.checked)} className="mt-0.5 flex-shrink-0" />
              <span className="text-[11px] text-red-200">
                This pair carries a risk warning (an unverified token, or flagged by Jupiter Shield above).
                It could be a scam or have transfer restrictions. I understand and want to swap anyway.
              </span>
            </label>
          )}

          {/* A swap this wallet sent, by either route, that the chain has not answered for yet. */}
          {pendingNote && (
            <Suspense fallback={null}>
              <div className="mb-3">
                <VenueSwapFlow swap={venueSwap} />
              </div>
            </Suspense>
          )}

          {/* Action */}
          {!publicKey ? (
            <SolanaConnectButton />
          ) : (
            <button
              ref={buyRef}
              type="button"
              onClick={() => {
                tick();
                void handleSwap();
              }}
              disabled={actionDisabled}
              className="btn-primary w-full py-2.5 text-[14px] disabled:opacity-50"
            >
              {ctaLabel}
            </button>
          )}
          {offerOwn && ownOffer && (
            <button
              type="button"
              onClick={() => startOwnSwap(ownOffer.out)}
              className="btn-secondary w-full min-h-[44px] mt-2 py-2.5 text-[13px]"
              data-testid="solana-own-offer"
            >
              {OWN_POOL_REVIEW_OFFER}
            </button>
          )}

          {/* WAVE SEVEN, element O: the commitment line, latched by the confirm
              above and rendered whether or not a wallet is attached right now.
              It stays silent until the venue holds a reading for this buyer - on
              this rail that is usually not yet, and a sentence the venue cannot
              support is worse than no sentence at all. */}
          <ClockLine />

          <p className="mt-3 text-center text-white/60 text-[10px]" data-testid="swap-footer">
            {/* On our own pool's route the fee sentences below are not this trade's. */}
            {ownBest ? 'No platform fee on a swap in our own pool.' : (
              <>
            {/* While the no-fee re-quote is on screen the standing sentence
                would contradict the notice a few rows above it. */}
            {!isSolanaFeeConfigured()
              ? 'No platform fee is charged here today.'
              : feeWaived
                ? 'No platform fee on this route.'
                : `A ${feePct}% platform fee applies on pairs that include SOL or USDC.`}
              </>
            )}
          </p>
            </fieldset>
            </>
          ) : mode === 'limit' ? (
            <LimitTab payToken={payToken} buyToken={buyToken} shieldWarnings={shieldWarnings} needsAck={needsAck} ack={ack} setAck={onAck} onPickPay={() => setPicker('pay')} onPickBuy={() => setPicker('buy')} />
          ) : (
            <DcaTab payToken={payToken} buyToken={buyToken} payUsd={prices[payToken.mint] ?? null} shieldWarnings={shieldWarnings} needsAck={needsAck} ack={ack} setAck={onAck} onPickPay={() => setPicker('pay')} onPickBuy={() => setPicker('buy')} />
          )}
        </div>
      </m.div>

      {mode === 'swap' && !home && (
        <>
          {/* Skip the chart for stablecoin buys — a $1.00 flatline is noise. */}
          {buyToken.mint !== USDC.mint && buyToken.mint !== USDT.mint && (
            <div className="mt-6">
              <PairChart key={buyToken.mint} mint={buyToken.mint} symbol={buyToken.symbol} />
            </div>
          )}
          <EarnRail onPick={(t) => { if (!held) { setPayToken(SOL); setBuyToken(t); } }} />
          <TrendingRail onPick={(t) => { if (!held) { setPayToken(SOL); setBuyToken(t); } }} />
          <ActivityRail />
        </>
      )}

      {picker === 'pay' && (
        <TokenPicker
          title="Pay with"
          featured={PAY_WITH_TOKENS}
          onClose={() => setPicker(null)}
          onSelect={(t) => { rememberToken(t); setPayToken(t); setPicker(null); }}
        />
      )}
      {picker === 'buy' && (
        <TokenPicker
          title="Buy"
          featured={BUY_TOKENS}
          onClose={() => setPicker(null)}
          onSelect={(t) => { rememberToken(t); setBuyToken(t); setPicker(null); }}
        />
      )}
      {detailToken && <TokenDetail token={detailToken} onClose={() => setDetailToken(null)} />}
    </div>
    </>
  );
}

/**
 * A swap in one of our pools, either kind, as the page says it: what is paid and what comes
 * out, from the prepared transaction's own summary. Null for any other transaction.
 */
function ownSwapView(s: TxSummary | undefined) {
  if (s?.kind === 'venue-swap') {
    return { paysCoin: s.paysCoin, coin: s.coin, tokenMint: s.tokenMint, tokenDecimals: s.tokenDecimals, amountIn: s.amountIn, minimumAmountOut: s.minimumAmountOut, outAmount: s.quoted.outAmount };
  }
  if (s?.kind === 'range-swap') {
    const l = s.poolLine;
    return { paysCoin: s.paysCoin, coin: l.quote, tokenMint: l.tokenMint, tokenDecimals: l.tokenDecimals, amountIn: s.amountIn, minimumAmountOut: s.minimumAmountOut, outAmount: s.quotedOut };
  }
  return null;
}
const ownSwapOut = (s: TxSummary | undefined): bigint | null => ownSwapView(s)?.outAmount ?? null;

export default function SolanaSwapPage() {
  usePageTitle('Solana Swap', 'Swap Solana tokens on memetics.finance, through our own pools or Jupiter.');
  useEffect(() => { trackPageView('solana-swap'); }, []);

  // The surface is gated on the SWAP being available, not on the venue having
  // somewhere to send a fee — see isSolanaSwapLive(). The branch is kept (rather
  // than deleted) so a future operator kill-switch has one place to live.
  if (!isSolanaSwapLive()) {
    return (
      <>
        {/* idx is spelled out: the coverage guard pairs a pageId with the next
            idx it finds, and the next one here belongs to the card below. */}
        <PageArtBackdrop pageId="solana-swap" idx={0} />
        <div className="relative z-10 max-w-md mx-auto px-4 py-10">
          <FeatureNotDeployed
            pageId="swap"
            idx={2}
            title="Solana swap isn't live yet"
            subtitle="Buy Solana tokens on the venue — coming soon."
          />
        </div>
      </>
    );
  }

  return (
    <SolanaProviders>
      <SolanaSwapInner />
    </SolanaProviders>
  );
}
