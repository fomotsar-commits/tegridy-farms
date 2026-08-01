// @vitest-environment node
// Same reason as program.test.ts: PDA derivation under jsdom fails on a realm
// mismatch inside web3.js's sync sha256, not on anything in this code.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  ACCOUNT_DISCRIMINATOR,
  BONDING_CURVE_SIZE,
  CP_SWAP_PROGRAM_ID,
  DEFAULT_PUBKEY,
  GLOBAL_CONFIG_SIZE,
  PROGRAM_ID,
  curvePda,
  decodeBondingCurve,
  decodeGlobalConfig,
  globalPda,
  type GlobalConfig,
} from './program';
import {
  classifyLaunch,
  clipDetail,
  curveProgress,
  migrationEligibility,
  readCurve,
  readDeployment,
  readGlobal,
  readLaunch,
  readRentFloors,
  type AccountSnapshot,
  type CurveAccount,
  type CurveRpc,
  type Deployment,
  type Read,
} from './read';
import type { CurveTerms } from './math';

const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const CREATOR = new PublicKey('So11111111111111111111111111111111111111112');
const POOL = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const SOL = 1_000_000_000n;
const TARGET = 85n * SOL;
const RESERVE = SOL / 4n;
const RENT_EXEMPT_CURVE = 2_018_400n;

// ── encoders (fields concatenated in declaration order) ─────────────────────

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const u64le = (v: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const byte = (n: number): Uint8Array => Uint8Array.from([n]);

function globalBytes(o: { paused?: boolean; ammConfigured?: boolean } = {}): Uint8Array {
  const venue = o.ammConfigured === false ? DEFAULT_PUBKEY : CP_SWAP_PROGRAM_ID;
  return cat(
    ACCOUNT_DISCRIMINATOR.GlobalConfig,
    CREATOR.toBytes(),
    CREATOR.toBytes(),
    u64le(100n),
    u64le(30n * SOL),
    u64le(1_073_000_000_000_000n),
    u64le(1_000_000_000_000_000n),
    u64le(TARGET),
    u64le(RESERVE),
    venue.toBytes(),
    (o.ammConfigured === false ? DEFAULT_PUBKEY : CREATOR).toBytes(),
    byte(o.paused ? 1 : 0),
    byte(254),
  );
}

function curveBytes(o: { realSol?: bigint; complete?: boolean; pool?: PublicKey } = {}): Uint8Array {
  return cat(
    ACCOUNT_DISCRIMINATOR.BondingCurve,
    MINT.toBytes(),
    CREATOR.toBytes(),
    u64le(30n * SOL),
    u64le(1_073_000_000_000_000n),
    u64le(o.realSol ?? 7n * SOL),
    u64le(900_000_000_000_000n),
    u64le(100n),
    u64le(TARGET),
    u64le(RESERVE),
    byte(o.complete ? 1 : 0),
    (o.pool ?? DEFAULT_PUBKEY).toBytes(),
    byte(253),
  );
}

// ── fake RPC ────────────────────────────────────────────────────────────────

interface FakeOpts {
  /** base58 → account, or a thrown error to simulate an unreachable RPC. */
  accounts?: Record<string, AccountSnapshot | Error>;
  rentThrows?: boolean;
}

function fakeRpc(opts: FakeOpts = {}): CurveRpc & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async getAccountInfo(address: PublicKey) {
      reads.push(address.toBase58());
      const hit = opts.accounts?.[address.toBase58()];
      if (hit instanceof Error) throw hit;
      return hit ?? null;
    },
    async getMinimumBalanceForRentExemption(len: number) {
      if (opts.rentThrows) throw new Error('rpc down');
      return len === BONDING_CURVE_SIZE ? Number(RENT_EXEMPT_CURVE) : 2_185_440;
    },
  };
}

const snapshot = (data: Uint8Array, lamports: number, executable = false): AccountSnapshot => ({
  data,
  lamports,
  owner: PROGRAM_ID,
  executable,
});

/** A cluster where everything exists and the launch is mid-raise. */
function healthyAccounts(over: Record<string, AccountSnapshot | Error> = {}) {
  return {
    [PROGRAM_ID.toBase58()]: snapshot(new Uint8Array(36), 1_000_000, true),
    [globalPda().toBase58()]: snapshot(globalBytes(), 2_185_440),
    [curvePda(MINT).toBase58()]: snapshot(
      curveBytes(),
      Number(RENT_EXEMPT_CURVE + 7n * SOL),
    ),
    ...over,
  };
}

// ── deployment ──────────────────────────────────────────────────────────────

