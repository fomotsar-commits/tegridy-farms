import type { ReactNode } from 'react';
import { CardArt } from '../../ui/CardArt';
import { Card, ExplorerLink, Row } from './ui';
import { noteKey, type PendingTrade } from './pendingTrade';
import type { PendingTradesState } from './usePendingTrades';

/**
 * Transactions sent from this browser that the chain has not answered for yet. The
 * forms they hold stay off until it has. Shared by a launch's page (its trades) and
 * the pools page (liquidity); each passes its own words.
 */
export function PendingTradeCard({
  state,
  explorerUrl,
  title,
  lead,
  testId,
  describe,
  dismissLabel = 'I checked my wallet: start over',
  dismissMeans,
}: {
  state: Pick<PendingTradesState, 'notes' | 'checking' | 'message' | 'recheck' | 'dismiss'>;
  explorerUrl: (signature: string) => string;
  title: string;
  /** What this is and what not to do, above the notes. */
  lead: ReactNode;
  testId: string;
  /** What one note was (its pool, what it did), above its signature. */
  describe?: (note: PendingTrade) => ReactNode;
  dismissLabel?: string;
  /** What pressing the dismiss button does and does not do, under it. */
  dismissMeans?: string;
}) {
  return (
    <Card title={title} testId={testId} art={<CardArt pageId="pending-trade" idx={0} />}>
      {lead}
      {/* Always there, so each check's answer is read out when it arrives. */}
      <p role="status" className="text-white/55">
        {state.checking ? 'Checking it on the network…' : (state.message ?? '')}
      </p>
      {state.notes.map((n) => (
        <div key={noteKey(n)} className="space-y-1">
          {describe?.(n)}
          {/* A lost wallet answer has none: its `describe` says so. */}
          {n.signature !== null && (
            <>
              <Row label="Transaction signature" value={n.signature} />
              <ExplorerLink href={explorerUrl(n.signature)} />
            </>
          )}
        </div>
      ))}
      {/* aria-disabled, not disabled: a button switched off under the keyboard drops focus to the page. */}
      <button
        type="button"
        className={`btn-primary w-full min-h-[44px] py-2 text-[12px] ${state.checking ? 'opacity-60' : ''}`}
        aria-disabled={state.checking || undefined}
        onClick={() => !state.checking && state.recheck()}
      >
        Check again
      </button>
      <button
        type="button"
        className={`btn-secondary w-full min-h-[44px] py-2 text-[12px] ${state.checking ? 'opacity-60' : ''}`}
        aria-disabled={state.checking || undefined}
        onClick={() => !state.checking && state.dismiss()}
      >
        {dismissLabel}
      </button>
      {dismissMeans && <p className="text-white/55">{dismissMeans}</p>}
    </Card>
  );
}
