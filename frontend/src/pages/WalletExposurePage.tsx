import { useCallback, useMemo, useRef, useState } from 'react';
import { m } from 'framer-motion';
import { useAccount } from 'wagmi';
import { usePageTitle } from '../hooks/usePageTitle';
import { ConnectPrompt } from '../components/ui/ConnectPrompt';
import { useWalletExposure } from '../hooks/useWalletExposure';
import { scanTokenLive } from '../lib/scanner';
import {
  BAND_LABEL,
  deriveHoldingExposure,
  etherscanHoldersUrl,
  summarizeExposures,
  type HoldingExposure,
  type WalletHolding,
} from '../lib/detection/walletExposure';
import { METHOD_VERSION, type Band, type ConfidenceLevel } from '../lib/detection';
import { formatBalance, formatPercent, shortenAddress } from '../lib/formatting';
import { Link } from 'react-router-dom';
import { validateAddress } from '../lib/tokenList';
import { readExplorerPage, isTokenTxRow } from '../lib/txHistory';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { HeatCard } from '../components/HeatCard';

// WalletExposurePage — connect a wallet, see every ERC-20 position, and read each
// one's concentration / bundle / rug exposure from the shared detection core.
//
// HONEST-FRAMING: this is a descriptive measurement with a disclosed method and a
// timestamp, never a fraud verdict. Position sizes are exact on-chain reads.
// Distribution scoring self-gates to "not measured" for tokens whose holder
// distribution could not be read — never a fabricated band, and never retried
// behind the user's back. See lib/detection/walletExposure.ts for the scanner
// seam, which this page fills with the live `scanTokenLive` adapter below.

const CARD_BG = 'rgba(6, 12, 26, 0.82)';
const CARD_BORDER = '1px solid rgba(245, 228, 184, 0.12)';

const BAND_STYLE: Record<Band, { fg: string; bg: string; border: string }> = {
  'well-distributed': { fg: '#7ee2a8', bg: 'rgba(45, 139, 78, 0.16)', border: 'rgba(126, 226, 168, 0.35)' },
  mixed: { fg: '#f5d488', bg: 'rgba(200, 150, 40, 0.16)', border: 'rgba(245, 212, 136, 0.35)' },
  concentrated: { fg: '#f2a2a2', bg: 'rgba(180, 50, 50, 0.16)', border: 'rgba(242, 162, 162, 0.35)' },
};

const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

function BandPill({ band }: { band: Band }) {
  const s = BAND_STYLE[band];
  return (
    <span
      className="inline-flex items-center rounded-full px-3 py-1 text-[12px] font-semibold"
      style={{ color: s.fg, background: s.bg, border: `1px solid ${s.border}` }}
    >
      {BAND_LABEL[band]}
    </span>
  );
}

function ConfidenceBadge({ level }: { level: ConfidenceLevel }) {
  return (
    <span className="text-[11px] uppercase tracking-wider text-white/45">{CONFIDENCE_LABEL[level]}</span>
  );
}

function pct(share: number | null): string {
  if (share == null) return '—';
  return formatPercent(share * 100);
}

