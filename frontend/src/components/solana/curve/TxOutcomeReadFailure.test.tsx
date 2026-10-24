// @vitest-environment node
//
// A test run that could not run, or did not answer what it was asked, is not a refusal of
// the transaction. Node, not jsdom: the fake chain's address derivation needs Node's Uint8Array.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '../../../lib/launcher/solana/curve/program';
import { SOL_QUOTE } from '../../../lib/solana/lp/quotes';
import { publicTierConfig } from '../../../lib/solana/cpswap/program';
import { CPSWAP, FakeChain, addPool, cfgLocal, setClock } from '../../../lib/launcher/solana/write/testkit.fixture';
import type { NotSent, SwapOpenGate, WriteRpc } from '../../../lib/launcher/solana/write/types';
import { prepareVenueSwap, type VenueSwapArgs } from '../../../lib/launcher/solana/write/venueSwap';
import { TxOutcomeCard } from './TxFlowView';

const ME = Keypair.generate().publicKey;
const NOW = 2_000_000_000n;
const SOL = 10n ** 9n;
const OPEN: SwapOpenGate = { kind: 'open', cfg: cfgLocal };

function world() {
  const chain = FakeChain.healthy().addTier1();
  const mint = Keypair.generate().publicKey;
  chain.mint(mint, { decimals: 6 });
  const pool = addPool(chain, mint, { sol: 24n * SOL, tokens: 5_000_000n * 10n ** 6n, tokenProgram: TOKEN_PROGRAM_ID, quote: SOL_QUOTE, ammConfig: publicTierConfig(CPSWAP), openTime: NOW - 100n });
  setClock(chain, NOW);
  chain.fund(ME, Number(20n * SOL));
  const args: VenueSwapArgs = { owner: ME, pool: pool.address, inputMint: new PublicKey(SOL_QUOTE.mint), outputMint: mint, amountIn: SOL, slippageBps: 100n, aggregator: { kind: 'no-route' } };
  return { chain, args };
}

async function notSent(set: (c: FakeChain) => void): Promise<NotSent> {
  const { chain, args } = world();
  set(chain);
  const r = await prepareVenueSwap(chain as unknown as WriteRpc, OPEN, args);
  if (r.ok) throw new Error('it prepared');
  return r.outcome;
}

const card = (o: NotSent) =>
  renderToStaticMarkup(<TxOutcomeCard outcome={o} explorerUrl={null} onRecheck={() => {}} onReset={() => {}} rechecking={false} kind="venue-swap" />)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

describe('a test run that could not run is not called a refusal', () => {
  it('the node failing to answer, a lagging node, and a test run that left out the balances', async () => {
    const threw = await notSent((c) => { c.simulate = () => { throw new Error('HTTP 502'); }; });
    const lagged = await notSent((c) => { c.simulate = () => ({ err: 'BlockhashNotFound', logs: [], unitsConsumed: 0 }); });
    // The default fake answers the test run with no accounts at all.
    const unanswered = await notSent(() => {});
    for (const [name, o] of [['threw', threw], ['lagged', lagged], ['unanswered', unanswered]] as const) {
      const t = card(o);
      expect(t, name).toMatch(/Not sent\./);
      expect(t, name).toMatch(/Nothing was charged\./);
      expect(t, name).not.toMatch(/was refused/);
    }
  });

  it('a program that ran and refused still says so', async () => {
    const refused = await notSent((c) => {
      c.simulate = () => ({ err: { InstructionError: [3, { Custom: 6005 }] }, logs: [`Program ${CPSWAP.toBase58()} failed: custom program error: 0x1775`], unitsConsumed: 40_000 });
    });
    expect(card(refused)).toMatch(/A test run of this transaction was refused/);
  });
});
