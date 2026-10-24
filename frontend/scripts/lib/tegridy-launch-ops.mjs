/**
 * Pure helpers for `tegridy-launch-operator.mjs` — the parts of the operator CLI
 * that can be unit-tested without an RPC, a key or the TS loader.
 *
 * Plain JS on purpose. The operator script registers a loader that strips
 * TypeScript types at RUNTIME, so anything it imports statically is loaded before
 * that loader exists. This file therefore imports no `src/` module; where it needs
 * the curve core's numbers (the reserve cap, the curve/reserve split), the caller
 * passes them in.
 *
 * What lives here and why:
 *   • the rule that an optional flag typed with no value is an error;
 *   • the `--platform-reserve-bps` rule (required, no default, capped);
 *   • the sold / LP / reserve split `check-config` prints, and the scaled
 *     `initial_virtual_token` recipe;
 *   • cp-swap `create_permission_pda`, which has no builder in `src/` because only
 *     an operator ever sends it;
 *   • the payer budget for `migrate_to_amm`'s seed top-up;
 *   • the listing gate, the "can this address ever sign" rule, and which program
 *     raised a simulated error;
 *   • a tail check on encoded instruction data, because a renamed argument in the
 *     encoder turns an `Option` into a silent `None`.
 */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';

const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

// ─── --platform-reserve-bps ─────────────────────────────────────────────────────

// ─── Optional flags ─────────────────────────────────────────────────────────────

/**
 * An optional flag's value: `{ ok: true, value: undefined }` when it was not
 * passed, `{ ok: true, value: '<string>' }` when it was.
 *
 * A flag typed with NO value is an error, not "not given". `parseArgs` stores
 * `true` for a flag followed by another `--flag` or by nothing, so
 * `update-global --target --reserve 1` would otherwise drop the target and still
 * build a reserve-only update, and the operator would believe both changed.
 */
export function optionalFlagValue(flags, name) {
  const raw = flags[name];
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === true) return { ok: false, error: `--${name} needs a value` };
  return { ok: true, value: String(raw) };
}

// ─── --platform-reserve-bps ─────────────────────────────────────────────────────

/**
 * Parse `--platform-reserve-bps`. Returns `{ ok: true, value }` or `{ ok: false, error }`.
 *
 * `raw === undefined` means the flag was not given. With `required`, that is an
 * error: there is no default, for the same reason `--creator-fee-share-bps` has
 * none. `initialize_global` runs once, the value is snapshotted onto every launch,
 * and the share of supply the protocol takes must not be chosen by leaving a flag
 * off. Zero is a legal answer, but it has to be typed.
 *
 * `raw === true` (the flag typed with no value) is always an error, required or
 * not: on `update-global` it would otherwise read as "leave unchanged" and the
 * reserve change the operator typed would drop out of an update that still goes.
 *
 * `max` is the program's cap (`MAX_PLATFORM_RESERVE_BPS`, 1000 = 10%); the caller
 * passes the curve core's constant so this file cannot drift from it.
 */
export function parsePlatformReserveBps(raw, { required, max }) {
  if (raw === true) return { ok: false, error: '--platform-reserve-bps needs a value' };
  if (raw === undefined) {
    return required
      ? {
          ok: false,
          error:
            'missing required --platform-reserve-bps <n>. No default: it is the share of every\n' +
            "  launch's supply the protocol holds back (369 = 3.69%). Pass 0 to launch with none.",
        }
      : { ok: true, value: undefined };
  }
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    return { ok: false, error: `--platform-reserve-bps must be a non-negative integer (bps of supply), got "${s}"` };
  }
  const v = BigInt(s);
  if (v > max) {
    return {
      ok: false,
      error: `--platform-reserve-bps is ${v}, above the ${max} (=${Number(max) / 100}%) cap the program enforces (InvalidParameter).`,
    };
  }
  return { ok: true, value: v };
}

// ─── The split a launch lists with ──────────────────────────────────────────────

/**
 * Where a launch's supply ends up if it graduates at exactly `target + reserve`.
 *
 * `curveTokens` is the part the curve can sell (supply minus the platform reserve,
 * from the core's `curveSupply`). The pool gets whatever the curve has not sold,
 * which on a constant-product book at that point is `k / x - Vt` with
 * `k = Vs * (Vt + curveTokens)` and `x = Vs + target + reserve` — the same
 * quantity `graduation_price_ratio_bps` calls `remaining` (curve.rs). The core
 * does not export it, so it is computed here, for DISPLAY: a real graduation
 * overshoots by the last buy's rounding, so the numbers move by a few base units.
 *
 * Returns `null` when the book cannot reach the target (nothing left for the pool).
 */
export function graduationSplit({ supply, curveTokens, virtualSol, virtualToken, target, migrationReserve }) {
  if (supply <= 0n || curveTokens > supply || virtualToken <= 0n) return null;
  const x = virtualSol + target + migrationReserve;
  if (x <= 0n) return null;
  const y = (virtualSol * (virtualToken + curveTokens)) / x;
  if (y <= virtualToken) return null;
  const lp = y - virtualToken;
  if (lp > curveTokens) return null;
  return { sold: curveTokens - lp, lp, reserve: supply - curveTokens };
}