describe('readDeployment — the first call any surface makes', () => {
  it('reports not-deployed when the program account is absent', async () => {
    expect(await readDeployment(fakeRpc())).toEqual({ kind: 'not-deployed' });
  });

  it('reports unreadable, NOT not-deployed, when the RPC fails', async () => {
    const rpc = fakeRpc({ accounts: { [PROGRAM_ID.toBase58()]: new Error('502 Bad Gateway') } });
    const d = await readDeployment(rpc);
    expect(d.kind).toBe('unreadable');
    if (d.kind !== 'unreadable') return;
    expect(d.detail).toContain('502');
  });

  it('passes through executable so a squatting non-program account is visible', async () => {
    const rpc = fakeRpc({
      accounts: { [PROGRAM_ID.toBase58()]: snapshot(new Uint8Array(4), 1, false) },
    });
    expect(await readDeployment(rpc)).toEqual({ kind: 'deployed', executable: false });
  });
});

// ── account reads ───────────────────────────────────────────────────────────

describe('readGlobal / readCurve', () => {
  it('decodes global from the PDA', async () => {
    const rpc = fakeRpc({ accounts: healthyAccounts() });
    const g = await readGlobal(rpc);
    expect(g.kind).toBe('ok');
    if (g.kind !== 'ok') return;
    expect(g.value.graduationTargetLamports).toBe(TARGET);
    expect(rpc.reads).toEqual([globalPda().toBase58()]);
  });

  it('an absent global is "not initialized", which is not an error about a launch', async () => {
    expect(await readGlobal(fakeRpc())).toEqual({ kind: 'absent' });
  });

  it('reports the curve PDA lamport balance SEPARATELY from real_sol_reserves', async () => {
    // Anyone can send lamports to a derivable address, so the two differ. The
    // repo has shipped the confusion; keep them apart.
    const donated = 1_234n;
    const rpc = fakeRpc({
      accounts: healthyAccounts({
        [curvePda(MINT).toBase58()]: snapshot(
          curveBytes({ realSol: 7n * SOL }),
          Number(RENT_EXEMPT_CURVE + 7n * SOL + donated),
        ),
      }),
    });
    const c = await readCurve(rpc, MINT);
    expect(c.kind).toBe('ok');
    if (c.kind !== 'ok') return;
    expect(c.value.curve.realSolReserves).toBe(7n * SOL);
    expect(c.value.lamports).toBe(RENT_EXEMPT_CURVE + 7n * SOL + donated);
    expect(c.value.lamports).not.toBe(c.value.curve.realSolReserves);
  });

  it('surfaces a decode failure as undecodable, never as an empty curve', async () => {
    const rpc = fakeRpc({
      accounts: healthyAccounts({
        [curvePda(MINT).toBase58()]: snapshot(new Uint8Array(BONDING_CURVE_SIZE), 1),
      }),
    });
    expect(await readCurve(rpc, MINT)).toEqual({ kind: 'undecodable', reason: 'wrong-discriminator' });
  });

  it('readRentFloors returns null rather than a guessed floor', async () => {
    expect(await readRentFloors(fakeRpc())).toEqual({
      global: 2_185_440n,
      curve: RENT_EXEMPT_CURVE,
    });
    expect(await readRentFloors(fakeRpc({ rentThrows: true }))).toBeNull();
  });
});

describe('clipDetail', () => {
  it('bounds an error string so a wall of RPC payload never reaches a page', () => {
    expect(clipDetail(new Error('a'.repeat(500)))).toHaveLength(181); // 180 + ellipsis
    expect(clipDetail(new Error('  spaced   out  '))).toBe('spaced out');
    expect(clipDetail(new Error(''))).toBe('the RPC call failed with no message');
    expect(clipDetail('plain string')).toBe('plain string');
  });
});

// ── phase classification ────────────────────────────────────────────────────

const DEPLOYED: Deployment = { kind: 'deployed', executable: true };

function decodedGlobal(o?: Parameters<typeof globalBytes>[0]): Read<GlobalConfig> {
  const d = decodeGlobalConfig(globalBytes(o));
  if (!d.ok) throw new Error(d.reason);
  return { kind: 'ok', value: d.value };
}

function decodedCurve(
  o?: Parameters<typeof curveBytes>[0],
  lamports = RENT_EXEMPT_CURVE + 7n * SOL,
): Read<CurveAccount> {
  const d = decodeBondingCurve(curveBytes(o));
  if (!d.ok) throw new Error(d.reason);
  return { kind: 'ok', value: { address: curvePda(MINT), curve: d.value, lamports } };
}

