// @vitest-environment node
// PDA derivation goes through web3.js's SYNC sha256 path, which does not work
// under jsdom — the same constraint dbcClient.test.ts:1-5 already runs into.
// Measured here: under jsdom `new TextEncoder().encode(x).constructor === Uint8Array`
// is FALSE (separate realm) and findProgramAddressSync throws "Unable to find a
// viable program address nonce" for every seed shape, including Buffer; under
// the node environment the identical call derives correctly. It is a harness
// artifact, not a defect in the derivation — a real browser has one realm.
import '../../solanaPolyfill';
import { describe, it, expect, vi } from 'vitest';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  browserRpc,
  clipMessage,
  deriveLaunchPdas,
  probeProgram,
  readLaunch,
  readMint,
  type SolanaRpc,
} from './curveClient';
import { BONDING_CURVE_SIZE, TEGRIDY_LAUNCH_PROGRAM_ID } from './curve';

const MINT = 'So11111111111111111111111111111111111111112';

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
  v.setBigUint64(112, 85_000_000_000n, true); // graduation_target_lamports
  v.setBigUint64(120, 1_000_000_000n, true); // migration_reserve_lamports
  b[128] = over.complete ? 1 : 0;
  return b;
}

/** The canonical 82-byte SPL Mint layout. */
function mintBytes(o: { supply?: bigint; decimals?: number; freeze?: boolean; mintAuth?: boolean } = {}): Uint8Array {
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

describe('probeProgram', () => {
  it('reports NOT DEPLOYED when the program id returns null', () => {
    // This is the live answer today: the id in lib.rs:101 is a placeholder that
    // corresponds to no key anybody holds.
    const rpc: SolanaRpc = async () => ({ value: null });
    return expect(probeProgram(rpc)).resolves.toEqual({ status: 'not-deployed' });
  });

  it('reports DEPLOYED only for an executable account', async () => {
    const rpc: SolanaRpc = async () => ({ value: { executable: true, owner: 'BPFLoaderUpgradeab1e11111111111111111111111' } });
    expect(await probeProgram(rpc)).toEqual({ status: 'deployed' });
  });

  it('does NOT call a non-executable account "deployed" — nor "not deployed"', async () => {
    // Something occupies the address but it is not a program. Neither answer is
    // available, so the honest result is that we could not conclude.
    const rpc: SolanaRpc = async () => ({ value: { executable: false } });
    const r = await probeProgram(rpc);
    expect(r.status).toBe('unreadable');
  });

  it('reports an RPC failure as UNREADABLE, never as "not deployed"', async () => {
    // The bug this guards: a 503 rendering as a clean negative finding.
    const rpc: SolanaRpc = async () => {
      throw new Error('getAccountInfo: HTTP 503');
    };
    const r = await probeProgram(rpc);
    expect(r.status).toBe('unreadable');
    if (r.status === 'unreadable') expect(r.reason).toMatch(/503/);
  });

  it('asks about the placeholder program id by default', async () => {
    const seen: unknown[] = [];
    const rpc: SolanaRpc = async (_m, params) => {
      seen.push(params[0]);
      return { value: null };
    };
    await probeProgram(rpc);
    expect(seen[0]).toBe(TEGRIDY_LAUNCH_PROGRAM_ID);
  });
});

describe('deriveLaunchPdas', () => {
  it('derives all five PDAs from this program, deterministically', async () => {
    const a = await deriveLaunchPdas(MINT);
    const b = await deriveLaunchPdas(MINT);
    expect(a).toEqual(b);
    for (const v of Object.values(a)) expect(typeof v).toBe('string');
    // Every PDA is distinct — a seed collision would silently point two roles
    // at one account.
    expect(new Set(Object.values(a)).size).toBe(5);
  });

  it('keys the per-launch PDAs on the mint but not `global`', async () => {
    const a = await deriveLaunchPdas(MINT);
    const b = await deriveLaunchPdas('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(a.global).toBe(b.global);
    expect(a.curve).not.toBe(b.curve);
    expect(a.vault).not.toBe(b.vault);
    expect(a.pool).not.toBe(b.pool);
  });

  it('derives `pool` from OUR seed, not cp-swap\'s canonical one', async () => {
    // cp-swap's canonical pool PDA is permissionlessly squattable — occupying
    // it bricks graduation for one transaction's cost (state.rs:50-69). A
    // client deriving the canonical address points users at an address anyone
    // can occupy. Pin that `pool` is derived on tegridy-launch's program id.
    const { PublicKey } = await import('@solana/web3.js');
    const expected = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('launchpool'), new PublicKey(MINT).toBytes()],
      new PublicKey(TEGRIDY_LAUNCH_PROGRAM_ID),
    )[0].toBase58();
    expect((await deriveLaunchPdas(MINT)).pool).toBe(expected);
  });
});

