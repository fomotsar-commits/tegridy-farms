import { PROGRAM_ID as LAUNCH_PROGRAM_ID } from '../../launcher/solana/curve/program';
import { RANGE_PROGRAM_ADDRESS } from '../clmm/programId';
import { LIVE_PROGRAM_ID } from '../cpswap/program';

/**
 * Every program of ours that holds pools: our constant-product pools, our range pools and
 * the launch curve. A market price that comes through any of them is ours agreeing with
 * itself, never an outside price (outsidePrice.ts). `also`: a program a page reads besides.
 */
export function ownPoolPrograms(also: string[] = []): string[] {
  return [...new Set([...(LIVE_PROGRAM_ID ? [LIVE_PROGRAM_ID.toBase58()] : []), RANGE_PROGRAM_ADDRESS, LAUNCH_PROGRAM_ID.toBase58(), ...also])];
}