describe('classifyLaunch — the five phases, first match wins', () => {
  it('row 0: not deployed stops everything', () => {
    const s = classifyLaunch({ kind: 'not-deployed' }, decodedGlobal(), decodedCurve());
    expect(s.phase).toEqual({ kind: 'not-deployed' });
    // And it does NOT leak the state it was handed — nothing was established.
    expect(s.global).toBeNull();
    expect(s.curve).toBeNull();
    expect(s.paused).toBeNull();
  });

  it('row 0b: an unreadable deployment NEVER falls through to a later row', () => {
    const s = classifyLaunch(
      { kind: 'unreadable', detail: 'timeout' },
      decodedGlobal(),
      decodedCurve({ complete: true, pool: POOL }),
    );
    expect(s.phase).toEqual({ kind: 'unreadable', detail: 'timeout' });
  });

  it('row 0b: an unreadable GLOBAL never renders as pre-launch or trading', () => {
    const s = classifyLaunch(DEPLOYED, { kind: 'unreadable', detail: 'rate limited' }, decodedCurve());
    expect(s.phase).toEqual({ kind: 'unreadable', detail: 'rate limited' });
    expect(s.paused).toBeNull();
  });

  it('row 0b: an unreadable CURVE never renders as pre-launch', () => {
    const s = classifyLaunch(DEPLOYED, decodedGlobal(), { kind: 'unreadable', detail: '503' });
    expect(s.phase).toEqual({ kind: 'unreadable', detail: '503' });
    // The global DID read, so its overlay is real and is kept.
    expect(s.paused).toBe(false);
    expect(s.curve).toBeNull();
  });

  it('an UNDECODABLE curve is a failure to read, not evidence about the launch', () => {
    const s = classifyLaunch(DEPLOYED, decodedGlobal(), {
      kind: 'undecodable',
      reason: 'wrong-discriminator',
    });
    expect(s.phase.kind).toBe('unreadable');
    expect(s.curve).toBeNull();
  });

  it('row 1: an ABSENT global is protocol-not-initialized', () => {
    const s = classifyLaunch(DEPLOYED, { kind: 'absent' }, decodedCurve());
    expect(s.phase).toEqual({ kind: 'protocol-not-initialized' });
  });

  it('an UNDECODABLE global is unreadable — the account exists, we just cannot read it', () => {
    const s = classifyLaunch(
      DEPLOYED,
      { kind: 'undecodable', reason: 'wrong-discriminator' },
      decodedCurve(),
    );
    expect(s.phase.kind).toBe('unreadable');
    expect(s.phase.kind === 'unreadable' && s.phase.detail).toContain('wrong-discriminator');
    expect(s.global).toBeNull();
  });

  it('row 2: an absent curve is PRE-LAUNCH, not "0 SOL raised"', () => {
    const s = classifyLaunch(DEPLOYED, decodedGlobal(), { kind: 'absent' });
    expect(s.phase).toEqual({ kind: 'pre-launch' });
    expect(s.curve).toBeNull();
  });

  it('row 3: complete === true is graduated, and carries the pool', () => {
    const s = classifyLaunch(
      DEPLOYED,
      decodedGlobal(),
      decodedCurve({ complete: true, pool: POOL, realSol: 0n }),
    );
    expect(s.phase.kind).toBe('graduated');
    if (s.phase.kind !== 'graduated') return;
    expect(s.phase.pool.equals(POOL)).toBe(true);
  });

  it('row 3 beats row 4 — a graduated curve is never "awaiting migration"', () => {
    const s = classifyLaunch(
      DEPLOYED,
      decodedGlobal(),
      decodedCurve({ complete: true, pool: POOL, realSol: TARGET + RESERVE }),
    );
    expect(s.phase.kind).toBe('graduated');
  });

  it('row 4: fully funded is AWAITING MIGRATION — distinctly not graduated', () => {
    const s = classifyLaunch(DEPLOYED, decodedGlobal(), decodedCurve({ realSol: TARGET + RESERVE }));
    expect(s.phase).toEqual({ kind: 'awaiting-migration' });
  });

  it('row 5: at the target but short of the ceiling is AT-TARGET, not awaiting migration', () => {
    const s = classifyLaunch(
      DEPLOYED,
      decodedGlobal(),
      decodedCurve({ realSol: TARGET + RESERVE - 1n }),
    );
    expect(s.phase).toEqual({ kind: 'at-target' });
    // …and one lamport more flips it. The boundary is the ceiling, not the target.
    expect(
      classifyLaunch(DEPLOYED, decodedGlobal(), decodedCurve({ realSol: TARGET + RESERVE })).phase,
    ).toEqual({ kind: 'awaiting-migration' });
  });

  it('row 6: anything below the target is trading', () => {
    const s = classifyLaunch(DEPLOYED, decodedGlobal(), decodedCurve({ realSol: TARGET - 1n }));
    expect(s.phase).toEqual({ kind: 'trading' });
  });

  it('paused overlays the phase — it never replaces it, because sells stay open', () => {
    const s = classifyLaunch(DEPLOYED, decodedGlobal({ paused: true }), decodedCurve());
    expect(s.phase).toEqual({ kind: 'trading' });
    expect(s.paused).toBe(true);
  });

  it('an unconfigured venue is reported and is not a launch problem', () => {
    const s = classifyLaunch(DEPLOYED, decodedGlobal({ ammConfigured: false }), decodedCurve());
    expect(s.ammConfigured).toBe(false);
    expect(s.phase).toEqual({ kind: 'trading' });
  });
});

