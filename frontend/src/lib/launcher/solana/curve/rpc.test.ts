// @vitest-environment node
// PDA derivation goes through web3.js's SYNC sha256 path, which does not work
// under jsdom — the same constraint dbcClient.test.ts:1-5 already runs into.
// Measured: under jsdom `new TextEncoder().encode(x).constructor === Uint8Array`
// is FALSE (separate realm) and findProgramAddressSync throws "Unable to find a
// viable program address nonce" for every seed shape; under the node environment
// the identical call derives correctly. A harness artifact, not a defect — a real
// browser has one realm.
import '../../../solanaPolyfill';
import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { browserCurveRpc, browserRpc, readMint, type SolanaRpc } from './rpc';
import {
  BONDING_CURVE_SIZE,
  GLOBAL_CONFIG_SIZE,
  PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './program';
import { readDeployment, readLaunch } from './read';

const MINT = 'So11111111111111111111111111111111111111112';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** A minimal, well-formed BondingCurve account payload. */
function curveBytes(over: { realSol?: bigint; complete?: boolean } = {}): Uint8Array {
  const b = new Uint8Array(BONDING_CURVE_SIZE);
  b.set([23, 183, 248, 55, 96, 216, 172, 96], 0);
  const v = new DataView(b.buffer);
  v.setBigUint64(72, 30_000_000_000n, true); // virtual_sol_reserves
  v.setBigUint64(80, 1_073_000_000_000_000n, true); // virtual_token_reserves
  v.setBigUint64(88, over.realSol ?? 0n, true); // real_sol_reserves
  v.setBigUint64(96, 1_000_000_000_000_000n, true); // real_token_reserves
  v.setBigUint64(104, 100n, true); // trade_fee_bps
  v.setBigUint64(112, 4_800n, true); // creator_fee_share_bps
  v.setBigUint64(120, 85_000_000_000n, true); // graduation_target_lamports
  v.setBigUint64(128, 1_000_000_000n, true); // migration_reserve_lamports
  b[136] = over.complete ? 1 : 0;
  // 137..168 pool, 169 bump — zero here, which reads as "not migrated".
  return b;
}

/**
 * A minimal, well-formed GlobalConfig payload.
 *
 * Present in every launch fixture below because `classifyLaunch` evaluates
 * `global` BEFORE `curve` — without it every case would report
 * `protocol-not-initialized` and the curve branch under test would never be
 * reached.
 */
function globalBytes(): Uint8Array {
  // 194: `creator_fee_share_bps` sits second, shifting every offset below it by 8.
  const b = new Uint8Array(GLOBAL_CONFIG_SIZE);
  b.set([149, 8, 156, 202, 160, 252, 176, 217], 0);
  b.set(new PublicKey(MINT).toBytes(), 8); // authority
  b.set(new PublicKey(MINT).toBytes(), 40); // fee_recipient
  const v = new DataView(b.buffer);
  v.setBigUint64(72, 100n, true); // trade_fee_bps
  v.setBigUint64(80, 4_800n, true); // creator_fee_share_bps
  v.setBigUint64(88, 30_000_000_000n, true); // initial_virtual_sol
  v.setBigUint64(96, 1_073_000_000_000_000n, true); // initial_virtual_token
  v.setBigUint64(104, 1_000_000_000_000_000n, true); // token_total_supply
  v.setBigUint64(112, 85_000_000_000n, true); // graduation_target_lamports
  v.setBigUint64(120, 1_000_000_000n, true); // migration_reserve_lamports
  b.set(new PublicKey(MINT).toBytes(), 128); // cp_swap_program
  b.set(new PublicKey(MINT).toBytes(), 160); // amm_config
  b[192] = 0; // paused
  b[193] = 254; // bump
  return b;
}

/** The canonical 82-byte SPL Mint layout. */
function mintBytes(
  o: { supply?: bigint; decimals?: number; freeze?: boolean; mintAuth?: boolean } = {},
): Uint8Array {
  const b = new Uint8Array(82);
  const v = new DataView(b.buffer);
  v.setUint32(0, o.mintAuth === false ? 0 : 1, true); // mint_authority COption tag
  b.set(new Uint8Array(32).fill(7), 4);
  v.setBigUint64(36, o.supply ?? 0n, true);
  b[44] = o.decimals ?? 9;
  b[45] = 1; // is_initialized
  v.setUint32(46, o.freeze ? 1 : 0, true); // freeze_authority COption tag
  b.set(new Uint8Array(32).fill(8), 50);
  return b;
}

const account = (data: Uint8Array, over: Record<string, unknown> = {}) => ({
  data: [b64(data), 'base64'],
  owner: PROGRAM_ID.toBase58(),
  lamports: 1_000_000,
  executable: false,
  ...over,
});

// ── the two accounts a live upgradeable program is ──────────────────────────
// The executable flag on the program account is NOT the answer: `solana program
// close` deletes ProgramData and leaves the stub flagged. These fixtures used to
// be `new Uint8Array(36)` — all zeros — which is not a stub any loader would
// write, and they passed only because nothing followed the pointer.
const PROGRAM_DATA = '6vV7DqMyGwpM18rf2Lkefa1U9YfKquZjvwA61ch3FsnS';

/** A `Program` stub: `u32 enum(2) | 32-byte ProgramData address`. */
function stubBytes(programData = PROGRAM_DATA): Uint8Array {
  const b = new Uint8Array(36);
  new DataView(b.buffer).setUint32(0, 2, true);
  b.set(new PublicKey(programData).toBytes(), 4);
  return b;
}

/** The stub plus the ProgramData account it points at — a program that can run. */
const liveProgram = () => account(stubBytes(), { owner: LOADER, executable: true });
const liveProgramData = () => account(new Uint8Array(45), { lamports: 2_000_000_000 });

// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS FILE EXISTS FOR
//
// A JSON-RPC 200 that carries NEITHER `result` NOR `error` is a malformed
// response. The obvious transport returns `body.result` — `undefined` there — and
// every `?? null` / `?? []` downstream converts that silence into a confident
// negative: `not-deployed`, and a page stating "There is no program at this
// address. No launches exist…". A fabricated finding from a non-answer.
//
// Each block below covers one place the silence used to land.
// ─────────────────────────────────────────────────────────────────────────────

describe('browserRpc — a non-answer is never an answer', () => {
  const withBody = (body: unknown, ok = true, status = 200) =>
    browserRpc(
      vi.fn(async () => ({ ok, status, json: async () => body }) as unknown as Response) as unknown as typeof fetch,
    );

  it('posts JSON-RPC to our OWN origin, never a Solana host', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({ result: { value: null } }) }) as unknown as Response,
    );
    const rpc = browserRpc(fetchMock as unknown as typeof fetch);
    await rpc('getAccountInfo', ['x']);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/solrpc');
    expect(url).not.toMatch(/solana|helius|quicknode|alchemy/i);
    expect(JSON.parse(init.body as string)).toMatchObject({ jsonrpc: '2.0', method: 'getAccountInfo' });
  });

  it('THROWS on a 200 carrying neither result nor error', async () => {
    // The fix. Previously this returned `undefined`, which every caller turned
    // into a clean negative finding about the chain.
    await expect(withBody({ jsonrpc: '2.0', id: 1 })('getAccountInfo', [])).rejects.toThrow(
      /neither a result nor an error/,
    );
  });

  it('keeps an explicit null result — that IS an answer', async () => {
    // "No account at this address" is a real, useful reading. Only the ABSENCE of
    // the member is a non-answer, so the check is `'result' in body`.
    await expect(withBody({ jsonrpc: '2.0', id: 1, result: null })('getAccountInfo', [])).resolves.toBeNull();
  });

  it('throws on a body that is not an object at all', async () => {
    await expect(withBody('gateway timeout')('getAccountInfo', [])).rejects.toThrow(/not a JSON-RPC object/);
    await expect(withBody(null)('getAccountInfo', [])).rejects.toThrow(/not a JSON-RPC object/);
  });

  it('throws when the body is not JSON, naming that rather than the chain', async () => {
    const rpc = browserRpc(
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected token < in JSON at position 0');
            },
          }) as unknown as Response,
      ) as unknown as typeof fetch,
    );
    await expect(rpc('getAccountInfo', [])).rejects.toThrow(/was not JSON/);
  });

  it('throws on a JSON-RPC error body instead of returning undefined as data', async () => {
    await expect(
      withBody({ error: { message: 'method not allowed' } })('getProgramAccounts', []),
    ).rejects.toThrow(/method not allowed/);
  });

  it('throws on a non-200 rather than parsing an error page as a result', async () => {
    await expect(withBody({}, false, 429)('getAccountInfo', [])).rejects.toThrow(/429/);
  });
});

