// Test-only: the venue's BAYLA/SOL pool as mainnet held it at slot 455093758 (unchanged at
// 455105163, when __fixtures__/mainnet-history's 2026-10-10 files were read), built through
// the finder's own `poolViewFrom`. Node tests only: it derives the pool's real addresses,
// which jsdom cannot.
import { PublicKey } from '@solana/web3.js';
import { decodePoolState } from '../cpswap/program';
import { poolViewFrom, type PoolView } from './poolFinder';
import { BAYLA_MINT } from './tokenSafety';
import { LAUNCH, PROGRAM, buildPool, observationBytes } from './testkit.fixture';

export const POOL = 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4';
/** The SOL vault's balance, and the venue's uncollected cut inside it. */
export const SOL_VAULT = 25_648_407_921n;
export const VENUE_CUT = 801_600n;
/** What the shares are valued against: Rc = 25,648,407,921 - 801,600. */
export const Rc = 25_647_606_321n;
export const Rt = 5_414_845_326_496n;
export const S = 372_631_821_673n;
/** One second after the opening transaction's block time (initialize.rs). */
export const OPEN_TIME = 1_791_055_084n;
export const THIRD_SWAP = 1_791_514_249;

/** The real pool at those balances, judged by the finder's own `poolViewFrom` (the reserve is the vault less the fees owed). */
export function livePool(): PoolView {
  const b = buildPool({ mint: new PublicKey(BAYLA_MINT), configIndex: 1, quoteReserve: Rc, tokenReserve: Rt, lpSupply: S, protocolFeesSol: VENUE_CUT, openTime: OPEN_TIME });
  const address = b.address.toBase58();
  const acc = (a: string) => ({ address: a, owner: b.accounts[a]!.owner, data: b.accounts[a]!.data, lamports: 1 });
  const pool = decodePoolState(address, b.accounts[address]!.data)!;
  const entry = poolViewFrom({
    address,
    pool: acc(address),
    vault0: acc(pool.token0Vault),
    vault1: acc(pool.token1Vault),
    config: acc(pool.ammConfig),
    // The record as the chain holds it: written by a swap, newest slot 2, last update the third swap.
    observation: { address: b.observation.toBase58(), owner: PROGRAM.toBase58(), data: observationBytes({ pool: b.address, index: 2, lastUpdate: BigInt(THIRD_SWAP) }), lamports: 1 },
    opts: { programId: PROGRAM, launchProgramId: LAUNCH },
  });
  if (entry.kind !== 'pool') throw new Error(`the finder did not read the pool: ${entry.kind}`);
  return entry.view;
}
