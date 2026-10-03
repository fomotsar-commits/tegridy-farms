import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { parseMintInput } from '../../../lib/solana/lp/mintInput';
import { assessPool, type PoolHealth } from '../../../lib/solana/lp/poolHealth';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import type { PoolSearchRead } from '../../../lib/solana/lp/poolFinder';
import type { OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { BUNGALOWS } from '../../../lib/bungalows';
import { useActiveBungalowId } from '../../../hooks/useActiveBungalowId';
import { Card, Field, Notice } from '../curve/ui';
import { TOGGLE_CLS, inputCls, inputStyle } from '../curve/uiFormat';
import { TokenSafetyCard } from './TokenSafetyCard';
import { PoolCard, UnreadPoolCard } from './PoolCard';
import { CreatePoolCard } from './CreatePoolCard';
import { depositOffer, lpHeld } from './offers';
import { useLpWrites } from './useLpWrites';
import type { LpReaders } from './readers';

/** What a visitor came to do. The three are on the first screen, as buttons. */
export type LpTask = 'create' | 'add' | 'remove';

/**
 * A lookup the visitor asked to END in a form: once the answer for `mint` is in, the
 * panel for `task` opens by itself. `n` numbers the asks, so each is acted on once: a
 * panel the visitor closed is not opened again by a later re-read.
 */
export interface LpWish {
  task: 'create' | 'add';
  mint: string;
  n: number;
}

/**
 * The tokens with a room on this site whose mint is on Solana, by the addresses in the
 * site's own registry (lib/bungalows.ts). A phone has no token address to paste: these
 * are picked by a press, and what is looked up is the address, never the name.
 */
function siteTokens(roomId: string | null): { id: string; symbol: string; mint: string }[] {
  const all = BUNGALOWS.flatMap((b) => (b.chain === 'solana' && b.address ? [{ id: b.id, symbol: b.symbol, mint: b.address }] : []));
  // The visitor's own room first.
  return [...all.filter((t) => t.id === roomId), ...all.filter((t) => t.id !== roomId)];
}

const TASK_LABEL: Record<LpTask, string> = { create: 'Create a pool', add: 'Add liquidity', remove: 'Remove liquidity' };
const TASK_LINE: Record<LpTask, string> = {
  create: 'Pick the token to open a pool for. The form opens under the token’s checks.',
  add: 'Pick the token to add liquidity for. If it has no pool yet, your deposit opens one.',
  remove: 'Your pool shares are listed under Your positions. Each one that can be taken out has a Remove liquidity button.',
};
/** Before a press, with a token already on the page: which token the first two buttons act on. */
const TOKEN_HERE_LINE = 'A token is already on this page: its address is in the box below. Create a pool and Add liquidity open its form.';
/** The same, with a token already answered on the page: its form opens at once. */
const TASK_LINE_HERE: Record<'create' | 'add', string> = {
  create: 'The form opens under this token’s checks. Pick another token to change it.',
  add: 'The form opens under this token’s checks. If it has no pool yet, your deposit opens one.',
};

type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; mint: string }
  /**
   * `refreshing`: the last answer for this same mint, shown while it is read again.
   * `outsideAt`: when Jupiter's price was read (ms), or null when it was not asked.
   */
  | { status: 'done'; mint: string; safety: TokenSafety; pools: PoolSearchRead; outside: OutsidePrice | null; outsideAt: number | null; refreshing?: boolean };

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
      const outside = ask ? await readers.outsidePrice(mint, decimals) : null;
      finish({ status: 'done', mint, safety, pools, outside, outsideAt: ask ? Date.now() : null });
    })().catch((e: unknown) => {
      const detail = e instanceof Error ? e.message : String(e);
      finish({ status: 'done', mint, safety: { kind: 'unread', mint, detail }, pools: { kind: 'unread', detail, index: { kind: 'unread', detail } }, outside: null, outsideAt: null });
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
  onRemove,
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
  /** Remove liquidity was pressed: the section brings the visitor's positions onto the screen. */
  onRemove?: () => void;
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
  // The form the visitor's lookup should end in (LpWish). It is for one token and one
  // act: the page moving to another token drops it (Back, Forward, a link), and the card
  // that acts on it spends it (`spent`), so nothing later can act on it again.
  const [wish, setWish] = useState<LpWish | null>(null);
  if (linkKey !== shownLink) {
    setShownLink(linkKey);
    if (wish && wish.mint !== mint) setWish(null);
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
  // What the visitor came to do, and the form their next lookup should end in.
  const writes = useLpWrites();
  const canAdd = writes?.mode === 'on';
  const [task, setTask] = useState<LpTask | null>(null);
  const wishes = useRef(0);
  // Without this a wish outlived its form: a deposit sent from it held the pool, the
  // target moved to the Open card and the page jumped off "Sent, do not send it again";
  // a pool just opened came back in the re-read and its Add form opened by itself; Back
  // then Forward reopened a form the visitor had closed (review, 2026-10-03).
  const spent = useCallback((n: number) => setWish((w) => (w?.n === n ? null : w)), []);
  const lookUp = useCallback(
    (next: string, want: LpWish['task'] | null) => {
      asked.current = true;
      wishes.current += 1;
      setWish(want ? { task: want, mint: next, n: wishes.current } : null);
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
    // A typed address ends in a form only when the visitor said which one they want.
    lookUp(p.mint, canAdd && (task === 'create' || task === 'add') ? task : null);
  }, [input, lookUp, task, canAdd]);

  // One press looks a token up by its address, which a phone would otherwise have to
  // find, copy and paste. With adding switched on the press ends in a form: the one the
  // visitor chose, or adding (which opens the pool when there is none yet). With Remove
  // chosen it is only a lookup: nobody who asked to take liquidity out gets an Add form.
  const roomId = useActiveBungalowId();
  const tokens = useMemo(() => siteTokens(roomId), [roomId]);
  const pick = useCallback(
    (m: string) => {
      setInput(m);
      setError(null);
      lookUp(m, canAdd && task !== 'remove' ? (task === 'create' ? 'create' : 'add') : null);
    },
    [lookUp, task, canAdd],
  );
  // Create and Add: the tokens and the address box come onto the screen under the three
  // buttons (on a phone they start at its foot). Remove: the section goes to the positions.
  // With a token already answered on the page (a ?mint= link, which is how a wallet app's
  // own browser arrives, or an earlier lookup), Create and Add go straight to its form:
  // the answer is on the page (or on its way), so nothing is read again. The card says
  // which token that is before the press, by where its address is, never by its name.
  const tasksRef = useRef<HTMLDivElement>(null);
  const answered = state.status === 'idle' ? null : state.mint;
  const choose = useCallback(
    (t: LpTask) => {
      setTask(t);
      if (t === 'remove') onRemove?.();
      else if (answered && canAdd) {
        wishes.current += 1;
        setWish({ task: t, mint: answered, n: wishes.current });
      } else tasksRef.current?.scrollIntoView?.({ block: 'start' });
    },
    [onRemove, answered, canAdd],
  );
  // Create and Add need adding switched on; Remove needs only the write code.
  const tasks: LpTask[] = !writes ? [] : canAdd ? ['create', 'add', 'remove'] : ['remove'];

  return (
    <section data-testid="lp-finder" aria-label="Find pools for a token" className="space-y-4">
      <Card title={tasks.length > 0 ? 'Create a pool, add or remove liquidity' : 'Find pools for a token'}>
        {tasks.length > 0 && (
          <div ref={tasksRef} data-testid="lp-tasks" className="space-y-2 scroll-mt-[4.5rem]">
            <div className="flex gap-2" role="group" aria-label="What do you want to do?">
              {tasks.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`${task === t ? 'btn-primary' : 'btn-secondary'} flex-1 min-w-0 min-h-[48px] px-2 text-[13px] leading-tight`}
                  aria-pressed={task === t}
                  onClick={() => choose(t)}
                >
                  {TASK_LABEL[t]}
                </button>
              ))}
            </div>
            {/* Always mounted, so what a press changed is read out. Empty until something is chosen:
                on a phone each line here pushes the tokens under it off the first screen. */}
            <p role="status" className="text-white/75 text-[12px] leading-relaxed empty:hidden" data-testid="lp-task-line">
              {task
                ? task !== 'remove' && answered
                  ? TASK_LINE_HERE[task]
                  : TASK_LINE[task]
                : !canAdd
                  ? 'Adding liquidity and opening pools from this site are paused right now. Removing still works.'
                  : answered
                    ? TOKEN_HERE_LINE
                    : ''}
            </p>
          </div>
        )}
        {tokens.length > 0 && (
          <div data-testid="lp-site-tokens" className="space-y-1.5">
            <p className="text-white/75 text-[12px]">{canAdd ? 'Then pick a token with a room on this site' : 'Tokens with a room on this site'}</p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Tokens with a room on this site">
              {tokens.map((t) => (
                <button
                  key={t.mint}
                  type="button"
                  className={`${TOGGLE_CLS} !flex-none px-4 text-[13px] font-semibold`}
                  style={{ background: mint === t.mint ? 'rgba(45,139,78,0.45)' : 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.18)' }}
                  aria-pressed={mint === t.mint}
                  onClick={() => pick(t.mint)}
                >
                  {t.symbol}
                </button>
              ))}
            </div>
            <p className="text-white/55 text-[11px]">Each is looked up by its address from this site’s own list, not by its name.</p>
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {tokens.length > 0 && <p className="text-white/75 text-[12px] mb-1.5">Or any other token, by its address:</p>}
          <Field label="Token mint address" hint="The token’s address, not its name: anyone can copy a name." error={error}>
            {(a11y) => (
              <input
                {...a11y}
                className={`${inputCls} font-mono`}
                style={inputStyle}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  // The refusal was about the text that was there: it does not stay over a new one.
                  setError(null);
                }}
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

      {/* Where a lookup the visitor asked for scrolls to: clear of the fixed bar and tabs. */}
      <div ref={answerRef} className="scroll-mt-[4.5rem]" />

      <p role="status" aria-live="polite" className="sr-only" data-testid="lp-status">
        {state.status === 'loading' ? 'Reading the token and its pools.' : state.status === 'done' ? announce(state) : ''}
      </p>

      {state.status === 'loading' && <p className="text-white/70 text-[13px]">Reading the token and its pools from the chain…</p>}
      {state.status === 'done' && state.refreshing && <p className="text-white/55 text-[12px]">Reading the token and its pools again…</p>}
      {state.status === 'done' && (
        <SearchResults state={state} onReread={reread} wish={wish && !state.refreshing && wish.mint === state.mint ? wish : null} onActed={spent} />
      )}
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

function SearchResults({
  state,
  onReread,
  wish,
  onActed,
}: {
  state: Extract<SearchState, { status: 'done' }>;
  onReread: () => void;
  wish: LpWish | null;
  /** A card acted on wish number `n`: it is spent. */
  onActed: (n: number) => void;
}) {
  const { safety, pools, outside, outsideAt, mint } = state;
  const writes = useLpWrites();
  const decimals = safety.kind === 'read' ? safety.facts?.decimals ?? null : null;
  // One check per pool, shared by its card and by the "Open a new pool" card.
  const healths = useMemo(() => {
    const m = new Map<string, PoolHealth>();
    if (pools.kind !== 'ok') return m;
    for (const p of pools.search.pools) {
      if (p.kind === 'pool') m.set(p.view.address, assessPool({ view: p.view, tokenDecimals: decimals, chainNow: pools.search.chainNow, outside, safety }));
    }
    return m;
  }, [pools, decimals, outside, safety]);
  // Where a wish ends. Adding goes to the deepest pool that offers it; with none, and for
  // creating, it goes to the "Open a new pool" card, which opens its form or says why not.
  const gate = writes?.gate ?? null;
  const mode = writes?.mode ?? 'off';
  const notes = writes?.pending.notes;
  const addTo = useMemo(() => {
    if (wish?.task !== 'add' || pools.kind !== 'ok' || !notes) return null;
    for (const p of pools.search.pools) {
      const health = p.kind === 'pool' ? healths.get(p.view.address) : undefined;
      if (p.kind === 'pool' && health && depositOffer({ mode, gate, health, held: lpHeld(notes, p.view.address, 'add') }) === 'offer') return p.view.address;
    }
    return null;
  }, [wish, pools, healths, mode, gate, notes]);
  // Waits for the gate: until it has answered, no pool can say whether it offers adding.
  const gateAnswered = writes !== null && writes.status !== 'loading' && gate !== null;
  const openCreate = wish && gateAnswered && (wish.task === 'create' || addTo === null) ? wish.n : 0;
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
                    health={healths.get(p.view.address)!}
                    openNow={wish && addTo === p.view.address ? wish.n : 0}
                    onActed={onActed}
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
        openNow={openCreate}
        onActed={onActed}
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
