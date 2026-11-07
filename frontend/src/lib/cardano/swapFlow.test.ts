// prepareSwap against the real ADA/ASCEND pool (fixtures), with the proxy and the wallet stubbed.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrivateKey } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from './csl';
import { composeAddress, hexToBytes, type ParsedAddress } from './address';
import { ADA } from './minswapV2';
import { prepareSwap, quoteNow } from './swapFlow';
import { ASCEND, fixture, testCsl } from './testkit.fixture';

const PARAMS = { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310, maxTxSize: 16384, maxValueSize: 5000, stakeAddressDeposit: 2000000, stakePoolDeposit: 500000000, minFeeRefScriptCostPerByte: 15 };

let csl: Csl;
let key: PrivateKey;
let trader: ParsedAddress;

beforeAll(async () => {
  csl = await testCsl();
  key = csl.PrivateKey.generate_ed25519();
  trader = composeAddress({ kind: 'key', hash: key.to_public().hash().to_hex() }, null);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const op = new URL(url, 'https://site.test').pathname.replace('/api/cardano/', '');
      const body = op === 'pool' ? fixture('koios-asset-utxos-two-pools.json') : op === 'params' ? PARAMS : op === 'tip' ? [{ abs_slot: 201256000, block_height: 1, block_time: 1 }] : undefined;
      return body === undefined ? new Response('no', { status: 500 }) : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});

function api() {
  const utxo = csl.TransactionUnspentOutput.new(
    csl.TransactionInput.new(csl.TransactionHash.from_hex('ab'.repeat(32)), 0),
    csl.TransactionOutput.new(csl.Address.from_bytes(hexToBytes(trader.hex)), csl.Value.new(csl.BigNum.from_str('900000000'))),
  );
  return {
    getNetworkId: async () => 1,
    getChangeAddress: async () => trader.hex,
    getUtxos: async () => [utxo.to_hex()],
    signTx: async () => '',
    submitTx: async () => '',
  };
}

describe('prepareSwap', () => {
  it('never writes a minimum below the fresh quote’s, even when the one on screen was lower', async () => {
    const q = await quoteNow(csl, ASCEND, ADA, 400_000_000n, 100);
    expect(q.kind).toBe('quote');
    if (q.kind !== 'quote') return;
    // The pool moved in the trader's favour since the screen's quote (simulated: its minimum was 1).
    const shown = { ...q.quote, expectedOut: 2n, minimumReceive: 1n };
    const p = await prepareSwap(csl, api(), trader, ASCEND, ADA, 400_000_000n, 100, shown);
    expect(p.kind).toBe('review');
    if (p.kind === 'review') expect(p.plan.minimumReceive).toBe(q.quote.minimumReceive);
  });

  it('stops, building nothing, when the pool now pays less than the minimum on screen', async () => {
    const q = await quoteNow(csl, ASCEND, ADA, 400_000_000n, 100);
    if (q.kind !== 'quote') throw new Error('no quote');
    const shown = { ...q.quote, minimumReceive: q.quote.expectedOut + 1n };
    expect((await prepareSwap(csl, api(), trader, ASCEND, ADA, 400_000_000n, 100, shown)).kind).toBe('moved');
  });
});