function MeasuredBody({ exposure }: { exposure: HoldingExposure }) {
  const a = exposure.analysis;
  if (!a || !exposure.band) return null;
  const m10 = a.metrics.topN.top10;
  const nEff = a.metrics.effectiveHolders;
  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <BandPill band={exposure.band} />
        {exposure.confidence && <ConfidenceBadge level={exposure.confidence} />}
      </div>
      {exposure.headline && <p className="text-white/80 text-[13px] leading-relaxed">{exposure.headline}</p>}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-[12px]">
        <Metric label="Effective holders" value={nEff >= 10 ? Math.round(nEff).toString() : nEff.toFixed(1)} />
        <Metric label="Top 1 holder" value={pct(a.metrics.topN.top1)} />
        <Metric label="Top 10 holders" value={pct(m10)} />
        <Metric label="Nakamoto coeff." value={String(a.metrics.nakamotoCoefficient)} />
        <Metric label="Holders measured" value={String(a.metrics.includedHolders)} />
        <Metric label="Excluded supply" value={pct(a.excludedSupplyShareOfTotal)} />
      </div>
      {a.confidence.reasons.length > 0 && (
        <p className="text-white/45 text-[11px] leading-relaxed">{a.confidence.reasons[0]}</p>
      )}
      <p className="text-white/40 text-[11px] leading-relaxed">{a.correctionPath}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-white/45 uppercase tracking-wider text-[10px]">{label}</div>
      <div className="text-white/90 font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function UnmeasuredBody({ exposure, token }: { exposure: HoldingExposure; token: string }) {
  return (
    <div className="mt-3 space-y-2">
      <span className="inline-flex items-center rounded-full px-3 py-1 text-[12px] font-semibold text-white/60"
        style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)' }}>
        Distribution not measured
      </span>
      <p className="text-white/60 text-[12px] leading-relaxed">{exposure.reason}</p>
      <a
        href={etherscanHoldersUrl(token)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block text-[12px] text-[#7ee2a8] hover:underline underline-offset-2"
      >
        Inspect this token’s holders on Etherscan →
      </a>
    </div>
  );
}

function HoldingCard({ holding, exposure }: { holding: WalletHolding; exposure: HoldingExposure }) {
  return (
    <m.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="rounded-2xl p-4 sm:p-5"
      style={{ background: CARD_BG, border: CARD_BORDER, boxShadow: '0 8px 30px rgba(0,0,0,0.35)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-white font-semibold text-[15px] truncate">{holding.symbol}</h3>
            {!holding.curated && (
              <span className="text-[10px] uppercase tracking-wider text-white/40 border border-white/15 rounded px-1.5 py-0.5">
                Custom
              </span>
            )}
          </div>
          {holding.name && <p className="text-white/45 text-[12px] truncate">{holding.name}</p>}
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href={`https://etherscan.io/token/${holding.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-white/35 text-[11px] hover:text-white/60 tabular-nums"
            >
              {shortenAddress(holding.address, 5)}
            </a>
            {/* Same engine, full report: this row summarises one position, /scan gives
                the token's whole holder distribution with its exclusions + method. */}
            <Link to={`/scan?token=${holding.address}`} className="text-white/35 text-[11px] hover:text-white/60">
              full scan →
            </Link>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-white font-semibold text-[15px] tabular-nums">
            {formatBalance(holding.balanceFormatted, 4)}
          </div>
          <div className="text-white/45 text-[11px]">
            {holding.positionShareOfTotal != null
              ? `${pct(holding.positionShareOfTotal)} of supply`
              : 'supply unknown'}
          </div>
        </div>
      </div>

      {exposure.status === 'measured' ? (
        <MeasuredBody exposure={exposure} />
      ) : (
        <UnmeasuredBody exposure={exposure} token={holding.address} />
      )}
    </m.div>
  );
}

/**
 * What the explorer discovery pass found, as a state a reader can act on.
 *
 * `failed` exists so that a `tokentx` read which did not happen can never be
 * rendered as an empty wallet — the two are different facts and this page's
 * whole argument is that it keeps them apart.
 */
type DiscoveryState =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'failed'; detail: string }
  | { kind: 'done'; distinct: number; added: number; overCap: boolean; partialLog: boolean };

/**
 * How many discovered contracts we are willing to add to the balance multicall.
 *
 * Each token costs four calls in `useWalletExposure`'s multicall and one holder
 * scan afterwards, so an unbounded set turns one click into a very long read. A
 * cap that is DISCLOSED is honest; an undisclosed one is the "short list that
 * reads as a complete one" failure this page exists to avoid.
 */
const DISCOVERY_CAP = 60;

/** One page of the explorer's token-transfer log. 500 is the proxy's own ceiling. */
const DISCOVERY_PAGE = 500;

export default function WalletExposurePage() {
  usePageTitle(
    'Wallet Exposure',
    'A descriptive, method-disclosed read of concentration and rug exposure across the tokens your wallet holds.',
  );
  const { address, isConnected } = useAccount();

  const [extraTokens, setExtraTokens] = useState<string[]>([]);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryState>({ kind: 'idle' });
  const discoveryAbort = useRef<AbortController | null>(null);

  // Inject the LIVE scanner adapter (2026-07-24). Previously omitted, so every
  // holding self-gated to `unmeasured` and the page's headline concentration
  // scoring never rendered — even though /scan already had the wired holder
  // source. Each held token now runs through the same scanTokenLive path the
  // Scanner page uses; a failed scan falls back to null (still `unmeasured`).
  const { isWrongNetwork, isLoading, error, holdings, unreadableBalances, exposures, scanning } = useWalletExposure({
    extraTokens,
    scanToken: (t, signal) =>
      scanTokenLive(t.address, { signal, chainOverride: t.chain })
        .then((o) => o.analysis)
        .catch(() => null),
  });

  const summary = useMemo(() => summarizeExposures(Object.values(exposures)), [exposures]);
  // `Date | null`, never `new Date()`.
  //
  // The fallback used to be the current clock, so a page where every scan was
  // still pending — or where every scan had FAILED — stamped "balances read
  // on-chain as of <now>" onto a read that did not happen. The absence of an
  // observation is its own fact and the footer says so in words instead.
  const observedAt = useMemo<Date | null>(() => {
    const ts = Object.values(exposures)
      .map((e) => e.observedAt)
      .sort((a, b) => b - a)[0];
    return ts ? new Date(ts * 1000) : null;
  }, [exposures]);

  /**
   * Read the wallet's ERC-20 transfer log through the existing explorer proxy,
   * take the distinct contracts out of it, and hand them to the SAME on-chain
   * multicall the curated list already goes through. The explorer decides only
   * WHICH contracts to look at; every balance on this page is still an on-chain
   * read, and a token the wallet has since sold reads zero and drops out.
   *
   * Opt-in on purpose: `/api/etherscan` is budgeted at 30 requests per minute
   * per IP, so this spends a request only when a person asks it to.
   */
  const discoverTokens = useCallback(async () => {
    if (!address) return;
    discoveryAbort.current?.abort();
    const controller = new AbortController();
    discoveryAbort.current = controller;
    setDiscovery({ kind: 'reading' });

    const read = await readExplorerPage('tokentx', address, 1, controller.signal, undefined, DISCOVERY_PAGE)
      .catch((e: unknown) => ({
        kind: 'failed' as const,
        reason: 'proxy-error' as const,
        detail: e instanceof Error ? e.message : 'The transfer log could not be read.',
      }));
    if (controller.signal.aborted) return;

    if (read.kind === 'failed') {
      // NOT an empty wallet. Nothing was read, and the page has to say that.
      setDiscovery({ kind: 'failed', detail: read.detail });
      return;
    }

    const rows = read.kind === 'rows' ? read.rows.filter(isTokenTxRow) : [];
    const seen = new Set<string>();
    const found: string[] = [];
    for (const r of rows) {
      const key = r.contractAddress.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const checksummed = validateAddress(r.contractAddress);
      if (checksummed) found.push(checksummed);
    }
    const capped = found.slice(0, DISCOVERY_CAP);
    // Computed from the value we render against, not inside the state updater:
    // an updater can be invoked more than once and must stay pure.
    const have = new Set(extraTokens.map((t) => t.toLowerCase()));
    const fresh = capped.filter((t) => !have.has(t.toLowerCase()));
    if (fresh.length > 0) setExtraTokens((prev) => [...prev, ...fresh]);
    setDiscovery({
      kind: 'done',
      distinct: found.length,
      added: fresh.length,
      overCap: found.length > DISCOVERY_CAP,
      // `full` means the page came back at the request size, so there are older
      // transfers this single page did not reach.
      partialLog: read.kind === 'rows' && read.full,
    });
  }, [address, extraTokens]);

  function addPasted() {
    const checksummed = validateAddress(pasteValue.trim());
    if (!checksummed) {
      setPasteError('Enter a valid ERC-20 contract address (0x…).');
      return;
    }
    if (extraTokens.some((t) => t.toLowerCase() === checksummed.toLowerCase())) {
      setPasteError('That token is already in the list.');
      return;
    }
    setExtraTokens((prev) => [...prev, checksummed]);
    setPasteValue('');
    setPasteError(null);
  }

  return (
    <>
      <PageArtBackdrop pageId="wallet-exposure" />
      <div className="relative z-10 max-w-3xl mx-auto px-4 sm:px-6 py-10 md:py-14">
      <header className="mb-6">
        <h1 className="heading-luxury text-3xl md:text-4xl text-white mb-2">Wallet Exposure</h1>
        <p className="text-white/70 text-[14px] leading-relaxed max-w-2xl">
          A descriptive, method-disclosed read of how concentrated each token you hold is — effective
          holder count, top-holder share, and (when available) bundle and sniper supply. This is a
          measurement of on-chain distribution, not a verdict on any project’s intent.
        </p>
      </header>

      {!isConnected ? (
        <ConnectPrompt
          surface="dashboard"
          title="Connect to scan your wallet"
          description="Check your balances across a tracked token set, the tokens the explorer says you have received, and any token address you paste. Read-only: no signing, no approvals, no funds moved."
        />
      ) : (
        <>
          {isWrongNetwork && (
            <div className="rounded-xl px-4 py-3 mb-5 text-[13px] text-amber-200"
              style={{ background: 'rgba(200,150,40,0.12)', border: '1px solid rgba(245,212,136,0.3)' }}>
              Switch to Ethereum mainnet to read your holdings.
            </div>
          )}

          {/* THE RULER, on a connected-wallet surface. This page already reads what you
              hold; Heat reads how LONG you have held it, which is the one dimension
              concentration metrics cannot see. Same card, same tier words, same
              reckoning date as everywhere else. */}
          <div className="mb-6">
            <HeatCard />
          </div>

          {/* Add-a-token */}
          <div className="rounded-2xl p-4 mb-6" style={{ background: CARD_BG, border: CARD_BORDER }}>
            <label htmlFor="paste-token" className="block text-white/70 text-[12px] mb-2">
              Check a specific token not in the tracked list
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                id="paste-token"
                value={pasteValue}
                onChange={(e) => { setPasteValue(e.target.value); setPasteError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') addPasted(); }}
                placeholder="0x… ERC-20 contract address"
                spellCheck={false}
                autoComplete="off"
                className="flex-1 rounded-lg px-3 py-2 text-[13px] text-white bg-black/30 border border-white/15 focus:border-white/40 outline-none tabular-nums"
              />
              <button onClick={addPasted} className="btn-secondary px-4 py-2 text-[13px]">Add</button>
            </div>
            {pasteError && <p className="text-[12px] text-red-300 mt-2">{pasteError}</p>}

            {/* Discovery — opt-in, one click, and every outcome named.
                The curated list cannot answer "what am I holding", and a page
                that asks that question has to at least try. What the explorer
                gives us is a list of CONTRACTS this wallet has touched; the
                balances still come off chain through the multicall above. */}
            <div className="mt-4 pt-4 border-t border-white/10">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <button
                  onClick={() => { void discoverTokens(); }}
                  disabled={discovery.kind === 'reading' || !address}
                  className="btn-secondary px-4 py-2 text-[13px] min-h-11 disabled:opacity-50"
                >
                  {discovery.kind === 'reading' ? 'Reading the transfer log…' : 'Discover my tokens'}
                </button>
                <p className="text-white/45 text-[11px] leading-relaxed">
                  Reads tokens this wallet has ever received, per the explorer — not a complete
                  wallet index. Balances are then read on chain like everything else here.
                </p>
              </div>

              {discovery.kind === 'failed' && (
                <p className="text-[12px] text-amber-300 mt-2 leading-relaxed">
                  The transfer log could not be read, so nothing was discovered: {discovery.detail} This
                  is a failed read, not an empty wallet — the list below is still only the curated set
                  plus anything you added.
                </p>
              )}

              {discovery.kind === 'done' && (
                <p className="text-white/55 text-[12px] mt-2 leading-relaxed">
                  {discovery.distinct === 0
                    ? 'The explorer returned no ERC-20 transfers for this wallet.'
                    : `${discovery.distinct} distinct token${discovery.distinct === 1 ? '' : 's'} ever received; ${discovery.added} added to the reads below.`}
                  {discovery.overCap && ` Only the ${DISCOVERY_CAP} most recent were added — the rest are not being read.`}
                  {discovery.partialLog && ' The log came back full at one page, so transfers older than that page were not read.'}
                </p>
              )}
            </div>
            {extraTokens.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {extraTokens.map((t) => (
                  <button
                    key={t}
                    onClick={() => setExtraTokens((prev) => prev.filter((x) => x !== t))}
                    className="text-[11px] text-white/60 hover:text-white border border-white/15 rounded-full px-2.5 py-1"
                    title="Remove"
                  >
                    {shortenAddress(t, 4)} ✕
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Summary */}
          {holdings.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mb-5 text-[12px] text-white/60">
              <span>{holdings.length} position{holdings.length === 1 ? '' : 's'}</span>
              <span>{summary.measured} measured</span>
              {summary.unmeasured > 0 && <span>{summary.unmeasured} not measured</span>}
              {/* Distinct from "not measured": those are positions we DO show whose
                  distribution could not be read. These are positions missing from the
                  list entirely because their balance read failed — so the count below
                  is what keeps their absence from being silent. */}
              {unreadableBalances.length > 0 && (
                <span className="text-amber-300/80">
                  {unreadableBalances.length} balance{unreadableBalances.length === 1 ? '' : 's'} unreadable
                </span>
              )}
              {summary.worstBand && (
                <span className="inline-flex items-center gap-1.5">
                  Worst read: <BandPill band={summary.worstBand} />
                </span>
              )}
              {scanning && <span className="text-white/40">scanning…</span>}
            </div>
          )}

          {/* Body states */}
          {isLoading ? (
            <div className="text-white/50 text-[13px] py-10 text-center">Reading your on-chain balances…</div>
          ) : error ? (
            <div className="rounded-2xl p-5 text-[13px] text-white/70"
              style={{ background: CARD_BG, border: CARD_BORDER }}>
              Couldn’t read balances right now. This is a network hiccup, not a signal about any token —
              try again shortly.
            </div>
          ) : holdings.length === 0 ? (
            <div className="rounded-2xl p-6 text-center"
              style={{ background: CARD_BG, border: CARD_BORDER }}>
              <p className="text-white/80 text-[14px] mb-1">
                {discovery.kind === 'done'
                  ? 'No ERC-20 balances found in this wallet.'
                  : 'No tracked ERC-20 balances in this wallet.'}
              </p>
              <p className="text-white/50 text-[12px] leading-relaxed max-w-md mx-auto">
                {discovery.kind === 'done'
                  ? 'This read covers the curated set, anything you added, and the tokens the explorer says this wallet has received. Tokens acquired in ways the explorer’s transfer log does not show are still not covered.'
                  : discovery.kind === 'failed'
                    ? 'The discovery read failed, so this is the curated token set plus anything you added — it says nothing about the rest of the wallet. Try Discover again, or paste a contract address.'
                    : 'This view reads a curated token set plus any address you add above — it does not enumerate every token you hold. Run Discover above, or paste a contract address to check a specific position.'}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {holdings.map((h) => {
                const exp = exposures[h.address.toLowerCase()] ?? deriveHoldingExposure(null);
                return <HoldingCard key={h.address.toLowerCase()} holding={h} exposure={exp} />;
              })}
            </div>
          )}

          {/* Method disclosure */}
          <footer className="mt-8 pt-5 border-t border-white/10 text-white/40 text-[11px] leading-relaxed space-y-1">
            <p>
              Method {METHOD_VERSION} ·{' '}
              {observedAt
                ? `balances read on-chain as of ${observedAt.toLocaleString()}`
                : 'no distribution read has completed yet, so there is no observation time to report'}. Concentration
              excludes pools, exchanges, bridges, burns and contracts before any math; an unlabeled large wallet
              is kept but lowers confidence, never assumed hostile.
            </p>
            <p>
              Distribution comes from the same read the scanner uses, which enumerates the largest holders — the
              top ~100 on Ethereum, the top 20 on Solana. Where a token has more holders than that, the
              un-enumerated tail can only dilute concentration, so a concentrated band is an upper bound rather
              than an exact figure.
            </p>
            <p>
              Distribution scoring is shown only for tokens whose holder distribution could be read. Where it
              couldn’t, the read is marked not measured — the position size stays exact and nothing is inferred.
              A token whose <em>balance</em> read fails has no size to show, so it is left out of the list and
              counted as unreadable above rather than dropped silently: an omitted position would understate the
              concentration on this page.
            </p>
          </footer>
        </>
      )}
      </div>
    </>
  );
}
