// @vitest-environment node
// PDA derivation goes through web3.js's sync sha256 (`@noble/hashes`), whose
// Uint8Array guard is realm-sensitive: under jsdom, web3.js's Node-realm `Buffer`
// fails `instanceof Uint8Array` and every derivation throws "Unable to find a
// viable program address nonce". A real browser uses the `buffer` polyfill, which
// subclasses the page's own Uint8Array, so this is a jsdom artifact. Same remedy
// as `dbcClient.test.ts`.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  ACCOUNT_DISCRIMINATOR,
  ALREADY_COMPLETE_CODE,
  AWAITING_MIGRATION_CODE,
  BONDING_CURVE_LAYOUT,
  BONDING_CURVE_SIZE,
  CP_SWAP_PROGRAM_ID,
  PLACEHOLDER_PROGRAM_ID,
  DEFAULT_PUBKEY,
  EVENT_DISCRIMINATOR,
  GLOBAL_CONFIG_LAYOUT,
  GLOBAL_CONFIG_SIZE,
  IX_DISCRIMINATOR,
  LAUNCH_ERROR_CODES,
  POST_REMOVAL_PROGRAM,
  PROGRAM_ID,
  cpAmmAuthorityPda,
  cpAmmConfigPda,
  cpLpMintPda,
  cpObservationPda,
  cpPermissionPda,
  cpPoolVaultPda,
  curvePda,
  curveVaultPda,
  decodeBondingCurve,
  decodeGlobalConfig,
  globalPda,
  isAmmConfigured,
  isDefaultPubkey,
  isPlaceholderProgramId,
  launchErrorName,
  migrationAuthorityPda,
  poolStatePda,
  sortMints,
} from './program';

const MINT = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * Recompute an Anchor discriminator from its preimage instead of trusting the
 * literal in the module. This is the check that catches a transposed byte —
 * asserting the constant against itself would catch nothing.
 */
const ascii = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

async function discriminator(preimage: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', ascii(preimage));
  return new Uint8Array(digest).slice(0, 8);
}

describe('discriminators are Anchor default derivation, recomputed', () => {
  const IX_NAMES: Record<keyof typeof IX_DISCRIMINATOR, string> = {
    initializeGlobal: 'initialize_global',
    updateGlobal: 'update_global',
    createLaunch: 'create_launch',
    buy: 'buy',
    sell: 'sell',
    migrateToAmm: 'migrate_to_amm',
  };

  it.each(Object.entries(IX_NAMES))('global:%s', async (key, snake) => {
    expect(IX_DISCRIMINATOR[key as keyof typeof IX_DISCRIMINATOR]).toEqual(
      await discriminator(`global:${snake}`),
    );
  });

  it.each(Object.keys(ACCOUNT_DISCRIMINATOR))('account:%s', async (name) => {
    expect(ACCOUNT_DISCRIMINATOR[name as keyof typeof ACCOUNT_DISCRIMINATOR]).toEqual(
      await discriminator(`account:${name}`),
    );
  });

  it.each(Object.keys(EVENT_DISCRIMINATOR))('event:%s', async (name) => {
    expect(EVENT_DISCRIMINATOR[name as keyof typeof EVENT_DISCRIMINATOR]).toEqual(
      await discriminator(`event:${name}`),
    );
  });
});