describe('browserCurveRpc — a malformed account payload is unreadable, not absent', () => {
  const from = (handler: SolanaRpc) => browserCurveRpc(handler);

  it('returns null only for an explicit null value', async () => {
    const rpc = from(async () => ({ value: null }));
    expect(await rpc.getAccountInfo(PROGRAM_ID)).toBeNull();
  });

  it('THROWS when the context wrapper carries no `value` member', async () => {
    // `res?.value ?? null` used to turn this into "the account is absent".
    const rpc = from(async () => ({ context: { slot: 1 } }));
    await expect(rpc.getAccountInfo(PROGRAM_ID)).rejects.toThrow(/no `value`/);
  });

  it('throws when the payload is not an object', async () => {
    await expect(from(async () => 'ok').getAccountInfo(PROGRAM_ID)).rejects.toThrow(/expected an object/);
  });

  it('throws when the account carries no base64 data, owner, or lamports', async () => {
    await expect(
      from(async () => ({ value: { owner: LOADER, lamports: 1 } })).getAccountInfo(PROGRAM_ID),
    ).rejects.toThrow(/no base64 data/);
    await expect(
      from(async () => ({ value: account(new Uint8Array(4), { owner: undefined }) })).getAccountInfo(PROGRAM_ID),
    ).rejects.toThrow(/no owner/);
    await expect(
      from(async () => ({ value: account(new Uint8Array(4), { lamports: undefined }) })).getAccountInfo(PROGRAM_ID),
    ).rejects.toThrow(/no lamport balance/);
  });

  // `executable` is the one field the deployment probe branches on, and it was the
  // only one of the four not runtime-checked. A proxy answering `"true"` or `1` would
  // fail `=== undefined`, so it flowed into the "exists but is not a program" branch —
  // reporting our own live program as a squatting account, off a value nobody validated.
  it('throws on a non-boolean executable flag instead of branching on it', async () => {
    for (const bad of ['true', 1, 0, null, {}]) {
      await expect(
        from(async () => ({ value: account(new Uint8Array(4), { executable: bad }) })).getAccountInfo(PROGRAM_ID),
      ).rejects.toThrow(/non-boolean executable/);
    }
  });

  it('still passes a MISSING executable through as undefined, so it reads unreadable', async () => {
    // Absent is not malformed: readDeployment turns undefined into `unreadable`.
    // Throwing here, or defaulting to false, would both be wrong in opposite ways.
    const snap = await from(async () => ({
      value: account(new Uint8Array(4), { executable: undefined }),
    })).getAccountInfo(PROGRAM_ID);
    expect(snap?.executable).toBeUndefined();
  });

  it('accepts both real booleans', async () => {
    for (const good of [true, false]) {
      const snap = await from(async () => ({
        value: account(new Uint8Array(4), { executable: good }),
      })).getAccountInfo(PROGRAM_ID);
      expect(snap?.executable).toBe(good);
    }
  });

  it('refuses a non-numeric rent figure rather than passing a guess along', async () => {
    await expect(
      from(async () => 'plenty').getMinimumBalanceForRentExemption(BONDING_CURVE_SIZE),
    ).rejects.toThrow(/expected a number/);
  });
});

