// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../../lib/solanaPolyfill';
import { SolanaProviders } from '../solana/SolanaProviders';
import { SheetBodyOutlet } from './SheetOutlet';

/**
 * The sheet's own Solana connection, for a page that has none of its own (a room's door with
 * no cards, the launch door). Mounted as a page section, so the top bar's own connection
 * steps aside while it is up: still one live connection on the page (lib/solanaSurface.ts).
 */
export default function SheetOwnConnection() {
  return (
    <SolanaProviders>
      <SheetBodyOutlet page={false} />
    </SolanaProviders>
  );
}
