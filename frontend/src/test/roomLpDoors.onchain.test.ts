// @vitest-environment node
// Every Solana room whose coin has a SOL pool on the venue's own pool program names it in
// `venueSolPool` (lib/bungalows.ts), so its "Add SOL + <coin>" door shows. Reads mainnet,
// so it runs only where ROOM_LP_DOORS_ONCHAIN=1: the registry-onchain.yml job, which runs
// daily and on a diff that touches the registry. Everywhere else, `npm test` included, it
// is skipped, and an RPC that does not answer can redden no unrelated merge. The rule and
// its canned tests: roomLpDoors.ts, roomLpDoors.test.ts.
import { describe, it, expect } from 'vitest';
import { BAYLA_MINT, BUNGALOWS } from '../lib/bungalows';
import { judgeRoomLpDoors, jsonRpc, readVenueSolPools, roomsWithCoins } from './roomLpDoors';

const LIVE = process.env.ROOM_LP_DOORS_ONCHAIN === '1';
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

describe.runIf(LIVE)('room LP doors against mainnet', () => {
  it('every Solana room with a SOL pool on the venue names it, and names only its own', async () => {
    const rooms = roomsWithCoins(BUNGALOWS);
    // A green that checked nothing is not a green: BAYLA's room and its pool, open since
    // 2026-10-03, must both be seen.
    expect(rooms.map((r) => r.id)).toContain('bayla');
    const pools = await readVenueSolPools(jsonRpc(RPC));
    expect(pools.some((p) => p.tokenMint === BAYLA_MINT), 'the scan found no BAYLA/SOL pool, so it read nothing it can be trusted on').toBe(true);

    const verdict = judgeRoomLpDoors(rooms, pools);
    // The workflow greps for this header, so a run that skipped this test cannot pass as one that read.
    console.log(
      [`ROOM LP DOORS: ${rooms.length} Solana rooms against ${pools.length} SOL pools on the venue's pool program`, ...verdict.lines].join('\n'),
    );
    for (const note of verdict.notes) console.log(`::warning title=Room LP door::${note}`);
    expect(verdict.problems, verdict.problems.join('\n')).toEqual([]);
  }, 120_000);
});