/** `part / whole` as a percentage with three decimals, rounded down. Never a float. */
export function pct3(part, whole) {
  if (whole <= 0n) return '?';
  const milli = (part * 100_000n) / whole;
  return `${milli / 1000n}.${(milli % 1000n).toString().padStart(3, '0')}%`;
}

/**
 * The `initial_virtual_token` that keeps a book's graduation target unchanged once
 * a reserve is carved: `Vt * curveTokens / supply`, rounded down.
 *
 * Why it works: the continuity target depends on `Vs`, `(Vt + S) / Vt` and `R`.
 * Scaling `Vt` and `S` by the same factor leaves `(Vt + S) / Vt` alone, so the
 * target (and the SOL raise) stays the same to the lamport at 369 bps.
 *
 * ⚠ Only `initialize_global` sets `initial_virtual_token`. `update_global` has no
 * argument for it, so after day one a reserve change must be absorbed by virtual
 * SOL, the target or the migration reserve instead.
 */
export function scaledVirtualToken(virtualToken, curveTokens, supply) {
  if (supply <= 0n) return null;
  return (virtualToken * curveTokens) / supply;
}

// ─── The listing gate ───────────────────────────────────────────────────────────

/**
 * How far from the final curve price a book may list and still count as tuned.
 * A book tuned for its reserve (scaled Vt, or the target moved to the continuity
 * target) lists at 9999 or 10000 bps; 25 leaves room for rounding and no more.
 */
export const LISTING_GAP_TOLERANCE_BPS = 25n;

/**
 * Why a config must not be signed as it stands, or `null` when the pool would list
 * at the curve's final price.
 *
 * The program's own check is a ±5% band (`PRICE_CONTINUITY_BAND_BPS`), and a 3.69%
 * carve on a book tuned for NO reserve lists at 10488 bps, inside it. So the
 * program accepts the one mistake the reserve invites, and every launch would list
 * 4.88% above the price its last buyer paid. This tool is the only place that can
 * stop it. `ratioBps` is the pre-flight's `graduationPriceRatioBps`; `null` (not
 * computable) is refused too, because it is not a known good listing.
 */
export function listingGap(ratioBps) {
  if (typeof ratioBps !== 'bigint') {
    return 'the listing price could not be computed, so it is not known to match the curve';
  }
  const off = ratioBps > 10_000n ? ratioBps - 10_000n : 10_000n - ratioBps;
  if (off <= LISTING_GAP_TOLERANCE_BPS) return null;
  return (
    `the pool would list at ${ratioBps} bps of the final curve price, ${off} bps away from it ` +
    `(a tuned book is within ${LISTING_GAP_TOLERANCE_BPS})`
  );
}

/**
 * Must an `update-global` pass the listing gate?
 *
 * Yes whenever the pre-flight re-ran the economics check (`economics` is not null:
 * a --target, --reserve, --virtual-sol or --platform-reserve-bps change) and the
 * update either changes the reserve or leaves a book that still carries one. The
 * gate used to fire only on --platform-reserve-bps, but a target alone moves the
 * listing too: on a book holding 369 bps with the target retuned for it,
 * `--target 11685689681` (the no-reserve target) lists at 10488 bps, and the
 * program's ±5% band accepts it.
 *
 * A book with no reserve, and no reserve change, is left alone, as init-global
 * leaves it.
 */
export function updateNeedsListingGate({ economics, newPlatformReserveBps, currentPlatformReserveBps }) {
  if (!economics) return false;
  if (newPlatformReserveBps !== undefined) return true;
  return (currentPlatformReserveBps ?? 0n) > 0n;
}

// ─── Addresses that can never sign ──────────────────────────────────────────────

/**
 * Why an existing account can never sign, or `null` when it can (or does not exist
 * yet: a fresh wallet can still sign).
 *
 * Only a System-owned, non-executable account is a wallet or a Squads VAULT PDA.
 * Anything owned by a program (the Squads MULTISIG account EVGSnRZ…, a token
 * account, a PDA) or executable is an address nothing can sign as. That matters
 * for any address the program later pays or checks as a signer: the 2026-08-08
 * `admin::ID` mistake was exactly this.
 */
export function unsignableReason(info, systemProgramId) {
  if (!info) return null;
  if (!info.executable && info.owner.equals(systemProgramId)) return null;
  return `owned by ${info.owner.toBase58()} (${info.data.length} bytes${info.executable ? ', executable' : ''})`;
}

// ─── Naming a simulated failure ─────────────────────────────────────────────────

/**
 * The program that failed FIRST in a simulation's logs, or `null` if no failure
 * line is there.
 *
 * When a called program fails, Solana fails the whole transaction and reports the
 * OUTER instruction's index with the INNER program's code. The logs print the inner
 * program's `failed` line first and the outer one's last, so the first line is the
 * program that actually raised the code.
 */
