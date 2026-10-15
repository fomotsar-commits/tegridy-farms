import type { ReactNode } from 'react';
import { PendingTradeCard } from '../solana/curve/PendingTradeCard';
import { TxFlowView } from '../solana/curve/TxFlowView';
import { Notice } from '../solana/curve/ui';
import {
  HELD_UNTIL,
  HOLD_DISMISS_LABEL,
  HOLD_DISMISS_MEANS,
  LOST_HELD_UNTIL,
  LOST_HOLD_TITLE,
  LOST_NO_SIGNATURE,
} from '../../lib/solana/swap/walletCopy';
import { signerScope, type VenueSwap } from './useVenueSwap';

/**
 * What the swap page shows in place of its form while a swap in our own pool is under
 * way (the review, the wallet's turn, the wait, the answer), and the note of a swap the
 * connected wallet sent from this browser, by either route, that is not confirmed yet.
 * Its own chunk: the page asks for it only when one of those is on screen.
 */
export default function VenueSwapFlow({ swap, extraReview }: { swap: VenueSwap; extraReview?: ReactNode }) {
  const { flow, api, cfg, signerState, pending } = swap;
  const cluster = cfg?.cluster ?? 'mainnet';
  const s = flow.state;
  if (s.step === 'idle') {
    if (pending.notes.length === 0) return null;
    // A lost wallet answer has no signature: the card says so, and its own time limit.
    const signed = pending.notes.some((n) => n.signature !== null);
    const lost = pending.notes.some((n) => n.signature === null);
    return (
      <PendingTradeCard
        state={pending}
        explorerUrl={(sig) => (api ? api.explorerTxUrl(sig, cluster) : `https://solscan.io/tx/${sig}`)}
        title={signed ? 'A swap you sent is not confirmed yet' : LOST_HOLD_TITLE}
        lead={
          <>
            <Notice tone="warn">It may still land. Buying again now could make you pay twice. Check it first.</Notice>
            {signed && <Notice>{HELD_UNTIL}</Notice>}
            {lost && <Notice>{LOST_HELD_UNTIL}</Notice>}
          </>
        }
        describe={(n) => (
          <p className="text-white/70">{n.signature === null ? LOST_NO_SIGNATURE : n.kind === 'jupiter-swap' ? 'Through Jupiter' : 'In our own pool'}</p>
        )}
        testId="venue-swap-pending"
        dismissLabel={HOLD_DISMISS_LABEL}
        dismissMeans={HOLD_DISMISS_MEANS}
      />
    );
  }
  // Sent and not confirmed: "I checked my wallet: start over" also drops its hold, in one press.
  const unsure = s.step === 'outcome' && s.outcome.status === 'unknown' && s.outcome.signature ? s.outcome.signature : null;
  const startOver = unsure
    ? () => {
        pending.release(unsure, (s.step === 'outcome' && s.prepared ? signerScope(s.prepared) : null) ?? undefined);
        flow.reset();
      }
    : undefined;
  return (
    <div className="text-white/60 text-[11px] leading-relaxed space-y-2" data-testid="venue-swap-flow">
      {api ? (
        <TxFlowView
          flow={flow}
          api={api}
          cluster={cluster}
          decimals={null}
          signer={signerState.kind === 'ready' ? signerState.signer : null}
          extraReview={extraReview}
          onOutcomeReset={startOver}
          resetMeans={unsure ? HOLD_DISMISS_MEANS : undefined}
        />
      ) : (
        <p role="status">Building the transaction and test-running it on the network…</p>
      )}
    </div>
  );
}
