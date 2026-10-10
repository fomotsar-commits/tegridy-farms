import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import type { PublicKey } from '@solana/web3.js';
import { displaySafe } from '../../../lib/launchMetadata/validate';
import { MAX_POSITIONS, type PositionsRead, type Position } from '../../../lib/solana/lp/positions';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { formatWhen, vaultFreezer, withdrawalsState } from '../../../lib/solana/lp/poolHealth';
import { swapEnabled } from '../../../lib/solana/cpswap/program';
import { tokenText } from '../../../lib/solana/lp/format';
import { pairLabel } from '../../../lib/solana/lp/identity';
import { LEDGER_COPY, LEDGER_LABELS, ledgerFigures, ledgerText, ledgerUnits, type LedgerEntry, type LedgerLine, type LedgerRead } from '../../../lib/solana/lp/ledger';
import { lastTrade } from '../../../lib/solana/lp/poolPast';
import { QUOTE_COINS_OR } from '../../../lib/solana/lp/quotes';
import { HISTORY_PAGES_MAX } from '../../../lib/solana/lp/txHistory';
import { SolanaConnectButton } from '../SolanaConnectButton';
import { WalletAppHint } from '../curve/WalletNeeded';
import { Card, Notice, Row } from '../curve/ui';
import { AddressRow } from './AddressRow';
import { LeaveWithoutThisSite } from './LpDisclosures';
import { lpHeld, withdrawOffer, type WithdrawOffer } from './offers';
import { explorerOf } from './panelKit';
import { RemoveLiquidityPanel } from './RemoveLiquidityPanel';
import { useLpWrites, type LpWrites } from './useLpWrites';
import type { LpReaders } from './readers';

type State =
  | { status: 'loading' }
  /** `refreshing`: this is the last answer for the same wallet, shown while it is read again. */
  | { status: 'done'; read: PositionsRead; safety: Map<string, TokenSafety>; refreshing?: boolean };

type Done = Extract<State, { status: 'done' }>;

/**
 * Positions for `owner`, keyed like usePoolSearch: an answer is shown only for its own
 * question. A re-read of the SAME wallet (Read again, Look up more, or a finished
 * liquidity flow) keeps showing the last answer until the new one arrives, so rows and
 * an open panel, with its outcome on screen, never unmount. Only another wallet shows
 * "loading".
 */
