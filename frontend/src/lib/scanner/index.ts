// Public token scanner — barrel + default adapter dispatcher.
//
//   import { scanTokenLive, detectChain } from '@/lib/scanner';
//   const outcome = await scanTokenLive('0x420698…');
//
// `scanTokenLive` wires the real per-chain data adapters into the pure orchestrator
// in `scanner.ts`. Tests can bypass the network by calling `scanToken` directly with
// their own `fetchFor`.

import { fetchEthereumScan } from './ethereumAdapter';
import { fetchSolanaScan } from './solanaAdapter';
import { scanToken, type AdapterResult, type ScanChain, type ScanOutcome } from './scanner';

export * from './scanner';
export { parseSolanaScan, fetchSolanaScan } from './solanaAdapter';
export { parseEthereumScan, fetchEthereumScan } from './ethereumAdapter';

/** Default adapter dispatcher — picks the live data adapter for a detected chain. */
export function defaultFetchFor(chain: ScanChain, address: string, signal?: AbortSignal): Promise<AdapterResult> {
  return chain === 'solana' ? fetchSolanaScan(address, signal) : fetchEthereumScan(address, signal);
}

/** Run a live scan (auto-detect chain, fetch real holders, run the detection core). */
export function scanTokenLive(
  rawAddress: string,
  opts: { signal?: AbortSignal; chainOverride?: ScanChain } = {},
): Promise<ScanOutcome> {
  return scanToken(rawAddress, { ...opts, fetchFor: defaultFetchFor });
}
