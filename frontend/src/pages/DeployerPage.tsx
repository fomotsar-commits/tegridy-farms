import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { m } from 'framer-motion';
import { useAccount } from 'wagmi';
import { usePageTitle } from '../hooks/usePageTitle';
import { useDeployerReputation } from '../hooks/useDeployerReputation';
import {
  STATUS_LABEL,
  geckoTerminalTokenUrl,
  type DeployerReputation,
  type LaunchStatus,
  type LaunchTrajectory,
} from '../lib/detection/deployerReputation';
import { isDeployerAddress } from '../lib/detection/deployerLaunches';
import { METHOD_VERSION, type ConfidenceLevel } from '../lib/detection';
import { shortenAddress, formatTimeAgo } from '../lib/formatting';
import { PageArtBackdrop } from '../components/PageArtBackdrop';

// DEPLOYER REPUTATION GRAPH — paste a deployer address, see the tokens it deployed
// DIRECTLY and each one's CURRENT market state. Shareable via ?address=… .
//
// HONEST-FRAMING BRAND: this is a DESCRIPTIVE MEASUREMENT of current on-chain state
// with a disclosed method, its components, a timestamp and a correction path — never
// a fraud verdict. It self-gates to explicit unknown/empty states and NEVER invents a
// track record. It is DATA-CONSTRAINED: only direct contract-creations are visible
// (factory launches need an indexer), and no launch-time baselines exist, so a strict
// "survived / dumped / rugged" outcome cannot be computed — the gaps are shown loudly.

const STATUS_STYLE: Record<LaunchStatus, { fg: string; bg: string; border: string }> = {
  'active-market': { fg: '#7ee2a8', bg: 'rgba(45, 139, 78, 0.16)', border: 'rgba(126, 226, 168, 0.35)' },
  'thin-market': { fg: '#f5d488', bg: 'rgba(200, 150, 40, 0.16)', border: 'rgba(245, 212, 136, 0.35)' },
  'no-market': { fg: 'rgba(255,255,255,0.62)', bg: 'rgba(255,255,255,0.06)', border: 'rgba(255,255,255,0.16)' },
  unobserved: { fg: 'rgba(255,255,255,0.5)', bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.12)' },
};

const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

