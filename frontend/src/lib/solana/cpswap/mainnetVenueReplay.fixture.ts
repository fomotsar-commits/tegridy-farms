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
 * Both fee tiers' bytes as mainnet holds them since the island split (Squads #13, executed
 * 2026-10-19), read with getMultipleAccounts at finalized slot 459,685,071 on 2026-10-21.
 * The recording above predates the split: its tier 1 sends the whole 16% to the vault.
 */
export const SPLIT_TIER_BYTES = {
  0: '2vQhaMvLK2/9AAAAxAkAAAAAAADQ+wEAAAAAAHARAQAAAAAAAAAAAAAAAADlHNw/6eW4EcmokvPIdZLieSu4EBsSqEDvnU52HLfxSAPZGg5/+tHuG4mkK5QI8T4VwAVH8hK0ZE69i5NuyA38iBMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  1: '2vQhaMvLK2//AAEAECcAAAAAAABAlgEAAAAAAMDaAAAAAAAAgNHwCAAAAADlHNw/6eW4EcmokvPIdZLieSu4EBsSqEDvnU52HLfxSAPZGg5/+tHuG4mkK5QI8T4VwAVH8hK0ZE69i5NuyA38AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
} as const;

/** A fee tier as mainnet holds it since the split, decoded from `SPLIT_TIER_BYTES` with the repo's decoder. */
export function splitTier(index: 0 | 1): AmmConfigView {
  const config = decodeAmmConfig(index === 0 ? RECORDING.tier0 : RECORDING.tier1, bytes(SPLIT_TIER_BYTES[index]));
  if (!config) throw new Error(`the split fee tier ${index} does not decode`);
  return config;
}

/** `recordedFeeTiers` with both tiers as mainnet holds them since the split. */
export function splitFeeTiers(): FeeTierRead {
  const read = recordedFeeTiers();
  if (read.kind !== 'ok') throw new Error('the recording did not read');
  return { ...read, tiers: read.tiers.map((t) => ({ ...t, config: splitTier(t.index as 0 | 1) })) };
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