describe('readDeployment over the browser transport — the fabricated finding', () => {
  it('reports a malformed 200 as UNREADABLE, never as not-deployed', async () => {
    // ⚠ THE ORIGINAL BUG, END TO END. This exact response used to produce
    // `{status:'not-deployed'}` and a page stating "There is no program at this
    // address. No launches exist…" — a finding manufactured from silence.
    const rpc = browserCurveRpc(async () => ({ context: { slot: 1 } }));
    const d = await readDeployment(rpc);
    expect(d.kind).toBe('unreadable');
    expect(d.kind === 'unreadable' && d.detail).toMatch(/`value`/);
  });

  it('still reports a genuine null as not-deployed', async () => {
    // Fixing the malformed case must not blunt the real one. (This said the id
    // "is a placeholder that corresponds to no key anybody holds" — it was
    // deployed to on 2026-08-08 and the address is now spent, not unused.)
    const rpc = browserCurveRpc(async () => ({ value: null }));
    expect(await readDeployment(rpc)).toEqual({ kind: 'not-deployed' });
  });

  it('reports an executable account with live ProgramData as deployed', async () => {
    const rpc = browserCurveRpc(async (_m, params) =>
      String(params[0]) === PROGRAM_DATA ? { value: liveProgramData() } : { value: liveProgram() },
    );
    expect(await readDeployment(rpc)).toEqual({ kind: 'deployed', executable: true });
  });

  it('reports an executable account whose ProgramData is gone as CLOSED', async () => {
    // The state both of this repo's mainnet ids are actually in, over the real
    // browser transport rather than the in-memory fake.
    const rpc = browserCurveRpc(async (_m, params) =>
      String(params[0]) === PROGRAM_DATA ? { value: null } : { value: liveProgram() },
    );
    expect(await readDeployment(rpc)).toEqual({ kind: 'closed', programDataAddress: PROGRAM_DATA });
  });

  it('reports a non-executable squatter as not-a-program, neither deployed nor absent', async () => {
    const rpc = browserCurveRpc(async () => ({
      value: account(new Uint8Array(4), { owner: LOADER, executable: false }),
    }));
    expect(await readDeployment(rpc)).toEqual({ kind: 'not-a-program', owner: LOADER });
  });

  it('reports an RPC failure as unreadable, never as "not deployed"', async () => {
    const rpc = browserCurveRpc(async () => {
      throw new Error('getAccountInfo: HTTP 503');
    });
    const d = await readDeployment(rpc);
    expect(d.kind).toBe('unreadable');
    expect(d.kind === 'unreadable' && d.detail).toMatch(/503/);
  });

  it('asks about PROGRAM_ID by default', async () => {
    const seen: unknown[] = [];
    const rpc = browserCurveRpc(async (_m, params) => {
      seen.push(params[0]);
      return { value: null };
    });
    await readDeployment(rpc);
    expect(seen[0]).toBe(PROGRAM_ID.toBase58());
  });
});

