// @vitest-environment node
//
// NODE, not jsdom: `PublicKey.findProgramAddressSync` fails every bump under jsdom
// and reports it as a bad seed (see curve/program.ts's testing note).
//
// Pins for the pure half of the tegridy-launch operator CLI. The CLI itself cannot
// run under CI's Node 20 (its loader needs `stripTypeScriptTypes`, Node >= 23.6), so
// everything it decides with no RPC and no key lives in `tegridy-launch-ops.mjs`
// and is proven here, against the curve core and against the Rust source.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  CP_SWAP_PERMISSION_LEN,
  CREATE_PERMISSION_PDA_DISCRIMINATOR,
  createPermissionPdaIx,
  endsWithSomeU64,
  endsWithU64,
  graduationSplit,
  innermostFailingProgram,
  LISTING_GAP_TOLERANCE_BPS,
  listingGap,
  migratePayerFloat,
  optionalFlagValue,
  parsePlatformReserveBps,
  pct3,
  permissionAuthorityOf,
  scaledVirtualToken,
  simulatedErrorLabel,
  unsignableReason,
  updateNeedsListingGate,
} from './tegridy-launch-ops.mjs';
import {
  MAX_PLATFORM_RESERVE_BPS,
  continuityTarget,
  curveSupply,
  graduationPriceRatioBps,
} from '../../src/lib/launcher/solana/curve/math';
import { initializeGlobalIx, updateGlobalIx } from '../../src/lib/launcher/solana/curve/ix';
import { checkUpdateGlobal } from '../../src/lib/launcher/solana/curve/config';
import { launchErrorName } from '../../src/lib/launcher/solana/curve/program';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CP_SWAP_SRC = path.join(HERE, '..', '..', '..', 'solana', 'tegridy-amm', 'programs', 'cp-swap', 'src');
const OPERATOR_SRC = path.join(HERE, '..', 'tegridy-launch-operator.mjs');

// The operator example (tegridy-launch-operator.mjs header): 30 SOL virtual, 1e15 supply.
const VS = 30_000_000_000n;
const VT = 1_073_000_000_000_000n;
const S = 1_000_000_000_000_000n;
const T = 11_685_689_681n;
const R = 42_156_720n;

describe('--platform-reserve-bps', () => {
  const max = MAX_PLATFORM_RESERVE_BPS;

  it('is REQUIRED at init with no default — a missing flag is an error, not zero', () => {
    const r = parsePlatformReserveBps(undefined, { required: true, max });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing required --platform-reserve-bps/);
  });

  it('is optional on update (None = leave unchanged)', () => {
    expect(parsePlatformReserveBps(undefined, { required: false, max })).toEqual({ ok: true, value: undefined });
  });

  it('a valueless flag is an error, required or not — never a silent "leave unchanged"', () => {
    // `update-global --platform-reserve-bps --target 1`: parseArgs stores `true`. Read
    // as None, the typed reserve change would drop out of an update that still goes.
    for (const required of [true, false]) {
      const r = parsePlatformReserveBps(true, { required, max });
      expect(r.ok, String(required)).toBe(false);
      expect(r.error).toMatch(/--platform-reserve-bps needs a value/);
    }
  });

  it('accepts 0, 369 and the cap exactly; rejects cap + 1', () => {
    expect(parsePlatformReserveBps('0', { required: true, max })).toEqual({ ok: true, value: 0n });
    expect(parsePlatformReserveBps('369', { required: true, max })).toEqual({ ok: true, value: 369n });
    expect(parsePlatformReserveBps(String(max), { required: true, max })).toEqual({ ok: true, value: max });
    const over = parsePlatformReserveBps(String(max + 1n), { required: true, max });
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/cap/);
  });

  it('the cap it is handed is the EVM parity value, 10%', () => {
    expect(MAX_PLATFORM_RESERVE_BPS).toBe(1_000n);
  });

  it('rejects anything that is not a plain non-negative integer', () => {
    for (const raw of ['-1', '3.69', '369bps', '', ' ', '0x10']) {
      expect(parsePlatformReserveBps(raw, { required: true, max }).ok).toBe(false);
    }
  });
});