describe('readLaunch — end to end', () => {
  it('does not touch a single PDA when the program is not deployed', async () => {
    const rpc = fakeRpc();
    const s = await readLaunch(rpc, MINT);
    expect(s.phase).toEqual({ kind: 'not-deployed' });
    expect(rpc.reads).toEqual([PROGRAM_ID.toBase58()]);
  });

  it('does not touch a single PDA when the deployment read fails', async () => {
    const rpc = fakeRpc({ accounts: { [PROGRAM_ID.toBase58()]: new Error('nope') } });
    const s = await readLaunch(rpc, MINT);
    expect(s.phase.kind).toBe('unreadable');
    expect(rpc.reads).toEqual([PROGRAM_ID.toBase58()]);
  });

  it('classifies a healthy mid-raise launch', async () => {
    const rpc = fakeRpc({ accounts: healthyAccounts() });
    const s = await readLaunch(rpc, MINT);
    expect(s.phase).toEqual({ kind: 'trading' });
    expect(s.paused).toBe(false);
    expect(s.ammConfigured).toBe(true);
    expect(s.curve?.curve.realSolReserves).toBe(7n * SOL);
    expect(rpc.reads).toHaveLength(3);
  });

  it('the LIVE program id genuinely returns nothing — the placeholder is not deployed', async () => {
    // The whole product premise. If this ever fails, a real deploy happened and
    // every "not deployed" copy in the app needs revisiting.
    const s = await readLaunch(fakeRpc(), MINT, PROGRAM_ID);
    expect(s.phase.kind).toBe('not-deployed');
  });
});

// ── derived numbers ─────────────────────────────────────────────────────────

const TERMS: CurveTerms = {
  virtualSolReserves: 30n * SOL,
  virtualTokenReserves: 1_073_000_000_000_000n,
  realSolReserves: 0n,
  realTokenReserves: 1_000_000_000_000_000n,
  tradeFeeBps: 100n,
  graduationTargetLamports: TARGET,
  migrationReserveLamports: RESERVE,
};

describe('curveProgress', () => {
  it('measures progress against target + reserve, which is what buy caps on', () => {
    const p = curveProgress({ ...TERMS, realSolReserves: TARGET });
    expect(p).not.toBeNull();
    expect(p!.ceilingLamports).toBe(TARGET + RESERVE);
    // Against the target ALONE this would read 100% while buys still succeed.
    expect(p!.progressBps).toBeLessThan(10_000);
    expect(p!.raisedLamports).toBe(TARGET);
  });

  it('clamps at 100% and reports fully-funded distinctly from an amount', () => {
    const p = curveProgress({ ...TERMS, realSolReserves: TARGET + RESERVE });
    expect(p!.progressBps).toBe(10_000);
    expect(p!.remainingToSend).toEqual({ kind: 'fully-funded' });
  });

  it('the remaining amount is what a buyer must SEND — grossed up for the fee', () => {
    const p = curveProgress(TERMS);
    expect(p!.remainingToSend.kind).toBe('amount');
    if (p!.remainingToSend.kind !== 'amount') return;
    // Post-fee it must land at or above the ceiling; it is strictly larger than it.
    expect(p!.remainingToSend.lamports).toBeGreaterThan(TARGET + RESERVE);
  });

  it('reports an arithmetic failure as unknown, never as fully-funded', () => {
    const broken = { ...TERMS, tradeFeeBps: 10_000n };
    const p = curveProgress(broken);
    expect(p!.remainingToSend).toEqual({ kind: 'unknown', error: 'FeeTooHigh' });
  });

  it('tokensSold needs the global supply and is null without it', () => {
    expect(curveProgress(TERMS)!.tokensSold).toBeNull();
    const sold = curveProgress(
      { ...TERMS, realTokenReserves: 900_000_000_000_000n },
      1_000_000_000_000_000n,
    );
    expect(sold!.tokensSold).toBe(100_000_000_000_000n);
    // An impossible pairing yields null rather than a negative count.
    expect(curveProgress(TERMS, 1n)!.tokensSold).toBeNull();
  });

  it('spot is an exact fraction, not a rounded number', () => {
    const p = curveProgress({ ...TERMS, realSolReserves: 5n * SOL });
    expect(p!.spot).toEqual({
      numerator: 35n * SOL,
      denominator: 1_073_000_000_000_000n + 1_000_000_000_000_000n,
    });
  });
});

