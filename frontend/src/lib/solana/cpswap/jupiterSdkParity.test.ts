// @vitest-environment node
// Reads the Jupiter SDK's fixtures off disk, which node is the right environment for.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';

import { decodeAmmConfig, type AmmConfigView, type PoolStateView } from './program';
import { vaultAmountWithoutFee } from './math';
import { quoteOwnPool, readPoolAt, type AccountRpc, type PoolSnapshot } from './read';

/**
 * QUOTE PARITY WITH THE JUPITER SDK. `solana/tegridy-amm/jupiter-sdk` is the code Jupiter
 * runs to quote our pools; this file is the code the site runs. Both read the same vectors
 * (`tests/fixtures/quote_vectors.json`) and must give the same amount out for every one,
 * the SDK in `tests/quote_vectors.rs` and the site here, through `quoteOwnPool`. The live
 * vectors go through the site's whole read path (`readPoolAt`) over the very account
 * snapshots the SDK's LiteSVM test executes the deployed program against.
 */

const SDK = resolve(__dirname, '../../../../../solana/tegridy-amm/jupiter-sdk/tests/fixtures');
const PROGRAM = new PublicKey('EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT');
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';

interface Synthetic {
  name: string;
  pool: {
    status: number; openTime: string; creatorFeeOn: number; enableCreatorFee: boolean;
    protocolFees: [string, string]; fundFees: [string, string]; creatorFees: [string, string];
  };
  config: { tradeFeeRate: string; protocolFeeRate: string; fundFeeRate: string; creatorFeeRate: string };
  vaults: [string, string];
  now: string;
  inputIsToken0: boolean;
  amountIn: string;
  out: string | null;
  refusal: string | null;
}
interface Live { pool: string; inputMint: string; outputMint: string; amountIn: string; out: string }

const VECTORS = JSON.parse(readFileSync(resolve(SDK, 'quote_vectors.json'), 'utf8')) as {
  synthetic: Synthetic[];
  live: Live[];
};

/** A `<pubkey>.bin` snapshot: a bincode `Account` (lamports u64, data, owner, executable, rent epoch). */
function readAccount(pool: string, key: string) {
  const b = readFileSync(resolve(SDK, 'accounts', pool, `${key}.bin`));
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const lamports = Number(view.getBigUint64(0, true));
  const len = Number(view.getBigUint64(8, true));
  const data = new Uint8Array(b.subarray(16, 16 + len));
  const owner = new PublicKey(b.subarray(16 + len, 48 + len));
  return { data, lamports, owner, executable: b[48 + len] === 1 };
}

/** What the program pays, as the site quotes it: the amount out, or null for no quote. */
function want(c: Synthetic): bigint | null {
  if (c.refusal === null) return BigInt(c.out!);
  // The program refuses a trade that pays out nothing; the site quotes it as 0 and its
  // builders refuse it as too small to protect with a price limit (poolSwap.ts, venueSwap.ts).
  if (c.refusal === 'ZeroAmountOut') return 0n;
  return null;
}

const T0 = 'So11111111111111111111111111111111111111112';
const T1 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('the site quotes every vector exactly as the Jupiter SDK does', () => {
  it('holds the vectors it is meant to', () => {
    expect(VECTORS.synthetic.length).toBeGreaterThanOrEqual(20);
    expect(VECTORS.live.length).toBeGreaterThanOrEqual(12);
  });

  it.each(VECTORS.synthetic.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const p = c.pool;
    const pool = {
      address: 'pool', token0Mint: T0, token1Mint: T1,
      status: p.status, openTime: BigInt(p.openTime),
      creatorFeeOn: p.creatorFeeOn, enableCreatorFee: p.enableCreatorFee,
      protocolFeesToken0: BigInt(p.protocolFees[0]), protocolFeesToken1: BigInt(p.protocolFees[1]),
      fundFeesToken0: BigInt(p.fundFees[0]), fundFeesToken1: BigInt(p.fundFees[1]),
      creatorFeesToken0: BigInt(p.creatorFees[0]), creatorFeesToken1: BigInt(p.creatorFees[1]),
    } as PoolStateView;
    const vault0Amount = BigInt(c.vaults[0]);
    const vault1Amount = BigInt(c.vaults[1]);
    // read.ts `readPoolAt`: the reserves are the vaults less what is booked to the venue and
    // the creator, and a pool whose booked fees exceed a vault is unreadable, never quoted.
    const reserve0 = vaultAmountWithoutFee(vault0Amount, pool.protocolFeesToken0, pool.fundFeesToken0, pool.creatorFeesToken0);
    const reserve1 = vaultAmountWithoutFee(vault1Amount, pool.protocolFeesToken1, pool.fundFeesToken1, pool.creatorFeesToken1);
    const config = {
      tradeFeeRate: BigInt(c.config.tradeFeeRate), protocolFeeRate: BigInt(c.config.protocolFeeRate),
      fundFeeRate: BigInt(c.config.fundFeeRate), creatorFeeRate: BigInt(c.config.creatorFeeRate),
    };
    const quote = reserve0 === null || reserve1 === null
      ? null
      : quoteOwnPool({ pool, vault0Amount, vault1Amount, reserve0, reserve1 } as PoolSnapshot, config,
          c.inputIsToken0 ? T0 : T1, BigInt(c.amountIn), Number(c.now));
    expect(quote?.outAmount ?? null).toBe(want(c));
  });

  it.each(VECTORS.live.map((c) => [`${c.pool} ${c.inputMint} ${c.amountIn}`, c] as const))('live %s', async (_name, c) => {
    const rpc: AccountRpc = {
      getAccountInfo: async (address) => readAccount(c.pool, address.toBase58()),
      getMinimumBalanceForRentExemption: async () => { throw new Error('not read by a pool read'); },
    };
    const read = await readPoolAt(rpc, PROGRAM, new PublicKey(c.pool));
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    const configAccount = readAccount(c.pool, read.value.pool.ammConfig);
    expect(configAccount.owner.equals(PROGRAM)).toBe(true);
    const config = decodeAmmConfig(read.value.pool.ammConfig, configAccount.data) as AmmConfigView;
    expect(config).not.toBeNull();
    // Clock: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64.
    const clock = readAccount(c.pool, CLOCK).data;
    const now = Number(new DataView(clock.buffer, clock.byteOffset).getBigInt64(32, true));
    const quote = quoteOwnPool(read.value, config, c.inputMint, BigInt(c.amountIn), now);
    expect(quote?.outAmount ?? null).toBe(BigInt(c.out));
  });
});