describe('graduation split and the scaled-Vt recipe', () => {
  const carve = (bps) => {
    const r = curveSupply(S, bps);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  it('with no reserve, every unsold token is pooled: 58.262% sold / 41.737% LP', () => {
    const { curveTokens } = carve(0n);
    const g = graduationSplit({ supply: S, curveTokens, virtualSol: VS, virtualToken: VT, target: T, migrationReserve: R });
    expect(g).toEqual({ sold: 582_628_333_023_446n, lp: 417_371_666_976_554n, reserve: 0n });
  });

  it('at 369 bps the reserve is 36.9e12 and is neither sold nor pooled', () => {
    const { curveTokens, reserveTokens } = carve(369n);
    expect(reserveTokens).toBe(36_900_000_000_000n);
    const vt = scaledVirtualToken(VT, curveTokens, S);
    const g = graduationSplit({ supply: S, curveTokens, virtualSol: VS, virtualToken: vt, target: T, migrationReserve: R });
    expect(g).toEqual({ sold: 561_129_347_534_881n, lp: 401_970_652_465_119n, reserve: 36_900_000_000_000n });
    // Conservation: every token of supply is in exactly one bucket.
    expect(g.sold + g.lp + g.reserve).toBe(S);
    expect(pct3(g.reserve, S)).toBe('3.690%');
  });

  it('scaling Vt by (1 - b) keeps the graduation target identical to the lamport', () => {
    const { curveTokens } = carve(369n);
    const vt = scaledVirtualToken(VT, curveTokens, S);
    expect(vt).toBe(1_033_406_300_000_000n);
    const without = continuityTarget(VS, VT, S, R);
    const withReserve = continuityTarget(VS, vt, curveTokens, R);
    expect(without).toEqual({ ok: true, value: T });
    expect(withReserve).toEqual({ ok: true, value: T });
  });

  it('NOT scaling it moves the listing to 10488 bps — inside the ±5% band, so only the recipe catches it', () => {
    const { curveTokens } = carve(369n);
    expect(graduationPriceRatioBps(VS, VT, curveTokens, T, R)).toEqual({ ok: true, value: 10_488n });
    expect(graduationPriceRatioBps(VS, scaledVirtualToken(VT, curveTokens, S), curveTokens, T, R)).toEqual({
      ok: true,
      value: 9_999n,
    });
  });

  it('refuses to invent a split for a book that cannot reach its target', () => {
    const { curveTokens } = carve(369n);
    expect(
      graduationSplit({ supply: S, curveTokens, virtualSol: VS, virtualToken: VT, target: 10n ** 15n, migrationReserve: R }),
    ).toBeNull();
  });
});

describe('cp-swap create_permission_pda', () => {
  it('discriminator is sha256("global:create_permission_pda")[0..8]', () => {
    const d = createHash('sha256').update('global:create_permission_pda').digest().subarray(0, 8);
    expect([...CREATE_PERMISSION_PDA_DISCRIMINATOR]).toEqual([...d]);
  });

  it('accounts follow CreatePermissionPda declaration order in the Rust source', () => {
    const src = readFileSync(path.join(CP_SWAP_SRC, 'instructions', 'admin', 'create_permission_pda.rs'), 'utf8');
    const body = src.slice(src.indexOf('pub struct CreatePermissionPda'), src.indexOf('pub fn create_permission_pda'));
    const fields = [...body.matchAll(/pub (\w+):/g)].map((m) => m[1]);
    expect(fields).toEqual(['owner', 'permission_authority', 'permission', 'system_program']);

    const owner = Keypair.generate().publicKey;
    const permissionAuthority = Keypair.generate().publicKey;
    const permission = Keypair.generate().publicKey;
    const cp = Keypair.generate().publicKey;
    const ix = createPermissionPdaIx({ owner, permissionAuthority, permission }, cp);
    expect(ix.programId.equals(cp)).toBe(true);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      owner.toBase58(),
      permissionAuthority.toBase58(),
      permission.toBase58(),
      '11111111111111111111111111111111',
    ]);
    // owner signs AND pays (`mut`, `payer = owner`); the permission is `init`;
    // the authority is only read.
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([
      [true, true],
      [false, false],
      [false, true],
      [false, false],
    ]);
    expect([...ix.data]).toEqual([...CREATE_PERMISSION_PDA_DISCRIMINATOR]);
  });

  it('Permission::LEN matches states/permission.rs (the rent quote)', () => {
    const src = readFileSync(path.join(CP_SWAP_SRC, 'states', 'permission.rs'), 'utf8');
    const expr = src.match(/pub const LEN: usize = ([^;]+);/)[1];
    const len = expr.split('+').reduce((a, t) => a + t.split('*').reduce((p, f) => p * Number(f.trim()), 1), 0);
    expect(CP_SWAP_PERMISSION_LEN).toBe(len);
  });

  it('reads the stored authority back out of a Permission account', () => {
    const who = Keypair.generate().publicKey;
    const data = new Uint8Array(CP_SWAP_PERMISSION_LEN);
    data.set(who.toBytes(), 8);
    expect(permissionAuthorityOf(data).equals(who)).toBe(true);
    expect(permissionAuthorityOf(new Uint8Array(39))).toBeNull();
    expect(permissionAuthorityOf(null)).toBeNull();
  });
});

