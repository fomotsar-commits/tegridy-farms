import { useState } from 'react';
import {
  FOLLOW_REJECTION_TEXT,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  type FollowConfig,
  type FollowValidation,
} from '../../lib/copytrade/follows';
import { DEFAULT_QUOTE_TOKEN, QUOTE_TOKENS, formatQuoteAmount, parseQuoteAmount } from '../../lib/copytrade/quoteTokens';
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
  onAdd: (input: {
    leader: string;
    quoteToken: string;
    maxNotionalWei: bigint;
    slippageBps: number;
  }) => FollowValidation;
  onRemove: (leader: string, quoteToken: string) => void;
  persistError: string | null;
}

const DEFAULT_SLIPPAGE_BPS = 100;

export function FollowForm({
  follows,
  account,
  leader,
  onLeaderChange,
  onAdd,
  onRemove,
  persistError,
}: FollowFormProps) {
  const [quoteToken, setQuoteToken] = useState(DEFAULT_QUOTE_TOKEN.address);
  const [cap, setCap] = useState('');
  const [slippage, setSlippage] = useState(String(DEFAULT_SLIPPAGE_BPS));
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const maxNotionalWei = parseQuoteAmount(cap, quoteToken);
    if (maxNotionalWei === null) {
      setError(
        'The per-trade cap must be a plain decimal amount with no more places than the token has. Nothing was saved.',
      );
      return;
    }
    const slippageBps = Number(slippage);
    const result = onAdd({ leader: leader.trim(), quoteToken, maxNotionalWei, slippageBps });
    if (!result.ok) {
      setError(FOLLOW_REJECTION_TEXT[result.reason]);
      return;
    }
    onLeaderChange('');
    setCap('');
  }

  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
      <h2 className="text-sm font-semibold text-white">Follow a wallet</h2>
      <p className="mt-1.5 text-xs leading-relaxed text-white/70">{MIRROR_EXECUTION}</p>

      <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        <div className="sm:col-span-2">
          <label htmlFor="copy-leader" className="block text-[11px] font-medium uppercase tracking-wide text-white/60">
            Leader address
          </label>
          <input
            id="copy-leader"
            value={leader}
            onChange={(e) => onLeaderChange(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
            className="mt-1 w-full rounded-md border border-white/20 bg-black/40 px-2.5 py-1.5 font-mono text-xs text-white"
          />
        </div>

        <div>
          <label htmlFor="copy-quote" className="block text-[11px] font-medium uppercase tracking-wide text-white/60">
            Quote token
          </label>
          <select
            id="copy-quote"
            value={quoteToken}
            onChange={(e) => setQuoteToken(e.target.value)}
            className="mt-1 w-full rounded-md border border-white/20 bg-black/40 px-2.5 py-1.5 text-xs text-white"
          >
            {QUOTE_TOKENS.map((token) => (
              <option key={token.address} value={token.address}>
                {token.symbol}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[10px] leading-snug text-white/55">
            Only trades that SPEND this token are mirrored. A leader selling into something else is
            shown and refused rather than converted — the indexer stores no price to convert with.
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
            className="mt-1 w-full rounded-md border border-white/20 bg-black/40 px-2.5 py-1.5 text-xs text-white"
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
            className="mt-1 w-full rounded-md border border-white/20 bg-black/40 px-2.5 py-1.5 text-xs text-white"
          />
          <p className="mt-1 text-[10px] leading-snug text-white/55">
            {MIN_SLIPPAGE_BPS}–{MAX_SLIPPAGE_BPS} bps. Applied to a live quote when you confirm, not
            to the leader's old fill.
          </p>
        </div>

        <div className="sm:col-span-2 flex items-center gap-3">
          <button type="submit" className="btn-primary px-4 py-2 text-[13px]">
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
        Followed wallets ({follows.length})
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
                className="rounded-md border border-white/25 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-white/10"
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
