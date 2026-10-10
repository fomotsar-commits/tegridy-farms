import { PendingTradeCard } from '../solana/curve/PendingTradeCard';
import { TxFlowView } from '../solana/curve/TxFlowView';
import { Notice } from '../solana/curve/ui';
import type { VenueSwap } from './useVenueSwap';

/**
 * What the swap page shows in place of its form while a swap in our own pool is under
 * way (the review, the wallet's turn, the wait, the answer), and the note of a swap this
 * browser sent and could not confirm. Its own chunk: the page asks for it only when one
 * of those is on screen.
 */
export default function VenueSwapFlow({ swap }: { swap: VenueSwap }) {
  const { flow, api, cfg, signerState, pending } = swap;
  const cluster = cfg?.cluster ?? 'mainnet';
  if (flow.state.step === 'idle') {
    if (pending.notes.length === 0) return null;
    return (
      <PendingTradeCard
        state={pending}
        explorerUrl={(sig) => (api ? api.explorerTxUrl(sig, cluster) : `https://solscan.io/tx/${sig}`)}
        title="A swap you sent is not confirmed yet"
        lead={<Notice tone="warn">It may still land. Buying again now could make you pay twice. Check it first.</Notice>}
        testId="venue-swap-pending"
      />
    );
  }
  return (
    <div className="text-white/60 text-[11px] leading-relaxed space-y-2" data-testid="venue-swap-flow">
      {api ? (
        <TxFlowView flow={flow} api={api} cluster={cluster} decimals={null} signer={signerState.kind === 'ready' ? signerState.signer : null} />
      ) : (
        <p role="status">Building the transaction and test-running it on the network…</p>
      )}
    </div>
  );
}
