// @vitest-environment node
//
// The three-way distinction this module exists to hold:
//   read it, answer NO  /  read it, answer YES  /  COULD NOT READ IT
//
// Every test below is really asking one question: does an outage ever render as a
// fact? A pool that could not be read must never look like an empty pool, and a
// position that could not be read must never look like a closed one — because a
// user acts differently on "you have nothing staked" than on "we could not check".
import { describe, it, expect } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  ACCOUNT_DISCRIMINATOR, POOL_SIZE, POSITION_SIZE, USER_STATS_SIZE,
  poolPda, positionPda, userStatsPda,
} from './program';
import { readLadderPool, readLadderWallet, readVaultBalances, nextPositionNonce, walletPrincipalRaw } from './read';

const PROGRAM = new PublicKey('HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK');
const OTHER_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const MINT = new PublicKey('8opsYTPSp2AckjmAc2vx49kohs8CFtNcyR2sNURfrfoL');
const OWNER = new PublicKey('Gut9toQMqtrFL5ERLsAThmtq6e1Hq9BGtWPcjNqziHrj');
const POOL = poolPda(PROGRAM, MINT, 0);

/** A minimal, VALID account of each type — so a test failure is about the logic. */
function poolAccount(): Uint8Array {
  const d = new Uint8Array(POOL_SIZE);
  d.set(ACCOUNT_DISCRIMINATOR.Pool, 0);
  const v = new DataView(d.buffer);
  d.set(MINT.toBytes(), 10);
  d.set(OTHER_PROGRAM.toBytes(), 42);      // tokenProgram
  d[74] = 6;                               // decimals
  v.setBigUint64(203, 100_000_000n, true); // minStake
  d[387] = 0;                              // degraded = false
  return d;
}
function userStats(nextNonce: number, principal = 0n, openPositions = 0): Uint8Array {
  const d = new Uint8Array(USER_STATS_SIZE);
  d.set(ACCOUNT_DISCRIMINATOR.UserStats, 0);
  const v = new DataView(d.buffer);
  v.setUint32(73, nextNonce, true);
  d[77] = openPositions;          // the scan stops once it has found this many
  v.setBigUint64(94, principal, true);
  return d;
}
function position(nonce: number, amount: bigint): Uint8Array {
  const d = new Uint8Array(POSITION_SIZE);
  d.set(ACCOUNT_DISCRIMINATOR.Position, 0);
  const v = new DataView(d.buffer);
  d.set(POOL.toBytes(), 9);
  d.set(OWNER.toBytes(), 41);
  v.setUint32(73, nonce, true);
  v.setBigUint64(77, amount, true);
  v.setBigInt64(101, 1_800_000_000n, true);
  return d;
}

/** A fake Connection. Only the three methods this module calls. */
function fakeConn(opts: {
  account?: (a: PublicKey) => { owner: PublicKey; data: Uint8Array } | null;
  accountThrows?: string;
  multi?: (a: PublicKey[]) => ({ data: Uint8Array } | null)[];
  multiThrows?: string;
  /** The `context.slot` each multi-account call reports; `null` omits it. Default 1000. */
  slot?: number | null;
  balance?: (a: PublicKey) => unknown;
}): Connection {
  return {
    getAccountInfo: async (a: PublicKey) => {
      if (opts.accountThrows) throw new Error(opts.accountThrows);
      return opts.account ? opts.account(a) : null;
    },
    getMultipleAccountsInfo: async (a: PublicKey[]) => {
      if (opts.multiThrows) throw new Error(opts.multiThrows);
      return opts.multi ? opts.multi(a) : a.map(() => null);
    },
    getMultipleAccountsInfoAndContext: async (a: PublicKey[]) => {
      if (opts.multiThrows) throw new Error(opts.multiThrows);
      const slot = opts.slot === undefined ? 1000 : opts.slot;
      return { context: slot === null ? {} : { slot }, value: opts.multi ? opts.multi(a) : a.map(() => null) };
    },
    getTokenAccountBalance: async (a: PublicKey) => {
      if (!opts.balance) throw new Error('no balance');
      return opts.balance(a);
    },
  } as unknown as Connection;
}