describe('migrate payer float', () => {
  const ataRent = 1_488_440n;
  const zeroDataRent = 650_240n;

  it('an empty migration authority costs the payer the full seed top-up plus two ATAs', () => {
    expect(migratePayerFloat({ ataRent, zeroDataRent, authorityLamports: 0n })).toEqual({
      atas: 2n * ataRent,
      seedTopup: zeroDataRent,
      total: 2n * ataRent + zeroDataRent,
    });
  });

  it('a dusted authority is topped up only to the floor — the program saturates, it does not skip', () => {
    expect(migratePayerFloat({ ataRent, zeroDataRent, authorityLamports: 1n }).seedTopup).toBe(zeroDataRent - 1n);
    expect(migratePayerFloat({ ataRent, zeroDataRent, authorityLamports: zeroDataRent + 5n }).seedTopup).toBe(0n);
  });

  it('ATAs that already exist are not paid for again', () => {
    expect(migratePayerFloat({ ataRent, zeroDataRent, authorityLamports: zeroDataRent, existingAtas: 2 }).total).toBe(0n);
    expect(migratePayerFloat({ ataRent, zeroDataRent, authorityLamports: zeroDataRent, existingAtas: 1 }).total).toBe(ataRent);
  });
});

describe('the encoding guard catches an argument the encoder did not recognise', () => {
  const authority = Keypair.generate().publicKey;
  const feeRecipient = Keypair.generate().publicKey;

  it('update_global: the value reaches the wire only under the encoder\'s own name', () => {
    const good = updateGlobalIx({ authority }, { newPlatformReserveBps: 369n });
    expect(endsWithSomeU64(good.data, 369n)).toBe(true);
    // The drift this guards against: a caller spelling the field differently gets
    // `None` written, silently. The guard must say no.
    const drifted = updateGlobalIx({ authority }, { platformReserveBps: 369n });
    expect(endsWithSomeU64(drifted.data, 369n)).toBe(false);
    expect(endsWithSomeU64(good.data, 370n)).toBe(false);
  });

  it('initialize_global: platform_reserve_bps is the last eight bytes', () => {
    const ix = initializeGlobalIx(
      { authority, feeRecipient },
      {
        tradeFeeBps: 100n,
        creatorFeeShareBps: 5_000n,
        initialVirtualSol: VS,
        initialVirtualToken: 1_033_406_300_000_000n,
        tokenTotalSupply: S,
        graduationTargetLamports: T,
        migrationReserveLamports: R,
        cpSwapProgram: PublicKey.default,
        ammConfig: PublicKey.default,
        platformReserveBps: 369n,
      },
    );
    expect(endsWithU64(ix.data, 369n)).toBe(true);
    expect(endsWithU64(ix.data, 0n)).toBe(false);
  });
});

