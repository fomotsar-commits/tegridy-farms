// Fetches real Minswap V2 batches from mainnet (Koios's public API) into
// test/fixtures/minswap-batches.json: each batch's raw transaction bytes, and the raw bytes of
// every output it spends or references. The engine replays them (test/replay.test.ts): our
// pools run Minswap V2's contracts, so reproducing Minswap's own batches exactly is the proof
// the engine computes what the contract checks. Re-run only to add batches:
//   node scripts/fetch-fixtures.ts
import { writeFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';

const KOIOS = 'https://api.koios.rest/api/v1';
const OUT = new URL('../test/fixtures/minswap-batches.json', import.meta.url);

/** Each batch, and what it covers. */
const BATCHES: { tx: string; covers: string }[] = [
  { tx: '075110cd90ac76195e150de862ccfd48659e2e5f2c4338f0aa5b175fdff121e2', covers: "the venue's own buy: 25 ADA for MIN (SwapExactIn A->B)" },
  { tx: 'e28f404431713f6e810b89b4028e35c519fa1ff9b55e3c91f911912fa65184e4', covers: "the venue's own sell: MIN for ADA (SwapExactIn B->A)" },
  { tx: 'fe7b2977fa272e77333a2e7b641842b9a3952c168469d5ce60416220ba1994b3', covers: '7 SwapExactIn in one batch' },
  { tx: '223c30c2479bd551e1df557ed9df1c0157e97ca3369d4b4e80566311fda30d95', covers: '5 SwapExactIn in one batch' },
  { tx: '60fba39bc2e8815052a9fe09d9005f9c68e8fbc9c7484bb428746ab65ad8886e', covers: 'SwapExactIn and SwapExactOut together' },
  { tx: 'dc90a7a0a505b617eab7c59604a30dc61ea83c56789e18bca3c92a213dfc43f0', covers: 'SwapExactOut' },
  { tx: 'c25666343482f3463978ca90e4e4624627b0b0a67347d220fd95a0c953c293d5', covers: '2 Deposits in one batch' },
  { tx: '02c33a6483f9eeb56518e42f7cfb20433d4dbb11c7e5f06dfde738a83678beb5', covers: 'Deposit' },
  { tx: '25b67a01b32f5b9201c6141733914cda35bd7acbd02059d9187175dfb0133e3d', covers: 'Withdraw' },
  { tx: '99354905d9a28e8c5709c19b43a66324056dc532919a9c8835da4c820e7d415a', covers: 'Withdraw' },
  { tx: '3d67007249f1345215d9bba21eb559e1f6de32b3e3a532c8dc0ac1048c7a02ee', covers: 'an order whose datum travels by hash' },
  { tx: 'aecad5657386182b9964e463fe929c23e255507ba00b97027221a93d5ce6c060', covers: 'ZapOut: a type v1 does not build, so it must be refused, never guessed' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function txCbor(hashes: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < hashes.length; i += 20) {
    const chunk = hashes.slice(i, i + 20);
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${KOIOS}/tx_cbor`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ _tx_hashes: chunk }) });
      if (r.status === 429 && attempt < 4) { await sleep(3000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`tx_cbor HTTP ${r.status}`);
      for (const row of (await r.json()) as { tx_hash: string; cbor: string }[]) out.set(row.tx_hash, row.cbor);
      break;
    }
    await sleep(500);
  }
  for (const h of hashes) if (!out.has(h)) throw new Error(`Koios has no bytes for ${h}`);
  return out;
}

const batchCbor = await txCbor(BATCHES.map((b) => b.tx));
const refsOf = (hex: string): string[] => {
  const body = CSL.FixedTransaction.from_hex(hex).body();
  const refs: string[] = [];
  const add = (ins: CSL.TransactionInputs | undefined) => {
    for (let i = 0; ins && i < ins.len(); i++) refs.push(`${ins.get(i).transaction_id().to_hex()}#${ins.get(i).index()}`);
  };
  add(body.inputs());
  add(body.reference_inputs());
  add(body.collateral());
  return refs;
};
const wanted = [...new Set([...batchCbor.values()].flatMap(refsOf))];
const producers = await txCbor([...new Set(wanted.map((r) => r.split('#')[0]!))]);
const spent: Record<string, string> = {};
for (const ref of wanted) {
  const [hash, ix] = ref.split('#') as [string, string];
  const outs = CSL.FixedTransaction.from_hex(producers.get(hash)!).body().outputs();
  spent[ref] = outs.get(Number(ix)).to_hex();
}
writeFileSync(
  OUT,
  JSON.stringify(
    {
      source: 'Cardano mainnet via Koios tx_cbor; Minswap V2 (minswap-dex-v2 @ c3293ad43) batches, fetched by scripts/fetch-fixtures.ts',
      batches: BATCHES.map((b) => ({ ...b, cbor: batchCbor.get(b.tx) })),
      spent,
    },
    null,
    1,
  ) + '\n',
);
console.log(`wrote ${BATCHES.length} batches and ${Object.keys(spent).length} spent outputs to ${OUT.pathname}`);