describe('readLadderPool — an outage is never an empty pool', () => {
  it('an RPC throw is UNREADABLE, not absent', async () => {
    const r = await readLadderPool(fakeConn({ accountThrows: 'socket hang up' }), PROGRAM, POOL);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not be read/);
  });

  it('a genuinely absent account says so, distinctly', async () => {
    const r = await readLadderPool(fakeConn({ account: () => null }), PROGRAM, POOL);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no account at this pool address/);
  });

  it('an account owned by ANOTHER program is a config error, and names the owner', async () => {
    // The likeliest real mistake: a Streamflow pool address left in the registry.
    const r = await readLadderPool(
      fakeConn({ account: () => ({ owner: OTHER_PROGRAM, data: poolAccount() }) }), PROGRAM, POOL);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain(OTHER_PROGRAM.toBase58());
      expect(r.reason).toMatch(/check the configured pool/);
    }
  });

  it('a malformed account is unreadable, NOT a zeroed pool', async () => {
    const bad = poolAccount();
    bad[387] = 9;                       // `degraded` neither 0 nor 1
    const r = await readLadderPool(
      fakeConn({ account: () => ({ owner: PROGRAM, data: bad }) }), PROGRAM, POOL);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/did not decode/);
  });

  it('a good pool decodes', async () => {
    const r = await readLadderPool(
      fakeConn({ account: () => ({ owner: PROGRAM, data: poolAccount() }) }), PROGRAM, POOL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.mint).toBe(MINT.toBase58());
      expect(r.value.decimals).toBe(6);
      expect(r.value.minStakeRaw).toBe(100_000_000n);
    }
  });
});

describe('readVaultBalances — unreadable is null, never 0', () => {
  const pool = { stakeVault: POOL.toBase58(), rewardVault: MINT.toBase58() };

  it('a throw yields null on both, not zero', async () => {
    const r = await readVaultBalances(fakeConn({}), pool);
    expect(r.stakeRaw).toBeNull();
    expect(r.rewardRaw).toBeNull();
  });

  it('a non-numeric amount is null, not zero', async () => {
    const r = await readVaultBalances(fakeConn({ balance: () => ({ value: { amount: 'oops' } }) }), pool);
    expect(r.stakeRaw).toBeNull();
  });

  it('a real zero IS zero — the distinction runs both ways', async () => {
    const r = await readVaultBalances(fakeConn({ balance: () => ({ value: { amount: '0' } }) }), pool);
    expect(r.stakeRaw).toBe(0n);
    expect(r.rewardRaw).toBe(0n);
  });

  it('reads a real balance', async () => {
    const r = await readVaultBalances(fakeConn({ balance: () => ({ value: { amount: '50000000000' } }) }), pool);
    expect(r.stakeRaw).toBe(50_000_000_000n);
  });
});

