// Test-only. Reads __fixtures__/mainnet-accounts.json (scripts/record-clmm-fixture.mjs): real
// accounts of the live range program whose layout the venue's copy shares, read from mainnet
// with plain reads. Node only (it reads a file); nothing here can reach the site's bundle.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

export type RecordedKind = 'pool' | 'config' | 'observation' | 'extension' | 'vault' | 'tickArray' | 'position';

export interface RecordedAccount {
  kind: RecordedKind;
  owner: string;
  lamports: number;
  data: Uint8Array;
}

export interface RecordedPool {
  pool: string;
  slot: number;
  allBandsInFull: boolean;
  allPositions: boolean;
  positionsInPool: number;
  /** Every band the pool owns: address, start index, count of used prices. */
  tickArrays: [string, number, number][];
  accounts: Record<string, RecordedAccount>;
}

export interface Recording {
  recordedAt: string;
  rpcHost: string;
  /** The live program the accounts belong to. Test data only: never a site constant. */
  program: string;
  pools: RecordedPool[];
}

interface RawAccount {
  kind: RecordedKind;
  owner: string;
  lamports: number;
  gz: string;
}

let cached: Recording | null = null;

export function mainnetRecording(): Recording {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__', 'mainnet-accounts.json'), 'utf8')) as Omit<Recording, 'pools'> & {
    pools: (Omit<RecordedPool, 'accounts'> & { accounts: Record<string, RawAccount> })[];
  };
  cached = {
    ...raw,
    pools: raw.pools.map((p) => ({
      ...p,
      accounts: Object.fromEntries(
        Object.entries(p.accounts).map(([address, a]) => [
          address,
          { kind: a.kind, owner: a.owner, lamports: a.lamports, data: Uint8Array.from(gunzipSync(Buffer.from(a.gz, 'base64'))) },
        ]),
      ),
    })),
  };
  return cached;
}

/** The recorded accounts of one kind in a pool, as [address, data]. */
export function accountsOf(p: RecordedPool, kind: RecordedKind): [string, Uint8Array][] {
  return Object.entries(p.accounts)
    .filter(([, a]) => a.kind === kind)
    .map(([address, a]) => [address, a.data]);
}

/** A token account's balance (SPL layout: amount at byte 64). */
export function tokenAmount(data: Uint8Array): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}
