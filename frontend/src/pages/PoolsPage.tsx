// Polyfill MUST load before any @solana/* import — same rule as SolanaProviders.
import '../lib/solanaPolyfill';
import { useCallback, useEffect, useState } from 'react';
import { m } from 'framer-motion';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { ArtImg } from '../components/ArtImg';
import { CopyButton } from '../components/ui/CopyButton';
import { ChainSwitch } from '../components/swap/ChainSwitch';
import { browserCurveRpc } from '../lib/launcher/solana/curve/rpc';
import { readVenue, type VenueStatus } from '../lib/solana/cpswap/read';
import { SPENT_PROGRAM_ID, hasProgramId } from '../lib/solana/cpswap/program';
import {
  RECOMMENDED_AMM_CONFIG,
  createAmmConfigArgs,
  feeSplit,
  solOf,
} from '../lib/solana/cpswap/venue';

/**
 * The venue's own Solana liquidity pools — what they charge, what an LP keeps,
 * and exactly what state the venue is in.
 *
 * WHY THIS PAGE IS SHAPED LIKE THIS. The operator asked to showcase that we can
 * host liquidity pools on Solana. We cannot, yet: the cp-swap fork was deployed
 * 2026-08-08 and CLOSED 2026-08-13, its program id is permanently spent, and no
 * AmmConfig was ever created. A page that said otherwise would be advertising a
 * venue that does not exist — the failure this repo has a documented history of
 * hunting down (a stale "pool is being built", a fixture rendered as real
 * sales).
 *
 * So this page states the venue's REAL status from a live chain probe, the same
 * way /curve-launch does, and shows the fee sheet as an explicit PROPOSAL until
 * an AmmConfig exists to read. The moment the operator redeploys and runs
 * `create_amm_config`, the probe flips and every number on the page starts
 * coming off the chain — with no code change and no copy edit.
 *
 * THE PROBE, NOT `getAccountInfo`: a closed upgradeable program's stub stays
 * executable-flagged, so the naive check reports a spent id as deployed.
 * `readVenue` goes through `readDeployment`, which follows the stub to its
 * ProgramData account.
 */
