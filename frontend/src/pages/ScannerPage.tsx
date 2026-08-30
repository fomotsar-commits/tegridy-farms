import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { useTokenScan } from '../hooks/useTokenScan';
import { detectChain } from '../lib/scanner';
import { ScanReport } from '../components/scanner/ScanReport';
import { TOWELI_ADDRESS } from '../lib/constants';
import { PageArtBackdrop } from '../components/PageArtBackdrop';

// PUBLIC TOKEN SCANNER — a free, shareable, standalone magnet tool.
//
// Paste any Ethereum (0x…) or Solana token address and get a holder-concentration
// + distribution read from the shared detection core. The URL carries the address
// (?token=…) so any read is a shareable link. Honest-framing brand rules apply:
// this is a DESCRIPTIVE MEASUREMENT with a disclosed method, components, exclusions,
// timestamp and correction path — never a fraud accusation — and it self-gates to an
// explicit unknown/unavailable state whenever real data is missing (never a fake number).

const CHAIN_LABEL: Record<string, string> = { ethereum: 'Ethereum', base: 'Base', solana: 'Solana' };

export default function ScannerPage() {
  usePageTitle(
    'Token Scanner',
    'Paste any Ethereum, Base or Solana token address for a holder-concentration and distribution read — a descriptive measurement with a disclosed method, exclusions, and timestamp.',
  );

  const [params, setParams] = useSearchParams();
  const committed = (params.get('token') ?? '').trim();
  // A 0x address is FORMAT-ambiguous between Ethereum and Base, so the chain
  // rides the shareable URL (?chain=base) and a toggle under the input;
  // omitted = Ethereum, the pre-Base behavior. Solana stays auto-detected.
  const committedChain = params.get('chain') === 'base' ? ('base' as const) : null;
  const [draft, setDraft] = useState(committed);
  const [draftEvmChain, setDraftEvmChain] = useState<'ethereum' | 'base'>(committedChain ?? 'ethereum');
  const [copiedLink, setCopiedLink] = useState(false);

  // Keep the input synced when the URL changes underneath us (shared link, Back/Forward).
  useEffect(() => {
    setDraft(committed);
    setDraftEvmChain(committedChain ?? 'ethereum');
  }, [committed, committedChain]);

  const draftDetect = detectChain(draft.trim());
  const scan = useTokenScan(committed, committedChain ?? undefined);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = draft.trim();
    const next = new URLSearchParams();
    if (v) next.set('token', v);
    if (v && detectChain(v).chain === 'ethereum' && draftEvmChain === 'base') next.set('chain', 'base');
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
    <>
      <PageArtBackdrop pageId="scanner" />
      <div className="relative z-10 max-w-[860px] mx-auto px-4 md:px-6 pt-8 pb-28 md:pb-16">
      {/* ── Intro ──────────────────────────────────────────────────── */}
      <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
        <h1 className="heading-luxury text-2xl md:text-4xl text-text-primary tracking-tight mb-2">Token Scanner</h1>
        <p className="text-[14px] text-text-secondary max-w-[640px]">
          Paste an Ethereum, Base or Solana token address for a holder-concentration and distribution read. It is a{' '}
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
            placeholder="0x… (Ethereum / Base) or a Solana mint address"
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
          {draft.trim() && draftDetect.valid && draftDetect.chain === 'ethereum' && (
            <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-success)' }}>
              0x address — scan on
              {(['ethereum', 'base'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={draftEvmChain === c}
                  onClick={() => setDraftEvmChain(c)}
                  className="rounded px-1.5 py-0.5 text-[11px] transition-colors"
                  style={
                    draftEvmChain === c
                      ? { background: 'rgba(76,175,80,0.2)', border: '1px solid var(--color-success)', color: 'var(--color-success)' }
                      : { background: 'transparent', border: '1px solid var(--color-border)', color: 'var(--color-text-muted, #9aa4b2)' }
                  }
                >
                  {CHAIN_LABEL[c]}
                </button>
              ))}
            </span>
          )}
          {draft.trim() && draftDetect.valid && draftDetect.chain !== 'ethereum' && (
            <span className="text-[11px]" style={{ color: 'var(--color-success)' }}>
              Detected: {CHAIN_LABEL[draftDetect.chain as string]}
            </span>
          )}
          {draft.trim() && !draftDetect.valid && (
            <span className="text-[11px]" style={{ color: 'var(--color-warning)' }}>
              Not a recognized Ethereum, Base or Solana address yet
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
            Solana token scans work today. Ethereum scans need the holder-data source configured on the server — the
            route may be deployed and simply missing its upstream API key (see the deployment notes). Until then this
            tab stays honest about the gap rather than showing invented numbers.
          </p>
        </StateCard>
      )}

      {scan.status === 'empty' && (
        <StateCard tone="muted" title="No holder data for this token">
          <p>{scan.errorMessage}</p>
          {/* Not an accusation of user error. This state is also what a real token
              with nothing left to enumerate looks like — a fully-burned Solana mint
              reads exactly this way, and so does a token whose holders all sit below
              the enumeration cut. On Ethereum, "you pasted a wallet" now has its own
              message (the 422 path), so this card no longer has to carry that guess
              as its headline explanation. */}
          <p className="mt-2 text-text-muted">
            Double-check the address is a token (not a wallet or an NFT) — or the token really has no holders left to
            enumerate, which is how a fully-burned supply reads.
          </p>
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
          {/* Next question after "who holds it": "who made it". We do NOT have the
              token's deployer here (the scan reads holders, not provenance), so this
              points at the tool rather than pre-filling an address we'd be guessing at.
              Ethereum-only — the deployer graph reads EVM contract-creations. */}
          {(scan.outcome.chain === 'ethereum' || scan.outcome.chain === 'base') && (
            <p className="text-[12px] text-text-muted mt-3 leading-relaxed">
              Launched on our curve? It has a home at{' '}
              <Link
                to={`/eth-curve/${scan.outcome.address}${scan.outcome.chain === 'base' ? '?c=8453' : ''}`}
                className="text-emerald-400/80 hover:text-emerald-300 underline transition-colors"
              >
                its token page
              </Link>{' '}
              (which answers honestly if it wasn&apos;t) — and the venue swap lives at{' '}
              <Link to="/swap" className="text-emerald-400/80 hover:text-emerald-300 underline transition-colors">
                /swap
              </Link>
              .
            </p>
          )}
          {scan.outcome.chain === 'solana' && (
            <p className="text-[12px] text-text-muted mt-3 leading-relaxed">
              Trade it without leaving the venue on the{' '}
              <Link to={`/solana?out=${scan.outcome.address}`} className="text-emerald-400/80 hover:text-emerald-300 underline transition-colors">
                Solana swap
              </Link>
              .
            </p>
          )}
          {scan.outcome.chain === 'ethereum' && (
            <p className="text-[12px] text-text-muted mt-4 leading-relaxed">
              Want to know who deployed it? Paste the deployer&apos;s wallet into the{' '}
              <Link to="/deployer" className="text-emerald-400/80 hover:text-emerald-300 underline transition-colors">
                Deployer Graph
              </Link>{' '}
              to see what else that address has shipped — or check your own holdings with{' '}
              <Link to="/exposure" className="text-emerald-400/80 hover:text-emerald-300 underline transition-colors">
                Wallet Exposure
              </Link>
              .
            </p>
          )}
        </>
      )}
      </div>
    </>
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
