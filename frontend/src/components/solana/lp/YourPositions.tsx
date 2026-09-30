import { useEffect, useState } from 'react';
import type { PublicKey } from '@solana/web3.js';
import { displaySafe } from '../../../lib/launchMetadata/validate';
import type { PositionsRead, Position } from '../../../lib/solana/lp/positions';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { formatWhen } from '../../../lib/solana/lp/poolHealth';
import { swapEnabled, withdrawEnabled } from '../../../lib/solana/cpswap/program';
import { solText, tokenText } from '../../../lib/solana/lp/format';
import { SolanaConnectButton } from '../SolanaConnectButton';
import { Card, Notice, Row } from '../curve/ui';
import type { LpReaders } from './readers';

type State =
  | { status: 'loading' }
  | { status: 'done'; read: PositionsRead; safety: Map<string, TokenSafety> };

type Done = Extract<State, { status: 'done' }>;

/** Positions for `owner`, keyed like usePoolSearch: an answer is shown only for its own question. */
function usePositions(readers: LpReaders, owner: PublicKey | null, nonce: number): State | null {
  const ownerKey = owner?.toBase58() ?? null;
  const key = ownerKey ? `${ownerKey}#${nonce}` : null;
  const [answer, setAnswer] = useState<{ key: string; value: Done } | null>(null);
  useEffect(() => {
    if (!owner || !key) return;
    let live = true;
    const finish = (value: Done) => {
      if (live) setAnswer({ key, value });
    };
    (async () => {
      const read = await readers.positions(owner);
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

export function YourPositions({ readers, owner }: { readers: LpReaders; owner: PublicKey | null }) {
  const [nonce, setNonce] = useState(0);
  const state = usePositions(readers, owner, nonce);
  return (
    <section data-testid="lp-positions" aria-label="Your positions">
      <Card title="Your positions">
        {!owner ? (
          <>
            <p>Connect a Solana wallet to see the pool shares it holds. Reading them sends nothing and signs nothing.</p>
            <SolanaConnectButton />
          </>
        ) : !state || state.status === 'loading' ? (
          <p role="status">Reading your wallet’s pool shares…</p>
        ) : state.read.kind === 'unread' ? (
          <>
            <Notice tone="warn">We could not read your wallet ({state.read.detail}). That does not mean it holds none.</Notice>
            <ReadAgain onClick={() => setNonce((n) => n + 1)} />
          </>
        ) : (
          <>
            <p role="status" className="sr-only">
              {state.read.positions.length === 0 ? 'This wallet holds no pool shares.' : `This wallet holds ${state.read.positions.length} pool share(s).`}
            </p>
            {state.read.positions.length === 0 ? (
              <p data-testid="lp-no-positions">This wallet holds no shares in our pools.</p>
            ) : (
              <ul className="space-y-3">
                {state.read.positions.map((p) => (
                  <PositionRow key={p.lpAccount} p={p} safety={p.pool?.kind === 'pool' ? state.safety.get(p.pool.view.tokenMint) ?? null : null} chainNow={state.read.kind === 'ok' ? state.read.chainNow : null} />
                ))}
              </ul>
            )}
            <ReadAgain onClick={() => setNonce((n) => n + 1)} />
          </>
        )}
      </Card>
    </section>
  );
}

function ReadAgain({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" onClick={onClick}>
      Read my positions again
    </button>
  );
}

function PositionRow({ p, safety, chainNow }: { p: Position; safety: TokenSafety | null; chainNow: bigint | null }) {
  const view = p.pool?.kind === 'pool' ? p.pool.view : null;
  const decimals = safety?.kind === 'read' ? safety.facts?.decimals ?? null : null;
  return (
    <li className="rounded-lg p-3 space-y-1.5" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.08)' }} data-testid="lp-position" data-pool={view?.address ?? ''} data-placement={p.placement}>
      <Row label="Pool share token" value={p.lpMint} />
      <Row label="You hold" value={tokenText(p.lpAmount, view ? view.snapshot.pool.lpMintDecimals : null, 'shares')} mono={false} />
      {p.placement === 'index-unread' && <Notice tone="warn">Our pool index could not be read, so we cannot say which pool this share belongs to yet.</Notice>}
      {p.placement === 'not-found' && <Notice tone="warn">Our pool index has no pool for this share. It may be very new; read again in a minute.</Notice>}
      {p.pool?.kind === 'unread' && <Notice tone="warn">The pool could not be read ({p.pool.detail}).</Notice>}
      {view && (
        <>
          <Row label="Pool" value={view.address} />
          <Row label="Token" value={view.tokenMint} />
          {safety?.kind === 'read' && (safety.name || safety.symbol) && (
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
          <Row label="Withdrawals" value={!withdrawEnabled(view.snapshot.pool) ? 'switched off' : 'open'} mono={false} />
        </>
      )}
    </li>
  );
}
