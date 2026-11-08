// Which transaction format the connected wallet gets. Web3-free (types only), like
// sameToSign.ts, so a panel imports it without the write layer.

import type { TxSigner, TxVersion } from './types';

/** Version 1 (SIMD-0385) for a wallet that signs raw bytes, legacy for every other. */
export function txVersionOf(signer: Pick<TxSigner, 'signV1'> | null | undefined): TxVersion {
  return signer?.signV1 ? 1 : 'legacy';
}
