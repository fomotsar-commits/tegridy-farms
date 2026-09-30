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
  | { status: 'done'; mint: string; safety: TokenSafety; pools: PoolSearchRead; outside: OutsidePrice | null };

type Done = Extract<SearchState, { status: 'done' }>;

/**
 * The search for `mint`. Results are stored with the question they answer (mint and
 * nonce), so a new question reads as loading until its own answer arrives, and a late
 * answer to an old question is never shown.
 */
function usePoolSearch(readers: LpReaders, mint: string | null, nonce: number): SearchState {
  const key = mint ? `${mint}#${nonce}` : null;
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
  return answer?.key === key ? answer.value : { status: 'loading', mint };
}

export function PoolFinder({ readers, mint, onMint }: { readers: LpReaders; mint: string | null; onMint: (m: string | null) => void }) {
  const [input, setInput] = useState(mint ?? '');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const state = usePoolSearch(readers, mint, nonce);
  // A new ?mint= (a link, or back/forward) fills the field: adjusted during render, the
  // React way to follow a prop, rather than in an effect.
  const [shownMint, setShownMint] = useState(mint);
  if (mint !== shownMint) {
    setShownMint(mint);
    if (mint) setInput(mint);
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
      {state.status === 'done' && <SearchResults state={state} />}
    </section>
  );
}

function announce(s: Extract<SearchState, { status: 'done' }>): string {
  if (s.pools.kind === 'unread') return 'The pools could not be read.';
  const n = s.pools.search.pools.length;
  const verdict = s.safety.kind === 'read' ? (s.safety.verdict === 'blocked' ? ' This token is blocked on this site.' : '') : ' The token could not be read.';
  return `${n === 0 ? 'No pools' : n === 1 ? 'One pool' : `${n} pools`} found for this token.${verdict}`;
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
              <p data-testid="lp-no-pools">No TOKEN/SOL pools found for this token{pools.search.index.kind === 'ok' ? '.' : ' at the addresses we could check.'}</p>
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
                    health={assessPool({
                      snapshot: p.view.snapshot,
                      tokenMint: mint,
                      tokenDecimals: decimals,
                      chainNow: pools.search.chainNow,
                      outside,
                      safety,
                      isLaunchPool: p.view.origin === 'launch-pool',
                    })}
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
        <p>
          Pools are listed from our pool index and each one is then read and checked on chain. Deepest first. None of them is
          “the” pool for this token: anyone can open one, at any price.
          {index.truncated && ' The index returned its maximum; there may be more.'}
        </p>
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
