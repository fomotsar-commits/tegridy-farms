// @vitest-environment node
// (node, not jsdom: findProgramAddressSync throws under jsdom, as in every derivation test.)
//
// The registry's fee rows are derived, never typed. With a registered owner as the fee
// account, the swap builder must name exactly the registered token accounts, and the
// public fee tier must sit where the pool code derives it. A row naming any other
// account points the daily chain read, and whoever reads the row, at the wrong place.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { REGISTERED_PROGRAM_ID, deriveAmmConfig, publicTierConfig } from './cpswap/program';
import { SOL_MINT, USDC_MINT } from '../solana';

interface Entry { id?: string; address?: string; expect?: { type?: string } }

const registry = JSON.parse(
  readFileSync(new URL('../../../scripts/addresses.json', import.meta.url), 'utf8'),
) as { solana?: Entry[] };

const entry = (id: string): Entry => {
  const e = (registry.solana ?? []).find((x) => x?.id === id);
  // A missing row would make every comparison below vacuous: fail loudly instead.
  if (!e?.address) throw new Error(`${id} is not in scripts/addresses.json`);
  return e;
};

const BAYLA = entry('bayla-mint').address!;
const TRADER = entry('operator-payer').address!;

/** The fee account the swap builder names for `inputMint` -> BAYLA when `owner` is the fee owner. */
async function feeAccountNamed(owner: string, inputMint: string): Promise<unknown> {
  vi.resetModules();
  vi.stubEnv('VITE_SOLANA_FEE_ACCOUNT', owner);
  vi.stubEnv('VITE_SOLANA_PLATFORM_FEE_BPS', '50');
  const sent = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ swapTransaction: 'AAAA' }), { status: 200 }));
  vi.stubGlobal('fetch', sent);
  const { buildSwapTransaction } = await import('../jupiter');
  await buildSwapTransaction({
    quote: {
      inputMint, outputMint: BAYLA, inAmount: '100000000', outAmount: '1', otherAmountThreshold: '1',
      swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', routePlan: [], platformFee: { amount: '500000', feeBps: 50 },
    },
    userPublicKey: TRADER,
  });
  return (JSON.parse(String(sent.mock.calls[0]![1]!.body)) as { feeAccount?: unknown }).feeAccount;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the swap fee is paid to the registered token accounts of the registered owner', () => {
  it.each([
    ['squads-vault', SOL_MINT, 'cpswap-fee-receiver-wsol-ata'],
    ['squads-vault', USDC_MINT, 'squads-vault-usdc-ata'],
    // The wallet that used to be the fee owner: its two rows are derived the same way.
    ['swap-fee-account', SOL_MINT, 'swap-fee-ata-wsol'],
    ['swap-fee-account', USDC_MINT, 'swap-fee-ata-usdc'],
  ] as const)('with %s as fee owner, a swap from %s pays %s', async (owner, mint, row) => {
    expect(await feeAccountNamed(entry(owner).address!, mint)).toBe(entry(row).address);
    expect(entry(row).expect?.type).toBe('token-account');
  });

  it('the two owners have different accounts, so a row copied from the other owner fails', () => {
    const rows = ['cpswap-fee-receiver-wsol-ata', 'squads-vault-usdc-ata', 'swap-fee-ata-wsol', 'swap-fee-ata-usdc'];
    expect(new Set(rows.map((id) => entry(id).address)).size).toBe(rows.length);
  });
});

describe('both fee tiers are registered where the pool code derives them', () => {
  it('the public tier (index 1) and the launch tier (index 0)', () => {
    expect(entry('cp-swap-amm-config-public-restart').address).toBe(publicTierConfig(REGISTERED_PROGRAM_ID).toBase58());
    expect(entry('cp-swap-amm-config-restart').address).toBe(deriveAmmConfig(REGISTERED_PROGRAM_ID, 0).toBase58());
    expect(entry('cp-swap-amm-config-public-restart').expect?.type).toBe('program-owned');
    expect(entry('cp-swap-program-restart').address).toBe(REGISTERED_PROGRAM_ID.toBase58());
  });
});