export function innermostFailingProgram(logs) {
  for (const line of logs ?? []) {
    const m = /^Program (\S+) failed/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * The label to print after a simulated `Custom(code)` failure.
 *
 * Names the code only when tegridy-launch itself raised it. cp-swap's Anchor codes
 * also start at 6000, so a cp-swap failure inside `migrate_to_amm` would otherwise
 * print as one of ours (6000 = Overflow), and send the operator to the wrong fix.
 * `nameOf` is the curve core's `launchErrorName`.
 */
export function simulatedErrorLabel(code, logs, launchProgramId, nameOf) {
  if (typeof code !== 'number') return '';
  const raisedBy = innermostFailingProgram(logs);
  if (raisedBy === null) return ' (no failure line in the logs, so the code is not named)';
  if (raisedBy !== launchProgramId) {
    return ` (raised by ${raisedBy} inside a cross-program call; not a tegridy-launch error)`;
  }
  const name = nameOf(code);
  return name ? ` = ${name}` : '';
}

// ─── cp-swap create_permission_pda ──────────────────────────────────────────────

/**
 * `sha256("global:create_permission_pda")[0..8]` — Anchor's default derivation.
 * The test recomputes it from the name.
 */
export const CREATE_PERMISSION_PDA_DISCRIMINATOR = Uint8Array.from([135, 136, 2, 216, 137, 169, 181, 202]);

/** cp-swap `Permission::LEN` — `8 + 32 + 8 * 30` (states/permission.rs). For the rent quote. */
export const CP_SWAP_PERMISSION_LEN = 280;

/**
 * cp-swap `create_permission_pda()` — no args. Accounts in `CreatePermissionPda`
 * declaration order (instructions/admin/create_permission_pda.rs):
 *
 *   owner                 signer, writable — must be cp-swap's compile-time
 *                         `admin::ID`, and it PAYS the rent (`payer = owner`)
 *   permission_authority  read-only — whose permission this is
 *   permission            writable — `["permission", permission_authority]`, `init`
 *   system_program
 *
 * For tegridy-launch the authority is the program-wide migration authority
 * `["migauth"]`: `initialize_with_permission` derives the permission account from
 * its own payer, and that payer is the migration authority.
 */
export function createPermissionPdaIx({ owner, permissionAuthority, permission }, cpSwapProgram) {
  return new TransactionInstruction({
    programId: cpSwapProgram,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: permissionAuthority, isSigner: false, isWritable: false },
      { pubkey: permission, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(CREATE_PERMISSION_PDA_DISCRIMINATOR),
  });
}

/**
 * The `authority` stored in a cp-swap `Permission` account (bytes 8..40, after the
 * discriminator), or `null` if the data is too short to hold one.
 */
export function permissionAuthorityOf(data) {
  if (!data || data.length < 40) return null;
  return new PublicKey(Uint8Array.prototype.slice.call(data, 8, 40));
}

// ─── migrate_to_amm payer budget ────────────────────────────────────────────────

/**
 * Lamports the `migrate_to_amm` payer must front, before the refunds.
 *
 *   • two ATAs it `init_if_needed`s for the migration authority (the SOL leg and
 *     the token leg), unless they already exist;
 *   • the SEED TOP-UP: the program tops the migration authority up to
 *     `minimum_balance(0)` from the payer (lib.rs, `seed_topup`), so the residual
 *     left after cp-swap's costs can never sit in the rent-rejected band. It is a
 *     saturating subtraction: nothing if the authority already holds the floor.
 *
 * The payer gets three ATA rents back when the program closes those accounts at
 * the end, so this is a float, not a cost. Transaction fees are not included.
 */
export function migratePayerFloat({ ataRent, zeroDataRent, authorityLamports, existingAtas = 0 }) {
  const atasToCreate = BigInt(Math.max(0, 2 - existingAtas));
  const seedTopup = zeroDataRent > authorityLamports ? zeroDataRent - authorityLamports : 0n;
  return { atas: atasToCreate * ataRent, seedTopup, total: atasToCreate * ataRent + seedTopup };
}

// ─── Encoding guard ─────────────────────────────────────────────────────────────

/**
 * Does `data` END with the Borsh encoding of `Some(value)` for an `Option<u64>`?
 *
 * The instruction builders live in `src/`, and an argument whose name drifted
 * between this script and the encoder is not an error there: `optU64(undefined)`
 * writes `None`, the program leaves the field alone, and the operator believes the
 * change was made. Checking the last nine bytes of what was actually encoded is
 * the cheap proof that the value reached the wire.
 */
export function endsWithSomeU64(data, value) {
  if (!data || data.length < 9) return false;
  const tail = data.subarray(data.length - 9);
  if (tail[0] !== 1) return false;
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(tail[1 + i]) << (8n * BigInt(i));
  return v === value;
}

/** Same check for a trailing plain `u64` (an `initialize_global` argument). */
export function endsWithU64(data, value) {
  if (!data || data.length < 8) return false;
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(data[data.length - 8 + i]) << (8n * BigInt(i));
  return v === value;
}