describe('readLaunch over the browser transport', () => {
  /** Route by address so a launch read can be composed from three accounts. */
  const byAddress = (accounts: Record<string, unknown>) =>
    browserCurveRpc(async (method, params) => {
      if (method === 'getMinimumBalanceForRentExemption') return 2_018_400;
      const key = String(params[0]);
      if (!(key in accounts)) return { value: null };
      const hit = accounts[key];
      if (hit instanceof Error) throw hit;
      return { value: hit };
    });

  const program = liveProgram();

  it('stops at the program and never derives PDAs when it is not there', async () => {
    const asked: string[] = [];
    const rpc = browserCurveRpc(async (_m, params) => {
      asked.push(String(params[0]));
      return { value: null };
    });
    const s = await readLaunch(rpc, new PublicKey(MINT));
    expect(s.phase).toEqual({ kind: 'not-deployed' });
    expect(asked).toEqual([PROGRAM_ID.toBase58()]);
  });

  it('keeps the PDA lamport balance separate from real_sol_reserves', async () => {
    // The PDA holds rent + reserves + anything donated. Rendering progress from
    // the balance would over-report every launch; the migration budget check needs
    // the balance and not the field. Both must survive the read.
    const { curvePda, globalPda } = await import('./program');
    const rpc = byAddress({
      [PROGRAM_ID.toBase58()]: program,
      [PROGRAM_DATA]: liveProgramData(),
      [globalPda().toBase58()]: account(globalBytes()),
      [curvePda(new PublicKey(MINT)).toBase58()]: account(curveBytes({ realSol: 5_000_000_000n }), {
        lamports: 9_000_000_000,
      }),
    });
    const s = await readLaunch(rpc, new PublicKey(MINT));
    expect(s.curve).not.toBeNull();
    expect(s.curve!.curve.realSolReserves).toBe(5_000_000_000n);
    expect(s.curve!.lamports).toBe(9_000_000_000n);
    expect(s.curve!.lamports).not.toBe(s.curve!.curve.realSolReserves);
  });

  it('marks the launch unreadable when the curve read fails — never pre-launch', async () => {
    const { curvePda, globalPda } = await import('./program');
    const rpc = byAddress({
      [PROGRAM_ID.toBase58()]: program,
      [PROGRAM_DATA]: liveProgramData(),
      [globalPda().toBase58()]: account(globalBytes()),
      [curvePda(new PublicKey(MINT)).toBase58()]: new Error('upstream 502 Bad Gateway'),
    });
    const s = await readLaunch(rpc, new PublicKey(MINT));
    expect(s.phase.kind).toBe('unreadable');
    expect(s.phase.kind === 'unreadable' && s.phase.detail).toMatch(/502/);
  });

  it('a malformed curve response is unreadable, not "no curve for this mint"', async () => {
    const { curvePda, globalPda } = await import('./program');
    const rpc = browserCurveRpc(async (method, params) => {
      if (method === 'getMinimumBalanceForRentExemption') return 2_018_400;
      const key = String(params[0]);
      if (key === PROGRAM_ID.toBase58()) return { value: program };
      if (key === PROGRAM_DATA) return { value: liveProgramData() };
      if (key === globalPda().toBase58()) return { value: account(globalBytes()) };
      if (key === curvePda(new PublicKey(MINT)).toBase58()) return { context: { slot: 1 } };
      return { value: null };
    });
    const s = await readLaunch(rpc, new PublicKey(MINT));
    expect(s.phase.kind).toBe('unreadable');
  });
});