export default function PoolsPage() {
  usePageTitle(
    'Liquidity pools — Solana',
    'Provide liquidity on Tegridy’s own Solana AMM: what it charges, what LPs keep, and its live deployment status.',
  );
  useEffect(() => { trackPageView('pools'); }, []);

  const [status, setStatus] = useState<VenueStatus | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    readVenue(browserCurveRpc())
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => {
        if (!cancelled) setStatus({ kind: 'unreadable', detail: 'the RPC proxy did not answer' });
      });
    return () => { cancelled = true; };
  }, [reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  // The live config when the chain has one, the proposal otherwise. Same
  // `feeSplit` over both, so the disclosure cannot drift from the proposal.
  const liveConfig = status?.kind === 'live' ? status.config : null;
  const split = feeSplit(liveConfig ?? RECOMMENDED_AMM_CONFIG);

  return (
    <div className="relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="swap" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.72)' }} />
      </div>

      <div className="relative z-10 max-w-[900px] mx-auto px-4 md:px-6 pt-8 pb-16">
        <ChainSwitch active="solana" />

        <m.div className="mb-6" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <p className="text-white/70 text-[11px] uppercase tracking-[0.2em] mb-2">Tegridy AMM · Solana</p>
          <h1 className="heading-luxury text-3xl md:text-5xl text-white tracking-tight mb-3">
            Liquidity pools.
          </h1>
          <p className="text-white/85 text-[15px] max-w-xl leading-relaxed">
            Our own constant-product AMM on Solana — anyone can open a pool, anyone can
            provide liquidity, and the trade fee is split between the LPs who funded it
            and the venue. The swap surface quotes these pools alongside the aggregator
            and takes whichever is better for the trader.
          </p>
        </m.div>

        <VenueStatusCard status={status} onRefresh={refresh} />

        {/* ── The fee sheet ───────────────────────────────────────────────── */}
        <section className="rounded-2xl p-6 mt-6" style={CARD} aria-label="Fee sheet">
          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
            <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)' }}>
              {liveConfig ? 'Fees · read from the chain' : 'Fees · proposed, not yet on chain'}
            </p>
            {!liveConfig && (
              <span className="text-[10px] px-2 py-0.5 rounded-full"
                style={{ background: 'rgba(227,179,65,0.15)', border: '1px solid rgba(227,179,65,0.4)', color: '#e3b341' }}>
                PROPOSAL
              </span>
            )}
          </div>
          <h2 className="heading-luxury text-xl text-white mb-4">
            {split.traderPaysPct}% a trade — {split.lpKeepsPct.toFixed(2)}% of it to you
          </h2>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <Stat label="Trader pays" value={`${split.traderPaysPct}%`} sub="of each trade" />
            <Stat label="LPs keep" value={`${split.lpKeepsPct.toFixed(2)}%`} sub="of volume" tone="good" />
            <Stat label="Venue takes" value={`${split.venueTakesPct.toFixed(2)}%`} sub={`${split.venueShareOfFeePct}% of the fee`} />
            <Stat
              label="Open a pool"
              value={`${solOf(liveConfig?.createPoolFee ?? RECOMMENDED_AMM_CONFIG.createPoolFee)} SOL`}
              sub="one-off"
            />
          </div>

          <p className="text-white/70 text-[13px] leading-relaxed">
            {liveConfig ? (
              <>
                These are the live <code className="font-mono text-white/85">AmmConfig</code> rates,
                read from the chain on load — not a copy in this page. Retuning them on
                chain changes this card without a deploy.
              </>
            ) : (
              <>
                This matches Raydium&rsquo;s standard CPMM tier, which is the tier LPs and
                traders compare against — and it is already the config this repo&rsquo;s own
                migration rehearsal runs. It is a <strong>proposal</strong> until
                <code className="font-mono text-white/85"> create_amm_config</code> has run; nothing
                on chain charges it today.
              </>
            )}
          </p>
        </section>

        {/* ── How LPs earn ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
          <section className="rounded-2xl p-6" style={CARD}>
            <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>For liquidity providers</p>
            <h2 className="heading-luxury text-lg text-white mb-3">Deposit a pair, hold the LP token</h2>
            <ul className="text-white/80 text-[13px] leading-relaxed space-y-2 list-disc pl-4">
              <li>Deposit both sides of a pair and the pool mints you an <strong>LP token</strong> for your share.</li>
              <li>Every trade adds its fee to the reserves, so your share is worth more each time the pool trades. There is nothing to claim.</li>
              <li>Withdraw any time — burning the LP token returns your share of both sides. Pools have no lock.</li>
              <li className="text-white/60">
                Impermanent loss is real: a constant-product pool rebalances against you when
                the price moves, and fees are what compensate for it. This page will never
                quote you an APY it cannot read.
              </li>
            </ul>
          </section>

          <section className="rounded-2xl p-6" style={CARD}>
            <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>How the swap routes</p>
            <h2 className="heading-luxury text-lg text-white mb-3">Our pool, unless elsewhere is better</h2>
            <p className="text-white/80 text-[13px] leading-relaxed mb-3">
              Every quote on the Solana swap asks both our own pools and the aggregator, and
              takes the one that pays the trader more. A tie stays here; anything short of a
              tie does not. There is no tolerance band, and the surface prints which venue
              won and by how much.
            </p>
            <Link to="/solana" className="btn-secondary px-4 py-2 text-[12px] inline-block">
              Go to the Solana swap
            </Link>
          </section>
        </div>

        {/* ── The program ─────────────────────────────────────────────────── */}
        <section className="rounded-2xl p-6 mt-6" style={CARD}>
          <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>The program</p>
          <h2 className="heading-luxury text-lg text-white mb-3">Raydium&rsquo;s CPMM, unmodified</h2>
          <p className="text-white/80 text-[13px] leading-relaxed mb-3">
            The AMM is a verbatim fork of <strong>raydium-cp-swap</strong>. CI clones the pinned
            upstream commit, refuses any differing file outside two, and sha256-hashes the
            remaining delta against a pinned value — currently 86 lines across three files,
            all of it authority constants and comments. The curve, the swap, the deposit and
            withdraw paths and the fee maths are Raydium&rsquo;s, not ours, and the quotes on
            the swap page run that same maths client-side.
          </p>
          <p className="text-white/50 text-[12px] leading-relaxed">
            Pools cannot be enumerated from a browser — <code className="font-mono">getProgramAccounts</code> is
            deliberately off our RPC proxy&rsquo;s allowlist as an unbounded scan. Any list of
            pools here is a curated one, looked up pair by pair.
          </p>
        </section>
      </div>
    </div>
  );
}

const CARD = { background: 'rgba(4,9,18,0.78)', border: '1px solid var(--color-purple-25)' } as const;

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' }) {
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <p className="text-[10px] uppercase tracking-wider text-white/60">{label}</p>
      <p className="stat-value text-xl leading-tight" style={{ color: tone === 'good' ? '#4ade80' : '#ffffff' }}>{value}</p>
      {sub && <p className="text-[10px] text-white/50">{sub}</p>}
    </div>
  );
}

/**
 * The venue's real state, from a live probe. Every branch names precisely what
 * is missing — "come back later" and "one instruction has not run" are
 * different facts and a reader deserves to know which one they are looking at.
 */
