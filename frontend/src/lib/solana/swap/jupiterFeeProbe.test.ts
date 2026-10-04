// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { BuildSwapParams, JupiterQuote, SwapSimulation } from '../../jupiter';
import { probeJupiterFee, type JupiterFeeProbeDeps } from './jupiterFeeProbe';

// parity-1 (dark review): on a route where Jupiter's own program refuses the site fee
// (6014), the Jupiter trade that goes out is the NO-fee rebuild, which pays about 0.5%
// more than the fee-bearing quote. Our pool may be ranked against the fee-bearing number
// only with a proof that Jupiter's trade carries the fee. This is that proof.

const QUOTE = { inputMint: 'in', outputMint: 'out', inAmount: '1', outAmount: '2' } as unknown as JupiterQuote;
const OK: SwapSimulation = { ok: true, reason: null, jupiterIncorrectTokenProgram: false };
const JUP_6014: SwapSimulation = { ok: false, reason: 'custom program error: 0x177e', jupiterIncorrectTokenProgram: true };
const SLIPPAGE: SwapSimulation = { ok: false, reason: 'custom program error: 0x1771', jupiterIncorrectTokenProgram: false };

function deps(over: Partial<JupiterFeeProbeDeps> = {}) {
  return {
    buildSwapTransaction: vi.fn<JupiterFeeProbeDeps['buildSwapTransaction']>(over.buildSwapTransaction ?? (async () => ({ swapTransaction: 'TX', lastValidBlockHeight: 1 }))),
    simulateSwap: vi.fn<JupiterFeeProbeDeps['simulateSwap']>(over.simulateSwap ?? (async () => OK)),
    swapCarriesPlatformFee: vi.fn<JupiterFeeProbeDeps['swapCarriesPlatformFee']>(over.swapCarriesPlatformFee ?? (() => true)),
  };
}
const ask = { quote: QUOTE, inputMint: 'in', outputMint: 'out', user: 'me', priority: 'high' as const };

describe('probeJupiterFee: does Jupiter’s own trade for this quote carry the site fee', () => {
  it('the fee-bearing transaction simulates clean: charged', async () => {
    const d = deps();
    expect(await probeJupiterFee(d, ask)).toBe('charged');
    // The FEE-BEARING build of the very quote being compared, for this trader: never a no-fee build.
    const built: BuildSwapParams = d.buildSwapTransaction.mock.calls[0]![0];
    expect(built).toEqual({ quote: QUOTE, userPublicKey: 'me', priorityLevel: 'high' });
    expect(built.noPlatformFee).toBeUndefined();
    expect(d.simulateSwap).toHaveBeenCalledWith('TX');
  });

  it('Jupiter’s own 6014 with the fee attached: waived (the trade that goes out pays more than the quote says)', async () => {
    expect(await probeJupiterFee(deps({ simulateSwap: async () => JUP_6014 }), ask)).toBe('waived');
  });

  it('anything that is not a clean simulation or exactly that refusal is unchecked, never charged', async () => {
    expect(await probeJupiterFee(deps({ simulateSwap: async () => SLIPPAGE }), ask)).toBe('unchecked');
    expect(await probeJupiterFee(deps({ simulateSwap: async () => { throw new Error('503'); } }), ask)).toBe('unchecked');
    expect(await probeJupiterFee(deps({ buildSwapTransaction: async () => { throw new Error('400'); } }), ask)).toBe('unchecked');
    expect(await probeJupiterFee(deps({ simulateSwap: async () => undefined as never }), ask)).toBe('unchecked');
    expect(await probeJupiterFee(deps({ simulateSwap: async () => ({ ok: 'yes' }) as never }), ask)).toBe('unchecked');
  });

  it('a pair on which no fee is attached at all is unchecked, and nothing is built', async () => {
    const d = deps({ swapCarriesPlatformFee: () => false });
    expect(await probeJupiterFee(d, ask)).toBe('unchecked');
    expect(d.buildSwapTransaction).not.toHaveBeenCalled();
  });
});
