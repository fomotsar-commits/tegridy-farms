import { useCallback, useEffect, useState, type ReactNode, type Ref } from 'react';
import type { PublicKey } from '@solana/web3.js';
import { displaySafe } from '../../../lib/launchMetadata/validate';
import { MAX_POSITIONS, type PositionsRead, type Position } from '../../../lib/solana/lp/positions';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { formatWhen, withdrawalsState } from '../../../lib/solana/lp/poolHealth';
import { swapEnabled } from '../../../lib/solana/cpswap/program';
import { solText, tokenText } from '../../../lib/solana/lp/format';
import { SolanaConnectButton } from '../SolanaConnectButton';
import { WalletAppHint } from '../curve/WalletNeeded';
import { Card, Notice, Row } from '../curve/ui';
import { CardArt } from '../../ui/CardArt';
import { LeaveWithoutThisSite } from './LpDisclosures';
import { lpHeld, withdrawOffer, type WithdrawOffer } from './offers';
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

const VERDICT_WORD = { blocked: 'blocked on this site', warn: 'allowed, with warnings', ok: 'no problems found' } as const;
const WITHDRAWALS_WORD = { open: 'open', 'switched-off': 'switched off', 'vault-frozen': 'blocked: a pool vault is frozen by the token’s issuer' } as const;

/**
 * Shares that are set aside, below the rest and without the names their tokens give
 * themselves: anyone can send pool shares of a junk pool to any wallet, and a junk
 * token's name is whatever its maker typed.
 */
function setAsideReason(p: Position, safety: TokenSafety | null): string | null {
  if (p.pool?.kind === 'pool' && safety?.kind === 'read' && safety.verdict === 'blocked') return 'its token is blocked on this site';
  if (p.pool?.kind === 'other-pair') return 'its pool is not a TOKEN/SOL pool';
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

export function YourPositions({
  readers,
  owner,
  reloadKey = 0,
  sectionRef,
}: {
  readers: LpReaders;
  owner: PublicKey | null;
  reloadKey?: number;
  /** Set by the section: "Remove liquidity" scrolls here and sends focus here. */
  sectionRef?: Ref<HTMLElement>;
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
      <Card title="Your positions" art={<CardArt pageId="solana-lp" idx={3} />}>
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
            onMore={() => setLimit((l) => l + MAX_POSITIONS)}
            onReadAgain={readAgain}
            readers={readers}
          />
        )}
      </Card>
    </section>
  );
}