describe('readLaunch', () => {
  it('decodes global + curve from one getMultipleAccounts round trip', async () => {
    const calls: string[] = [];
    const rpc: SolanaRpc = async (method) => {
      calls.push(method);
      if (method === 'getMultipleAccounts') {
        return { value: [null, { data: [b64(curveBytes({ realSol: 5_000_000_000n })), 'base64'], lamports: 7_018_400 }] };
      }
      return 2_018_400;
    };
    const snap = await readLaunch(rpc, MINT);
    expect(calls).toContain('getMultipleAccounts');
    expect(snap.global.status).toBe('absent');
    expect(snap.curve.status).toBe('present');
    if (snap.curve.status === 'present') expect(snap.curve.value.realSolReserves).toBe(5_000_000_000n);
    expect(snap.curveRentExemptLamports).toBe(2_018_400n);
  });

  it('keeps the PDA lamport balance separate from real_sol_reserves', async () => {
    // The PDA holds rent + reserves + anything donated. Rendering progress from
    // the balance would over-report every launch; the migration budget check
    // needs the balance and not the field. Both must survive the read.
    const rpc: SolanaRpc = async (method) =>
      method === 'getMultipleAccounts'
        ? { value: [null, { data: [b64(curveBytes({ realSol: 5_000_000_000n })), 'base64'], lamports: 9_000_000_000 }] }
        : 2_018_400;
    const snap = await readLaunch(rpc, MINT);
    if (snap.curve.status !== 'present') throw new Error('expected present');
    expect(snap.curve.value.realSolReserves).toBe(5_000_000_000n);
    expect(snap.curveAccountLamports).toBe(9_000_000_000n);
    expect(snap.curveAccountLamports).not.toBe(snap.curve.value.realSolReserves);
  });

  it('marks BOTH accounts unreadable when the batch fails — never absent', async () => {
    const rpc: SolanaRpc = async (method) => {
      if (method === 'getMultipleAccounts') throw new Error('upstream 502 Bad Gateway');
      return 2_018_400;
    };
    const snap = await readLaunch(rpc, MINT);
    expect(snap.global.status).toBe('unreadable');
    expect(snap.curve.status).toBe('unreadable');
    if (snap.curve.status === 'unreadable') expect(snap.curve.reason).toMatch(/502/);
  });

  it('lets the rent read fail on its own without inventing a figure', async () => {
    const rpc: SolanaRpc = async (method) => {
      if (method === 'getMultipleAccounts') return { value: [null, { data: [b64(curveBytes()), 'base64'], lamports: 1 }] };
      throw new Error('rent lookup failed');
    };
    const snap = await readLaunch(rpc, MINT);
    expect(snap.curve.status).toBe('present');
    expect(snap.curveRentExemptLamports).toBeNull(); // not 0, not a hardcoded constant
  });
});

describe('readMint', () => {
  it('reads the facts create_launch actually constrains', async () => {
    const rpc: SolanaRpc = async () => ({ value: { data: [b64(mintBytes()), 'base64'], owner: TOKEN_PROGRAM_ID } });
    const r = await readMint(rpc, MINT);
    if (r.status !== 'present') throw new Error('expected present');
    expect(r.value.supply).toBe(0n);
    expect(r.value.decimals).toBe(9);
    expect(r.value.freezeAuthority).toBeNull();
    expect(r.value.mintAuthority).not.toBeNull();
    expect(r.value.isLegacySplToken).toBe(true);
  });

  it('surfaces a retained freeze authority', async () => {
    // Load-bearing: a freeze authority can freeze curve_vault — a deterministic
    // public PDA — and lock 100% of raised SOL forever (6011).
    const rpc: SolanaRpc = async () => ({ value: { data: [b64(mintBytes({ freeze: true })), 'base64'], owner: TOKEN_PROGRAM_ID } });
    const r = await readMint(rpc, MINT);
    if (r.status !== 'present') throw new Error('expected present');
    expect(r.value.freezeAuthority).not.toBeNull();
  });

  it('flags a Token-2022 mint as not legacy SPL', async () => {
    const rpc: SolanaRpc = async () => ({ value: { data: [b64(mintBytes()), 'base64'], owner: TOKEN_2022_PROGRAM_ID } });
    const r = await readMint(rpc, MINT);
    if (r.status !== 'present') throw new Error('expected present');
    expect(r.value.isLegacySplToken).toBe(false);
  });

  it('reads real decimals rather than assuming 9', async () => {
    const rpc: SolanaRpc = async () => ({ value: { data: [b64(mintBytes({ decimals: 6 })), 'base64'], owner: TOKEN_PROGRAM_ID } });
    const r = await readMint(rpc, MINT);
    if (r.status !== 'present') throw new Error('expected present');
    expect(r.value.decimals).toBe(6);
  });

  it('reports a missing mint as absent and a short buffer as unreadable', async () => {
    expect((await readMint(async () => ({ value: null }), MINT)).status).toBe('absent');
    const short: SolanaRpc = async () => ({ value: { data: [b64(new Uint8Array(10)), 'base64'], owner: TOKEN_PROGRAM_ID } });
    expect((await readMint(short, MINT)).status).toBe('unreadable');
  });
});

describe('browserRpc', () => {
  it('posts JSON-RPC to our OWN origin, never a Solana host', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ result: { value: null } }) }) as unknown as Response);
    const rpc = browserRpc(fetchMock as unknown as typeof fetch);
    await rpc('getAccountInfo', ['x']);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/solrpc');
    expect(url).not.toMatch(/solana|helius|quicknode|alchemy/i);
    expect(JSON.parse(init.body as string)).toMatchObject({ jsonrpc: '2.0', method: 'getAccountInfo' });
  });

  it('throws on a JSON-RPC error body instead of returning undefined as data', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ error: { message: 'method not allowed' } }) }) as unknown as Response,
    );
    const rpc = browserRpc(fetchMock as unknown as typeof fetch);
    await expect(rpc('getProgramAccounts', [])).rejects.toThrow(/method not allowed/);
  });

  it('throws on a non-200 rather than parsing an error page as a result', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429 }) as unknown as Response);
    const rpc = browserRpc(fetchMock as unknown as typeof fetch);
    await expect(rpc('getAccountInfo', [])).rejects.toThrow(/429/);
  });
});

describe('clipMessage', () => {
  it('bounds a transport error so a request body cannot reach the page', () => {
    expect(clipMessage('a'.repeat(500))).toHaveLength(181); // 180 + ellipsis
    expect(clipMessage('  spaced   out  ')).toBe('spaced out');
  });
});
