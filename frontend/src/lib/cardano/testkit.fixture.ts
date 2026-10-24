// Test-only. The real serialization library, loaded from the .wasm on disk, and the mainnet
// records in __fixtures__ (read from Koios on 2026-10-24 with plain reads). Node only (it reads
// files); nothing here can reach the site's bundle.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { loadCslFromBytes, type Csl } from './csl';

let csl: Promise<Csl> | null = null;

export function testCsl(): Promise<Csl> {
  if (!csl) {
    const require = createRequire(import.meta.url);
    const wasm = require.resolve('@emurgo/cardano-serialization-lib-browser/cardano_serialization_lib_bg.wasm');
    csl = loadCslFromBytes(readFileSync(wasm));
  }
  return csl;
}

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(resolve(__dirname, '__fixtures__', name), 'utf8')) as T;
}

/** Three real Minswap V2 swap orders: ADA in (Minswap's site), a token in (Minswap's site), a token in with killable set (another site). */
export const ORDER_TXS = {
  adaIn: '308261ce391a90f8727c9e5f723635f8a8512d10898699e42f7f2b4d3a7a0a48',
  tokenIn: '73a22d3ed91deb5bf614434ef72745b296171d4515baf49bfb33755590b1499f',
  tokenInKillable: '35e569d964d56787c5d238d17ff0c475dad8c121b798f65936985723764f40a1',
} as const;

export const ASCEND = { policyId: 'eb7a93ebc321647673490810f618b548d7c24aa64d30ae342dba7076', assetName: '0014df10415343454e44' };
export const TOOLS = { policyId: 'f0470d121b121f7f211d3c54f860f21b5f676c6c8bad15d14a9e28a7', assetName: '0014df10544f4f4c53' };

export function orderTxCbor(txHash: string): string {
  const rows = fixture<{ tx_hash: string; cbor: string }[]>('koios-tx-cbor-three-orders.json');
  const row = rows.find((r) => r.tx_hash === txHash);
  if (!row) throw new Error(`no fixture for ${txHash}`);
  return row.cbor;
}
