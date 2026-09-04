import { useState } from 'react';
import {
  FOLLOW_REJECTION_TEXT,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  type FollowConfig,
  type FollowValidation,
} from '../../lib/copytrade/follows';
import {
  formatQuoteAmount,
  parseQuoteAmount,
  quoteTokensForFamily,
} from '../../lib/copytrade/quoteTokens';
import type { PoolFamily } from '../../lib/copytrade/tape';
import { MIRROR_EXECUTION } from '../../lib/copytrade/mirror';
import { shortenAddress } from '../../lib/formatting';

// Adding a follow, and stating what a follow is not.
//
// The two controls here are the whole safety story of the feature — a per-trade
// cap and a slippage bound — so neither is allowed to be optional and neither is
// allowed to be silently corrected. An unparseable cap is REFUSED with its
// reason rather than rounded into something plausible: a cap this component
// invented is a trade size the user did not choose.
//
// `MIRROR_EXECUTION` is rendered above the button rather than in a footnote.
// "Follow" is a word that implies an automaton, and the honest correction has to
// arrive before the click, not after it.
//
// ─── THE VENUE IS A CONTROL, NOT AN INFERENCE ────────────────────────────────
//
// The island spans Ethereum, Base and Solana, and the quote token list is
// per-chain: WETH on Ethereum and WETH on Base are different contracts. The venue
// is chosen explicitly and the token list follows it, so a cap can never be
// entered against a chain the address does not live on — the failure that would
// otherwise sit in the list looking like a working follow and never match a fill.

export interface FollowFormProps {
  follows: readonly FollowConfig[];
  account?: string | null;
  /**
   * Controlled by the page so the board's "Use address" action can fill it. The
   * cap and the guard stay local: an address can be suggested, a trade size
   * cannot.
   */
  leader: string;
  onLeaderChange: (value: string) => void;
  /** Also controlled, so "Use address" can pick the row's own chain family. */
  venue: PoolFamily;
  onVenueChange: (venue: PoolFamily) => void;
  onAdd: (input: {
    venue: PoolFamily;
    leader: string;
    quoteToken: string;
    maxNotionalWei: bigint;
    slippageBps: number;
  }) => FollowValidation;
  onRemove: (leader: string, quoteToken: string) => void;
  persistError: string | null;
}

const DEFAULT_SLIPPAGE_BPS = 100;

const VENUE_LABEL: Record<PoolFamily, string> = {
  evm: 'Ethereum / Base (0x address)',
  solana: 'Solana (base58 address)',
};

