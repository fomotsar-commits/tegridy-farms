// Test-only: what /pools read from mainnet (mainnetVenue.fixture.ts, written by
// scripts/record-pools-venue-fixture.mjs) served back as a JSON-RPC transport, so a test
// reads the venue through the repo's own read path and every fee it checks is one the
// chain returned. em-dash-zero.spec.ts serves the same recording at /api/solrpc.

import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import type { FeeTierRead } from '../lp/poolFinder';
import { MAINNET_VENUE_RECORDING } from './mainnetVenue.fixture';
import { decodeAmmConfig, type AmmConfigView } from './program';

export const RECORDING = MAINNET_VENUE_RECORDING;

/** The key a recorded answer sits under, as the e2e spec keys a request. */
export const recordingKey = (method: string, params: readonly unknown[]) => `${method}:${String(params[0])}`;

/**
 * Answers exactly the recorded calls, each with a fresh copy of what mainnet returned.
 * A call the recording does not hold throws and names itself, so a read path that starts
 * asking something new fails here instead of being answered by a guess.
 */
export function recordedRpc(calls?: string[]): SolanaRpc {
  const answers: Record<string, unknown> = RECORDING.answers;
  return async (method, params) => {
    const k = recordingKey(method, params);
    calls?.push(k);
    if (!(k in answers)) throw new Error(`the mainnet recording holds no answer for ${k}`);
    return structuredClone(answers[k]);
  };
}

function bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A recorded fee tier, decoded from its recorded bytes with the repo's decoder. For a
 * test that mocks the read module; the read path itself is checked against these in
 * mainnetVenue.test.ts.
 */
export function recordedTier(index: 0 | 1): AmmConfigView {
  const address = index === 0 ? RECORDING.tier0 : RECORDING.tier1;
  const answer = RECORDING.answers[`getAccountInfo:${address}`];
  const config = decodeAmmConfig(address, bytes(answer.value.data[0]));
  if (!config) throw new Error(`the recorded fee tier ${index} does not decode`);
  return config;
}

/**
 * What the fee-tier card's `readFeeTiers` returns over the recording, built without
 * deriving an address (derivation cannot run under jsdom). mainnetVenue.test.ts holds
 * that the read path returns exactly this.
 */
export function recordedFeeTiers(): FeeTierRead {
  const rent = (n: 637 | 4075 | 82 | 165) => BigInt(RECORDING.answers[`getMinimumBalanceForRentExemption:${n}`]);
  return {
    kind: 'ok',
    // poolFinder.ts NEVER_REFUNDED_ACCOUNT_SIZES: the pool, its price record, its share mint, two vaults.
    openingDeposits: rent(637) + rent(4075) + rent(82) + rent(165) + rent(165),
    tiers: [
      { index: 0, address: RECORDING.tier0, config: recordedTier(0), state: 'live' },
      { index: 1, address: RECORDING.tier1, config: recordedTier(1), state: 'live' },
    ],
  };
}
