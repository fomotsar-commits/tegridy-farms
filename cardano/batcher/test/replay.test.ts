// The engine against the chain: real Minswap V2 batches from mainnet
// (test/fixtures/minswap-batches.json, fetched by scripts/fetch-fixtures.ts), read the way the
// pool contract reads them and recomputed from scratch. Our pools run Minswap V2's contracts
// (one constant patched, which batches never read), so reproducing every order output and the
// pool's new state exactly, to the unit, is what proves the engine computes what the contract
// checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAINNET_TIME } from '../src/chain.ts';
import { Unsupported } from '../src/engine.ts';
import { verifySinglePoolBatch, type DexConstants } from '../src/verify.ts';

/** Minswap V2 on mainnet (deployed/mainnet/script.json in cardano/minswap-dex-v2). Minswap's, not ours. */
const MINSWAP_MAINNET: DexConstants = {
  authenPolicy: 'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c',
  poolScriptHash: 'ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b',
  time: MAINNET_TIME,
};

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/minswap-batches.json', import.meta.url), 'utf8')) as {
  batches: { tx: string; covers: string; cbor: string }[];
  spent: Record<string, string>;
};

for (const b of fixtures.batches) {
  if (b.covers.startsWith('ZapOut')) {
    test(`refuses, never guesses: ${b.covers} (${b.tx.slice(0, 12)}…)`, () => {
      assert.throws(() => verifySinglePoolBatch(b.cbor, fixtures.spent, MINSWAP_MAINNET), (e: unknown) => e instanceof Unsupported && e.kind === 'ZapOut');
    });
    continue;
  }
  test(`reproduces a real Minswap batch exactly: ${b.covers} (${b.tx.slice(0, 12)}…)`, () => {
    const r = verifySinglePoolBatch(b.cbor, fixtures.spent, MINSWAP_MAINNET);
    assert.ok(r.orders.length > 0);
    // Batches never move the pool's fee settings; what they move is the reserves.
    assert.ok(r.stateOut.datumReserveA !== r.stateIn.datumReserveA || r.stateOut.totalLiquidity !== r.stateIn.totalLiquidity || r.orders.every((o) => !o.filled));
  });
}

test('the fixtures cover every order type the batcher builds', () => {
  const steps = new Set<string>();
  for (const b of fixtures.batches) {
    if (b.covers.startsWith('ZapOut')) continue;
    for (const o of verifySinglePoolBatch(b.cbor, fixtures.spent, MINSWAP_MAINNET).orders) steps.add(o.step);
  }
  assert.deepEqual([...steps].sort(), ['Deposit', 'SwapExactIn', 'SwapExactOut', 'Withdraw']);
});