function StatusPill({ status }: { status: LaunchStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
      style={{ color: s.fg, background: s.bg, border: `1px solid ${s.border}` }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function formatEthShort(n: number | null): string {
  if (n == null) return '—';
  if (n >= 100) return `${n.toFixed(0)} ETH`;
  if (n >= 1) return `${n.toFixed(2)} ETH`;
  if (n >= 0.001) return `${n.toFixed(3)} ETH`;
  if (n > 0) return `${n.toExponential(1)} ETH`;
  return '0 ETH';
}

function TokenCard({ t }: { t: LaunchTrajectory }) {
  return (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href={geckoTerminalTokenUrl(t.token)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[13px] text-text-primary hover:underline underline-offset-2"
            >
              {shortenAddress(t.token, 6)}
            </a>
            <StatusPill status={t.status} />
          </div>
          <p className="text-[11px] text-text-muted mt-1">
            {t.createdAt > 0 ? `Deployed ${formatTimeAgo(t.createdAt)}` : 'Deploy time unknown'}
            {t.txHash ? (
              <>
                {' · '}
                <a
                  href={`https://etherscan.io/tx/${t.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-text-secondary underline underline-offset-2"
                >
                  creation tx
                </a>
              </>
            ) : null}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Liquidity now</div>
          <div className="text-[13px] font-semibold text-text-primary tabular-nums">{formatEthShort(t.liquidityEth)}</div>
        </div>
      </div>
      <p className="text-[12px] text-text-secondary leading-relaxed mt-2">{t.note}</p>
    </div>
  );
}

function CountChip({ label, value, tone }: { label: string; value: number; tone?: LaunchStatus }) {
  const style = tone ? STATUS_STYLE[tone] : null;
  return (
    <div
      className="rounded-lg px-3 py-2 text-center"
      style={
        style
          ? { background: style.bg, border: `1px solid ${style.border}` }
          : { background: 'var(--color-bg-input)', border: '1px solid var(--color-border)' }
      }
    >
      <div className="text-[16px] font-bold tabular-nums" style={{ color: style?.fg ?? 'var(--color-text-primary)' }}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted mt-0.5">{label}</div>
    </div>
  );
}

function ReputationReport({ rep }: { rep: DeployerReputation }) {
  const observed = new Date(rep.observedAt * 1000);
  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="glass-card rounded-xl p-5">
        <div className="flex items-center justify-between gap-2 mb-3">
          <span
            className="text-[11px] uppercase tracking-wider"
            style={{ color: rep.confidence.level === 'low' ? 'var(--color-warning)' : 'var(--color-text-muted)' }}
          >
            {CONFIDENCE_LABEL[rep.confidence.level]}
          </span>
          <span className="font-mono text-[11px] text-text-muted">{shortenAddress(rep.deployer, 6)}</span>
        </div>

        <p className="text-[14px] text-text-primary leading-relaxed mb-4">{rep.headline}</p>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
          <CountChip label="Deployed" value={rep.counts.created} />
          <CountChip label="Active" value={rep.counts.activeMarket} tone="active-market" />
          <CountChip label="Thin" value={rep.counts.thinMarket} tone="thin-market" />
          <CountChip label="No market" value={rep.counts.noMarket} tone="no-market" />
          <CountChip label="Unread" value={rep.counts.unobserved} tone="unobserved" />
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-text-muted">
          {rep.latestCreationAt && <span>Most recent deploy {formatTimeAgo(rep.latestCreationAt)}</span>}
          {rep.lastActivityAt && <span>Deployer last active {formatTimeAgo(rep.lastActivityAt)}</span>}
        </div>

        {rep.confidence.reasons.length > 0 && (
          <ul className="mt-3 space-y-1">
            {rep.confidence.reasons.map((r, i) => (
              <li key={i} className="text-[11px] text-text-muted leading-relaxed">
                • {r}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Per-token trajectories */}
      <div className="space-y-3">
        {rep.trajectories.map((t) => (
          <TokenCard key={t.token} t={t} />
        ))}
      </div>

      {/* Loud gap disclosures */}
      <div className="glass-card rounded-xl p-5" style={{ borderColor: 'var(--color-warning)' }}>
        <h3 className="text-[12px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--color-warning)' }}>
          What this can and can't tell you
        </h3>
        <ul className="space-y-2">
          {rep.disclosures.map((d, i) => (
            <li key={i} className="text-[12px] text-text-secondary leading-relaxed">
              • {d}
            </li>
          ))}
        </ul>
      </div>

      {/* Method + correction path */}
      <footer className="pt-4 border-t border-white/10 text-text-muted text-[11px] leading-relaxed space-y-1">
        <p>
          Method {METHOD_VERSION} · read on {observed.toLocaleString()}. {rep.method.description}
        </p>
        <p>{rep.correctionPath}</p>
      </footer>
    </div>
  );
}

export default function DeployerPage() {
  usePageTitle(
    'Deployer Reputation Graph',
    'Paste a deployer address to see the tokens it deployed directly and each one’s current market state — a descriptive, method-disclosed measurement, not a fraud verdict.',
  );

  const [params, setParams] = useSearchParams();
  const committed = (params.get('address') ?? '').trim();
  const [draft, setDraft] = useState(committed);
  const [copiedLink, setCopiedLink] = useState(false);
  const { address: wallet, isConnected } = useAccount();

  useEffect(() => {
    setDraft(committed);
  }, [committed]);

  const draftValid = isDeployerAddress(draft.trim());
  const rep = useDeployerReputation(committed);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = draft.trim();
    const next = new URLSearchParams();
    if (v) next.set('address', v);
    setParams(next);
  }

  function useMyWallet() {
    if (!wallet) return;
    setDraft(wallet);
    const next = new URLSearchParams();
    next.set('address', wallet);
    setParams(next);
  }

  function copyLink() {
    if (typeof window === 'undefined') return;
    navigator.clipboard?.writeText(window.location.href).then(
      () => {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2500);
      },
      () => setCopiedLink(false),
    );
  }

  return (
    <>
      <PageArtBackdrop pageId="deployer" />
      <div className="max-w-[860px] mx-auto px-4 md:px-6 pt-8 pb-28 md:pb-16">
      {/* Intro */}
      <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
        <h1 className="heading-luxury text-2xl md:text-4xl text-text-primary tracking-tight mb-2">
          Deployer Reputation Graph
        </h1>
        <p className="text-[14px] text-text-secondary max-w-[660px]">
          Paste a wallet address to see the tokens it{' '}
          <span className="text-text-primary font-medium">deployed directly</span> and where each one stands right now.
          It is a <span className="text-text-primary font-medium">descriptive measurement</span> of current on-chain
          state — not a verdict on anyone&apos;s intent, and not a full track record (the limits are shown with every
          result).
        </p>
      </m.div>

      {/* Address form */}
      <form onSubmit={submit} className="glass-card rounded-xl p-4 mb-4">
        <label htmlFor="deployer-address" className="block text-[11px] uppercase tracking-wider text-text-muted mb-2">
          Deployer address
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            id="deployer-address"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="0x… wallet that deployed the tokens"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 rounded-lg px-3 py-2.5 text-[13px] font-mono text-text-primary outline-none"
            style={{ background: 'var(--color-bg-input)', border: '1px solid var(--color-border)' }}
          />
          <button type="submit" disabled={!draft.trim() || !draftValid} className="btn-primary text-[14px] px-6 py-2.5 whitespace-nowrap">
            Read history
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 min-h-[18px]">
          {draft.trim() && !draftValid && (
            <span className="text-[11px]" style={{ color: 'var(--color-warning)' }}>
              Not a valid Ethereum address yet
            </span>
          )}
          {isConnected && wallet && (
            <button
              type="button"
              onClick={useMyWallet}
              className="text-[11px] text-text-muted underline underline-offset-2 hover:text-text-secondary"
            >
              Use my connected wallet
            </button>
          )}
        </div>
      </form>

      {/* Result states */}
      {rep.status === 'idle' && <IdleHint />}

      {rep.status === 'invalid' && (
        <StateCard tone="warning" title="That address isn't valid">
          {rep.errorMessage}
        </StateCard>
      )}

      {rep.status === 'loading' && (
        <div className="glass-card rounded-xl p-6 text-center">
          <p className="text-[13px] text-text-secondary animate-pulse">
            Reading contract-creation history and current market state…
          </p>
        </div>
      )}

      {rep.status === 'empty' && (
        <StateCard tone="muted" title="No direct deploys found">
          <p>{rep.errorMessage}</p>
        </StateCard>
      )}

      {rep.status === 'error' && (
        <StateCard tone="danger" title="Couldn't complete the read">
          <p>{rep.errorMessage}</p>
          <button onClick={rep.reload} className="btn-secondary text-[12px] px-3 py-1.5 mt-3" type="button">
            Try again
          </button>
        </StateCard>
      )}

      {rep.status === 'success' && rep.reputation && (
        <>
          <div className="flex items-center justify-end mb-3">
            <button onClick={copyLink} className="btn-secondary text-[12px] px-3 py-1.5" type="button">
              {copiedLink ? 'Link copied' : 'Copy share link'}
            </button>
          </div>
          <ReputationReport rep={rep.reputation} />
        </>
      )}
      </div>
    </>
  );
}

function IdleHint() {
  return (
    <div className="glass-card rounded-xl p-5">
      <h2 className="text-[14px] font-semibold text-text-primary mb-2">What you&apos;ll get</h2>
      <ul className="space-y-1.5 text-[12.5px] text-text-secondary">
        <li>• Every token the address deployed <span className="text-text-primary">directly</span> (its own contract-creation transactions).</li>
        <li>• Each token&apos;s <span className="text-text-primary">current</span> market: an active pool, a thin pool, or no live market found.</li>
        <li>• A plain-English summary, a data-confidence flag, and a timestamp.</li>
        <li>• The gaps stated loudly — factory-launched tokens are invisible here, and without launch-time baselines a strict &ldquo;survived / dumped / rugged&rdquo; outcome can&apos;t be computed.</li>
      </ul>
      <p className="text-[11px] text-text-muted mt-3">
        This tool never invents a track record. When something can&apos;t be measured it says so rather than guessing.
      </p>
    </div>
  );
}

function StateCard({
  tone,
  title,
  children,
}: {
  tone: 'warning' | 'danger' | 'muted';
  title: string;
  children: React.ReactNode;
}) {
  const color =
    tone === 'danger' ? 'var(--color-danger)' : tone === 'warning' ? 'var(--color-warning)' : 'var(--color-text-muted)';
  return (
    <div className="glass-card rounded-xl p-5" style={{ borderColor: color }}>
      <h2 className="text-[14px] font-semibold mb-1.5" style={{ color }}>
        {title}
      </h2>
      <div className="text-[12.5px] text-text-secondary">{children}</div>
    </div>
  );
}
