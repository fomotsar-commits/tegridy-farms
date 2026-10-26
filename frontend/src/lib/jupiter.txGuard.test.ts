// @vitest-environment node
//
// NODE, like the other Solana tests: under jsdom a Uint8Array from the other realm
// fails web3.js's address and encoding checks.
//
// WIRING — every transaction the Jupiter client hands back has been read against the
// trade on screen (solana/swap/jupiterTxGuard.ts). These go through the real client
// functions with Jupiter's answer mocked: a real captured transaction comes back, and
// a tampered copy of it is refused before any caller can sign it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionedTransaction } from '@solana/web3.js';
import { LIVE_USER, RECURRING_CREATE, SWAP_SOL_USDC, TRIGGER_CREATE } from './solana/swap/__fixtures__/jupiterLive';

const VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';

function answer(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The live swap with its sold amount doubled: a different trade than the quote. */
function tamperedSwap(): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(SWAP_SOL_USDC.tx, 'base64'));
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const jup = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex].startsWith('JUP6'))!;
  const data = Uint8Array.from(jup.data);
  new DataView(data.buffer).setBigUint64(8, BigInt(SWAP_SOL_USDC.quote.inAmount) * 2n, true);
  jup.data = data;
  return Buffer.from(tx.serialize()).toString('base64');
}

let jupiter: typeof import('./jupiter');
beforeEach(async () => {
  vi.resetModules();
  // The venue's production fee setup: the Squads vault owns the fee accounts, 0.5%.
  vi.stubEnv('VITE_SOLANA_FEE_ACCOUNT', VAULT);
  vi.stubEnv('VITE_SOLANA_PLATFORM_FEE_BPS', '50');
  jupiter = await import('./jupiter');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const quote = () => ({ ...SWAP_SOL_USDC.quote, swapMode: 'ExactIn', otherAmountThreshold: '0', priceImpactPct: '0', routePlan: [], platformFee: { amount: '1', feeBps: 50 } });

describe('buildSwapTransaction', () => {
  it('returns a real swap built for the trade on screen', async () => {
    answer({ swapTransaction: SWAP_SOL_USDC.tx });
    await expect(jupiter.buildSwapTransaction({ quote: quote(), userPublicKey: LIVE_USER })).resolves.toBe(SWAP_SOL_USDC.tx);
  });

  it('refuses a swap that sells a different amount than the quote', async () => {
    answer({ swapTransaction: tamperedSwap() });
    await expect(jupiter.buildSwapTransaction({ quote: quote(), userPublicKey: LIVE_USER })).rejects.toThrow(/will not sign: the swap sells a different amount/);
  });

  it('refuses a real swap built for another wallet', async () => {
    answer({ swapTransaction: SWAP_SOL_USDC.tx });
    await expect(jupiter.buildSwapTransaction({ quote: quote(), userPublicKey: VAULT })).rejects.toThrow(/not signed by your wallet alone/);
  });
});

describe('limit orders and recurring buys', () => {
  it('createTriggerOrder returns the real order, and refuses one with other amounts', async () => {
    const params = { inputMint: TRIGGER_CREATE.inputMint, outputMint: TRIGGER_CREATE.outputMint, maker: LIVE_USER, makingAmount: TRIGGER_CREATE.makingAmount, takingAmount: TRIGGER_CREATE.takingAmount };
    answer({ transaction: TRIGGER_CREATE.tx });
    await expect(jupiter.createTriggerOrder(params)).resolves.toBe(TRIGGER_CREATE.tx);
    answer({ transaction: TRIGGER_CREATE.tx });
    await expect(jupiter.createTriggerOrder({ ...params, takingAmount: '1' })).rejects.toThrow(/different amounts/);
  });

  it('createRecurringOrder returns the real order, and refuses one on another schedule', async () => {
    const params = { user: LIVE_USER, inputMint: RECURRING_CREATE.inputMint, outputMint: RECURRING_CREATE.outputMint, inAmount: RECURRING_CREATE.inAmount, numberOfOrders: RECURRING_CREATE.numberOfOrders, intervalSeconds: RECURRING_CREATE.intervalSeconds };
    answer({ transaction: RECURRING_CREATE.tx });
    await expect(jupiter.createRecurringOrder(params)).resolves.toBe(RECURRING_CREATE.tx);
    answer({ transaction: RECURRING_CREATE.tx });
    await expect(jupiter.createRecurringOrder({ ...params, intervalSeconds: 60 })).rejects.toThrow(/different schedule/);
  });

  it('a "cancel" that is really something else is refused', async () => {
    answer({ transaction: TRIGGER_CREATE.tx });
    await expect(jupiter.cancelTriggerOrder(LIVE_USER, 'SomeOrder1111111111111111111111111111111111')).rejects.toThrow(/not a limit-order cancel/);
    answer({ transaction: RECURRING_CREATE.tx });
    await expect(jupiter.cancelRecurringOrder(LIVE_USER, 'SomeOrder1111111111111111111111111111111111')).rejects.toThrow(/not a recurring-buy cancel/);
  });
});