describe('the listing gate refuses what the program\'s ±5% band lets through', () => {
  const { curveTokens } = curveSupply(S, 369n).value;
  const ratio = (vt, s, t) => graduationPriceRatioBps(VS, vt, s, t, R).value;

  it('refuses the untuned 369 bps book (10488 bps), which the program accepts', () => {
    const r = ratio(VT, curveTokens, T);
    expect(r).toBe(10_488n);
    expect(r).toBeLessThanOrEqual(10_500n); // inside the program's band: only this gate catches it
    expect(listingGap(r)).toMatch(/10488 bps .* 488 bps away/);
  });

  it('passes both retunes: Vt scaled, or the target moved to the curve-supply continuity target', () => {
    expect(listingGap(ratio(scaledVirtualToken(VT, curveTokens, S), curveTokens, T))).toBeNull();
    const retuned = continuityTarget(VS, VT, curveTokens, R).value;
    expect(listingGap(ratio(VT, curveTokens, retuned))).toBeNull();
  });

  it('refuses a reserve-only update that moves a tuned book off the price, in either direction', () => {
    const tunedVt = scaledVirtualToken(VT, curveTokens, S);
    const at0 = ratio(tunedVt, S, T);
    const at500 = ratio(tunedVt, curveSupply(S, 500n).value.curveTokens, T);
    expect(at0).toBeLessThan(10_000n - LISTING_GAP_TOLERANCE_BPS);
    expect(at500).toBeGreaterThan(10_000n + LISTING_GAP_TOLERANCE_BPS);
    expect(listingGap(at0)).not.toBeNull();
    expect(listingGap(at500)).not.toBeNull();
  });

  it('sits exactly at the tolerance edge, and refuses a ratio it could not compute', () => {
    const tol = LISTING_GAP_TOLERANCE_BPS;
    expect(tol).toBe(25n);
    for (const r of [10_000n - tol, 10_000n, 10_000n + tol]) expect(listingGap(r)).toBeNull();
    for (const r of [10_000n - tol - 1n, 10_000n + tol + 1n]) expect(listingGap(r)).not.toBeNull();
    expect(listingGap(null)).toMatch(/could not be computed/);
  });
});

describe('an optional flag typed with no value is an error', () => {
  it('not passed is undefined; passed is its string; passed with no value is an error', () => {
    expect(optionalFlagValue({}, 'target')).toEqual({ ok: true, value: undefined });
    expect(optionalFlagValue({ target: '123' }, 'target')).toEqual({ ok: true, value: '123' });
    expect(optionalFlagValue({ target: true }, 'target')).toEqual({ ok: false, error: '--target needs a value' });
  });
});

describe('update-global runs the listing gate whenever the book it leaves carries a reserve', () => {
  // A 369 bps book on the UNSCALED Vt, tuned by moving its target instead.
  const { curveTokens } = curveSupply(S, 369n).value;
  const tunedTarget = continuityTarget(VS, VT, curveTokens, R).value;
  const current = {
    tradeFeeBps: 100n,
    initialVirtualSol: VS,
    initialVirtualToken: VT,
    tokenTotalSupply: S,
    graduationTargetLamports: tunedTarget,
    migrationReserveLamports: R,
    platformReserveBps: 369n,
  };
  const gateFor = (args, cur = current) => {
    const check = checkUpdateGlobal(args, cur);
    const gated = updateNeedsListingGate({
      economics: check.economics,
      newPlatformReserveBps: args.newPlatformReserveBps,
      currentPlatformReserveBps: cur.platformReserveBps,
    });
    return { check, gated };
  };

  it('the book as it stands is tuned', () => {
    expect(tunedTarget).toBe(11_312_638_249n);
    expect(listingGap(graduationPriceRatioBps(VS, VT, curveTokens, tunedTarget, R).value)).toBeNull();
  });

  it('gates a --target-only update back to the no-reserve target (10488 bps, which the program accepts)', () => {
    const { check, gated } = gateFor({ graduationTargetLamports: T });
    expect(check.problems).toEqual([]); // inside the ±5% band: the program says yes
    expect(check.economics.graduationPriceRatioBps).toBe(10_488n);
    expect(listingGap(check.economics.graduationPriceRatioBps)).toMatch(/10488 bps/);
    expect(gated).toBe(true);
  });

  it('gates --virtual-sol and --reserve updates on that book too', () => {
    expect(gateFor({ newInitialVirtualSol: VS + 1_000_000_000n }).gated).toBe(true);
    expect(gateFor({ migrationReserveLamports: R + 1n }).gated).toBe(true);
  });

  it('gates a reserve change, including one to zero', () => {
    expect(gateFor({ newPlatformReserveBps: 0n }).gated).toBe(true);
    expect(gateFor({ newPlatformReserveBps: 500n }, { ...current, platformReserveBps: 0n }).gated).toBe(true);
  });

  it('leaves alone an update the program does not re-check, and a book with no reserve', () => {
    expect(gateFor({ tradeFeeBps: 50n }).gated).toBe(false);
    expect(gateFor({ graduationTargetLamports: T }, { ...current, platformReserveBps: 0n }).gated).toBe(false);
  });
});