function usePositions(readers: LpReaders, owner: PublicKey | null, nonce: number, limit: number, reloadKey: number): State | null {
  const ownerKey = owner?.toBase58() ?? null;
  const key = ownerKey ? `${ownerKey}#${nonce}#${limit}#${reloadKey}` : null;
  const [answer, setAnswer] = useState<{ key: string; owner: string; value: Done } | null>(null);
  useEffect(() => {
    if (!owner || !key || !ownerKey) return;
    let live = true;
    const finish = (value: Done) => {
      if (live) setAnswer({ key, owner: ownerKey, value });
    };
    (async () => {
      const read = await readers.positions(owner, limit);
      const tokens = read.kind === 'ok'
        ? read.positions.flatMap((p) => (p.pool?.kind === 'pool' ? [p.pool.view.tokenMint] : []))
        : [];
      const safety = tokens.length ? await readers.safety(tokens) : new Map<string, TokenSafety>();
      finish({ status: 'done', read, safety });
    })().catch((e: unknown) => {
      finish({ status: 'done', read: { kind: 'unread', detail: e instanceof Error ? e.message : String(e) }, safety: new Map() });
    });
    return () => {
      live = false;
    };
    // key, not owner: a new PublicKey object for the same wallet is not a new wallet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readers, key]);
  if (!key) return null;
  if (answer?.key === key) return answer.value;
  return answer && answer.owner === ownerKey ? { ...answer.value, refreshing: true } : { status: 'loading' };
}

// After "Token check:". The first says what this site does not do, never that the token is "blocked" (owner ruling 2026-10-07).
const VERDICT_WORD = { blocked: 'this site does not open or add to pools for it', warn: 'allowed, with warnings', ok: 'no problems found' } as const;
const withdrawalsWord = (view: PoolView): string => {
  const state = withdrawalsState(view);
  return state === 'open' ? 'open' : state === 'switched-off' ? 'switched off' : `blocked: a pool vault is frozen by ${vaultFreezer(view.quote)}`;
};

/**
 * Shares that are set aside, below the rest and without the names their tokens give
 * themselves: anyone can send pool shares of a junk pool to any wallet, and a junk
 * token's name is whatever its maker typed.
 */
function setAsideReason(p: Position, safety: TokenSafety | null): string | null {
  if (p.pool?.kind === 'pool' && safety?.kind === 'read' && safety.verdict === 'blocked') return 'this site does not open or add to pools for its token';
  if (p.pool?.kind === 'other-pair') return `its pool is not paired with ${QUOTE_COINS_OR}`;
  if (p.pool?.kind === 'absent' || p.pool?.kind === 'not-a-pool') return 'its pool could not be confirmed on chain';
  return null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function statusText(owner: PublicKey | null, state: State | null): string {
  if (!owner) return '';
  if (!state || state.status === 'loading') return 'Reading your wallet’s pool shares.';
  if (state.read.kind === 'unread') return 'Your wallet could not be read. That does not mean it holds no pool shares.';
  const { positions, totalShares } = state.read;
  if (totalShares === 0) return 'This wallet holds no pool shares.';
  const more = totalShares - positions.length;
  return `This wallet holds ${plural(totalShares, 'pool share', 'pool shares')}.${more > 0 ? ` ${positions.length} are shown; ${more} more are not looked up yet.` : ''}`;
}

/**
 * "Add more liquidity" on a position: the token to look up and the pool the share is in.
 * The section hands it to the finder, which owns the lookup, the checks and the form.
 */
export type AddMore = (tokenMint: string, pool: string) => void;

/** Can this section add at all right now? `depositOffer`'s first three stops, without a pool. */
function addingOpen(writes: LpWrites | null): boolean {
  return writes !== null && writes.mode === 'on' && writes.gate?.kind === 'open' && writes.gate.mode === 'on';
}

/**
 * How many rows work out what they earned by themselves, so a holder sees it with no
 * press: the first two shares in the main list whose pool was read. Each is one read of
 * at most 21 calls behind the budget gate (rpcBudget.ts). Every other share keeps the
 * press, and a set-aside or unplaced share has no earnings block at all.
 */
const AUTO_LEDGER_ROWS = 2;

const HEAD = 'text-white font-semibold text-[12px]';
const HINT = 'text-white/70';

export function YourPositions({
  readers,
  owner,
  reloadKey = 0,
  sectionRef,
  onAddMore,
}: {
  readers: LpReaders;
  owner: PublicKey | null;
  reloadKey?: number;
  /** Set by the section: "Remove liquidity" scrolls here and sends focus here. */
  sectionRef?: Ref<HTMLElement>;
  /** Set by the section: without it no position offers "Add more liquidity". */
  onAddMore?: AddMore;
}) {
  const [nonce, setNonce] = useState(0);
  const [limit, setLimit] = useState(MAX_POSITIONS);
  // A different wallet starts from the first page again (adjusted during render).
  const ownerKey = owner?.toBase58() ?? null;
  const [shownOwner, setShownOwner] = useState(ownerKey);
  if (ownerKey !== shownOwner) {
    setShownOwner(ownerKey);
    setLimit(MAX_POSITIONS);
  }
  const state = usePositions(readers, owner, nonce, limit, reloadKey);
  // The Add panels say the share before and after from this answer.
  const writes = useLpWrites();
  const report = writes?.reportPositions;
  const read = state?.status === 'done' && !state.refreshing ? state.read : null;
  useEffect(() => {
    if (report && read) report(read);
  }, [report, read]);
  useEffect(() => {
    if (report && !owner) report(null);
  }, [report, owner]);
  const readAgain = useCallback(() => setNonce((n) => n + 1), []);
  return (
    <section ref={sectionRef} tabIndex={sectionRef ? -1 : undefined} className="scroll-mt-[4.5rem] outline-none" data-testid="lp-positions" aria-label="Your positions">
      <Card title="Your positions">
        {/* One live region for the whole section, always mounted: only its text changes. */}
        <p role="status" aria-live="polite" className="sr-only" data-testid="lp-positions-status">
          {statusText(owner, state)}
        </p>
        {!owner ? (
          <>
            <p>Connect a Solana wallet to see the pool shares it holds. Reading them sends nothing and signs nothing.</p>
            {writes && <p>Removing liquidity starts here: each share that can be taken out gets a Remove liquidity button.</p>}
            <SolanaConnectButton />
            {/* A phone's own browser has no wallet in it: the same way on the forms give. */}
            <WalletAppHint />
          </>
        ) : !state || state.status === 'loading' ? (
          <p>Reading your wallet’s pool shares…</p>
        ) : state.read.kind === 'unread' ? (
          <>
            <Notice tone="warn">We could not read your wallet ({state.read.detail}). That does not mean it holds none.</Notice>
            <ReadAgain onClick={() => setNonce((n) => n + 1)} />
          </>
        ) : (
          <PositionsList
            read={state.read}
            safety={state.safety}
            owner={owner}
            onMore={() => setLimit((l) => l + MAX_POSITIONS)}
            onReadAgain={readAgain}
            readers={readers}
            onAddMore={onAddMore}
          />
        )}
      </Card>
    </section>
  );
}

function PositionsList({
  read,
  safety,
  owner,
  onMore,
  onReadAgain,
  readers,
  onAddMore,
}: {
  read: Extract<PositionsRead, { kind: 'ok' }>;
  safety: Map<string, TokenSafety>;
  owner: PublicKey;
  onMore: () => void;
  onReadAgain: () => void;
  readers: LpReaders;
  onAddMore?: AddMore;
}) {
  const safetyOf = (p: Position) => (p.pool?.kind === 'pool' ? safety.get(p.pool.view.tokenMint) ?? null : null);
  const main = read.positions.filter((p) => setAsideReason(p, safetyOf(p)) === null);
  const aside = read.positions.filter((p) => setAsideReason(p, safetyOf(p)) !== null);
  const autoLedger = new Set(main.filter((p) => p.pool?.kind === 'pool').slice(0, AUTO_LEDGER_ROWS).map((p) => p.lpAccount));
  const more = read.totalShares - read.positions.length;
  if (read.totalShares === 0) {
    return (
      <>
        <p data-testid="lp-no-positions">This wallet holds no shares in our pools.</p>
        <p>So there is nothing to remove yet. A share appears here once this wallet adds liquidity or opens a pool.</p>
        <ReadAgain onClick={onReadAgain} />
      </>
    );
  }
  return (
    <>
      {main.length > 0 && (
        <ul className="space-y-3" aria-label="Your pool shares, most valuable first">
          {main.map((p) => (
            <PositionRow
              key={p.lpAccount}
              p={p}
              owner={owner}
              safety={safetyOf(p)}
              chainNow={read.chainNow}
              autoLedger={autoLedger.has(p.lpAccount)}
              readers={readers}
              onReadAgain={onReadAgain}
              onAddMore={onAddMore}
            />
          ))}
        </ul>
      )}
      {aside.length > 0 && (
        <details data-testid="lp-positions-set-aside" className="rounded-lg" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
          <summary className="min-h-[44px] flex items-center px-3 cursor-pointer text-white/75">
            {plural(aside.length, 'other pool share', 'other pool shares')}, set aside without their names: tokens this site does not open or
            add to pools for, pools that are not paired with {QUOTE_COINS_OR}, or pools we could not confirm
          </summary>
          <ul className="space-y-3 p-3">
            {aside.map((p) => (
              <PositionRow
                key={p.lpAccount}
                p={p}
                owner={owner}
                safety={safetyOf(p)}
                chainNow={read.chainNow}
                setAside={setAsideReason(p, safetyOf(p))}
                readers={readers}
                onReadAgain={onReadAgain}
                onAddMore={onAddMore}
              />
            ))}
          </ul>
        </details>
      )}
      {more > 0 && (
        <div data-testid="lp-positions-more" className="space-y-2">
          <Notice tone="warn">
            This wallet holds {plural(more, 'more pool share', 'more pool shares')} that {more === 1 ? 'is' : 'are'} not looked up yet. Anyone
            can send pool shares to any wallet, so some of them may be junk.
          </Notice>
          <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" onClick={onMore}>
            Look up {Math.min(more, MAX_POSITIONS)} more
          </button>
        </div>
      )}
      <ReadAgain onClick={onReadAgain} />
    </>
  );
}

function ReadAgain({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" onClick={onClick}>
      Read my positions again
    </button>
  );
}

/**
 * One share. With its pool read: headed by the pair and tier, the pool's address short,
 * the sentence that fees are already in the shares, what it is worth and what it earned,
 * the pool's two switches, the buttons; the rest behind one fold. Without a pool: the
 * share's own token, what it holds and why it could not be placed.
 */
function PositionRow({
  p,
  owner,
  safety,
  chainNow,
  setAside = null,
  autoLedger = false,
  readers,
  onReadAgain,
  onAddMore,
}: {
  p: Position;
  owner: PublicKey;
  safety: TokenSafety | null;
  chainNow: bigint | null;
  setAside?: string | null;
  /** Set by the list on its first rows: the earnings block reads by itself. */
  autoLedger?: boolean;
  readers: LpReaders;
  onReadAgain: () => void;
  onAddMore?: AddMore;
}) {
  const view = p.pool?.kind === 'pool' ? p.pool.view : null;
  const decimals = safety?.kind === 'read' ? safety.facts?.decimals ?? null : null;
  const pool = p.pool;
  const writes = useLpWrites();
  const explorer = explorerOf(writes);
  // The pool a pending withdrawal would name: the read pool, or the address the share was placed at.
  const poolAddress = view?.address ?? (pool && pool.kind !== 'pool' ? pool.address : null);
  const offer = withdrawOffer({
    mode: writes?.mode ?? 'off',
    gate: writes?.gate ?? null,
    position: p,
    held: writes !== null && poolAddress !== null && lpHeld(writes.pending.notes, poolAddress, 'remove'),
  });
  const units = view ? ledgerUnits(view, 'exact') : null;
  // Needs no history: the share of the pool's two reserves, to the unit, under the token's registry name.
  const worth: ReactNode =
    view && units && p.value ? (
      <Row
        label={LEDGER_LABELS.worthNow}
        value={view.quoteIsToken0 ? `${units.coin(p.value.token0)} and ${units.token(p.value.token1)}` : `${units.coin(p.value.token1)} and ${units.token(p.value.token0)}`}
        mono={false}
      />
    ) : p.tooSmall ? (
      <Notice tone="warn">Too small to take out at the pool&apos;s current size: one side would round to zero.</Notice>
    ) : (
      <Notice tone="warn">Its value could not be worked out.</Notice>
    );
  const tokenCheck = (
    <Row
      label="Token check"
      value={!safety ? 'not read' : safety.kind === 'read' ? VERDICT_WORD[safety.verdict] : safety.kind === 'absent' ? 'not a token' : 'not read'}
      mono={false}
    />
  );
  // A token with nothing against it keeps its check in the fold; anything else is said on the row.
  const checkedClean = safety?.kind === 'read' && safety.verdict === 'ok';
  const shareRows = (
    <>
      <AddressRow label="Pool share token" value={p.lpMint} explorerUrl={explorer(p.lpMint)} />
      <Row label="You hold" value={tokenText(p.lpAmount, view ? view.snapshot.pool.lpMintDecimals : null, 'shares')} mono={false} />
    </>
  );
  return (
    <li
      className="rounded-lg p-3 space-y-1.5"
      style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.08)' }}
      data-testid="lp-position"
      data-pool={view?.address ?? ''}
      data-lp-mint={p.lpMint}
      data-placement={p.placement}
      data-pool-kind={pool?.kind ?? 'none'}
      data-remove={offer}
    >
      {view ? <h3 className={HEAD}>{pairLabel(view)}</h3> : shareRows}
      {setAside && <Notice tone="warn">Set aside: {setAside}.</Notice>}
      {p.placement === 'index-unread' && (
        <Notice tone="warn">
          Our pool index could not be read{p.placementDetail ? ` (${p.placementDetail})` : ''}, so we cannot say which pool this share belongs to yet.
        </Notice>
      )}
      {p.placement === 'not-found' && <Notice tone="warn">Our pool index has no pool for this share. It may be very new; read again in a minute.</Notice>}
      {pool?.kind === 'unread' && <Notice tone="warn">The pool could not be read ({pool.detail}).</Notice>}
      {pool?.kind === 'other-pair' && (
        <>
          <Row label="Pool" value={pool.address} />
          <Row label="Its two tokens" value={`${pool.token0Mint} and ${pool.token1Mint}`} />
          <Notice>Neither side of this pool is {QUOTE_COINS_OR}. This site does not show those pools, so nothing about it is checked here.</Notice>
        </>
      )}
      {pool?.kind === 'absent' && (
        <>
          <Row label="Pool" value={pool.address} />
          <Notice tone="warn">There is no account at the pool address for this share. The pool for this share could not be confirmed on chain.</Notice>
        </>
      )}
      {pool?.kind === 'not-a-pool' && (
        <>
          <Row label="Pool" value={pool.address} />
          <Notice tone="warn">The pool for this share could not be confirmed on chain ({pool.detail}).</Notice>
        </>
      )}
      {view && (
        <>
          {p.value && <p className={HINT}>Your share: {p.value.sharePct.toFixed(4)}% of the pool</p>}
          <AddressRow label="Pool" value={view.address} explorerUrl={explorer(view.address)} />
          {!checkedClean && tokenCheck}
          <p data-testid="lp-fees-in-shares">{LEDGER_COPY.feesInShares}</p>
          {!setAside && readers.ledger ? (
            <LedgerBlock p={p} owner={owner} view={view} readers={readers} auto={autoLedger} chainNow={chainNow} worth={worth} />
          ) : (
            worth
          )}
          <Row
            label="Pool swaps"
            value={
              !swapEnabled(view.snapshot.pool)
                ? 'switched off'
                : chainNow === null
                  ? 'not checked'
                  : chainNow < view.snapshot.pool.openTime
                    ? `blocked until ${formatWhen(view.snapshot.pool.openTime)}`
                    : 'open'
            }
            mono={false}
          />
          <Row label="Withdrawals" value={withdrawalsWord(view)} mono={false} />
        </>
      )}
      <RemoveBlock
        offer={offer}
        writes={writes}
        p={p}
        view={view}
        safety={safety}
        decimals={decimals}
        chainNow={chainNow}
        setAside={setAside !== null}
        readers={readers}
        onReadAgain={onReadAgain}
        onAddMore={onAddMore}
      />
      <details className="rounded-lg" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
        <summary className="min-h-[44px] flex items-center px-3 cursor-pointer text-white/75">More about this share</summary>
        <div className="space-y-1.5 px-3 pb-3">
          {view && shareRows}
          <AddressRow label="Share account" value={p.lpAccount} explorerUrl={explorer(p.lpAccount)} />
          {view && (
            <>
              <AddressRow label="Token" value={view.tokenMint} explorerUrl={explorer(view.tokenMint)} />
              {!setAside && safety?.kind === 'read' && (safety.name || safety.symbol) && (
                <Row label="Calls itself" value={`${displaySafe(safety.name ?? '', 32)} (${displaySafe(safety.symbol ?? '', 12)})`} mono={false} />
              )}
              {checkedClean && tokenCheck}
            </>
          )}
        </div>
      </details>
    </li>
  );
}

/** One earnings line: the figure beside its label, then its sentence (and the pace) under it, read as prose. */
function LedgerLineRow({ label, line, pace = null }: { label: string; line: LedgerLine; pace?: string | null }) {
  return (
    <div className="space-y-0.5">
      <Row label={label} value={line.figure} mono={false} />
      {line.note && <p className={HINT}>{line.note}</p>}
      {pace && (
        <p className={HINT} data-testid="lp-pace">
          {pace}
        </p>
      )}
    </div>
  );
}

/** The window sentence's "read {s} s ago" moves on this tick. */
const LEDGER_TICK_MS = 5_000;

interface LedgerAnswer {
  read: LedgerRead;
  /** Every entry read so far, newest first (`unread` and `paused` carry none). */
  entries: LedgerEntry[];
  pages: number;
  readAt: number;
  /** The shares held and the pool as read when it was worked out. */
  forAmount: bigint;
  forView: PoolView;
}

const LEDGER_BUTTON = 'btn-secondary w-full sm:w-auto min-h-[44px] px-4 text-[13px] aria-disabled:opacity-60';

/**
 * What a share earned, from its share account's own transactions (ledger.ts): by itself
 * when `auto`, on a press otherwise. The answer belongs to the shares it was worked out
 * for; while they are unchanged a re-read of the wallet asks for no history again and the
 * kept transactions are valued at the pool as just read. Read 20 more joins the older page
 * to what is held, up to HISTORY_PAGES_MAX pages. `worth` needs no history: always printed.
 */
function LedgerBlock({
  p,
  owner,
  view,
  readers,
  auto,
  chainNow,
  worth,
}: {
  p: Position;
  owner: PublicKey;
  view: PoolView;
  readers: LpReaders;
  auto: boolean;
  chainNow: bigint | null;
  worth: ReactNode;
}) {
  const [answer, setAnswer] = useState<LedgerAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [moreProblem, setMoreProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const shown = answer && answer.forAmount === p.lpAmount ? answer : null;
  useEffect(() => {
    if (!shown) return;
    const id = setInterval(() => setNow(Date.now()), LEDGER_TICK_MS);
    return () => clearInterval(id);
  }, [shown]);
  const share = { lpAccount: p.lpAccount, lpMint: p.lpMint, owner, lpAmount: p.lpAmount };
  const ask = async (opts?: { before: string }): Promise<LedgerRead> => {
    try {
      return opts ? await readers.ledger!(share, view, opts) : await readers.ledger!(share, view);
    } catch (e) {
      return { kind: 'unread', detail: e instanceof Error ? e.message : String(e) };
    }
  };
  const entriesOf = (r: LedgerRead): LedgerEntry[] => (r.kind === 'ok' || r.kind === 'worth-only' ? r.entries : []);
  // Only the newest question's answer is kept: one for shares that have since changed is dropped.
  const asked = useRef(0);
  const readFirstPage = async () => {
    const mine = ++asked.current;
    const r = await ask();
    if (asked.current !== mine) return;
    setAnswer({ read: r, entries: entriesOf(r), pages: 1, readAt: Date.now(), forAmount: share.lpAmount, forView: view });
    setNow(Date.now());
    setBusy(false);
  };
  const read = () => {
    setBusy(true);
    setMoreProblem(null);
    void readFirstPage();
  };
  const more = async () => {
    const oldest = shown?.entries[shown.entries.length - 1];
    if (!shown || !oldest) return;
    setBusy(true);
    setMoreProblem(null);
    const mine = ++asked.current;
    const older = await ask({ before: oldest.signature });
    if (asked.current !== mine) return;
    if (older.kind === 'unread') setMoreProblem(ledgerText.unread(older.detail));
    else if (older.kind === 'paused') setMoreProblem(ledgerText.paused());
    else {
      const entries = [...shown.entries, ...older.entries];
      setAnswer({ read: ledgerFigures(entries, view, share.lpAmount, older.window.more), entries, pages: shown.pages + 1, readAt: Date.now(), forAmount: share.lpAmount, forView: view });
      setNow(Date.now());
    }
    setBusy(false);
  };
  // The automatic read: once for the shares held, never again while an answer for them is
  // kept, and again when they change. A row the list did not mark never reads by itself.
  const startedFor = useRef<bigint | null>(null);
  useEffect(() => {
    if (!auto || startedFor.current === p.lpAmount || answer?.forAmount === p.lpAmount) return;
    startedFor.current = p.lpAmount;
    void readFirstPage();
    // The shares and the mark decide; the reader and the pool are read when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, p.lpAmount]);
  // The figures follow the pool as last read: the kept transactions at the new reserves, no history call.
  const r = useMemo((): LedgerRead | null => {
    if (!shown) return null;
    const kept = shown.read;
    if (shown.forView === view || (kept.kind !== 'ok' && kept.kind !== 'worth-only')) return kept;
    return ledgerFigures(shown.entries, view, p.lpAmount, kept.window.more);
  }, [shown, view, p.lpAmount]);

  if (!shown || !r) {
    const reading = busy || auto;
    return (
      <div className="space-y-1.5" data-testid="lp-ledger" data-ledger={reading ? 'reading' : 'idle'}>
        {worth}
        {reading ? (
          <p role="status" className={HINT}>
            {LEDGER_COPY.reading}
          </p>
        ) : (
          <button type="button" className={LEDGER_BUTTON} onClick={read}>
            {LEDGER_COPY.button}
          </button>
        )}
      </div>
    );
  }
  const u = ledgerUnits(view, 'exact');
  const trade = lastTrade(view);
  const readAgoSec = Math.max(0, Math.floor((now - shown.readAt) / 1000));
  // A deposit or withdrawal the chain has not finalized yet is said so on its own line.
  const notFinal = (kinds: LedgerEntry['kind'][]) => (shown.entries.some((e) => kinds.includes(e.kind) && 'final' in e && !e.final) ? ` ${LEDGER_COPY.notFinal}` : '');
  const canPage = (r.kind === 'ok' || r.kind === 'worth-only') && r.window.more;
  return (
    <div className="space-y-1.5" data-testid="lp-ledger" data-ledger={r.kind}>
      {r.kind === 'ok' ? (
        <>
          <Row label={LEDGER_LABELS.putIn} value={`${ledgerText.putIn(r.figures, u)}${notFinal(['deposit', 'opening'])}`} mono={false} />
          {r.figures.takenOut && <Row label={LEDGER_LABELS.takenOut} value={`${ledgerText.takenOut(r.figures, u)}${notFinal(['withdrawal'])}`} mono={false} />}
          {worth}
          <LedgerLineRow label={LEDGER_LABELS.growth} line={ledgerText.growth(r.figures, u, trade)} pace={ledgerText.pace(r.figures, trade, chainNow)} />
          <LedgerLineRow label={LEDGER_LABELS.versusHolding} line={ledgerText.versusHolding(r.figures, u)} />
          <LedgerLineRow label={LEDGER_LABELS.priceEffect} line={ledgerText.priceEffect(r.figures, u)} />
          {r.figures.locked !== null && <Row label={LEDGER_LABELS.locked} value={ledgerText.locked(r.figures, u) ?? ''} mono={false} />}
          {r.figures.otherShares && <Notice>{ledgerText.otherShares(r.figures, u)}</Notice>}
        </>
      ) : (
        <>
          {worth}
          {/* No figure for a read that returned none: the reason, never a zero. */}
          {r.kind === 'worth-only' && <Notice tone="warn">{ledgerText.worthOnly(r)}</Notice>}
          {r.kind === 'unread' && <Notice tone="warn">{ledgerText.unread(r.detail)}</Notice>}
          {r.kind === 'paused' && <Notice>{ledgerText.paused()}</Notice>}
        </>
      )}
      {(r.kind === 'ok' || r.kind === 'worth-only') && <p className={HINT}>{ledgerText.window(r, readAgoSec)}</p>}
      {canPage && shown.pages < HISTORY_PAGES_MAX && (
        <button
          type="button"
          className={LEDGER_BUTTON}
          aria-disabled={busy}
          onClick={() => {
            if (!busy) void more();
          }}
        >
          {LEDGER_COPY.readMore}
        </button>
      )}
      {canPage && shown.pages >= HISTORY_PAGES_MAX && <p className={HINT}>{LEDGER_COPY.olderNotRead}</p>}
      {moreProblem && <Notice tone="warn">{moreProblem}</Notice>}
      <button
        type="button"
        className={LEDGER_BUTTON}
        aria-disabled={busy}
        onClick={() => {
          if (!busy) read();
        }}
      >
        {LEDGER_COPY.readAgain}
      </button>
    </div>
  );
}

/**
 * What a position row offers for taking liquidity out (spec 4.3), from `withdrawOffer`:
 * the Remove button and its panel, the "find this share's pool on the chain" search
 * when our index could not place it, or one line saying why not. A placed share that
 * this site cannot take out right now also shows how to leave without it.
 *
 * And, beside Remove, **Add more liquidity** (owner, 2026-10-03): a holder who wanted to
 * add to the pool they were already in had to know to look the token up in the finder and
 * pick the right card. The button does that for them and nothing more. It opens no form
 * of its own: the finder runs its whole lookup and opens the Add form on this pool's own
 * card, or shows that card's reason. So a deposit is checked in one place, however it
 * was asked for.
 */
function RemoveBlock({
  offer,
  writes,
  p,
  view,
  safety,
  decimals,
  chainNow,
  setAside,
  readers,
  onReadAgain,
  onAddMore,
}: {
  offer: WithdrawOffer;
  writes: LpWrites | null;
  p: Position;
  view: PoolView | null;
  safety: TokenSafety | null;
  decimals: number | null;
  chainNow: bigint | null;
  setAside: boolean;
  readers: LpReaders;
  onReadAgain: () => void;
  onAddMore?: AddMore;
}) {
  const key = `remove:${p.lpAccount}`;
  const open = writes?.active?.key === key;
  const blockedByOther = !!writes?.busy && !open;
  // Any form mid-flow, this row's own Remove included: a lookup started now would pull
  // the page away from it, and could not open a form over it anyway.
  const flowRunning = !!writes?.busy;
  // Add more liquidity: on a share that is not set aside, whose pool this site read as one
  // of its own and which names this share, while the section can add at all. Whether THIS
  // pool takes a deposit right now is not decided here: the finder says so, on the pool's
  // card, after its checks. Nor does it wait on Remove: a share too small to take out is
  // one a holder may well want to add to. The one thing the row does know: a pool whose
  // withdrawals are off or whose vault is frozen takes no deposit from this site (nobody
  // is let in who cannot be let out), so the row that says so does not offer to add.
  const addMore =
    onAddMore && !setAside && view && view.snapshot.pool.lpMint === p.lpMint && withdrawalsState(view) === 'open' && addingOpen(writes) ? (
      <button
        type="button"
        className="btn-secondary w-full sm:w-auto min-h-[44px] px-4 text-[13px] disabled:opacity-60"
        disabled={flowRunning}
        onClick={() => onAddMore(view.tokenMint, view.address)}
      >
        Add more liquidity
      </button>
    ) : null;
  const pool = p.pool;
  // A share whose pool is known: the accounts the pool program's own withdraw takes.
  const placedAt = view?.address ?? (pool?.kind === 'other-pair' ? pool.address : null);
  const leaving =
    placedAt !== null && (offer === 'off' || offer === 'gate' || offer === 'other-pair') ? (
      <LeaveWithoutThisSite
        programId={readers.programId}
        pool={placedAt}
        lpMint={p.lpMint}
        lpAccount={p.lpAccount}
        shares={tokenText(p.lpAmount, view ? view.snapshot.pool.lpMintDecimals : null, 'pool shares')}
      />
    ) : null;
  // An open panel stays mounted whatever the offer turns into while its flow runs: its
  // own sent withdrawal makes this pool `held`, and the outcome must stay on screen.
  const panel =
    open && writes && view ? (
      <RemoveLiquidityPanel position={p} view={view} safety={safety} tokenDecimals={decimals} chainNow={chainNow} setAside={setAside} onClose={writes.close} />
    ) : null;

  const removeButton =
    offer === 'offer' ? (
      <button
        type="button"
        className="btn-primary w-full sm:w-auto min-h-[44px] px-4 text-[13px] disabled:opacity-60"
        disabled={blockedByOther}
        aria-expanded={open}
        onClick={(e) => writes?.open('remove', key, e.currentTarget)}
      >
        Remove liquidity
      </button>
    ) : null;
  // One row for both: stacked and full width on a phone, side by side from `sm:` up.
  const buttons =
    removeButton || addMore ? (
      <div className="flex flex-col sm:flex-row gap-2">
        {removeButton}
        {addMore}
      </div>
    ) : null;
  // Said once under the row, for whichever button a running flow has switched off.
  const wait = (removeButton && blockedByOther) || (addMore && flowRunning) ? <Notice>Finish or close the open liquidity panel first.</Notice> : null;

  // Why the share cannot be taken out here, or the other thing to press. Above the buttons.
  let line: ReactNode = null;
  switch (offer) {
    case 'offer':
      break;
    case 'switched-off':
      line = (
        <Notice tone="warn">
          Withdrawals are switched off on this pool by the pool program&apos;s admin (the team&apos;s vault). Only the vault can switch them
          back on. Your pool shares stay in your wallet and keep their claim on the pool.
        </Notice>
      );
      break;
    case 'vault-frozen': {
      // Who can have frozen it is the Withdrawals row's own answer (`vaultFreezer`): the
      // read does not say which vault is frozen, and on a pool paired with USDC it may be
      // USDC's. This notice blamed the token's issuer on every pool, one line under a row
      // that said otherwise. Written with the sentence's own apostrophes, so on a pool
      // whose coin nobody can freeze it reads to the letter as it always did.
      const who = view ? vaultFreezer(view.quote).replace(/’/g, "'") : 'an issuer';
      line = (
        <Notice tone="warn">
          {who.charAt(0).toUpperCase() + who.slice(1)} has frozen one of this pool&apos;s vaults, so nothing can move in or out, for anyone. That is the
          issuer&apos;s doing, not the pool program&apos;s. Your pool shares stay in your wallet.
        </Notice>
      );
      break;
    }
    case 'dust':
      line = (
        <Notice tone="warn">
          This share is too small to take out at the pool&apos;s current size: one side would round to zero (the pool program&apos;s rule).
          Nothing is lost by waiting; if the pool grows, it may become possible.
        </Notice>
      );
      break;
    case 'other-pair':
      line = <Notice>Neither side of this pool is {QUOTE_COINS_OR}. This site cannot build a withdrawal for it. The pool program still lets you withdraw.</Notice>;
      break;
    case 'unplaced':
      line = <FindOnChain readers={readers} p={p} disabled={blockedByOther} onPlaced={onReadAgain} />;
      break;
    case 'pool-unread':
      line = (
        <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" onClick={onReadAgain}>
          Read my positions again
        </button>
      );
      break;
    case 'held':
      line = <Notice tone="warn">A withdrawal you sent from this pool is not confirmed yet (see the top of this section).</Notice>;
      break;
    case 'gate':
      line = (
        <Notice>
          Removing liquidity needs this page to reach the pool program, and it cannot right now (see the note at the top of this section).
        </Notice>
      );
      break;
    case 'off':
      // Said only where there is a share to leave with: an unplaced row has its own lines.
      line =
        placedAt !== null ? (
          <Notice>
            Removing liquidity from this site is switched off right now. The pool program still lets you withdraw, and your shares are safe
            in your wallet.
          </Notice>
        ) : null;
      break;
  }
  if (!line && !buttons && !leaving && !panel) return null;
  return (
    <div className="space-y-2 pt-1">
      {line}
      {buttons}
      {wait}
      {leaving}
      {panel}
    </div>
  );
}

type FindState = { status: 'idle' } | { status: 'searching' } | { status: 'not-found' } | { status: 'unread'; detail: string };

/**
 * Leaving does not depend on our index (D12): a share the index could not place can be
 * placed from its own chain history. A match is proven twice (the program derives this
 * share's mint from the pool, and the pool names that mint) and kept for the session, so
 * reading the positions again shows the row placed `chain`, with Remove offered.
 */
function FindOnChain({ readers, p, disabled, onPlaced }: { readers: LpReaders; p: Position; disabled: boolean; onPlaced: () => void }) {
  const [state, setState] = useState<FindState>({ status: 'idle' });
  const find = async () => {
    setState({ status: 'searching' });
    try {
      const r = await readers.placeShareOnChain({ lpMint: p.lpMint, lpAccount: p.lpAccount });
      if (r.kind === 'placed') {
        setState({ status: 'idle' });
        onPlaced();
      } else if (r.kind === 'not-found') setState({ status: 'not-found' });
      else setState({ status: 'unread', detail: r.detail });
    } catch (e) {
      setState({ status: 'unread', detail: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="btn-secondary w-full sm:w-auto min-h-[44px] px-4 text-[13px] disabled:opacity-60"
        disabled={disabled || state.status === 'searching'}
        onClick={() => void find()}
      >
        Find this share&apos;s pool on the chain
      </button>
      {/* Always there, so each answer is read out when it arrives. */}
      <p role="status" className="text-white/70">
        {state.status === 'searching'
          ? 'Looking for this share’s pool on the chain…'
          : state.status === 'not-found'
            ? 'We could not find this share’s pool from its recent history. Your shares are safe in your wallet. Read again later.'
            : state.status === 'unread'
              ? `We could not read the chain just now (${state.detail}). Your shares are safe in your wallet. Try again.`
              : ''}
      </p>
    </div>
  );
}