describe('account sizes are 8 + InitSpace, summed from the field widths', () => {
  const PUBKEY = 32;
  const U64 = 8;
  const BOOL = 1;
  const U8 = 1;
  const DISC = 8;

  it('GlobalConfig = 194 once the segmented tail is gone', () => {
    // authority, fee_recipient | 7 × u64 | cp_swap_program, amm_config | paused, bump
    expect(DISC + 2 * PUBKEY + 7 * U64 + 2 * PUBKEY + BOOL + U8).toBe(GLOBAL_CONFIG_SIZE);
    expect(GLOBAL_CONFIG_SIZE).toBe(194);
    // The 529 bytes that went: sqrt_price_start_x64 (16) + segment_count (1) +
    // [Segment; 16] (512). The live mainnet account still carries them, which is why
    // it is 723 and why this decoder now rejects it — see the mainnet case below.
    expect(723 - GLOBAL_CONFIG_SIZE).toBe(16 + 1 + 16 * 32);
  });

  it('BondingCurve = 170 once the mode snapshot is gone', () => {
    // mint, creator | 8 × u64 | complete | pool | bump
    expect(DISC + 2 * PUBKEY + 8 * U64 + BOOL + PUBKEY + U8).toBe(BONDING_CURVE_SIZE);
    expect(BONDING_CURVE_SIZE).toBe(170);
    // mode (1) + sqrt_price_x64 (16) + sqrt_price_start_x64 (16) + segment_count (1)
    // + [Segment; 16] (512).
    expect(716 - BONDING_CURVE_SIZE).toBe(1 + 16 + 16 + 1 + 16 * 32);
  });

  // The offset tables are the decoders' ONLY source of offsets, so a field left at
  // a stale offset shows up here as a gap or an overlap rather than as a plausible
  // number decoded from the wrong place.
  it('every offset table is gapless and ends exactly at its size', () => {
    const walk = (fields: readonly [string, number, number][], size: number) => {
      let at = 8; // past the Anchor discriminator
      for (const [name, offset, width] of fields) {
        expect(offset, `${name} starts where the previous field ends`).toBe(at);
        at += width;
      }
      expect(at, 'the last field ends at the account size').toBe(size);
    };

    walk(
      [
        ['authority', GLOBAL_CONFIG_LAYOUT.authority, PUBKEY],
        ['feeRecipient', GLOBAL_CONFIG_LAYOUT.feeRecipient, PUBKEY],
        ['tradeFeeBps', GLOBAL_CONFIG_LAYOUT.tradeFeeBps, U64],
        ['creatorFeeShareBps', GLOBAL_CONFIG_LAYOUT.creatorFeeShareBps, U64],
        ['initialVirtualSol', GLOBAL_CONFIG_LAYOUT.initialVirtualSol, U64],
        ['initialVirtualToken', GLOBAL_CONFIG_LAYOUT.initialVirtualToken, U64],
        ['tokenTotalSupply', GLOBAL_CONFIG_LAYOUT.tokenTotalSupply, U64],
        ['graduationTargetLamports', GLOBAL_CONFIG_LAYOUT.graduationTargetLamports, U64],
        ['migrationReserveLamports', GLOBAL_CONFIG_LAYOUT.migrationReserveLamports, U64],
        ['cpSwapProgram', GLOBAL_CONFIG_LAYOUT.cpSwapProgram, PUBKEY],
        ['ammConfig', GLOBAL_CONFIG_LAYOUT.ammConfig, PUBKEY],
        ['paused', GLOBAL_CONFIG_LAYOUT.paused, BOOL],
        ['bump', GLOBAL_CONFIG_LAYOUT.bump, U8],
      ],
      GLOBAL_CONFIG_LAYOUT.size,
    );

    walk(
      [
        ['mint', BONDING_CURVE_LAYOUT.mint, PUBKEY],
        ['creator', BONDING_CURVE_LAYOUT.creator, PUBKEY],
        ['virtualSolReserves', BONDING_CURVE_LAYOUT.virtualSolReserves, U64],
        ['virtualTokenReserves', BONDING_CURVE_LAYOUT.virtualTokenReserves, U64],
        ['realSolReserves', BONDING_CURVE_LAYOUT.realSolReserves, U64],
        ['realTokenReserves', BONDING_CURVE_LAYOUT.realTokenReserves, U64],
        ['tradeFeeBps', BONDING_CURVE_LAYOUT.tradeFeeBps, U64],
        ['creatorFeeShareBps', BONDING_CURVE_LAYOUT.creatorFeeShareBps, U64],
        ['graduationTargetLamports', BONDING_CURVE_LAYOUT.graduationTargetLamports, U64],
        ['migrationReserveLamports', BONDING_CURVE_LAYOUT.migrationReserveLamports, U64],
        ['complete', BONDING_CURVE_LAYOUT.complete, BOOL],
        ['pool', BONDING_CURVE_LAYOUT.pool, PUBKEY],
        ['bump', BONDING_CURVE_LAYOUT.bump, U8],
      ],
      BONDING_CURVE_LAYOUT.size,
    );
  });

  // The verified layout, transcribed a second time and independently of the module,
  // so a transposed pair of offsets in the table above is caught rather than
  // confirmed by a test that reads the table it is checking.
  it('BondingCurve offsets match the verified post-removal layout', () => {
    expect(BONDING_CURVE_LAYOUT).toEqual({
      mint: 8,
      creator: 40,
      virtualSolReserves: 72,
      virtualTokenReserves: 80,
      realSolReserves: 88,
      realTokenReserves: 96,
      tradeFeeBps: 104,
      creatorFeeShareBps: 112,
      graduationTargetLamports: 120,
      migrationReserveLamports: 128,
      complete: 136,
      pool: 137,
      bump: 169,
      size: 170,
    });
  });
});

