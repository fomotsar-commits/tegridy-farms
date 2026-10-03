// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../../lib/solanaPolyfill';
import { CopyButton } from '../ui/CopyButton';
import type { VenueStatus } from '../../lib/solana/cpswap/read';
import { SPENT_PROGRAM_ID, hasProgramId } from '../../lib/solana/cpswap/program';
import type { LpWriteMode } from '../../lib/launcher/solana/lpWriteFlag';

const CARD = { background: 'rgba(4,9,18,0.90)', border: '1px solid var(--color-purple-25)' } as const;

// What this site can do with the pools follows LP's own switch (lpWriteFlag.ts). Whether
// the public fee tier takes new pools is said only by the create card's live read.
const VENUE_LP_LINE: Record<LpWriteMode, string> = {
  off: 'This site only reads pools so far.',
  on: 'This site can add and remove liquidity, and open new pools on the public fee tier (the pools section below says whether it can right now).',
  'withdraw-only': 'This site can take liquidity out; adding liquidity and opening pools are paused.',
};

/**
 * The venue's real state, from the live read (useVenueStatus), on /pools and /solana-lp.
 * Each branch names what is missing: "not deployed" and "one instruction has not run"
 * are different facts. `feeSheetBelow`: the live card points at the fee sheet read from
 * its config, which only /pools has, so /solana-lp passes false.
 */
export function VenueStatusCard({ status, onRefresh, lpMode, feeSheetBelow = true }: {
  status: VenueStatus | null;
  onRefresh: () => void;
  lpMode: LpWriteMode;
  feeSheetBelow?: boolean;
}) {
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
          liquidity on chain. {VENUE_LP_LINE[lpMode]}
          {feeSheetBelow && ' Fees below are read from that config.'}
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
