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
  feeSplit,
  solOf,
} from '../lib/solana/cpswap/venue';

/**
 * The venue's own Solana liquidity pools — what they charge, what an LP keeps,
 * and exactly what state the venue is in.
 *
 * Every fee and every capability claim here hangs off `readVenue`, never a constant:
 * a pending or failed read shows no fee at all. `readVenue` follows a closed program's
 * stub to its ProgramData, because `getAccountInfo` alone reports a spent id as deployed.
 */
export default function PoolsPage() {
  usePageTitle(
    'Solana liquidity pools',
    'Provide liquidity on the venue’s own Solana AMM: what it charges, what LPs keep, and its live deployment status.',
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
  // After a failed read, show "reading" again so a second failure is visibly a new answer.
  const retry = useCallback(() => { setStatus(null); setReloadKey((k) => k + 1); }, []);

  // Fees come only from a config the chain returned. With none, the sheet shows no number.
  const liveConfig = status?.kind === 'live' ? status.config : null;
  const split = liveConfig ? feeSplit(liveConfig) : null;

  // Every capability claim on this page hangs off the live probe. A spent program
  // id must never be described in the present tense, and "still reading" is not a
  // licence to assert either — so the conditional copy is the default and the
  // present-tense copy is what the probe has to earn.
  const venueIsOpen = liveConfig !== null;

  return (
    <div className="relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="swap" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.86)' }} />
      </div>

      <div className="relative z-10 max-w-[900px] mx-auto px-4 md:px-6 pt-8 pb-16">
        <ChainSwitch />

        <m.div className="mb-6" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <p className="text-white/70 text-[11px] uppercase tracking-[0.2em] mb-2">Venue AMM · Solana</p>
          <h1 className="heading-luxury text-3xl md:text-5xl text-white tracking-tight mb-3">
            Liquidity pools.
          </h1>
          <p className="text-white/85 text-[15px] max-w-xl leading-relaxed">
            {venueIsOpen ? (
              <>
                Our own constant-product AMM on Solana — anyone can open a pool, anyone can
                provide liquidity, and the trade fee is split between the LPs who funded it
                and the venue. The swap surface quotes these pools alongside the aggregator
                and takes whichever is better for the trader.
              </>
            ) : (
              <>
                Our own constant-product AMM on Solana. No pool can be opened here yet. This
                page shows a fee only after reading it from the chain, and the card below says
                what the latest read found.
              </>
            )}
          </p>
        </m.div>

        <VenueStatusCard status={status} onRefresh={refresh} />

        {/* ── The fee sheet ───────────────────────────────────────────────── */}
        <section className="rounded-2xl p-6 mt-6" style={CARD} aria-label="Fee sheet">
          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
            <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)' }}>
              {liveConfig ? 'Fees · read from the chain' : 'Fees · not read'}
            </p>
          </div>
          <h2 className="heading-luxury text-xl text-white mb-4">
            {split
              ? `${split.traderPaysPct}% a trade, ${split.lpKeepsPct.toFixed(2)}% of it to you`
              : feesNotRead(status).title}
          </h2>

          {liveConfig && split && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <Stat label="Trader pays" value={`${split.traderPaysPct}%`} sub="of each trade" />
              <Stat label="LPs keep" value={`${split.lpKeepsPct.toFixed(2)}%`} sub="of volume" tone="good" />
              <Stat label="Venue takes" value={`${split.venueTakesPct.toFixed(2)}%`} sub={`${split.venueShareOfFeePct}% of the fee`} />
              <Stat
                label="Open a pool"
                value={`${solOf(liveConfig.createPoolFee)} SOL`}
                sub="one-off"
              />
            </div>
          )}

          <p className="text-white/70 text-[13px] leading-relaxed">
            {liveConfig ? (
              <>
                These are the live <code className="font-mono text-white/85">AmmConfig</code> rates,
                read from the chain on load — not a copy in this page. Retuning them on
                chain changes this card without a deploy.
              </>
            ) : (
              feesNotRead(status).line
            )}
          </p>
          {status?.kind === 'unreadable' && (
            <button type="button" onClick={retry} className="btn-secondary px-4 py-2 text-[12px] mt-3">
              Try again
            </button>
          )}
        </section>

        {/* ── How LPs earn ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
          <section className="rounded-2xl p-6" style={CARD}>
            <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>For liquidity providers</p>
            <h2 className="heading-luxury text-lg text-white mb-3">
              {venueIsOpen ? 'Deposit a pair, hold the LP token' : 'How it works: deposit a pair, hold the LP token'}
            </h2>
            {!venueIsOpen && (
              <p className="text-white/60 text-[12px] leading-relaxed mb-3">
                Depositing from this page waits on a live read of the venue. The status card
                above says what the latest read found.
              </p>
            )}
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

const CARD = { background: 'rgba(4,9,18,0.90)', border: '1px solid var(--color-purple-25)' } as const;

/** The fee sheet with no config read: still reading, a failed read, or nothing to read. */
function feesNotRead(status: VenueStatus | null): { title: string; line: string } {
  if (status === null) {
    return { title: 'Reading the fee tiers from the chain…', line: 'No fee is shown until the chain answers.' };
  }
  if (status.kind === 'unreadable') {
    return {
      title: 'The fee tiers could not be read just now',
      line: 'The chain did not answer, so this page shows no fee rather than a guess.',
    };
  }
  return {
    title: 'No fee tier was read',
    line: 'This page shows a fee only from a tier it read on chain. The card above says why there is none to read.',
  };
}

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
  const amber = { background: 'rgba(28,21,6,0.92)', border: '1px solid rgba(227,179,65,0.45)' };
  const green = { background: 'rgba(6,24,14,0.92)', border: '1px solid rgba(34,197,94,0.45)' };

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
          title: 'This page has no program id to read',
          lines: [
            'This build of the site was not given the AMM’s program id, so it has no program to read and shows no fees or pools. That says nothing about what is on chain.',
            'The id the venue ran on until 2026-08-13 is closed and permanently spent, and this page never reads it.',
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
          title: 'Deployed, one instruction from open',
          lines: [
            'The AMM is on chain, but its fee tier (AmmConfig index 0) has not been created, so there is no tier for a pool to belong to and every pool creation would fail. The missing instruction is create_amm_config, which only the program’s admin can run.',
          ],
          spent: false,
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

      {!hasProgramId() && (
        <p className="text-white/45 text-[11px] mt-3">
          This site takes the id from <code className="font-mono">VITE_SOLANA_CPSWAP_PROGRAM</code> when
          it is built.
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