// The honesty guard for this module: it targets a program whose source is not on
// this branch, and parts of that target were DERIVED rather than read. A surface
// that presented the whole layout as confirmed would be claiming knowledge it does
// not have, so the module has to keep saying which parts those are.
describe('the drift from the on-disk program is disclosed, not silent', () => {
  it('names the branch it targets', () => {
    expect(POST_REMOVAL_PROGRAM.branch).toBe('claude/solana-segmented-removal');
  });

  it('keeps an explicit list of what was inferred rather than verified', () => {
    // Emptying this list is how the disclosure would disappear — either because
    // someone confirmed every item against the reworked Rust, in which case this
    // test is the right place to record that, or because someone deleted an
    // inconvenient caveat.
    expect(POST_REMOVAL_PROGRAM.UNVERIFIED.length).toBeGreaterThan(0);
    for (const item of POST_REMOVAL_PROGRAM.UNVERIFIED) {
      expect(item.length).toBeGreaterThan(20); // a name, not a shrug
    }
  });

  it('records the date the layout was read off the branch', () => {
    // Three items left this list on 2026-08-18 because they were checked against
    // state.rs and lib.rs — and two of the three were WRONG, so the checking is the
    // whole point. Dropping the stamp while keeping the layout would turn read
    // facts back into unattributed assertions.
    expect(POST_REMOVAL_PROGRAM.VERIFIED_AGAINST_BRANCH).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('no longer lists what has since been read off the struct', () => {
    // GlobalConfig's size, and the positions of `creator` and `permission`, are
    // transcribed now. Re-adding them to UNVERIFIED would understate what is known;
    // leaving them in while the code depends on the read values would be worse.
    const listed = POST_REMOVAL_PROGRAM.UNVERIFIED.join(' | ');
    expect(listed).not.toContain('GlobalConfig');
    expect(listed).not.toContain('sits directly after');
  });

  it('the BondingCurve layout is NOT on that list — it was supplied, not guessed', () => {
    expect(POST_REMOVAL_PROGRAM.UNVERIFIED.join(' | ')).not.toContain('BondingCurve');
  });
});

describe('PDA derivation', () => {
  // Pinned base58, so a seed typo (or a stray null terminator) fails loudly
  // instead of silently pointing every read at a different address.
  //
  // RE-PINNED 2026-08-08 when PROGRAM_ID and CP_SWAP_PROGRAM_ID moved off their
  // placeholders to the real mainnet addresses. Every one of these derives FROM a
  // program id, so they all moved together — which is exactly what the
  // 'an alternate program id changes every derived address' case below asserts.
  it('tegridy-launch PDAs', () => {
    expect(globalPda().toBase58()).toBe('7hrjMjYxoMKxrBvNkHYfyfJfFPxHi2ovXNLhownm1B6e');
    expect(curvePda(MINT).toBase58()).toBe('4LaVwaxeQDWQLQk98E7JnZzqZXttBADsH9q3osPDCsqH');
    expect(curveVaultPda(MINT).toBase58()).toBe('8CSq1f5LHCfAv73WEb34zUpeyCyJKXNjmC5znFfyww5R');
    expect(migrationAuthorityPda(MINT).toBase58()).toBe('4URospGA9UuXnqPp74MHTrexf8erjgnyGsF11d8ABhRM');
    expect(poolStatePda(MINT).toBase58()).toBe('hFBoCWt59BriJ8b5ZSXFGtZM5vLsTW19nB2Fum5wie6');
  });

  it('cp-swap PDAs', () => {
    expect(cpAmmAuthorityPda().toBase58()).toBe('39TE29rvRbuT3DLri3LwQWUYLwjFKJE4UoHarhTKqFGP');
    expect(cpAmmConfigPda(0).toBase58()).toBe('DpaUiYQPRk6WNqmGVPZB4LPCMQUSoUxGmc8XXto9FGMk');
  });

  it('the permission PDA is keyed by its authority, and lives on CP-SWAP', () => {
    // `["permission", authority]` — cp-swap's own seed, so it must derive against
    // cp-swap's program id. Deriving it on tegridy-launch would produce a
    // syntactically fine address that cp-swap can never have created.
    const perMint = cpPermissionPda(migrationAuthorityPda(MINT));
    expect(perMint.equals(cpPermissionPda(migrationAuthorityPda(PROGRAM_ID)))).toBe(false);
    expect(
      perMint.equals(
        PublicKey.findProgramAddressSync(
          [ascii('permission'), migrationAuthorityPda(MINT).toBytes()],
          CP_SWAP_PROGRAM_ID,
        )[0],
      ),
    ).toBe(true);
    expect(perMint.equals(cpPermissionPda(migrationAuthorityPda(MINT), PROGRAM_ID))).toBe(false);
  });

  it('amm_config uses BIG-endian u16, so index 1 is not index 256', () => {
    expect(cpAmmConfigPda(1).toBase58()).toBe('4gaXxch5n5mE7XEESzMc7KXx86R352PkYGPpFKZX1C7y');
    expect(cpAmmConfigPda(1).equals(cpAmmConfigPda(256))).toBe(false);
    expect(() => cpAmmConfigPda(65_536)).toThrow(RangeError);
    expect(() => cpAmmConfigPda(-1)).toThrow(RangeError);
  });

  it('pool_state is OURS, never cp-swap canonical — a squattable address', () => {
    // cp-swap's canonical derivation, which `initialize` lets ANYONE occupy for
    // the price of one transaction (state.rs:50-69). A client that derived this
    // would point users at an address a stranger may own.
    const ammConfig = cpAmmConfigPda(0);
    const [m0, m1] = sortMints(MINT, PROGRAM_ID);
    const canonical = PublicKey.findProgramAddressSync(
      [ascii('pool'), ammConfig.toBytes(), m0.toBytes(), m1.toBytes()],
      CP_SWAP_PROGRAM_ID,
    )[0];
    expect(poolStatePda(MINT).equals(canonical)).toBe(false);
  });

  it('every cp-swap pool account hangs off pool_state, so they all move together', () => {
    const a = poolStatePda(MINT);
    const b = poolStatePda(PROGRAM_ID);
    expect(cpLpMintPda(a).equals(cpLpMintPda(b))).toBe(false);
    expect(cpObservationPda(a).equals(cpObservationPda(b))).toBe(false);
    expect(cpPoolVaultPda(a, MINT).equals(cpPoolVaultPda(b, MINT))).toBe(false);
    // The two vaults of one pool differ only by mint.
    expect(cpPoolVaultPda(a, MINT).equals(cpPoolVaultPda(a, PROGRAM_ID))).toBe(false);
  });

  it('an alternate program id changes every derived address', () => {
    const other = new PublicKey('BvBkt84ZiKmiPSuWrdefxbxPTX5YiLnU6YEGtY6pDodL');
    expect(globalPda(other).equals(globalPda())).toBe(false);
    expect(curvePda(MINT, other).equals(curvePda(MINT))).toBe(false);
  });
});

describe('sortMints — cp-swap requires token_0_mint < token_1_mint by RAW BYTES', () => {
  it('orders by byte comparison, not base58', () => {
    const [a, b] = sortMints(MINT, PROGRAM_ID);
    expect(Buffer.compare(Buffer.from(a.toBytes()), Buffer.from(b.toBytes()))).toBeLessThan(0);
  });

  it('is stable whichever way the pair is handed in', () => {
    const forward = sortMints(MINT, PROGRAM_ID);
    const backward = sortMints(PROGRAM_ID, MINT);
    expect(forward[0].equals(backward[0])).toBe(true);
    expect(forward[1].equals(backward[1])).toBe(true);
  });

  it('base58 order is NOT byte order — which is why this exists', () => {
    // "So111…" sorts after "8YVjj…" as a base58 STRING, but its first byte is
    // smaller. Anything comparing base58 would get this pair backwards.
    expect(MINT.toBase58() > PROGRAM_ID.toBase58()).toBe(true);
    expect(sortMints(MINT, PROGRAM_ID)[0].equals(MINT)).toBe(true);
  });
});

// ── decoders ────────────────────────────────────────────────────────────────
//
// Buffers are built by CONCATENATING fields in declaration order, deliberately
// without reference to the decoder's offset table. If an offset there is wrong,
// these fail; asserting against the same constants would not.

function cat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
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
const key = (k: PublicKey): Uint8Array => k.toBytes();
const byte = (n: number): Uint8Array => Uint8Array.from([n]);

const AUTHORITY = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const FEE_RECIPIENT = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/**
 * `GlobalConfig` as the POST-REMOVAL program writes it — 194 bytes, ending at
 * `bump`. The 529-byte segmented tail (`sqrt_price_start_x64`, `segment_count`,
 * `[Segment; 16]`) is gone with the mode it described.
 *
 * This fixture once stopped at `bump` while the program wrote 723, and once omitted
 * `creator_fee_share_bps` entirely. Because these tests encode AND decode with the
 * same table, a mistake made in both cancels out and CI stays green while every real
 * account reads `bad-length`. `decodes the surviving prefix of a REAL mainnet
 * account` below is the only assertion here anchored to bytes the program wrote.
 */
function encodeGlobal(
  over: Partial<{
    paused: number;
    cpSwap: PublicKey;
    ammConfig: PublicKey;
    creatorFeeShareBps: bigint;
  }> = {},
) {
  return cat(
    ACCOUNT_DISCRIMINATOR.GlobalConfig,
    key(AUTHORITY),
    key(FEE_RECIPIENT),
    u64le(100n),
    u64le(over.creatorFeeShareBps ?? 4_800n),
    u64le(30_000_000_000n),
    u64le(1_073_000_000_000_000n),
    u64le(1_000_000_000_000_000n),
    u64le(85_000_000_000n),
    u64le(250_000_000n),
    key(over.cpSwap ?? CP_SWAP_PROGRAM_ID),
    key(over.ammConfig ?? AUTHORITY),
    byte(over.paused ?? 0),
    byte(254),
  );
}

/**
 * `BondingCurve` as the POST-REMOVAL program writes it — 170 bytes. `complete`
 * follows `migration_reserve_lamports` directly; the 546-byte mode snapshot that
 * used to sit between them is gone.
 *
 * No captured account anchors this one — none has ever been created — so the size
 * assertion above sums the Rust field widths instead.
 */
function encodeCurve(
  over: Partial<{
    complete: number;
    pool: PublicKey;
    creatorFeeShareBps: bigint;
  }> = {},
) {
  return cat(
    ACCOUNT_DISCRIMINATOR.BondingCurve,
    key(MINT),
    key(AUTHORITY),
    u64le(30_000_000_000n),
    u64le(1_073_000_000_000_000n),
    u64le(7_000_000_000n),
    u64le(900_000_000_000_000n),
    u64le(100n),
    u64le(over.creatorFeeShareBps ?? 4_800n),
    u64le(85_000_000_000n),
    u64le(250_000_000n),
    byte(over.complete ?? 0),
    key(over.pool ?? DEFAULT_PUBKEY),
    byte(253),
  );
}

describe('decodeGlobalConfig', () => {
  it('round-trips every field', () => {
    const bytes = encodeGlobal();
    expect(bytes.length).toBe(GLOBAL_CONFIG_SIZE);
    const d = decodeGlobalConfig(bytes);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.value.authority.equals(AUTHORITY)).toBe(true);
    expect(d.value.feeRecipient.equals(FEE_RECIPIENT)).toBe(true);
    expect(d.value.tradeFeeBps).toBe(100n);
    expect(d.value.initialVirtualSol).toBe(30_000_000_000n);
    expect(d.value.initialVirtualToken).toBe(1_073_000_000_000_000n);
    expect(d.value.tokenTotalSupply).toBe(1_000_000_000_000_000n);
    expect(d.value.graduationTargetLamports).toBe(85_000_000_000n);
    expect(d.value.migrationReserveLamports).toBe(250_000_000n);
    expect(d.value.cpSwapProgram.equals(CP_SWAP_PROGRAM_ID)).toBe(true);
    expect(d.value.paused).toBe(false);
    expect(d.value.bump).toBe(254);
  });

  it('reads u64 as bigint, exactly, past Number.MAX_SAFE_INTEGER', () => {
    // The plausible book (1.073e15) still fits in a double; a u64 field does not
    // have to, and a `number` decode loses the low bits SILENTLY. Two values that
    // are distinct as u64 and IDENTICAL as doubles:
    const a = 18_446_744_073_709_551_615n; // u64::MAX
    const b = 18_446_744_073_709_551_614n;
    expect(Number(a)).toBe(Number(b));

    const withMax = cat(
      ACCOUNT_DISCRIMINATOR.GlobalConfig,
      key(AUTHORITY),
      key(FEE_RECIPIENT),
      u64le(100n),
      u64le(4_800n), // creator_fee_share_bps
      u64le(a),
      u64le(b),
      u64le(1n),
      u64le(1n),
      u64le(1n),
      key(CP_SWAP_PROGRAM_ID),
      key(AUTHORITY),
      byte(0),
      byte(254),
    );
    const d = decodeGlobalConfig(withMax);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(typeof d.value.initialVirtualSol).toBe('bigint');
    expect(d.value.initialVirtualSol).toBe(a);
    expect(d.value.initialVirtualToken).toBe(b);
  });

  it('an unset AMM is a real state, not a read failure', () => {
    const configured = (over?: Parameters<typeof encodeGlobal>[0]) => {
      const d = decodeGlobalConfig(encodeGlobal(over));
      if (!d.ok) throw new Error(`expected a decode, got ${d.reason}`);
      return { cfg: d.value, configured: isAmmConfigured(d.value) };
    };

    const unset = configured({ cpSwap: DEFAULT_PUBKEY, ammConfig: DEFAULT_PUBKEY });
    expect(isDefaultPubkey(unset.cfg.cpSwapProgram)).toBe(true);
    expect(unset.configured).toBe(false);
    // Half-configured is still not configured.
    expect(configured({ ammConfig: DEFAULT_PUBKEY }).configured).toBe(false);
    expect(configured().configured).toBe(true);
  });

  // The regression guard. Every other test here encodes with `encodeGlobal` and
  // decodes with `decodeGlobalConfig`, so a layout mistake made in BOTH cancels out —
  // which is exactly what happened once: the pair agreed on a 186-byte struct while
  // the program wrote 723. These bytes came off mainnet (`global` PDA
  // 7hrjMjYxoMKxrBvNkHYfyfJfFPxHi2ovXNLhownm1B6e, initialized 2026-08-08), so this
  // is anchored to a program's actual output rather than to our idea of it.
  //
  // That account was written by the PRE-removal program and is 723 bytes. Nothing
  // before `bump` moved in the removal, so its first 194 bytes ARE the post-removal
  // layout, byte for byte — which makes this the only real-bytes evidence available
  // for any offset in `GLOBAL_CONFIG_LAYOUT`. The 723-byte whole is asserted to be
  // REJECTED below; a shorter struct must not quietly accept a longer account.
  it('decodes the surviving prefix of a REAL mainnet account', () => {
    const HEAD_B64 =
      'lQicyqD8sNm7c+Aqo3S9kOE+Z402zTfNZXq5lfIBei5HU0hDn0H6UuUc3D/p5bgRyaiS88h1kuJ5K7gQGxKo' +
      'QO+dTnYct/FIZAAAAAAAAADAEgAAAAAAAACsI/wGAAAAABDYR+PPAwAAgMakfo0DACTEuLQCAAAAgLLmDgAA' +
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
      'AAAAAP8AAAAAAAAAAAAAAAAAAAAAAA==';
    const head = Uint8Array.from(atob(HEAD_B64), (c) => c.charCodeAt(0));
    // 211 captured bytes: the 194 that survive, plus `sqrt_price_start_x64` and
    // `segment_count`, both zero at initialization. The 512 segment slots that
    // followed on chain were zero too and are not reproduced.
    expect(head.length).toBe(211);
    const real = head.subarray(0, GLOBAL_CONFIG_SIZE);
    expect(real.length).toBe(194);

    const d = decodeGlobalConfig(real);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.value.authority.toBase58()).toBe('Dcjink4RGNUBpRVV4AX8mzxNLpUF2ik5h8Em6usv7kZ7');
    expect(d.value.feeRecipient.toBase58()).toBe('GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd');
    expect(d.value.tradeFeeBps).toBe(100n);
    // The field whose absence shifted every value below it by one slot.
    expect(d.value.creatorFeeShareBps).toBe(4_800n);
    expect(d.value.initialVirtualSol).toBe(30_000_000_000n);
    expect(d.value.initialVirtualToken).toBe(1_073_000_000_000_000n);
    expect(d.value.tokenTotalSupply).toBe(1_000_000_000_000_000n);
    expect(d.value.graduationTargetLamports).toBe(11_621_942_308n);
    expect(d.value.migrationReserveLamports).toBe(250_000_000n);
    // Zero at init and set later by `update_global` — see lib.rs:184-187.
    expect(isDefaultPubkey(d.value.cpSwapProgram)).toBe(true);
    expect(isDefaultPubkey(d.value.ammConfig)).toBe(true);
    expect(d.value.paused).toBe(false);
    expect(d.value.bump).toBe(255);
  });

  it('rejects a pre-removal 723-byte account instead of decoding its prefix', () => {
    // The dangerous near-miss: a 723-byte account's first 194 bytes decode
    // perfectly, so a length check written as `>=` would return a confident,
    // correct-looking config read from a program that is not the one this client
    // builds instructions for. It has to be `bad-length` — the honest answer is
    // "this is not my account", not a plausible struct.
    const preRemoval = cat(encodeGlobal(), new Uint8Array(723 - GLOBAL_CONFIG_SIZE));
    expect(preRemoval.length).toBe(723);
    expect(decodeGlobalConfig(preRemoval)).toEqual({ ok: false, reason: 'bad-length' });
  });

  it('reports WHY it failed and never returns a zeroed struct', () => {
    expect(decodeGlobalConfig(null)).toEqual({ ok: false, reason: 'missing' });
    expect(decodeGlobalConfig(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(decodeGlobalConfig(new Uint8Array(0))).toEqual({ ok: false, reason: 'bad-length' });
    expect(decodeGlobalConfig(new Uint8Array(GLOBAL_CONFIG_SIZE - 1))).toEqual({
      ok: false,
      reason: 'bad-length',
    });
    // Right size, someone else's account.
    expect(decodeGlobalConfig(new Uint8Array(GLOBAL_CONFIG_SIZE))).toEqual({
      ok: false,
      reason: 'wrong-discriminator',
    });
    // A BondingCurve is a different size AND a different discriminator.
    expect(decodeGlobalConfig(encodeCurve())).toEqual({ ok: false, reason: 'bad-length' });
    // A bool byte the program can never write.
    expect(decodeGlobalConfig(encodeGlobal({ paused: 2 }))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('decodeBondingCurve', () => {
  it('round-trips every field', () => {
    const bytes = encodeCurve();
    expect(bytes.length).toBe(BONDING_CURVE_SIZE);
    const d = decodeBondingCurve(bytes);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.value.mint.equals(MINT)).toBe(true);
    expect(d.value.creator.equals(AUTHORITY)).toBe(true);
    expect(d.value.virtualSolReserves).toBe(30_000_000_000n);
    expect(d.value.virtualTokenReserves).toBe(1_073_000_000_000_000n);
    expect(d.value.realSolReserves).toBe(7_000_000_000n);
    expect(d.value.realTokenReserves).toBe(900_000_000_000_000n);
    expect(d.value.tradeFeeBps).toBe(100n);
    // The field whose absence shifted `graduation_target` and everything after it.
    expect(d.value.creatorFeeShareBps).toBe(4_800n);
    expect(d.value.graduationTargetLamports).toBe(85_000_000_000n);
    expect(d.value.migrationReserveLamports).toBe(250_000_000n);
    expect(d.value.complete).toBe(false);
    expect(d.value.bump).toBe(253);
  });

  it('reads `complete` from 136, where the mode snapshot used to begin', () => {
    // The whole removal lands on this byte: `complete` moved 546 bytes earlier, and
    // 136 used to hold `mode`. A decoder still reading 682 finds nothing at all in a
    // 170-byte account; one reading 136 against a PRE-removal account reads the mode
    // byte and calls a live launch complete — which reads as "already graduated" and
    // would hide a curve that is still raising.
    const bytes = encodeCurve({ complete: 1 });
    expect(bytes[136]).toBe(1);
    const d = decodeBondingCurve(bytes);
    expect(d.ok && d.value.complete).toBe(true);
    // …and the pubkey immediately after it is `pool`, not a sqrt price.
    const g = decodeBondingCurve(encodeCurve({ complete: 1, pool: FEE_RECIPIENT }));
    expect(g.ok && g.value.pool.equals(FEE_RECIPIENT)).toBe(true);
  });

  it('rejects a pre-removal 716-byte account instead of decoding its prefix', () => {
    // Same near-miss as GlobalConfig, and worse here: the first 136 bytes of a
    // pre-removal curve decode to correct reserves, so a permissive length check
    // would quote real-looking prices off an account whose `complete` and `pool` it
    // is reading from the wrong place entirely.
    const preRemoval = cat(encodeCurve(), new Uint8Array(716 - BONDING_CURVE_SIZE));
    expect(preRemoval.length).toBe(716);
    expect(decodeBondingCurve(preRemoval)).toEqual({ ok: false, reason: 'bad-length' });
  });

  it('an un-migrated curve has an all-zero pool, which is "not yet", not an address', () => {
    const d = decodeBondingCurve(encodeCurve());
    expect(d.ok && isDefaultPubkey(d.value.pool)).toBe(true);
    const g = decodeBondingCurve(encodeCurve({ complete: 1, pool: AUTHORITY }));
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.value.complete).toBe(true);
    expect(isDefaultPubkey(g.value.pool)).toBe(false);
  });

  it('reports WHY it failed and never returns a zeroed struct', () => {
    expect(decodeBondingCurve(null)).toEqual({ ok: false, reason: 'missing' });
    expect(decodeBondingCurve(new Uint8Array(BONDING_CURVE_SIZE))).toEqual({
      ok: false,
      reason: 'wrong-discriminator',
    });
    expect(decodeBondingCurve(encodeGlobal())).toEqual({ ok: false, reason: 'bad-length' });
    expect(decodeBondingCurve(encodeCurve({ complete: 7 }))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('decodes a view into a larger buffer without reading past its slice', () => {
    // `Connection` hands back a Buffer that may be a view; a DataView built from
    // `.buffer` without honouring byteOffset silently reads the wrong bytes.
    const padded = new Uint8Array(BONDING_CURVE_SIZE + 64);
    padded.fill(0xab);
    padded.set(encodeCurve(), 32);
    const view = padded.subarray(32, 32 + BONDING_CURVE_SIZE);
    const d = decodeBondingCurve(view);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.value.realSolReserves).toBe(7_000_000_000n);
    expect(d.value.bump).toBe(253);
  });
});

describe('error table', () => {
  it('numbers from 6000 in declaration order (errors.rs:5-48)', () => {
    expect(Object.keys(LAUNCH_ERROR_CODES).length).toBe(20);
    expect(LAUNCH_ERROR_CODES[6000]).toBe('Overflow');
    expect(LAUNCH_ERROR_CODES[6019]).toBe('AwaitingMigration');
    expect(launchErrorName(6004)).toBe('Paused');
    expect(launchErrorName(6011)).toBe('MintHasFreezeAuthority');
  });

  it('an error that is not ours resolves to null, never to a generic in-house message', () => {
    expect(launchErrorName(5999)).toBeNull();
    expect(launchErrorName(6020)).toBeNull();
    expect(launchErrorName(1)).toBeNull();
  });

  it('AwaitingMigration and AlreadyComplete are different codes and must stay so', () => {
    expect(AWAITING_MIGRATION_CODE).toBe(6019);
    expect(ALREADY_COMPLETE_CODE).toBe(6005);
    expect(launchErrorName(AWAITING_MIGRATION_CODE)).not.toBe(
      launchErrorName(ALREADY_COMPLETE_CODE),
    );
  });
});

describe('deployment honesty', () => {
  // This tripwire has flipped twice. It first pinned the pre-deploy placeholder, then
  // the 2026-08-08 deploy address. Both ids were closed on 2026-08-13 and are spent, so
  // what these two literals now pin is a HISTORICAL record, not a target — and pinning
  // them is still load-bearing: verify-addresses.mjs check 5b matches these exact
  // literals against the registry entries carrying the closure evidence, so a silent
  // repoint here would break the only place code and registry are compared.
  // `spentProgramIds.test.ts` is what stops either being described as live again.
  it('PROGRAM_ID is still the 2026-08-08 address, now spent', () => {
    expect(PROGRAM_ID.toBase58()).toBe('CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED');
    expect(isPlaceholderProgramId()).toBe(false);
  });

  // Without this, `isPlaceholderProgramId` could be hardcoded `false` and the
  // assertion above would still pass.
  it('the placeholder is still recognised, so the predicate is not vacuous', () => {
    expect(isPlaceholderProgramId(PLACEHOLDER_PROGRAM_ID)).toBe(true);
  });

  it('CP_SWAP_PROGRAM_ID is still the fork address, closed the same day', () => {
    expect(CP_SWAP_PROGRAM_ID.toBase58()).toBe('3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y');
  });

  it('the default pubkey is the System Program address', () => {
    expect(DEFAULT_PUBKEY.toBase58()).toBe('11111111111111111111111111111111');
  });
});