describe('an address that can never sign is refused', () => {
  const SYSTEM = new PublicKey('11111111111111111111111111111111');
  const SQUADS = new PublicKey('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
  const acct = (owner, len, executable = false) => ({ owner, data: new Uint8Array(len), executable });

  it('accepts a wallet or a Squads VAULT (System-owned), and an address with no account yet', () => {
    expect(unsignableReason(acct(SYSTEM, 0), SYSTEM)).toBeNull();
    expect(unsignableReason(null, SYSTEM)).toBeNull();
  });

  it('refuses the Squads MULTISIG account, a program, or any other program-owned account', () => {
    expect(unsignableReason(acct(SQUADS, 1_024), SYSTEM)).toMatch(/owned by SQDS4ep6.*\(1024 bytes\)/);
    expect(unsignableReason(acct(SYSTEM, 0, true), SYSTEM)).toMatch(/executable/);
    expect(unsignableReason(acct(Keypair.generate().publicKey, 165), SYSTEM)).not.toBeNull();
  });
});

describe('a simulated error is named only when tegridy-launch raised it', () => {
  const LAUNCH = Keypair.generate().publicKey.toBase58();
  const CP_SWAP = Keypair.generate().publicKey.toBase58();
  // What the runtime prints when cp-swap fails inside migrate_to_amm: the INNER
  // program's failed line first, the outer one last, both with the inner code.
  const cpiLogs = [
    `Program ${LAUNCH} invoke [1]`,
    `Program ${CP_SWAP} invoke [2]`,
    'Program log: AnchorError occurred. Error Code: NotApproved. Error Number: 6000.',
    `Program ${CP_SWAP} failed: custom program error: 0x1770`,
    `Program ${LAUNCH} failed: custom program error: 0x1770`,
  ];

  it('does not call a cp-swap 6000 "Overflow"', () => {
    expect(launchErrorName(6000)).toBe('Overflow'); // the mislabel this guards against
    expect(innermostFailingProgram(cpiLogs)).toBe(CP_SWAP);
    const label = simulatedErrorLabel(6000, cpiLogs, LAUNCH, launchErrorName);
    expect(label).not.toMatch(/Overflow/);
    expect(label).toMatch(new RegExp(`raised by ${CP_SWAP}`));
  });

  it('names a code tegridy-launch raised itself', () => {
    const logs = [`Program ${LAUNCH} invoke [1]`, `Program ${LAUNCH} failed: custom program error: 0x1771`];
    expect(simulatedErrorLabel(6001, logs, LAUNCH, launchErrorName)).toBe(' = InsufficientLiquidity');
  });

  it('names nothing when the logs carry no failure line', () => {
    expect(simulatedErrorLabel(6000, [], LAUNCH, launchErrorName)).not.toMatch(/Overflow/);
    expect(simulatedErrorLabel(6000, undefined, LAUNCH, launchErrorName)).not.toMatch(/Overflow/);
  });
});

// The CLI cannot run under CI's Node 20 (see the top of this file), so the gates
// above are pinned to the commands that must call them by reading the source.
describe('the operator commands call the gates', () => {
  const src = readFileSync(OPERATOR_SRC, 'utf8');
  const body = (name) => {
    const start = src.indexOf(`async function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const end = src.indexOf('\nasync function ', start + 1);
    return src.slice(start, end === -1 ? undefined : end);
  };

  it('init-global refuses a listing gap and an unsignable --fee-recipient before it loads a key', () => {
    const b = body('cmdInitGlobal');
    const key = b.indexOf("loadKeypair('OPERATOR_KEYPAIR')");
    expect(key).toBeGreaterThan(-1);
    for (const call of ['refuseListingGap(', "refuseUnsignableAddress(connection, feeRecipient, '--fee-recipient'"]) {
      expect(b.indexOf(call), call).toBeGreaterThan(-1);
      expect(b.indexOf(call), call).toBeLessThan(key);
    }
  });

  it('update-global checks --fee-recipient as well as --new-authority, and gates every listing move', () => {
    const b = body('cmdUpdateGlobal');
    expect(b).toContain("refuseUnsignableAddress(connection, args.newFeeRecipient, '--fee-recipient'");
    expect(b).toContain("refuseUnsignableAddress(connection, args.newAuthority, '--new-authority'");
    const gate = b.indexOf('refuseListingGap(');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(b.indexOf('prepareAndSign('));
    // The gate's condition is the tested rule above, not "was --platform-reserve-bps
    // passed": that missed a target-only update on a book that carries a reserve.
    const cond = b.slice(b.lastIndexOf('if (', gate), gate);
    expect(cond).toMatch(/^if \(\s*updateNeedsListingGate\(/);
    expect(cond).toContain('currentPlatformReserveBps: current.platformReserveBps');
  });

  it('an optional u64 or pubkey flag typed with no value fails instead of reading as "not given"', () => {
    for (const fn of ['optionalU64Flag', 'optionalPubkeyFlag']) {
      const start = src.indexOf(`function ${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      const b = src.slice(start, src.indexOf('\n}', start));
      expect(b, fn).toContain('optionalFlag(flags, name)');
      expect(b, fn).not.toMatch(/raw === true/);
    }
    const helper = src.slice(src.indexOf('function optionalFlag('), src.indexOf('function optionalU64Flag('));
    expect(helper).toContain('optionalFlagValue(flags, name)');
    expect(helper).toContain('if (!r.ok) fail(r.error)');
  });

  it('every flag read only as a switch is in BOOLEAN_FLAGS, so it never swallows the next token', () => {
    // `--accept-listing-gap init-global …` would otherwise take "init-global" as the
    // flag's value, leave no subcommand, and print help.
    const listed = src.match(/const BOOLEAN_FLAGS = new Set\(\[([^\]]*)\]\)/)[1];
    const set = new Set([...listed.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));
    // A switch is only ever tested (`if (flags.x)`, `!flags.x`, `flags.x ? a : b`,
    // `flags.x && …`); a flag whose value is ever used anywhere is not one.
    const onlyTested = new Map();
    for (const m of src.matchAll(/flags(?:\.([a-zA-Z]+)|\['([a-z-]+)'\])/g)) {
      const name = m[1] ?? m[2];
      const before = src.slice(Math.max(0, m.index - 8), m.index);
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 4);
      const tested = /^\s*(\?(?!\?)|&&|\|\|)/.test(after) || (/^\)/.test(after) && /(if \(|!|&& )$/.test(before));
      onlyTested.set(name, (onlyTested.get(name) ?? true) && tested);
    }
    const switches = [...onlyTested].filter(([, t]) => t).map(([n]) => n);
    expect(switches).toEqual(expect.arrayContaining(['send', 'pause', 'unpause', 'accept-listing-gap']));
    for (const n of switches) expect(set.has(n), n).toBe(true);
  });

  it('migrate and release-reserve tell simulate which program is ours', () => {
    expect(body('cmdMigrate')).toMatch(/simulate\(connection, tx, 'migrate_to_amm', \{ launchProgramId: pid \}\)/);
    expect(body('cmdReleaseReserve')).toMatch(/simulate\(connection, tx, 'release_platform_reserve', \{ launchProgramId: pid \}\)/);
    expect(body('simulate')).not.toMatch(/L\.launchErrorName\(custom\)/);
  });
});
