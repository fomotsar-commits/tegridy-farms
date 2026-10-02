// @vitest-environment node
//
// The review is built only from a create that carries the WHOLE plant. The pre-sign
// check allows at most one burn and one Workshop transfer; this pins the other half:
// a create missing either one is blocked when the review is built. The plant builder
// is swapped here so a short plant can reach that step at all.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { WSOL_MINT, cpPermissionPda, migrationAuthorityPda } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { CP_CREATE_POOL_FEE_RECEIVER, readWriteGate } from './config';
import { prepareCreateLaunch } from './launch';
import * as plant from './plant';
import { CPSWAP, FakeChain, LAUNCH, VAULT, addPlantAccounts, cfgLocal, globalValue, plantMoved, rent } from './testkit.fixture';
import type { OpenGate, WriteRpc } from './types';

vi.mock('./plant', async (importOriginal) => {
  const real = await importOriginal<typeof import('./plant')>();
  return { ...real, plantInstructions: vi.fn(real.plantInstructions) };
});

const ME = Keypair.generate().publicKey;
const W = (c: FakeChain) => c as unknown as WriteRpc;

async function setup() {
  const chain = FakeChain.healthy(globalValue());
  chain.set(cpPermissionPda(migrationAuthorityPda(LAUNCH), CPSWAP), { lamports: 1, owner: CPSWAP, data: new Uint8Array(8) });
  chain.tokenAccount(CP_CREATE_POOL_FEE_RECEIVER, WSOL_MINT, VAULT, 0n);
  chain.fund(ME, 10_000_000_000);
  addPlantAccounts(chain, ME);
  const gate = (await readWriteGate(chain, cfgLocal)) as OpenGate;
  const mint = Keypair.generate();
  const g = globalValue();
  // The test run reports the full plant either way: only the decoded steps differ.
  chain.simulate = (_vtx, config) => ({
    err: null,
    logs: [],
    unitsConsumed: 100_000,
    ...(config?.accounts
      ? {
          accounts: chain.post(config.accounts.addresses, {
            [ME.toBase58()]: { lamportsDelta: -(rent(82) + rent(179) + 2 * rent(165) + rent(607)) },
            [associatedTokenAddress(mint.publicKey, VAULT).toBase58()]: {
              tokenAmount: (g.tokenTotalSupply * g.platformReserveBps) / 10_000n,
              mint: mint.publicKey,
              owner: VAULT,
            },
            ...plantMoved(ME),
          }),
        }
      : {}),
  });
  return { chain, gate, mint };
}

const metadata = { name: 'T', symbol: 'TT', uri: 'ipfs://bafy' };

describe('a create missing part of its plant never reaches review', () => {
  // A block body: a function returned from beforeEach is run as its teardown.
  beforeEach(() => {
    vi.mocked(plant.plantInstructions).mockClear();
  });

  it('the whole plant builds (control)', async () => {
    const { chain, gate, mint } = await setup();
    const r = await prepareCreateLaunch(W(chain), gate, { creator: ME, mint, metadata });
    expect(r.ok, r.ok ? '' : r.outcome.message).toBe(true);
    expect(plant.plantInstructions).toHaveBeenCalledTimes(1);
  });

  for (const [label, keep] of [
    ['only the burn', [0]],
    ['only the Workshop transfer', [1]],
    ['neither', []],
  ] as const) {
    it(`${label}: blocked as a missing step`, async () => {
      const { chain, gate, mint } = await setup();
      const full = plant.plantInstructions(ME);
      vi.mocked(plant.plantInstructions).mockImplementationOnce(
        () => keep.map((i) => full[i]!) as unknown as ReturnType<typeof plant.plantInstructions>,
      );
      const r = await prepareCreateLaunch(W(chain), gate, { creator: ME, mint, metadata });
      expect(!r.ok && r.outcome).toMatchObject({ stage: 'build', message: 'The launch transaction is missing a step, so it was blocked.' });
    });
  }
});