describe('migrationEligibility', () => {
  const globalOk = (o?: Parameters<typeof globalBytes>[0]): GlobalConfig => {
    const g = decodedGlobal(o);
    if (g.kind !== 'ok') throw new Error('fixture');
    return g.value;
  };
  const curveAt = (realSol: bigint, lamports: bigint, complete = false): CurveAccount => {
    const c = decodedCurve({ realSol, complete, pool: complete ? POOL : undefined }, lamports);
    if (c.kind !== 'ok') throw new Error('fixture');
    return c.value;
  };

  it('blocks on paused, on an unset venue, and on a completed curve', () => {
    const funded = curveAt(TARGET + RESERVE, RENT_EXEMPT_CURVE + TARGET + RESERVE);
    expect(migrationEligibility(globalOk({ paused: true }), funded, RENT_EXEMPT_CURVE)).toEqual({
      eligible: false,
      blockedBy: 'paused',
    });
    expect(
      migrationEligibility(globalOk({ ammConfigured: false }), funded, RENT_EXEMPT_CURVE),
    ).toEqual({ eligible: false, blockedBy: 'amm-not-configured' });
    expect(
      migrationEligibility(
        globalOk(),
        curveAt(TARGET + RESERVE, RENT_EXEMPT_CURVE + TARGET + RESERVE, true),
        RENT_EXEMPT_CURVE,
      ),
    ).toEqual({ eligible: false, blockedBy: 'already-complete' });
  });

  it('blocks below the target', () => {
    expect(
      migrationEligibility(
        globalOk(),
        curveAt(TARGET - 1n, RENT_EXEMPT_CURVE + TARGET),
        RENT_EXEMPT_CURVE,
      ),
    ).toEqual({ eligible: false, blockedBy: 'below-target' });
  });

  it('the binding check reads the ACCOUNT balance, not real_sol_reserves', () => {
    // real_sol_reserves says fully funded, but the PDA does not hold enough once
    // rent is set aside — this is exactly the case lib.rs:731-743 catches.
    expect(
      migrationEligibility(
        globalOk(),
        curveAt(TARGET + RESERVE, RENT_EXEMPT_CURVE + TARGET + RESERVE - 1n),
        RENT_EXEMPT_CURVE,
      ),
    ).toEqual({ eligible: false, blockedBy: 'reserve-too-low' });
    expect(
      migrationEligibility(
        globalOk(),
        curveAt(TARGET + RESERVE, RENT_EXEMPT_CURVE + TARGET + RESERVE),
        RENT_EXEMPT_CURVE,
      ),
    ).toEqual({ eligible: true });
  });

  it('without the rent floor the answer is UNKNOWN, never a guess', () => {
    const r = migrationEligibility(
      globalOk(),
      curveAt(TARGET + RESERVE, RENT_EXEMPT_CURVE + TARGET + RESERVE),
      null,
    );
    expect(r.eligible).toBeNull();
  });

  it('at-target but short of the reserve is reserve-too-low — do not offer the button', () => {
    // Row 5 of the phase table: `NotReadyToGraduate` passes, the budget check does not.
    expect(
      migrationEligibility(
        globalOk(),
        curveAt(TARGET, RENT_EXEMPT_CURVE + TARGET),
        RENT_EXEMPT_CURVE,
      ),
    ).toEqual({ eligible: false, blockedBy: 'reserve-too-low' });
  });
});

describe('the account sizes the rent reads use', () => {
  it('match the layouts', () => {
    expect(GLOBAL_CONFIG_SIZE).toBe(186);
    expect(BONDING_CURVE_SIZE).toBe(162);
  });
});
