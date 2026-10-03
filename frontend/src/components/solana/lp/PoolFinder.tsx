import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { parseMintInput } from '../../../lib/solana/lp/mintInput';
import { assessPool, type PoolHealth } from '../../../lib/solana/lp/poolHealth';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import type { PoolSearchRead } from '../../../lib/solana/lp/poolFinder';
import type { OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { QUOTE_COINS_OR, quotesFor } from '../../../lib/solana/lp/quotes';
import { getActiveBungalow } from '../../../lib/bungalows';
import { useActiveBungalowId } from '../../../hooks/useActiveBungalowId';
import { Card, Field, Notice } from '../curve/ui';
import { inputCls, inputStyle } from '../curve/uiFormat';
import { TokenSafetyCard } from './TokenSafetyCard';
import { PoolCard, UnreadPoolCard } from './PoolCard';
import { CreatePoolCard } from './CreatePoolCard';
import type { LpReaders } from './readers';

type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; mint: string }
  /**
   * `refreshing`: the last answer for this same mint, shown while it is read again.
   * `outsideAt`: when Jupiter's price was read (ms), or null when it was not asked.
   * `coins`: each pairing coin's own SOL price, by its mint, for the coins that were asked
   * (USDC, BAYLA). A pool paired with one is checked in that coin (poolHealth.ts), and a
   * coin missing here leaves its pools unchecked.
   */
  | {
      status: 'done';
      mint: string;
      safety: TokenSafety;
      pools: PoolSearchRead;
      outside: OutsidePrice | null;
      coins: CoinPrices;
      outsideAt: number | null;
      refreshing?: boolean;
    };

/** Each pairing coin's own outside price in SOL, by its mint. */
export type CoinPrices = Readonly<Record<string, OutsidePrice>>;

type Done = Extract<SearchState, { status: 'done' }>;

/**
 * The search for `mint`. Results are stored with the question they answer (mint, nonce
 * and the section's reload key), so a late answer to an old question is never shown. A
 * re-read of the SAME mint keeps showing the last answer until the new one arrives, so
 * the cards and an open panel (with its outcome on screen) never unmount; only a
 * different mint reads as loading.
 */
