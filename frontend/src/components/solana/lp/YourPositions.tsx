import { useEffect, useState } from 'react';
import type { PublicKey } from '@solana/web3.js';
import { displaySafe } from '../../../lib/launchMetadata/validate';
import { MAX_POSITIONS, type PositionsRead, type Position } from '../../../lib/solana/lp/positions';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { formatWhen, withdrawalsState } from '../../../lib/solana/lp/poolHealth';
import { swapEnabled } from '../../../lib/solana/cpswap/program';
import { solText, tokenText } from '../../../lib/solana/lp/format';
import { SolanaConnectButton } from '../SolanaConnectButton';
import { Card, Notice, Row } from '../curve/ui';
import type { LpReaders } from './readers';

type State =
  | { status: 'loading' }
  | { status: 'done'; read: PositionsRead; safety: Map<string, TokenSafety> };

type Done = Extract<State, { status: 'done' }>;

/** Positions for `owner`, keyed like usePoolSearch: an answer is shown only for its own question. */
function usePositions(readers: LpReaders, owner: PublicKey | null, nonce: number, limit: number): State | null {
  const ownerKey = owner?.toBase58() ?? null;
  const key = ownerKey ? `${ownerKey}#${nonce}#${limit}` : null;
  const [answer, setAnswer] = useState<{ key: string; value: Done } | null>(null);
  useEffect(() => {
    if (!owner || !key) return;
    let live = true;
    const finish = (value: Done) => {
      if (live) setAnswer({ key, value });
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
  return answer?.key === key ? answer.value : { status: 'loading' };
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

export function YourPositions({ readers, owner }: { readers: LpReaders; owner: PublicKey | null }) {
  const [nonce, setNonce] = useState(0);
  const [limit, setLimit] = useState(MAX_POSITIONS);
  // A different wallet starts from the first page again (adjusted during render).
  const ownerKey = owner?.toBase58() ?? null;
  const [shownOwner, setShownOwner] = useState(ownerKey);
  if (ownerKey !== shownOwner) {
    setShownOwner(ownerKey);
    setLimit(MAX_POSITIONS);
  }
  const state = usePositions(readers, owner, nonce, limit);
  return (
    <section data-testid="lp-positions" aria-label="Your positions">
      <Card title="Your positions">
        {/* One live region for the whole section, always mounted: only its text changes. */}
        <p role="status" aria-live="polite" className="sr-only" data-testid="lp-positions-status">
          {statusText(owner, state)}
        </p>
        {!owner ? (
          <>
            <p>Connect a Solana wallet to see the pool shares it holds. Reading them sends nothing and signs nothing.</p>
            <SolanaConnectButton />
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
            onReadAgain={() => setNonce((n) => n + 1)}
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
}: {
  read: Extract<PositionsRead, { kind: 'ok' }>;
  safety: Map<string, TokenSafety>;
  onMore: () => void;
  onReadAgain: () => void;
}) {
  const safetyOf = (p: Position) => (p.pool?.kind === 'pool' ? safety.get(p.pool.view.tokenMint) ?? null : null);
  const main = read.positions.filter((p) => setAsideReason(p, safetyOf(p)) === null);
  const aside = read.positions.filter((p) => setAsideReason(p, safetyOf(p)) !== null);
  const more = read.totalShares - read.positions.length;
  if (read.totalShares === 0) {
    return (
      <>
        <p data-testid="lp-no-positions">This wallet holds no shares in our pools.</p>
        <ReadAgain onClick={onReadAgain} />
      </>
    );
  }
  return (
    <>
      {main.length > 0 && (
        <ul className="space-y-3" aria-label="Your pool shares, most valuable first">
          {main.map((p) => (
            <PositionRow key={p.lpAccount} p={p} safety={safetyOf(p)} chainNow={read.chainNow} />
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
              <PositionRow key={p.lpAccount} p={p} safety={safetyOf(p)} chainNow={read.chainNow} setAside={setAsideReason(p, safetyOf(p))} />
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

function PositionRow({ p, safety, chainNow, setAside = null }: { p: Position; safety: TokenSafety | null; chainNow: bigint | null; setAside?: string | null }) {
  const view = p.pool?.kind === 'pool' ? p.pool.view : null;
  const decimals = safety?.kind === 'read' ? safety.facts?.decimals ?? null : null;
  const pool = p.pool;
  return (
    <li
      className="rounded-lg p-3 space-y-1.5"
      style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.08)' }}
      data-testid="lp-position"
      data-pool={view?.address ?? ''}
      data-placement={p.placement}
      data-pool-kind={pool?.kind ?? 'none'}
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
    </li>
  );
}