function VenueStatusCard({ status, onRefresh }: { status: VenueStatus | null; onRefresh: () => void }) {
  const amber = { background: 'rgba(227,179,65,0.10)', border: '1px solid rgba(227,179,65,0.40)' };
  const green = { background: 'rgba(34,197,94,0.10)', border: '1px solid rgba(34,197,94,0.40)' };

  if (status === null) {
    return (
      <section className="rounded-2xl p-6" style={CARD}>
        <p className="text-white/70 text-[13px]">Reading the venue&rsquo;s status from the chain…</p>
      </section>
    );
  }

  if (status.kind === 'live') {
    return (
      <section className="rounded-2xl p-6" style={green} aria-label="Venue status">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
          <p className="text-[10px] uppercase tracking-wider" style={{ color: '#4ade80' }}>Venue · LIVE</p>
          <button type="button" onClick={onRefresh} className="text-white/50 hover:text-white text-[11px] underline underline-offset-2">Refresh</button>
        </div>
        <h2 className="heading-luxury text-xl text-white mb-2">Pools are open</h2>
        <p className="text-white/80 text-[13px] leading-relaxed mb-3">
          The AMM is deployed and its config exists, so anyone can open a pool and provide
          liquidity. Fees below are read from that config.
        </p>
        <div className="flex flex-wrap gap-3 text-[12px]">
          <Addr label="Program" value={status.programId} />
          <Addr label="Config" value={status.config.address} />
        </div>
      </section>
    );
  }

  const body = (() => {
    switch (status.kind) {
      case 'no-program-id':
        return {
          title: 'The AMM is being redeployed',
          lines: [
            'The venue’s AMM ran on mainnet from 2026-08-08 until it was closed on 2026-08-13. A closed upgradeable program id is permanently spent — Solana never lets one hold a program again — so the restart is a fresh keypair and a new program id, not a redeploy to the old address.',
            'Until that id exists there is nothing to point this page at, and it says so rather than rendering an empty market.',
          ],
          spent: true,
        };
      case 'program':
        return {
          title: status.deployment.kind === 'closed'
            ? 'That program id is closed'
            : status.deployment.kind === 'not-a-program'
              ? 'Something is at that address, but it is not a program'
              : 'No program at the configured id',
          lines: [
            status.deployment.kind === 'closed'
              ? 'Its bytecode account is gone, so nothing can run there and the id can never be reused. A configured id that reads as closed means the env var is pointing at a spent address.'
              : status.deployment.kind === 'not-a-program'
                ? `The account is owned by ${status.deployment.owner} and is not executable. A program id is a public address and anyone can send lamports to it.`
                : 'The configured program id has no account at all.',
          ],
          spent: false,
        };
      case 'no-config':
        return {
          title: 'Deployed — one instruction from open',
          lines: [
            'The AMM is on chain, but no AmmConfig has been created, so there is no fee tier for a pool to belong to and every pool creation would fail. This is the exact state that made graduation fail AmmNotConfigured (6015) for the whole life of the previous deployment.',
          ],
          spent: false,
          showArgs: true,
        };
      case 'unreadable':
        return {
          title: 'The chain could not be read',
          lines: [`That is an outage on our side, not a statement about the venue: ${status.detail}`],
          spent: false,
        };
    }
  })();

  return (
    <section className="rounded-2xl p-6" style={amber} aria-label="Venue status">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
        <p className="text-[10px] uppercase tracking-wider" style={{ color: '#e3b341' }}>Venue status · live chain read</p>
        <button type="button" onClick={onRefresh} className="text-white/50 hover:text-white text-[11px] underline underline-offset-2">Refresh</button>
      </div>
      <h2 className="heading-luxury text-xl text-white mb-2">{body.title}</h2>
      {body.lines.map((l) => (
        <p key={l.slice(0, 24)} className="text-white/80 text-[13px] leading-relaxed mb-2">{l}</p>
      ))}

      {body.spent && (
        <div className="mt-3 text-[12px]">
          <Addr label="Spent id" value={SPENT_PROGRAM_ID.toBase58()} />
        </div>
      )}

      {body.showArgs && (
        <div className="mt-3 rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <p className="text-[10px] uppercase tracking-wider mb-1.5 text-white/60">The missing instruction</p>
          <code className="block font-mono text-[12px] text-white/90 break-all">
            create_amm_config({createAmmConfigArgs().join(', ')})
          </code>
          <p className="text-white/45 text-[11px] mt-1.5">
            index, trade_fee_rate, protocol_fee_rate, fund_fee_rate, create_pool_fee, creator_fee_rate
          </p>
        </div>
      )}

      {!hasProgramId() && (
        <p className="text-white/45 text-[11px] mt-3">
          The page picks the new id up from <code className="font-mono">VITE_SOLANA_CPSWAP_PROGRAM</code> —
          no code change, no redeploy of this frontend.
        </p>
      )}
    </section>
  );
}

function Addr({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5"
      style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--color-kyle-40)' }}>
      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)' }}>{label}</span>
      <CopyButton text={value} display={`${value.slice(0, 4)}…${value.slice(-4)}`} className="font-mono text-[12px]" style={{ color: 'var(--color-kyle)' }} />
    </span>
  );
}
