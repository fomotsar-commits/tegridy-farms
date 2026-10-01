import { useCallback, useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { parseMintInput } from '../../../lib/solana/lp/mintInput';
import { assessPool } from '../../../lib/solana/lp/poolHealth';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import type { PoolSearchRead } from '../../../lib/solana/lp/poolFinder';
import type { OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { Card, Field, Notice } from '../curve/ui';
import { inputCls, inputStyle } from '../curve/uiFormat';
import { TokenSafetyCard } from './TokenSafetyCard';
import { PoolCard, UnreadPoolCard } from './PoolCard';
import type { LpReaders } from './readers';

type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; mint: string }
  /** `refreshing`: the last answer for this same mint, shown while it is read again. */
  | { status: 'done'; mint: string; safety: TokenSafety; pools: PoolSearchRead; outside: OutsidePrice | null; refreshing?: boolean };

type Done = Extract<SearchState, { status: 'done' }>;

/**
 * The search for `mint`. Results are stored with the question they answer (mint, nonce
 * and the section's reload key), so a late answer to an old question is never shown. A
 * re-read of the SAME mint keeps showing the last answer until the new one arrives, so
 * the cards and an open panel (with its outcome on screen) never unmount; only a
 * different mint reads as loading.
 */
function usePoolSearch(readers: LpReaders, mint: string | null, nonce: number, reloadKey: number): SearchState {
  const key = mint ? `${mint}#${nonce}#${reloadKey}` : null;
  const [answer, setAnswer] = useState<{ key: string; value: Done } | null>(null);
  useEffect(() => {
    if (!mint || !key) return;
    let live = true;
    const finish = (value: Done) => {
      if (live) setAnswer({ key, value });
    };
    (async () => {
      const [safetyMap, pools] = await Promise.all([readers.safety([mint]), readers.findPools(new PublicKey(mint))]);
      const safety: TokenSafety = safetyMap.get(mint) ?? { kind: 'unread', mint, detail: 'no answer for this token' };
      // The outside price only matters when there is a pool to compare and a token we
      // could read; it costs two Jupiter calls, so it is not asked for otherwise.
      const hasPool = pools.kind === 'ok' && pools.search.pools.some((p) => p.kind === 'pool');
      const decimals = safety.kind === 'read' ? safety.facts?.decimals ?? null : null;
      const outside = hasPool && decimals !== null && safety.kind === 'read' && safety.verdict !== 'blocked' ? await readers.outsidePrice(mint, decimals) : null;
      finish({ status: 'done', mint, safety, pools, outside });
    })().catch((e: unknown) => {
      const detail = e instanceof Error ? e.message : String(e);
      finish({ status: 'done', mint, safety: { kind: 'unread', mint, detail }, pools: { kind: 'unread', detail, index: { kind: 'unread', detail } }, outside: null });
    });
    return () => {
      live = false;
    };
  }, [readers, mint, key]);
  if (!mint || !key) return { status: 'idle' };
  if (answer?.key === key) return answer.value;
  return answer?.value.mint === mint ? { ...answer.value, refreshing: true } : { status: 'loading', mint };
}

/**
 * `linkError`: a `?mint=` that did not parse. Its text is put back in the field with the
 * reason, rather than the field quietly coming up empty.
 */
export function PoolFinder({
  readers,
  mint,
  onMint,
  linkError = null,
  reloadKey = 0,
}: {
  readers: LpReaders;
  mint: string | null;
  onMint: (m: string | null) => void;
  linkError?: { raw: string; reason: string } | null;
  /** Bumped by the section after a liquidity flow finishes: read the same mint again. */
  reloadKey?: number;
}) {
  const [input, setInput] = useState(mint ?? linkError?.raw ?? '');
  const [error, setError] = useState<string | null>(linkError?.reason ?? null);
  const [nonce, setNonce] = useState(0);
  const state = usePoolSearch(readers, mint, nonce, reloadKey);
  // A new ?mint= (a link, or back/forward) fills the field: adjusted during render, the
  // React way to follow a prop, rather than in an effect.
  const linkKey = mint ?? (linkError ? `bad:${linkError.raw}` : null);
  const [shownLink, setShownLink] = useState(linkKey);
  if (linkKey !== shownLink) {
    setShownLink(linkKey);
    if (mint) {
      setInput(mint);
      setError(null);
    } else if (linkError) {
      setInput(linkError.raw);
      setError(linkError.reason);
    }
  }

  const submit = useCallback(() => {
    const p = parseMintInput(input);
    if (!p.ok) {
      setError(p.reason);
      return;
    }
    setError(null);
    if (p.mint === mint) setNonce((n) => n + 1);
    else onMint(p.mint);
  }, [input, mint, onMint]);

  return (
    <section data-testid="lp-finder" aria-label="Find pools for a token" className="space-y-4">
      <Card title="Find pools for a token">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label="Token mint address" hint="The token’s address, not its name: anyone can copy a name." error={error}>
            {(a11y) => (
              <input
                {...a11y}
                className={`${inputCls} font-mono`}
                style={inputStyle}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary min-h-[44px] px-4 text-[13px]">
              Find pools
            </button>
            {state.status === 'done' && (
              <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" onClick={() => setNonce((n) => n + 1)}>
                Read again
              </button>
            )}
          </div>
        </form>
      </Card>

      <p role="status" aria-live="polite" className="sr-only" data-testid="lp-status">
        {state.status === 'loading' ? 'Reading the token and its pools.' : state.status === 'done' ? announce(state) : ''}
      </p>

      {state.status === 'loading' && <p className="text-white/70 text-[13px]">Reading the token and its pools from the chain…</p>}
      {state.status === 'done' && state.refreshing && <p className="text-white/55 text-[12px]">Reading the token and its pools again…</p>}
      {state.status === 'done' && <SearchResults state={state} />}
    </section>
  );
}

const count = (n: number, one: string, many: string) => (n === 1 ? `One ${one}` : `${n} ${many}`);

function announce(s: Extract<SearchState, { status: 'done' }>): string {
  if (s.pools.kind === 'unread') return 'The pools could not be read.';
  const { pools, index } = s.pools.search;
  const read = pools.filter((p) => p.kind === 'pool').length;
  const unread = pools.length - read;
  const parts = [`${read === 0 ? 'No pools' : count(read, 'pool', 'pools')} found for this token.`];
  if (unread) parts.push(`${count(unread, 'more pool', 'more pools')} could not be read.`);
  if (index.kind === 'unread') parts.push('Our pool index could not be read, so there may be other pools.');
  else if (index.truncated) parts.push('Our pool index returned its maximum, so there may be more pools.');
  if (s.safety.kind !== 'read') parts.push('The token could not be read.');
  else if (s.safety.verdict === 'blocked') parts.push('This token is blocked on this site.');
  return parts.join(' ');
}

function SearchResults({ state }: { state: Extract<SearchState, { status: 'done' }> }) {
  const { safety, pools, outside, mint } = state;
  const decimals = safety.kind === 'read' ? safety.facts?.decimals ?? null : null;
  return (
    <div className="space-y-4">
      <TokenSafetyCard mint={mint} safety={safety} />
      {pools.kind === 'unread' ? (
        <Card title="Pools">
          <Notice tone="warn">
            We could not read the pools ({pools.detail}). That is a problem on our side; it does not mean there are none.
          </Notice>
        </Card>
      ) : (
        <div data-testid="lp-pools" className="space-y-3">
          <IndexNote read={pools} />
          {pools.search.pools.length === 0 ? (
            <Card title="Pools">
              <p data-testid="lp-no-pools">
                {pools.search.index.kind !== 'ok'
                  ? 'No TOKEN/SOL pools found at the addresses we could check.'
                  : pools.search.index.truncated
                    ? 'None of the pools our index returned is a TOKEN/SOL pool we can show. It returned its maximum, so there may be more.'
                    : 'No TOKEN/SOL pools found for this token.'}
              </p>
              {pools.search.otherPairs > 0 && (
                <Notice>{pools.search.otherPairs} pool(s) pair this token with something other than SOL. This site only shows TOKEN/SOL pools for now.</Notice>
              )}
            </Card>
          ) : (
            <ul className="space-y-3" aria-label="Pools, deepest first">
              {pools.search.pools.map((p) =>
                p.kind === 'pool' ? (
                  <PoolCard
                    key={p.view.address}
                    view={p.view}
                    tokenDecimals={decimals}
                    safety={safety}
                    health={assessPool({ view: p.view, tokenDecimals: decimals, chainNow: pools.search.chainNow, outside, safety })}
                  />
                ) : (
                  <UnreadPoolCard key={p.address} entry={p} />
                ),
              )}
            </ul>
          )}
          {pools.search.pools.length > 0 && pools.search.otherPairs > 0 && (
            <Notice>{pools.search.otherPairs} more pool(s) pair this token with something other than SOL and are not shown.</Notice>
          )}
        </div>
      )}
    </div>
  );
}

function IndexNote({ read }: { read: Extract<PoolSearchRead, { kind: 'ok' }> }) {
  const { index, known, knownState } = read.search;
  const squatted = known.standard.filter((s) => knownState[s.address] === 'pool');
  return (
    <div className="text-white/55 text-[11px] leading-relaxed space-y-1" data-testid="lp-index-note">
      {index.kind === 'ok' ? (
        <>
          <p>
            Pools are listed from our pool index and each one is then read and checked on chain. Deepest first. None of them is
            “the” pool for this token: anyone can open one, at any price.
          </p>
          {index.truncated && (
            <p className="text-amber-300/90" data-testid="lp-index-truncated">
              Our pool index returned its maximum: the pools holding the most SOL. There may be more pools for this token that are not
              listed here.
            </p>
          )}
        </>
      ) : (
        <p className="text-amber-300/90">
          Our pool index could not be read ({index.detail}), so only the addresses we can work out ourselves were checked:
          the launch pool and the standard address on each fee tier. There may be other pools.
        </p>
      )}
      {squatted.length > 0 && (
        <p>
          Someone has opened a pool at the standard address for fee tier {squatted.map((s) => s.index).join(' and ')}. Being at that
          address does not make it the right pool: check its price and open time below.
        </p>
      )}
    </div>
  );
}