describe('readLadderWallet', () => {
  const statsAddr = userStatsPda(PROGRAM, POOL, OWNER).toBase58();

  it('NEVER STAKED is a fact, not an outage', async () => {
    const r = await readLadderWallet(fakeConn({ account: () => null }), PROGRAM, POOL, OWNER);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.stats).toBeNull();
      expect(r.value.open).toEqual([]);
      expect(nextPositionNonce(r.value)).toBe(0);
      expect(walletPrincipalRaw(r.value)).toBe(0n);
    }
  });

  it('an RPC throw is UNREADABLE, not "never staked"', async () => {
    // The whole point: these two look identical downstream unless kept apart.
    const r = await readLadderWallet(fakeConn({ accountThrows: 'timeout' }), PROGRAM, POOL, OWNER);
    expect(r.ok).toBe(false);
  });

  it('an ABSENT position below next_nonce is CLOSED, not missing', async () => {
    const conn = fakeConn({
      account: (a) => (a.toBase58() === statsAddr ? { owner: PROGRAM, data: userStats(3, 500n, 1) } : null),
      multi: () => [null, { data: position(1, 500_000_000n) }, null],
    });
    const r = await readLadderWallet(conn, PROGRAM, POOL, OWNER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.slots.map((s) => s.state)).toEqual(['closed', 'open', 'closed']);
    expect(r.value.open).toHaveLength(1);
    expect(r.value.open[0]!.amountRaw).toBe(500_000_000n);
    expect(nextPositionNonce(r.value)).toBe(3);
    expect(walletPrincipalRaw(r.value)).toBe(500n);
  });

  it('one undecodable position does NOT blank the others', async () => {
    const junk = new Uint8Array(POSITION_SIZE);   // right length, wrong discriminator
    // ADDRESS-KEYED, not positional: the scan runs newest-first, so a positional
    // mock silently answers for the wrong nonce and the test stops meaning anything.
    const at0 = positionPda(PROGRAM, POOL, OWNER, 0).toBase58();
    const conn = fakeConn({
      account: (a) => (a.toBase58() === statsAddr ? { owner: PROGRAM, data: userStats(2, 0n, 1) } : null),
      multi: (addrs) => addrs.map((a) =>
        a.toBase58() === at0 ? { data: junk } : { data: position(1, 42n) }),
    });
    const r = await readLadderWallet(conn, PROGRAM, POOL, OWNER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.slots[0]!.state).toBe('unreadable');
    expect(r.value.slots[1]!.state).toBe('open');
    expect(r.value.open).toHaveLength(1);      // the good one still shows
  });

  it('a batch throw is unreadable rather than an empty position list', async () => {
    const conn = fakeConn({
      account: (a) => (a.toBase58() === statsAddr ? { owner: PROGRAM, data: userStats(2, 0n, 1) } : null),
      multiThrows: 'batch failed',
    });
    expect((await readLadderWallet(conn, PROGRAM, POOL, OWNER)).ok).toBe(false);
  });

  it('a malformed next_nonce cannot cause an unbounded fetch', async () => {
    // Belt and braces: a corrupt counter must not turn into 4 billion requests.
    let asked = 0;
    const conn = fakeConn({
      account: (a) => (a.toBase58() === statsAddr ? { owner: PROGRAM, data: userStats(0xffffffff, 0n, 1) } : null),
      multi: (addrs) => { asked += addrs.length; return addrs.map(() => null); },
    });
    const r = await readLadderWallet(conn, PROGRAM, POOL, OWNER);
    expect(r.ok).toBe(true);
    // A u32 counter of 4 billion must not become 4 billion derivations.
    expect(asked).toBeLessThanOrEqual(1000);
    // ...and because it could NOT account for the open position, it says so rather
    // than presenting an empty list as complete.
    if (r.ok) expect(r.value.truncated).toBe(true);
  });

  it('a LONG-LIVED wallet still finds its one open position', async () => {
    // THE BUG THIS REPLACED. `next_nonce` is lifetime-cumulative and MAX_POSITIONS
    // bounds `open_positions`, not it (lib.rs:411). A wallet that staked 25 times
    // and closed 24 has next_nonce=25 and its live position at nonce 24 — clamping
    // the scan to 20 showed that staker NOTHING, which is the worst possible answer.
    const live = 24;
    const conn = fakeConn({
      account: (a) => (a.toBase58() === statsAddr ? { owner: PROGRAM, data: userStats(25, 900n, 1) } : null),
      multi: (addrs) => addrs.map((a) =>
        a.toBase58() === positionPda(PROGRAM, POOL, OWNER, live).toBase58()
          ? { data: position(live, 777n) } : null),
    });
    const r = await readLadderWallet(conn, PROGRAM, POOL, OWNER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.open).toHaveLength(1);
    expect(r.value.open[0]!.nonce).toBe(live);
    expect(r.value.open[0]!.amountRaw).toBe(777n);
    expect(r.value.truncated).toBe(false);
  });

  it('stops early — one open position does not cost a walk of every nonce', async () => {
    let calls = 0;
    const conn = fakeConn({
      account: (a) => (a.toBase58() === statsAddr ? { owner: PROGRAM, data: userStats(500, 0n, 1) } : null),
      multi: (addrs) => { calls += 1; return addrs.map((a, i) => (i === 0 ? { data: position(499, 5n) } : null)); },
    });
    const r = await readLadderWallet(conn, PROGRAM, POOL, OWNER);
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);        // found the newest one; no further batches
  });

  it('derives the position addresses the program would', async () => {
    let seen: string[] = [];
    const conn = fakeConn({
      account: (a) => (a.toBase58() === statsAddr ? { owner: PROGRAM, data: userStats(2, 0n, 1) } : null),
      multi: (addrs) => { seen = addrs.map((a) => a.toBase58()); return addrs.map(() => null); },
    });
    await readLadderWallet(conn, PROGRAM, POOL, OWNER);
    // NEWEST FIRST — live positions cluster at the top, so this is what lets the
    // scan stop early instead of walking every lifetime nonce.
    // The pool rides LAST in the same call, so a share can come from one slot.
    expect(seen).toEqual([
      positionPda(PROGRAM, POOL, OWNER, 1).toBase58(),
      positionPda(PROGRAM, POOL, OWNER, 0).toBase58(),
      POOL.toBase58(),
    ]);
  });
});

