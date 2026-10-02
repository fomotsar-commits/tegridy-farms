// Polyfill MUST load before any @solana/* import, same rule as SolanaProviders.
import '../../lib/solanaPolyfill';
import { SolanaProviders } from '../solana/SolanaProviders';
import type { Bungalow } from '../../lib/bungalows';
import { SolanaLadderPoolCard } from './SolanaLadderPoolLive';
import { LighthouseClaimStrip } from './LighthousePoolLive';

/**
 * The ladder card with a members-only Streamflow pool's claim strip beneath it, in one
 * column (BungalowFarmPanel gives it the full row). ONE SolanaProviders: a second
 * WalletProvider reads the saved wallet only when it mounts, so a member who connected
 * through the ladder would not appear in a separately provided strip until a reload.
 */
export function SolanaPoolStack({ bungalow }: { bungalow: Bungalow & { ladderPool: string; stakePool: string } }) {
  return (
    <SolanaProviders>
      <div className="flex flex-col gap-5">
        <SolanaLadderPoolCard bungalow={bungalow} />
        <LighthouseClaimStrip bungalow={bungalow} />
      </div>
    </SolanaProviders>
  );
}