function usePoolSearch(readers: LpReaders, mint: string | null, nonce: number, reloadKey: number, wantOutside: boolean): SearchState {
  const key = mint ? `${mint}#${nonce}#${reloadKey}#${wantOutside ? 'o' : ''}` : null;
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
      // The outside price only matters when there is a pool to compare, or (with opening
      // pools offered, `wantOutside`) an opening price to check, and a token we could
      // read; it costs two Jupiter calls, so it is not asked for otherwise.
      const hasPool = pools.kind === 'ok' && pools.search.pools.some((p) => p.kind === 'pool');
      const decimals = safety.kind === 'read' ? safety.facts?.decimals ?? null : null;
      const ask = (hasPool || wantOutside) && decimals !== null && safety.kind === 'read' && safety.verdict !== 'blocked';
      // A pool paired with USDC or BAYLA is checked in that coin, which needs the coin's
      // own price: two more Jupiter calls each, so it is asked only for a coin that has a
      // pool here. (An opening priced in a coin reads that coin's price in its own panel.)
      const paired = new Set(pools.kind === 'ok' ? pools.search.pools.flatMap((p) => (p.kind === 'pool' ? [p.view.quote.mint] : [])) : []);
      const wanted = ask ? quotesFor(mint).filter((q) => !q.native && paired.has(q.mint)) : [];
      const [outside, ...coinPrices] = await Promise.all([
        ask ? readers.outsidePrice(mint, decimals) : null,
        ...wanted.map((q) => readers.outsidePrice(q.mint, q.decimals)),
      ]);
      const coins: Record<string, OutsidePrice> = {};
      wanted.forEach((q, i) => {
        coins[q.mint] = coinPrices[i]!;
      });
      finish({ status: 'done', mint, safety, pools, outside, coins, outsideAt: ask ? Date.now() : null });
    })().catch((e: unknown) => {
      const detail = e instanceof Error ? e.message : String(e);
      finish({ status: 'done', mint, safety: { kind: 'unread', mint, detail }, pools: { kind: 'unread', detail, index: { kind: 'unread', detail } }, outside: null, coins: {}, outsideAt: null });
    });
    return () => {
      live = false;
    };
  }, [readers, mint, key, wantOutside]);
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
  wantOutside = false,
}: {
  readers: LpReaders;
  mint: string | null;
  onMint: (m: string | null) => void;
  linkError?: { raw: string; reason: string } | null;
  /** Bumped by the section after a liquidity flow finishes: read the same mint again. */
  reloadKey?: number;
  /**
   * Ask Jupiter for every readable, unblocked token, pool or not: opening a pool checks
   * its price against Jupiter's. Only when opening pools can be offered (LP mode 'on').
   */
  wantOutside?: boolean;
}) {
  const [input, setInput] = useState(mint ?? linkError?.raw ?? '');
  const [error, setError] = useState<string | null>(linkError?.reason ?? null);
  const [nonce, setNonce] = useState(0);
  const state = usePoolSearch(readers, mint, nonce, reloadKey, wantOutside);
  const reread = useCallback(() => setNonce((n) => n + 1), []);
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

  // A lookup the visitor asked for is brought onto the screen. On a phone the answer
  // begins below the fold, so a press on Find pools looked as if it had done nothing
  // (owner, 2026-10-03). A link that carries a token does not move the page by itself.
  const answerRef = useRef<HTMLDivElement>(null);
  const asked = useRef(false);
  const lookUp = useCallback(
    (next: string) => {
      asked.current = true;
      if (next === mint) setNonce((n) => n + 1);
      else onMint(next);
    },
    [mint, onMint],
  );
  useEffect(() => {
    if (!asked.current || state.status === 'idle') return;
    asked.current = false;
    answerRef.current?.scrollIntoView?.({ block: 'start' });
  }, [state.status, mint, nonce]);

  const submit = useCallback(() => {
    const p = parseMintInput(input);
    if (!p.ok) {
      setError(p.reason);
      return;
    }
    setError(null);
    lookUp(p.mint);
  }, [input, lookUp]);

  // The visitor's own room, when its token is on Solana: one press looks it up by its
  // address, which a phone would otherwise have to find, copy and paste.
  const roomId = useActiveBungalowId();
  const room = useMemo(() => {
    const b = getActiveBungalow();
    return roomId && b && b.chain === 'solana' && b.address ? { symbol: b.symbol, mint: b.address } : null;
  }, [roomId]);
  const findRoomToken = useCallback(() => {
    if (!room) return;
    setInput(room.mint);
    setError(null);
    lookUp(room.mint);
  }, [room, lookUp]);

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
            {room && (
              <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" onClick={findRoomToken}>
                Find {room.symbol} pools
              </button>
            )}
            {state.status === 'done' && (
              <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" onClick={() => setNonce((n) => n + 1)}>
                Read again
              </button>
            )}
          </div>
          <p className="mt-3 text-white/55 text-[12px] leading-relaxed">
            To add liquidity, look a token up. A pool that passes its checks gets an Add liquidity button; a token
            with no pool yet gets Open a pool.
          </p>
        </form>
      </Card>

      {/* Where a lookup the visitor asked for scrolls to: clear of the fixed bar and tabs. */}
      <div ref={answerRef} className="scroll-mt-32" />

      <p role="status" aria-live="polite" className="sr-only" data-testid="lp-status">
        {state.status === 'loading' ? 'Reading the token and its pools.' : state.status === 'done' ? announce(state) : ''}
      </p>

      {state.status === 'loading' && <p className="text-white/70 text-[13px]">Reading the token and its pools from the chain…</p>}
      {state.status === 'done' && state.refreshing && <p className="text-white/55 text-[12px]">Reading the token and its pools again…</p>}
      {state.status === 'done' && <SearchResults state={state} onReread={reread} />}
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

function SearchResults({ state, onReread }: { state: Extract<SearchState, { status: 'done' }>; onReread: () => void }) {
  const { safety, pools, outside, coins, outsideAt, mint } = state;
  const decimals = safety.kind === 'read' ? safety.facts?.decimals ?? null : null;
  // One check per pool, shared by its card and by the "Open a new pool" card.
  const healths = useMemo(() => {
    const m = new Map<string, PoolHealth>();
    if (pools.kind !== 'ok') return m;
    for (const p of pools.search.pools) {
      if (p.kind === 'pool') {
        m.set(p.view.address, assessPool({ view: p.view, tokenDecimals: decimals, chainNow: pools.search.chainNow, outside, coinOutside: coins[p.view.quote.mint] ?? null, safety }));
      }
    }
    return m;
  }, [pools, decimals, outside, coins, safety]);
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
                  ? `No pools pairing this token with ${QUOTE_COINS_OR} found at the addresses we could check.`
                  : pools.search.index.truncated
                    ? `None of the pools our index returned pairs this token with ${QUOTE_COINS_OR}. It returned its maximum, so there may be more.`
                    : `No pools pairing this token with ${QUOTE_COINS_OR} found.`}
              </p>
              {pools.search.otherPairs > 0 && (
                <Notice>
                  {pools.search.otherPairs} pool(s) pair this token with something else. This site only shows pools paired with {QUOTE_COINS_OR}.
                </Notice>
              )}
            </Card>
          ) : (
            <ul className="space-y-3" aria-label="Pools: SOL pools first, then USDC, then BAYLA, the deepest of each first">
              {pools.search.pools.map((p) =>
                p.kind === 'pool' ? (
                  <PoolCard
                    key={p.view.address}
                    view={p.view}
                    tokenDecimals={decimals}
                    safety={safety}
                    health={healths.get(p.view.address)!}
                  />
                ) : (
                  <UnreadPoolCard key={p.address} entry={p} />
                ),
              )}
            </ul>
          )}
          {pools.search.pools.length > 0 && pools.search.otherPairs > 0 && (
            <Notice>{pools.search.otherPairs} more pool(s) pair this token with something other than {QUOTE_COINS_OR} and are not shown.</Notice>
          )}
        </div>
      )}
      <CreatePoolCard
        mint={mint}
        safety={safety}
        decimals={decimals}
        search={pools}
        healths={healths}
        outside={outside}
        outsideAt={outsideAt}
        onReread={onReread}
        refreshing={state.refreshing === true}
      />
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
            Pools are listed from our pool index and each one is then read and checked on chain. SOL pools first, then USDC, then
            BAYLA, the deepest of each first. None of them is
            “the” pool for this token: anyone can open one, at any price.
          </p>
          {index.truncated && (
            <p className="text-amber-300/90" data-testid="lp-index-truncated">
              Our pool index returned its maximum: for each coin, the pools holding the most of it. There may be more pools for this
              token that are not listed here.
            </p>
          )}
        </>
      ) : (
        <p className="text-amber-300/90">
          Our pool index could not be read ({index.detail}), so only the addresses we can work out ourselves were checked:
          the launch pool and the standard address on each fee tier, for each coin a pool can pair with. There may be other pools.
        </p>
      )}
      {squatted.length > 0 && (
        <p>
          Someone has opened a pool at the standard address for fee tier {[...new Set(squatted.map((s) => s.index))].join(' and ')}. Being at that
          address does not make it the right pool: check its price and open time below.
        </p>
      )}
    </div>
  );
}
