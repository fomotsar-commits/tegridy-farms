import { useMemo, useState } from 'react';
import { m } from 'framer-motion';
import { useAccount } from 'wagmi';
import { usePageTitle } from '../hooks/usePageTitle';
import { ConnectPrompt } from '../components/ui/ConnectPrompt';
import { useWalletExposure } from '../hooks/useWalletExposure';
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
import { validateAddress } from '../lib/tokenList';

// WalletExposurePage — connect a wallet, see every ERC-20 position, and read each
// one's concentration / bundle / rug exposure from the shared detection core.
//
// HONEST-FRAMING: this is a descriptive measurement with a disclosed method and a
// timestamp, never a fraud verdict. Position sizes are exact on-chain reads.
// Distribution scoring self-gates to "pending" for tokens whose holder
// distribution we can't fetch yet — never a fabricated band. See
// lib/detection/walletExposure.ts for the scanner seam that lights these up.

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
          <a
            href={`https://etherscan.io/token/${holding.address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/35 text-[11px] hover:text-white/60 tabular-nums"
          >
            {shortenAddress(holding.address, 5)}
          </a>
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

export default function WalletExposurePage() {
  usePageTitle(
    'Wallet Exposure',
    'A descriptive, method-disclosed read of concentration and rug exposure across the tokens your wallet holds.',
  );
  const { isConnected } = useAccount();

  const [extraTokens, setExtraTokens] = useState<string[]>([]);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);

  // No scanToken is injected yet: a token-distribution scanner adapter (holder
  // list source) is not deployed, so every holding self-gates to `unmeasured`.
  // Inject one here to light up the bands with real data.
  const { isWrongNetwork, isLoading, error, holdings, exposures, scanning } = useWalletExposure({ extraTokens });

  const summary = useMemo(() => summarizeExposures(Object.values(exposures)), [exposures]);
  const observedAt = useMemo(() => {
    const ts = Object.values(exposures)
      .map((e) => e.observedAt)
      .sort((a, b) => b - a)[0];
    return ts ? new Date(ts * 1000) : new Date();
  }, [exposures]);

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
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 md:py-14">
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
          description="Read every ERC-20 position in your wallet and score each for concentration and rug exposure. Read-only — no signing, no approvals, no funds moved."
        />
      ) : (
        <>
          {isWrongNetwork && (
            <div className="rounded-xl px-4 py-3 mb-5 text-[13px] text-amber-200"
              style={{ background: 'rgba(200,150,40,0.12)', border: '1px solid rgba(245,212,136,0.3)' }}>
              Switch to Ethereum mainnet to read your holdings.
            </div>
          )}

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
              {summary.unmeasured > 0 && <span>{summary.unmeasured} pending holder data</span>}
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
              <p className="text-white/80 text-[14px] mb-1">No tracked ERC-20 balances in this wallet.</p>
              <p className="text-white/50 text-[12px] leading-relaxed max-w-md mx-auto">
                This view reads a curated token set plus any address you add above — it does not
                enumerate every token you hold. Paste a contract address to check a specific position.
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
              Method {METHOD_VERSION} · balances read on-chain as of {observedAt.toLocaleString()}. Concentration
              excludes pools, exchanges, bridges, burns and contracts before any math; an unlabeled large wallet
              is kept but lowers confidence, never assumed hostile.
            </p>
            <p>
              Distribution scoring is shown only for tokens whose holder distribution is available. Where it isn’t,
              the read is marked pending — the position size stays exact and nothing is inferred.
            </p>
          </footer>
        </>
      )}
    </div>
  );
}