export function FollowForm({
  follows,
  account,
  leader,
  onLeaderChange,
  venue,
  onVenueChange,
  onAdd,
  onRemove,
  persistError,
}: FollowFormProps) {
  const options = quoteTokensForFamily(venue);
  const fallback = options[0];
  const [quoteToken, setQuoteToken] = useState<string | null>(null);
  const [cap, setCap] = useState('');
  const [slippage, setSlippage] = useState(String(DEFAULT_SLIPPAGE_BPS));
  const [error, setError] = useState<string | null>(null);

  // The selected token has to belong to the selected venue. Rather than syncing
  // two pieces of state in an effect, the selection is DERIVED: a token that is
  // not on this venue's list falls back to the venue's first, so switching venue
  // can never leave a Solana cap attached to an Ethereum follow.
  const selected = options.some((t) => t.address === quoteToken) && quoteToken !== null
    ? quoteToken
    : (fallback ? fallback.address : '');

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const maxNotionalWei = parseQuoteAmount(cap, selected);
    if (maxNotionalWei === null) {
      setError(
        'The per-trade cap must be a plain decimal amount with no more places than the token has. Nothing was saved.',
      );
      return;
    }
    const slippageBps = Number(slippage);
    const result = onAdd({ venue, leader: leader.trim(), quoteToken: selected, maxNotionalWei, slippageBps });
    if (!result.ok) {
      setError(FOLLOW_REJECTION_TEXT[result.reason]);
      return;
    }
    onLeaderChange('');
    setCap('');
  }

  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
      <h2 className="text-sm font-semibold text-white">Follow an address</h2>
      <p className="mt-1.5 text-xs leading-relaxed text-white/70">{MIRROR_EXECUTION}</p>

      <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        <div>
          <label htmlFor="copy-venue" className="block text-[11px] font-medium uppercase tracking-wide text-white/60">
            Venue
          </label>
          <select
            id="copy-venue"
            value={venue}
            onChange={(e) => onVenueChange(e.target.value === 'solana' ? 'solana' : 'evm')}
            className="mt-1 min-h-11 w-full rounded-md border border-white/20 bg-black/40 px-2.5 py-1.5 text-xs text-white"
          >
            <option value="evm">{VENUE_LABEL.evm}</option>
            <option value="solana">{VENUE_LABEL.solana}</option>
          </select>
        </div>

        <div>
          <label htmlFor="copy-leader" className="block text-[11px] font-medium uppercase tracking-wide text-white/60">
            Address to follow
          </label>
          <input
            id="copy-leader"
            value={leader}
            onChange={(e) => onLeaderChange(e.target.value)}
            placeholder={venue === 'solana' ? 'base58 address…' : '0x…'}
            spellCheck={false}
            className="mt-1 min-h-11 w-full rounded-md border border-white/20 bg-black/40 px-2.5 py-1.5 font-mono text-xs text-white"
          />
          <p className="mt-1 text-[10px] leading-snug text-white/55">
            Addresses on the board are the ones that SENT each transaction. A bot or a relayer
            appears under its own address, so following one follows the sender, not a person.
          </p>
        </div>

        <div>
          <label htmlFor="copy-quote" className="block text-[11px] font-medium uppercase tracking-wide text-white/60">
            Quote token
          </label>
          <select
            id="copy-quote"
            value={selected}
            onChange={(e) => setQuoteToken(e.target.value)}
            className="mt-1 min-h-11 w-full rounded-md border border-white/20 bg-black/40 px-2.5 py-1.5 text-xs text-white"
          >
            {options.map((token) => (
              <option key={token.address} value={token.address}>
                {token.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[10px] leading-snug text-white/55">
            Only fills that SPEND this token in a pool quoted in it are sized. A fill on another
            chain, or against another quote asset, is shown and refused rather than converted —
            there is no price here to convert with.
          </p>
        </div>

        <div>
          <label htmlFor="copy-cap" className="block text-[11px] font-medium uppercase tracking-wide text-white/60">
            Per-trade cap
          </label>
          <input
            id="copy-cap"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            inputMode="decimal"
            placeholder="0.05"
            className="mt-1 min-h-11 w-full rounded-md border border-white/20 bg-black/40 px-2.5 py-1.5 text-xs text-white"
          />
          <p className="mt-1 text-[10px] leading-snug text-white/55">
            A mirror is sized at the smaller of the leader's amount and this. It never scales up to
            match them.
          </p>
        </div>

        <div>
          <label htmlFor="copy-slippage" className="block text-[11px] font-medium uppercase tracking-wide text-white/60">
            Slippage guard (bps)
          </label>
          <input
            id="copy-slippage"
            value={slippage}
            onChange={(e) => setSlippage(e.target.value)}
            inputMode="numeric"
            className="mt-1 min-h-11 w-full rounded-md border border-white/20 bg-black/40 px-2.5 py-1.5 text-xs text-white"
          />
          <p className="mt-1 text-[10px] leading-snug text-white/55">
            {MIN_SLIPPAGE_BPS}–{MAX_SLIPPAGE_BPS} bps. Applied to a live quote when you confirm, not
            to the leader's old fill.
          </p>
        </div>

        <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary min-h-11 px-4 py-2 text-[13px]">
            Save follow
          </button>
          {account ? null : (
            <span className="text-[11px] text-white/60">
              No wallet is connected. A follow can still be saved — it is a local note, not an
              approval.
            </span>
          )}
        </div>
      </form>

      {error ? (
        <p className="mt-3 text-[11px] text-amber-200" role="alert">
          {error}
        </p>
      ) : null}
      {persistError ? <p className="mt-2 text-[11px] text-amber-200">{persistError}</p> : null}

      <h3 className="mt-5 text-[11px] font-medium uppercase tracking-wide text-white/60">
        Followed addresses ({follows.length})
      </h3>
      {follows.length === 0 ? (
        <p className="mt-2 text-xs text-white/70">
          Nothing is followed yet. This list lives in this browser only — it is never sent anywhere,
          and it grants no permission over your wallet.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {follows.map((follow) => (
            <li
              key={`${follow.leader}:${follow.quoteToken}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="font-mono text-xs text-white">{shortenAddress(follow.leader, 6)}</p>
                <p className="text-[10px] text-white/60">
                  Cap {formatQuoteAmount(follow.maxNotionalWei, follow.quoteToken)} · {follow.slippageBps} bps
                </p>
              </div>
              <button
                type="button"
                onClick={() => onRemove(follow.leader, follow.quoteToken)}
                className="min-h-11 min-w-11 rounded-md border border-white/25 px-3 py-1 text-[11px] font-medium text-white hover:bg-white/10"
              >
                Unfollow
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
