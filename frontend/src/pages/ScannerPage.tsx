import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { useTokenScan } from '../hooks/useTokenScan';
import { detectChain } from '../lib/scanner';
import { ScanReport } from '../components/scanner/ScanReport';
import { TOWELI_ADDRESS } from '../lib/constants';

// PUBLIC TOKEN SCANNER — a free, shareable, standalone magnet tool.
//
// Paste any Ethereum (0x…) or Solana token address and get a holder-concentration
// + distribution read from the shared detection core. The URL carries the address
// (?token=…) so any read is a shareable link. Honest-framing brand rules apply:
// this is a DESCRIPTIVE MEASUREMENT with a disclosed method, components, exclusions,
// timestamp and correction path — never a fraud accusation — and it self-gates to an
// explicit unknown/unavailable state whenever real data is missing (never a fake number).

const CHAIN_LABEL: Record<string, string> = { ethereum: 'Ethereum', solana: 'Solana' };

export default function ScannerPage() {
  usePageTitle(
    'Token Scanner',
    'Paste any Ethereum or Solana token address for a holder-concentration and distribution read — a descriptive measurement with a disclosed method, exclusions, and timestamp.',
  );

  const [params, setParams] = useSearchParams();
  const committed = (params.get('token') ?? '').trim();
  const [draft, setDraft] = useState(committed);
  const [copiedLink, setCopiedLink] = useState(false);

  // Keep the input synced when the URL changes underneath us (shared link, Back/Forward).
  useEffect(() => {
    setDraft(committed);
  }, [committed]);

  const draftDetect = detectChain(draft.trim());
  const scan = useTokenScan(committed);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = draft.trim();
    const next = new URLSearchParams();
    if (v) next.set('token', v);
    setParams(next);
  }

  function loadExample() {
    setDraft(TOWELI_ADDRESS);
    const next = new URLSearchParams();
    next.set('token', TOWELI_ADDRESS);
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
    <div className="max-w-[860px] mx-auto px-4 md:px-6 pt-8 pb-28 md:pb-16">
      {/* ── Intro ──────────────────────────────────────────────────── */}
      <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
        <h1 className="heading-luxury text-2xl md:text-4xl text-text-primary tracking-tight mb-2">Token Scanner</h1>
        <p className="text-[14px] text-text-secondary max-w-[640px]">
          Paste an Ethereum or Solana token address for a holder-concentration and distribution read. It is a{' '}
          <span className="text-text-primary font-medium">descriptive measurement</span> — a disclosed method with its
          components, the addresses it excluded, and a timestamp — not a verdict on anyone&apos;s intent.
        </p>
      </m.div>

      {/* ── Address form ───────────────────────────────────────────── */}
      <form onSubmit={submit} className="glass-card rounded-xl p-4 mb-4">
        <label htmlFor="scan-address" className="block text-[11px] uppercase tracking-wider text-text-muted mb-2">
          Token address
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            id="scan-address"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="0x… (Ethereum) or a Solana mint address"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 rounded-lg px-3 py-2.5 text-[13px] font-mono text-text-primary outline-none"
            style={{ background: 'var(--color-bg-input)', border: '1px solid var(--color-border)' }}
          />
          <button
            type="submit"
            disabled={!draft.trim() || !draftDetect.valid}
            className="btn-primary text-[14px] px-6 py-2.5 whitespace-nowrap"
          >
            Scan
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 min-h-[18px]">
          {draft.trim() && draftDetect.valid && (
            <span className="text-[11px]" style={{ color: 'var(--color-success)' }}>
              Detected: {CHAIN_LABEL[draftDetect.chain as string]}
            </span>
          )}
          {draft.trim() && !draftDetect.valid && (
            <span className="text-[11px]" style={{ color: 'var(--color-warning)' }}>
              Not a recognized Ethereum or Solana address yet
            </span>
          )}
          <button type="button" onClick={loadExample} className="text-[11px] text-text-muted underline underline-offset-2 hover:text-text-secondary">
            Try our token (TOWELI)
          </button>
        </div>
      </form>

      {/* ── Result area ────────────────────────────────────────────── */}
      {scan.status === 'idle' && <IdleHint />}

      {scan.status === 'invalid' && (
        <StateCard tone="warning" title="That address isn't valid">
          {scan.errorMessage}
        </StateCard>
      )}

      {scan.status === 'loading' && (
        <div className="glass-card rounded-xl p-6 text-center">
          <p className="text-[13px] text-text-secondary animate-pulse">
            Reading {scan.chain ? CHAIN_LABEL[scan.chain] : ''} holders and computing distribution…
          </p>
        </div>
      )}

      {scan.status === 'unavailable' && (
        <StateCard tone="muted" title="Not enabled on this deployment yet">
          <p>{scan.errorMessage}</p>
          <p className="mt-2 text-text-muted">
            Solana token scans work today. Ethereum scans need the holder-data route configured on the server (see the
            deployment notes) — until then this tab stays honest about the gap rather than showing invented numbers.
          </p>
        </StateCard>
      )}

      {scan.status === 'empty' && (
        <StateCard tone="muted" title="No holder data for this token">
          <p>{scan.errorMessage}</p>
          <p className="mt-2 text-text-muted">Double-check the address is a token (not a wallet or an NFT), then try again.</p>
        </StateCard>
      )}

      {scan.status === 'error' && (
        <StateCard tone="danger" title="Couldn't complete the scan">
          <p>{scan.errorMessage}</p>
          <button onClick={scan.reload} className="btn-secondary text-[12px] px-3 py-1.5 mt-3" type="button">
            Try again
          </button>
        </StateCard>
      )}

      {scan.status === 'success' && scan.outcome && (
        <>
          <div className="flex items-center justify-between gap-2 mb-3">
            <span className="badge badge-primary text-[10px]">{CHAIN_LABEL[scan.outcome.chain]}</span>
            <button onClick={copyLink} className="btn-secondary text-[12px] px-3 py-1.5" type="button">
              {copiedLink ? 'Link copied' : 'Copy share link'}
            </button>
          </div>
          <ScanReport outcome={scan.outcome} />
        </>
      )}
    </div>
  );
}

function IdleHint() {
  return (
    <div className="glass-card rounded-xl p-5">
      <h2 className="text-[14px] font-semibold text-text-primary mb-2">What you'll get</h2>
      <ul className="space-y-1.5 text-[12.5px] text-text-secondary">
        <li>• A plain-English effective-holder count (how many equally-sized holders this concentration is worth).</li>
        <li>• Top-holder shares, HHI, and a Nakamoto coefficient — with burns, contracts and program accounts excluded; large unlabeled wallets lower the confidence flag.</li>
        <li>• A three-band read (Well distributed / Mixed / Concentrated) plus a separate data-confidence flag.</li>
        <li>• Every exclusion shown, a timestamp, the method, and a way to dispute a label.</li>
      </ul>
      <p className="text-[11px] text-text-muted mt-3">
        This tool never invents data. When a signal isn't measurable it says &ldquo;not measured&rdquo; rather than guessing.
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