describe('readMint', () => {
  const okMint = (bytes: Uint8Array, owner = TOKEN_PROGRAM_ID.toBase58()): SolanaRpc =>
    async () => ({ value: { data: [b64(bytes), 'base64'], owner, lamports: 1 } });

  it('reads the facts create_launch actually constrains', async () => {
    const r = await readMint(okMint(mintBytes()), MINT);
    if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`);
    expect(r.value.supply).toBe(0n);
    expect(r.value.decimals).toBe(9);
    expect(r.value.freezeAuthority).toBeNull();
    expect(r.value.mintAuthority).not.toBeNull();
    expect(r.value.isLegacySplToken).toBe(true);
  });

  it('surfaces a retained freeze authority', async () => {
    // Load-bearing: a freeze authority can freeze curve_vault — a deterministic
    // public PDA — and lock 100% of raised SOL forever (6011).
    const r = await readMint(okMint(mintBytes({ freeze: true })), MINT);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.value.freezeAuthority).not.toBeNull();
  });

  it('flags a Token-2022 mint as not legacy SPL', async () => {
    const r = await readMint(okMint(mintBytes(), TOKEN_2022_PROGRAM_ID.toBase58()), MINT);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.value.isLegacySplToken).toBe(false);
  });

  it('reads real decimals rather than assuming 9', async () => {
    const r = await readMint(okMint(mintBytes({ decimals: 6 })), MINT);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.value.decimals).toBe(6);
  });

  it('reports a missing mint as absent and a short buffer as undecodable', async () => {
    expect((await readMint(async () => ({ value: null }), MINT)).kind).toBe('absent');
    expect((await readMint(okMint(new Uint8Array(10)), MINT)).kind).toBe('undecodable');
  });

  it('reports a malformed response as unreadable, NOT as an absent mint', async () => {
    // Same defect class: a create-launch checklist that reads "no mint at that
    // address yet" from a non-answer is stating something it did not learn.
    const r = await readMint(async () => ({ context: { slot: 1 } }), MINT);
    expect(r.kind).toBe('unreadable');
    expect(r.kind === 'unreadable' && r.detail).toMatch(/`value`/);
  });

  it('reports a transport failure as unreadable', async () => {
    const r = await readMint(async () => {
      throw new Error('HTTP 503');
    }, MINT);
    expect(r.kind).toBe('unreadable');
    expect(r.kind === 'unreadable' && r.detail).toMatch(/503/);
  });
});