// ── THE SHARE BASIS: wallet weight and pool total from ONE call, therefore ONE slot ──
//
// The card used to divide the wallet's weight (one request) by the pool's total
// (another request). After a stake BOTH rise, so a wallet read carrying the new weight
// over a pool read still carrying the old total printed a share better than the truth.
// The basis puts the pool account in the SAME getMultipleAccounts call as the positions.
describe('readLadderWallet — shareBasis is read in one call', () => {
  const statsAddr = userStatsPda(PROGRAM, POOL, OWNER).toBase58();
  const W = (n: number) => BigInt(n) * 1_000_000n;
  function positionW(nonce: number, weight: bigint): Uint8Array {
    const d = position(nonce, weight);
    new DataView(d.buffer).setBigUint64(85, weight, true);   // weight, u128 low half
    return d;
  }
  function poolWithTotal(total: bigint): Uint8Array {
    const d = poolAccount();
    new DataView(d.buffer).setBigUint64(251, total, true);   // total_weighted, u128 low half
    return d;
  }
  const statsFor = (nextNonce: number, open: number) => (a: PublicKey) =>
    (a.toBase58() === statsAddr ? { owner: PROGRAM, data: userStats(nextNonce, 0n, open) } : null);

  it('WORKED EXAMPLE: the basis is 20 of 110 from the positions\' own call — never 20 over a stale 100', async () => {
    const calls: string[][] = [];
    const conn = fakeConn({
      account: (a) => {
        // A separately-read pool would still say 100. The basis must not use it.
        if (a.toBase58() === POOL.toBase58()) return { owner: PROGRAM, data: poolWithTotal(W(100)) };
        return statsFor(2, 2)(a);
      },
      multi: (addrs) => {
        calls.push(addrs.map((a) => a.toBase58()));
        return addrs.map((a) => {
          if (a.toBase58() === POOL.toBase58()) return { owner: PROGRAM, data: poolWithTotal(W(110)) } as never;
          const n = [0, 1].find((i) => positionPda(PROGRAM, POOL, OWNER, i).toBase58() === a.toBase58());
          return n === undefined ? null : { data: positionW(n, W(10)) };
        });
      },
    });
    const r = await readLadderWallet(conn, PROGRAM, POOL, OWNER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.shareBasis).toEqual({ mineWeight: W(20), totalWeighted: W(110), slot: 1000 });
    // ONE call carried both the positions and the pool.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(POOL.toBase58());
  });

  it('no pool account in that call (or one owned by another program) is NO basis — never a guess', async () => {
    const conn = fakeConn({
      account: statsFor(1, 1),
      multi: (addrs) => addrs.map((a) =>
        a.toBase58() === POOL.toBase58()
          ? ({ owner: OTHER_PROGRAM, data: poolWithTotal(W(110)) } as never)
          : { data: positionW(0, W(10)) }),
    });
    const r = await readLadderWallet(conn, PROGRAM, POOL, OWNER);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.open).toHaveLength(1);        // the positions still show
      expect(r.value.shareBasis).toBeNull();       // ...but no share is derivable
    }
  });

  it('a partial scan (open_positions counts one the scan did not find) is NO basis', async () => {
    const conn = fakeConn({
      account: statsFor(2, 2),
      multi: (addrs) => addrs.map((a) => {
        if (a.toBase58() === POOL.toBase58()) return { owner: PROGRAM, data: poolWithTotal(W(110)) } as never;
        return a.toBase58() === positionPda(PROGRAM, POOL, OWNER, 1).toBase58() ? { data: positionW(1, W(10)) } : null;
      }),
    });
    const r = await readLadderWallet(conn, PROGRAM, POOL, OWNER);
    expect(r.ok && r.value.shareBasis).toBeNull();
  });

  it('positions found across TWO calls are re-read together with the pool in one more call', async () => {
    // nonce 150 is in the first batch, nonce 0 in the second — two slots. Summing them
    // over either call's pool could count a position the other slot had already closed.
    const at = (n: number) => positionPda(PROGRAM, POOL, OWNER, n).toBase58();
    const calls: string[][] = [];
    const conn = fakeConn({
      account: statsFor(151, 2),
      multi: (addrs) => {
        calls.push(addrs.map((a) => a.toBase58()));
        const confirming = calls.length === 3;
        return addrs.map((a) => {
          const k = a.toBase58();
          if (k === POOL.toBase58()) return { owner: PROGRAM, data: poolWithTotal(confirming ? W(200) : W(999)) } as never;
          if (k === at(150)) return { data: positionW(150, W(10)) };
          if (k === at(0)) return { data: positionW(0, W(30)) };
          return null;
        });
      },
    });
    const r = await readLadderWallet(conn, PROGRAM, POOL, OWNER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls).toHaveLength(3);
    expect(calls[2]!.sort()).toEqual([at(0), at(150), POOL.toBase58()].sort());
    expect(r.value.shareBasis).toEqual({ mineWeight: W(40), totalWeighted: W(200), slot: 1000 });
  });

  // SAME-SLOT IS NOT RECENT. The card fences the share on the slot of your own confirmed
  // write, so the basis must carry the slot its ONE call was answered at — and a response
  // without one must say null, never a made-up number that could pass the fence.
  it('carries the context.slot of its call, and null when the response has none', async () => {
    const multi = (addrs: PublicKey[]) => addrs.map((a) =>
      a.toBase58() === POOL.toBase58()
        ? ({ owner: PROGRAM, data: poolWithTotal(W(110)) } as never)
        : { data: positionW(0, W(10)) });
    const withSlot = await readLadderWallet(fakeConn({ account: statsFor(1, 1), multi, slot: 412_000_001 }), PROGRAM, POOL, OWNER);
    expect(withSlot.ok && withSlot.value.shareBasis).toEqual({ mineWeight: W(10), totalWeighted: W(110), slot: 412_000_001 });
    const noSlot = await readLadderWallet(fakeConn({ account: statsFor(1, 1), multi, slot: null }), PROGRAM, POOL, OWNER);
    expect(noSlot.ok && noSlot.value.shareBasis).toEqual({ mineWeight: W(10), totalWeighted: W(110), slot: null });
  });
});