function PositionsList({
  read,
  safety,
  onMore,
  onReadAgain,
  readers,
}: {
  read: Extract<PositionsRead, { kind: 'ok' }>;
  safety: Map<string, TokenSafety>;
  onMore: () => void;
  onReadAgain: () => void;
  readers: LpReaders;
}) {
  const safetyOf = (p: Position) => (p.pool?.kind === 'pool' ? safety.get(p.pool.view.tokenMint) ?? null : null);
  const main = read.positions.filter((p) => setAsideReason(p, safetyOf(p)) === null);
  const aside = read.positions.filter((p) => setAsideReason(p, safetyOf(p)) !== null);
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
            <PositionRow key={p.lpAccount} p={p} safety={safetyOf(p)} chainNow={read.chainNow} readers={readers} onReadAgain={onReadAgain} />
          ))}
        </ul>
      )}
      {aside.length > 0 && (
        <details data-testid="lp-positions-set-aside" className="rounded-lg" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
          <summary className="min-h-[44px] flex items-center px-3 cursor-pointer text-white/75">
            {plural(aside.length, 'other pool share', 'other pool shares')}, set aside without their names: blocked tokens, pools that are
            not TOKEN/SOL, or pools we could not confirm
          </summary>
          <ul className="space-y-3 p-3">
            {aside.map((p) => (
              <PositionRow
                key={p.lpAccount}
                p={p}
                safety={safetyOf(p)}
                chainNow={read.chainNow}
                setAside={setAsideReason(p, safetyOf(p))}
                readers={readers}
                onReadAgain={onReadAgain}
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

function PositionRow({
  p,
  safety,
  chainNow,
  setAside = null,
  readers,
  onReadAgain,
}: {
  p: Position;
  safety: TokenSafety | null;
  chainNow: bigint | null;
  setAside?: string | null;
  readers: LpReaders;
  onReadAgain: () => void;
}) {
  const view = p.pool?.kind === 'pool' ? p.pool.view : null;
  const decimals = safety?.kind === 'read' ? safety.facts?.decimals ?? null : null;
  const pool = p.pool;
  const writes = useLpWrites();
  // The pool a pending withdrawal would name: the read pool, or the address the share was placed at.
  const poolAddress = view?.address ?? (pool && pool.kind !== 'pool' ? pool.address : null);
  const offer = withdrawOffer({
    mode: writes?.mode ?? 'off',
    gate: writes?.gate ?? null,
    position: p,
    held: writes !== null && poolAddress !== null && lpHeld(writes.pending.notes, poolAddress, 'remove'),
  });
  return (
    <li
      className="rounded-lg p-3 space-y-1.5"
      style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.08)' }}
      data-testid="lp-position"
      data-pool={view?.address ?? ''}
      data-placement={p.placement}
      data-pool-kind={pool?.kind ?? 'none'}
      data-remove={offer}
    >
      <Row label="Pool share token" value={p.lpMint} />
      <Row label="You hold" value={tokenText(p.lpAmount, view ? view.snapshot.pool.lpMintDecimals : null, 'shares')} mono={false} />
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
          <Notice>Neither side of this pool is SOL. This site does not show those pools yet, so nothing about it is checked here.</Notice>
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
          <Row label="Pool" value={view.address} />
          <Row label="Token" value={view.tokenMint} />
          {!setAside && safety?.kind === 'read' && (safety.name || safety.symbol) && (
            <Row label="Calls itself" value={`${displaySafe(safety.name ?? '', 32)} (${displaySafe(safety.symbol ?? '', 12)})`} mono={false} />
          )}
          <Row
            label="Token check"
            value={!safety ? 'not read' : safety.kind === 'read' ? VERDICT_WORD[safety.verdict] : safety.kind === 'absent' ? 'not a token' : 'not read'}
            mono={false}
          />
          {p.value ? (
            <>
              <Row label="Your share of the pool" value={`${p.value.sharePct.toFixed(4)}%`} mono={false} />
              <Row
                label="Worth if withdrawn now"
                value={
                  view.solIsToken0
                    ? `${solText(p.value.token0)} and ${tokenText(p.value.token1, decimals)}`
                    : `${solText(p.value.token1)} and ${tokenText(p.value.token0, decimals)}`
                }
                mono={false}
              />
            </>
          ) : p.tooSmall ? (
            <Notice tone="warn">Too small to take out at the pool&apos;s current size: one side would round to zero.</Notice>
          ) : (
            <Notice tone="warn">Its value could not be worked out.</Notice>
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
          <Row label="Withdrawals" value={WITHDRAWALS_WORD[withdrawalsState(view)]} mono={false} />
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
      />
    </li>
  );
}

/**
 * What a position row offers for taking liquidity out (spec 4.3), from `withdrawOffer`:
 * the Remove button and its panel, the "find this share's pool on the chain" search
 * when our index could not place it, or one line saying why not. A placed share that
 * this site cannot take out right now also shows how to leave without it.
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
}) {
  const key = `remove:${p.lpAccount}`;
  const open = writes?.active?.key === key;
  const blockedByOther = !!writes?.busy && !open;
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

  let line: ReactNode = null;
  switch (offer) {
    case 'offer':
      line = (
        <>
          <button
            type="button"
            className="btn-primary w-full sm:w-auto min-h-[44px] px-4 text-[13px] disabled:opacity-60"
            disabled={blockedByOther}
            aria-expanded={open}
            onClick={(e) => writes?.open('remove', key, e.currentTarget)}
          >
            Remove liquidity
          </button>
          {blockedByOther && <Notice>Finish or close the open liquidity panel first.</Notice>}
        </>
      );
      break;
    case 'switched-off':
      line = (
        <Notice tone="warn">
          Withdrawals are switched off on this pool by the pool program&apos;s admin (the team&apos;s vault). Only the vault can switch them
          back on. Your pool shares stay in your wallet and keep their claim on the pool.
        </Notice>
      );
      break;
    case 'vault-frozen':
      line = (
        <Notice tone="warn">
          The token&apos;s issuer has frozen one of this pool&apos;s vaults, so nothing can move in or out, for anyone. That is the
          issuer&apos;s doing, not the pool program&apos;s. Your pool shares stay in your wallet.
        </Notice>
      );
      break;
    case 'dust':
      line = (
        <Notice tone="warn">
          This share is too small to take out at the pool&apos;s current size: one side would round to zero (the pool program&apos;s rule).
          Nothing is lost by waiting; if the pool grows, it may become possible.
        </Notice>
      );
      break;
    case 'other-pair':
      line = <Notice>Neither side of this pool is SOL. This site cannot build a withdrawal for it yet. The pool program still lets you withdraw.</Notice>;
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
  if (!line && !leaving && !panel) return null;
  return (
    <div className="space-y-2 pt-1">
      {line}
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
