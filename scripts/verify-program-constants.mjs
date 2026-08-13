#!/usr/bin/env node
/**
 * verify-program-constants — prove which pubkeys are BAKED INTO a Solana program binary.
 *
 * ─── WHY THIS EXISTS, AND WHY NOTHING ELSE ANSWERS IT ─────────────────────────
 *
 * On 2026-08-08 cp-swap shipped to mainnet with `admin::ID` set to the Squads
 * MULTISIG account (EVGSnRZ…) instead of a system-owned, fundable address. That made
 * `create_amm_config` uncallable — `CreateAmmConfig` has `payer = owner`, and the
 * System Program cannot debit a 495-byte program-owned account — which left
 * tegridy-launch's `migrate_to_amm` permanently on AmmNotConfigured (6015). Tokens
 * could trade and could never graduate. The only fix is a program upgrade.
 *
 * Nothing that existed at the time could have caught it:
 *
 *   • It is NOT readable from an account. `pubkey!()` and `declare_id!()` are
 *     compile-time constants living in the ELF's read-only data. There is no account
 *     to `getAccountInfo`, no field on the IDL, and no explorer page that shows them.
 *   • A REPRODUCIBLE BUILD DOES NOT HELP. `solana-verify` proves the bytecode matches
 *     the source it was built from. A wrong constant is still faithfully reproduced,
 *     and still hashes correctly. Reproducibility answers "is this the source?", never
 *     "is the source right?".
 *   • THE SOURCE ON TRUNK IS NOT THE SOURCE THAT WAS BUILT. MAINNET_RUNBOOK §2 has the
 *     operator hand-edit the four mainnet authority constants immediately before the
 *     verifiable build; those edits are deliberately never committed (the committed
 *     non-devnet arms are fail-closed sentinels and placeholders). So reading lib.rs
 *     tells you what a DEVELOPER build would contain, not what is live.
 *   • Reading the diff, or the runbook, or the session notes is reading a claim.
 *
 * The one check that works is mechanical: a 32-byte pubkey constant is stored
 * LITERALLY, as 32 raw bytes, in the program's rodata. So fetch the bytes that are
 * actually deployed and search them for the raw 32 bytes of every key on a roster.
 * REQUIRED keys must be present. FORBIDDEN keys must be absent.
 *
 * ─── WHAT THIS CAN AND CANNOT TELL YOU ────────────────────────────────────────
 *
 * It reports the SET of keys present. It does NOT attribute a key to a constant, and
 * it must never be read as doing so:
 *
 *   • rustc/LLVM fold identical constants into ONE rodata entry. If `admin::ID` and
 *     `deployer::ID` hold the same key, there is a single 32-byte occurrence covering
 *     both, and no way to tell them apart from the bytes.
 *   • Conversely, a key can be present for an unrelated reason — another constant, a
 *     vendored table, a seed — so PRESENT is evidence, not proof, that a specific
 *     gate compares against it.
 *   • ABSENT is the strong direction and the useful one. A constant that is not in the
 *     binary cannot be the one a gate compares against. That is a proof, not a hint,
 *     and it is what settles the cp-swap question: `admin::ID` cannot be the deploy
 *     authority if the deploy authority's bytes are nowhere in the binary.
 *
 * ─── LOW-ENTROPY KEYS ARE UNSEARCHABLE, AND SAYING SO MATTERS ─────────────────
 *
 * The System Program sentinel `11111111111111111111111111111111` decodes to 32 ZERO
 * bytes. Every ELF is full of zero padding, so a byte search "finds" it in any binary
 * and finds it in an empty buffer too. Reporting that as PRESENT would be a lie, and
 * reporting the search as conclusive would be worse. Such keys are classified
 * UNSEARCHABLE and excluded from the verdict, with the substitute check named: the
 * fail-closed sentinel shipping is detected by the REQUIRED real key being ABSENT.
 *
 * ─── THE PROGRAMDATA HEADER TRAP ──────────────────────────────────────────────
 *
 * A BPFLoaderUpgradeable program account is a 36-byte pointer; the ELF lives in a
 * separate ProgramData account 45 bytes in. Those 45 bytes are
 * `u32 enum | u64 slot | u8 option | 32-byte UPGRADE AUTHORITY`. Searching them would
 * report the upgrade authority (today the Squads vault) as a baked-in constant — a
 * confident, completely wrong answer to the exact question being asked. The header is
 * skipped, and the self-test proves it is.
 *
 * ─── USAGE ────────────────────────────────────────────────────────────────────
 *
 *   # BEFORE spending rent — check the artifact you are about to deploy.
 *   node scripts/verify-program-constants.mjs --so target/deploy/raydium_cp_swap.so
 *
 *   # AFTER the fact — audit what is actually live. Needs SOLANA_RPC_URL.
 *   SOLANA_RPC_URL=https://your-keyed-rpc \
 *     node scripts/verify-program-constants.mjs --deployed 3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y
 *
 *   # CI — prove the matcher can still both pass and fail.
 *   node scripts/verify-program-constants.mjs --self-test
 *
 * Flags: --roster <cp-swap|tegridy-launch>  (inferred where possible; required when not)
 *        --json                             (machine-readable report on stdout)
 *
 * Exits non-zero on any REQUIRED-absent, FORBIDDEN-present, or inconclusive read.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';

// ── base58, inlined ──────────────────────────────────────────────────────────
// Same reasoning as scripts/verify-addresses.mjs: this check has to be trivially
// runnable — on an operator's laptop, mid-deploy, with no install step — so it takes
// no dependency. A Solana pubkey is EXACTLY 32 bytes and nothing else decodes to one.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  // `n === 0n`, NOT `hex === '0'`. The odd-length pad above turns "0" into "00" first,
  // so the string test never fires and an all-'1' address picks up a spurious trailing
  // zero byte: `11111111111111111111111111111111` decoded to 33 bytes instead of 32 and
  // was rejected as "not a pubkey". That address is the System Program — the sentinel
  // this script has to reason about — and the same line is in
  // frontend/scripts/verify-addresses.mjs, whose entire purpose is catching a 33-byte fake.
  const body = n === 0n ? [] : Array.from(Buffer.from(hex, 'hex'));
  let leading = 0;
  for (const ch of s) {
    if (ch === '1') leading++;
    else break;
  }
  return Uint8Array.from([...new Array(leading).fill(0), ...body]);
}

function pubkeyBytes(base58, label) {
  const b = base58Decode(base58);
  if (b === null) throw new Error(`${label}: "${base58}" is not valid base58`);
  if (b.length !== 32) {
    throw new Error(`${label}: "${base58}" decodes to ${b.length} bytes, not 32 — not a pubkey`);
  }
  return b;
}

/**
 * Is this key's byte pattern too common to search for?
 *
 * The only real member of this class is the all-zero System Program sentinel, but the
 * test is on the BYTES rather than on a hardcoded address list, so a future sentinel
 * (all-ones, a repeated byte, anything with almost no entropy) is caught by the same
 * rule instead of silently becoming a false PRESENT.
 *
 * Threshold: fewer than 8 distinct byte values in 32 bytes. A real ed25519 point has
 * ~28-30 distinct values; hitting 7 or fewer by chance is not something that happens.
 */
function isUnsearchable(bytes) {
  return new Set(bytes).size < 8;
}

// ── the rosters ──────────────────────────────────────────────────────────────
//
// These are the INTENDED MAINNET values, not what trunk's source says. They cannot be
// derived from the source: the committed non-devnet arms are placeholders and
// sentinels, replaced by hand at build time per MAINNET_RUNBOOK §2. Writing them down
// here is the point — this file is the only place the intended values and the shipped
// bytes can be compared.
//
// Every address below is also carried in frontend/scripts/addresses.json with its role
// and custody; `--self-test` cross-checks the two so they cannot drift apart.

const ROSTERS = {
  'cp-swap': {
    programId: '3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y',
    artifact: 'raydium_cp_swap.so',
    source: 'solana/tegridy-amm/programs/cp-swap/src/lib.rs',
    keys: [
      {
        id: 'declare_id',
        address: '3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y',
        expect: 'required',
        why: 'declare_id! (lib.rs:44). Anchor compares every instruction against it; a binary built for a different id cannot execute at this address.',
      },
      {
        id: 'admin::ID',
        address: 'Dcjink4RGNUBpRVV4AX8mzxNLpUF2ik5h8Em6usv7kZ7',
        expect: 'required',
        why:
          'lib.rs:75. THE DECISIVE CHECK. create_config/update_config/update_pool_status are gated on it AND `payer = owner`, so it must be system-owned and fundable. ' +
          'The 2026-08-08 binary has the Squads MULTISIG here, which is neither — that is what made create_amm_config uncallable and graduation impossible. ' +
          'Because the multisig is legitimately present for another constant (see create_support_mint_associated_owner below), its presence proves nothing; ' +
          'the ABSENCE of this key is what proves the fix has not shipped.',
      },
      {
        id: 'create_pool_fee_reveiver::ID',
        address: '2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa',
        expect: 'required',
        why: 'lib.rs:88. Consumed as a WSOL TOKEN ACCOUNT (InterfaceAccount<TokenAccount> + sync_native), not a wallet. The Squads vault’s WSOL ATA.',
      },
      {
        id: 'create_support_mint_associated_owner::ID',
        address: 'EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK',
        expect: 'required',
        why:
          'instructions/admin/create_support_mint_associated.rs:29. This one IS the Squads multisig, deliberately and documented as such — it is a pure OR-fallback ' +
          'that grants nobody anything, and repointing it would widen the fork diff for no capability. Listed REQUIRED so its disappearance is noticed, ' +
          'and so nobody reads a multisig hit here as evidence about admin::ID.',
      },
      {
        id: 'devnet declare_id',
        address: 'BvBkt84ZiKmiPSuWrdefxbxPTX5YiLnU6YEGtY6pDodL',
        expect: 'forbidden',
        why: 'lib.rs:42, the `--features devnet` arm. Present => this is a DEVNET build. The CI SBF artifact is one; deploying it to mainnet is the mistake §3 of the runbook warns about.',
      },
      {
        id: 'devnet admin',
        address: 'GgE6AfEH2AVSrKGckyKMzC6mhtXWiAn39EzAikAsWq5a',
        expect: 'forbidden',
        why: 'lib.rs:73. A single operator-held devnet throwaway. Present in a mainnet binary => AMM admin is a throwaway key.',
      },
      {
        id: 'devnet fee receiver',
        address: '27AC7YwwAULHQcQXGErV7rHMsLZAUBWF6ozDNhSpTQE9',
        expect: 'forbidden',
        why: 'lib.rs:86. The devnet WSOL ATA. Every pool-creation fee would be paid to a devnet account that does not exist on mainnet.',
      },
      {
        id: 'squads vault (upgrade authority)',
        address: 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd',
        expect: 'informational',
        why:
          'NOT forbidden — a vault PDA is a perfectly legal admin::ID (runbook §5 costs it out). Tracked because it is the program’s UPGRADE AUTHORITY, which lives in the ' +
          'ProgramData header at bytes 13..45. If this ever reports PRESENT under --deployed, the header skip has regressed and every other answer on this page is suspect.',
      },
    ],
  },

  'tegridy-launch': {
    programId: 'CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED',
    artifact: 'tegridy_launch.so',
    source: 'solana/tegridy-amm/programs/tegridy-launch/src/lib.rs',
    keys: [
      {
        id: 'declare_id',
        address: 'CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED',
        expect: 'required',
        why: 'declare_id! — the mainnet id. Trunk still carries the placeholder (lib.rs:114); the real id is patched in at build time per runbook §5b.',
      },
      {
        id: 'deployer::ID',
        address: 'Dcjink4RGNUBpRVV4AX8mzxNLpUF2ik5h8Em6usv7kZ7',
        expect: 'required',
        why:
          'lib.rs:142 (non-devnet arm). The ONLY key that can call initialize_global — without it that instruction is an unprotected initializer and whoever calls it first ' +
          'owns the protocol and every trade fee. Trunk ships the all-zero System sentinel here, which nobody can sign for; this REQUIRED check is how the sentinel is ' +
          'detected, because the sentinel itself is unsearchable (see below).',
      },
      {
        id: 'System sentinel (deployer fail-closed default)',
        address: '11111111111111111111111111111111',
        expect: 'forbidden',
        why:
          'lib.rs:142 as committed. A mainnet build that keeps it can never be initialized. UNSEARCHABLE — it is 32 zero bytes, which occur as padding in every ELF, ' +
          'so neither presence nor absence can be established by a byte search. The substitute check is deployer::ID above: if the sentinel shipped, the real key is absent.',
      },
      {
        id: 'placeholder declare_id / devnet deployer',
        address: '8YVjjc5ibXQRewh7xtUQMTVR9rrBJjBj4kBMLpbr3kV8',
        expect: 'forbidden',
        why:
          'lib.rs:114 and lib.rs:140. A throwaway keypair nobody holds, used only so the crate compiles. It is BOTH the placeholder program id and the devnet deployer, ' +
          'so a single hit means either a devnet build or an unpatched id — and declare_id! is not fail-closed: ship it and you deploy to an address a stranger may hold.',
      },
      {
        id: 'devnet admin (cp-swap)',
        address: 'GgE6AfEH2AVSrKGckyKMzC6mhtXWiAn39EzAikAsWq5a',
        expect: 'forbidden',
        why: 'Tripwire. Nothing in tegridy-launch takes this key as a constant; a hit means devnet material leaked into a mainnet build.',
      },
      {
        id: 'squads multisig',
        address: 'EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK',
        expect: 'forbidden',
        why:
          'Tripwire for a repeat of the cp-swap mistake. tegridy-launch has NO compile-time multisig constant — its admin is `global.authority`, runtime state that ' +
          'update_global can move. A baked multisig here would be an unsignable gate with no upgrade-free fix.',
      },
      {
        id: 'cp-swap program',
        address: '3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y',
        expect: 'informational',
        why: 'The graduation venue is `global.cp_swap_program`, runtime state, so this is not expected to be baked in. Reported either way rather than asserted.',
      },
    ],
  },
};

// ── the matcher ──────────────────────────────────────────────────────────────

/** Raw 32-byte substring search. `Buffer.includes` is the whole check. */
function bytesPresent(haystack, needle) {
  return Buffer.from(haystack).includes(Buffer.from(needle));
}

/**
 * Evaluate a roster against a byte range.
 *
 * `bin` MUST already be the ELF only — for a ProgramData account the caller strips the
 * 45-byte header first. This function has no idea where its bytes came from and must
 * not: keeping the header logic at the fetch boundary is what lets the self-test feed
 * it hand-built buffers.
 */
function evaluate(roster, bin) {
  const results = [];
  for (const k of roster.keys) {
    const bytes = pubkeyBytes(k.address, k.id);
    if (isUnsearchable(bytes)) {
      results.push({ ...k, state: 'unsearchable', verdict: 'skipped' });
      continue;
    }
    const present = bytesPresent(bin, bytes);
    let verdict;
    if (k.expect === 'required') verdict = present ? 'ok' : 'FAIL';
    else if (k.expect === 'forbidden') verdict = present ? 'FAIL' : 'ok';
    else verdict = 'info';
    results.push({ ...k, state: present ? 'present' : 'absent', verdict });
  }
  const failures = results.filter((r) => r.verdict === 'FAIL');
  return { results, failures, ok: failures.length === 0 };
}

// ── sources of bytes ─────────────────────────────────────────────────────────

/** The ProgramData header: u32 enum | u64 slot | u8 option | 32-byte upgrade authority. */
const PROGRAMDATA_HEADER_LEN = 45;
/** A BPFLoaderUpgradeable *program* account: u32 enum | 32-byte ProgramData address. */
const PROGRAM_ACCOUNT_LEN = 36;

function fromFile(soPath) {
  if (!existsSync(soPath)) throw new Error(`--so file not found: ${soPath}`);
  const buf = readFileSync(soPath);
  // An .so on disk is the bare ELF. Refuse anything that is not one rather than
  // search a truncated download and report a confident set of absences.
  if (!(buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46)) {
    throw new Error(`${soPath} does not start with the ELF magic \\x7fELF — this is not a program binary`);
  }
  return { bin: buf, note: `local artifact ${soPath} (${statSync(soPath).size.toLocaleString()} B)` };
}

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`RPC ${method} returned HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

async function fromChain(programId) {
  const url = (process.env.SOLANA_RPC_URL ?? '').trim();
  if (!url) throw new Error('--deployed needs SOLANA_RPC_URL (a keyed endpoint; the public one rate-limits a 700 KB read)');
  // Validated immediately before the request, not only at parse time, so the network
  // path is unreachable with anything that is not a well-formed pubkey.
  pubkeyBytes(programId, '--deployed');

  const prog = await rpc(url, 'getAccountInfo', [programId, { encoding: 'base64' }]);
  if (!prog?.value) throw new Error(`no account at ${programId} — nothing is deployed there`);
  if (!prog.value.executable) {
    throw new Error(`the account at ${programId} exists but is NOT executable (owner ${prog.value.owner}) — nothing is deployed there`);
  }
  const data = Buffer.from(prog.value.data[0], 'base64');

  if (data.length !== PROGRAM_ACCOUNT_LEN) {
    // A loader-v2 program holds the ELF directly. Rare now, but handling it beats
    // throwing on a program that is perfectly readable.
    return { bin: data, note: `deployed ${programId} (loader-v2, ELF inline, ${data.length.toLocaleString()} B)` };
  }
  const programDataAddress = base58Encode(data.subarray(4, 36));
  const pd = await rpc(url, 'getAccountInfo', [programDataAddress, { encoding: 'base64' }]);
  if (!pd?.value) throw new Error(`ProgramData account ${programDataAddress} could not be read — the answer is UNKNOWN, not "absent"`);
  const raw = Buffer.from(pd.value.data[0], 'base64');
  if (raw.length <= PROGRAMDATA_HEADER_LEN) throw new Error(`ProgramData account is ${raw.length} B — too short to hold an ELF`);

  // THE HEADER SKIP. Bytes 13..45 are the upgrade authority; searching them would
  // report the Squads vault as a compile-time constant.
  const bin = raw.subarray(PROGRAMDATA_HEADER_LEN);
  const upgradeAuthority = raw[12] === 1 ? base58Encode(raw.subarray(13, 45)) : null;
  return {
    bin,
    note: `deployed ${programId} via ProgramData ${programDataAddress} (${bin.length.toLocaleString()} B of ELF, 45-B header skipped)`,
    upgradeAuthority,
  };
}

function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out || '1';
}

// ── self-test ────────────────────────────────────────────────────────────────
//
// A gate nobody exercises is not a gate. Every row below is a case this checker got
// wrong at least once in design, or a property the whole thing rests on. Each has a
// positive control: the same buffer shape that must PASS is used to build the one that
// must FAIL, so a matcher that always returns the same answer cannot survive the table.

function selfTest() {
  const rows = [];
  const check = (name, actual, expected) => {
    rows.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
  };

  const cps = ROSTERS['cp-swap'];
  const req = cps.keys.filter((k) => k.expect === 'required');
  const forb = cps.keys.filter((k) => k.expect === 'forbidden');

  /** Build a fake binary containing exactly the given keys, padded with zeros. */
  const build = (addresses, { headerOnly = [] } = {}) => {
    const head = Buffer.concat([Buffer.alloc(13), ...headerOnly.map((a) => Buffer.from(pubkeyBytes(a, a)))]);
    const body = Buffer.concat([
      Buffer.alloc(64),
      ...addresses.map((a) => Buffer.concat([Buffer.from(pubkeyBytes(a, a)), Buffer.alloc(16)])),
      Buffer.alloc(64),
    ]);
    return { head, body };
  };

  // 1. All REQUIRED present, no FORBIDDEN → clean pass.
  const good = build(req.map((k) => k.address)).body;
  check('a binary with every required key and no forbidden key passes', evaluate(cps, good).ok, true);

  // 2. POSITIVE CONTROL for 1: drop one required key from that same buffer → fail,
  //    naming it. Without this, a matcher hardwired to `ok: true` passes row 1.
  const missingAdmin = build(req.filter((k) => k.id !== 'admin::ID').map((k) => k.address)).body;
  const r2 = evaluate(cps, missingAdmin);
  check('dropping admin::ID flips the verdict to FAIL', r2.ok, false);
  check('...and names admin::ID as the failure', r2.failures.map((f) => f.id), ['admin::ID']);

  // 3. POSITIVE CONTROL the other way: add a forbidden key to the passing buffer.
  const withDevnet = build([...req.map((k) => k.address), forb[0].address]).body;
  const r3 = evaluate(cps, withDevnet);
  check('adding a forbidden devnet key flips the verdict to FAIL', r3.ok, false);
  check('...and names it', r3.failures.map((f) => f.id), [forb[0].id]);

  // 4. THE HEADER TRAP. A key that appears ONLY in the 45-byte ProgramData header must
  //    read as ABSENT. This is the check that stops the UPGRADE AUTHORITY being
  //    reported as a baked-in constant — the failure mode that would have made this
  //    whole tool confidently wrong about the one question it exists to answer.
  const vault = cps.keys.find((k) => k.id.startsWith('squads vault'));
  const trap = build(req.map((k) => k.address), { headerOnly: [vault.address] });
  const full = Buffer.concat([trap.head, trap.body]);
  check(
    'the upgrade authority is PRESENT in the raw ProgramData bytes (control — the trap is real)',
    bytesPresent(full, pubkeyBytes(vault.address, 'vault')),
    true,
  );
  check(
    'and ABSENT once the 45-byte header is stripped, the way fromChain strips it',
    evaluate(cps, full.subarray(PROGRAMDATA_HEADER_LEN)).results.find((r) => r.id === vault.id).state,
    'absent',
  );

  // 5. WE SEARCH BYTES, NOT TEXT. `pubkey!()` leaves no base58 string behind. A tool
  //    that grepped for the address text would pass on a binary that merely mentions
  //    it in a log message and fail on every real one.
  const textOnly = Buffer.concat([
    Buffer.alloc(64),
    Buffer.from(req.map((k) => k.address).join(' '), 'ascii'),
    Buffer.alloc(64),
  ]);
  check('a binary containing only the base58 TEXT reports every key absent', evaluate(cps, textOnly).results.filter((r) => r.state === 'present').length, 0);

  // 6. LOW-ENTROPY KEYS. The System sentinel is 32 zero bytes; an empty buffer
  //    "contains" it. It must be classified unsearchable, never reported present.
  const launch = ROSTERS['tegridy-launch'];
  const sentinel = launch.keys.find((k) => k.address === '11111111111111111111111111111111');
  check('the all-zero System sentinel is classified unsearchable', isUnsearchable(pubkeyBytes(sentinel.address, 'sentinel')), true);
  const zeros = Buffer.alloc(4096);
  const r6 = evaluate(launch, zeros);
  check('...so 4 KB of zeros does not report it present', r6.results.find((r) => r.id === sentinel.id).state, 'unsearchable');
  check('...and a real 32-byte key IS searchable', isUnsearchable(pubkeyBytes('Dcjink4RGNUBpRVV4AX8mzxNLpUF2ik5h8Em6usv7kZ7', 'x')), false);

  // 7. A zeroed buffer must still FAIL tegridy-launch: every required key is absent.
  //    Guards against "unsearchable" swallowing the verdict.
  check('4 KB of zeros fails the tegridy-launch roster on its required keys', r6.ok, false);

  // 8. Every roster address decodes to 32 bytes. This is the check that would have
  //    caught the 33-byte fabricated address in the 2026-08-08 incident.
  for (const [name, r] of Object.entries(ROSTERS)) {
    for (const k of r.keys) {
      check(`${name}/${k.id} decodes to 32 bytes`, pubkeyBytes(k.address, k.id).length, 32);
    }
  }

  // 9. base58Encode round-trips — fromChain uses it to name the ProgramData account,
  //    and a wrong address there sends the operator to look at the wrong thing.
  for (const a of ['3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y', '11111111111111111111111111111111']) {
    check(`base58 round-trips ${a.slice(0, 8)}...`, base58Encode(pubkeyBytes(a, a)), a);
  }

  // 10. DRIFT: every roster address must also be in the canonical registry, so this
  //     file and frontend/scripts/addresses.json cannot disagree about what a key is.
  try {
    const regPath = new URL('../frontend/scripts/addresses.json', import.meta.url);
    const reg = JSON.parse(readFileSync(regPath, 'utf8'));
    const registered = new Set((reg.solana ?? []).map((e) => e.address));
    const unregistered = [];
    for (const r of Object.values(ROSTERS)) {
      for (const k of r.keys) if (!registered.has(k.address)) unregistered.push(`${k.id} (${k.address})`);
    }
    check('every roster key is in the canonical address registry', unregistered, []);
  } catch (e) {
    check('the canonical address registry is readable', String(e.message), '(readable)');
  }

  const failed = rows.filter((r) => !r.ok);
  for (const r of rows) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  if (failed.length) {
    console.error(`\n${failed.length} self-test FAILURE(S):`);
    for (const f of failed) console.error(`  x ${f.name}\n      expected ${JSON.stringify(f.expected)}\n      actual   ${JSON.stringify(f.actual)}`);
    return false;
  }
  console.log(`\n${rows.length} self-test checks passed`);
  return true;
}

// ── reporting ────────────────────────────────────────────────────────────────

const SYMBOL = { ok: 'ok  ', FAIL: 'FAIL', info: 'info', skipped: '??  ' };

function report(rosterName, roster, source, evaluated, upgradeAuthority) {
  console.log(`\nprogram : ${rosterName}   (expected id ${roster.programId})`);
  console.log(`source  : ${source}`);
  if (upgradeAuthority) console.log(`upgrade authority (from the ProgramData header, NOT the ELF): ${upgradeAuthority}`);
  console.log('');
  for (const r of evaluated.results) {
    const state =
      r.state === 'unsearchable'
        ? 'UNSEARCHABLE — low-entropy key; neither presence nor absence can be established'
        : `${r.state.toUpperCase()} (expected ${r.expect})`;
    console.log(`  ${SYMBOL[r.verdict]} ${r.id.padEnd(42)} ${state}`);
    console.log(`       ${r.address}`);
    if (r.verdict === 'FAIL' || r.state === 'unsearchable') {
      for (const line of wrap(r.why, 96)) console.log(`       ${line}`);
    }
  }
  console.log('');
  console.log('  This reports the SET of keys present in the binary. It does NOT attribute a key to a');
  console.log('  particular constant: rustc folds identical constants into one rodata entry, so two');
  console.log('  constants holding the same key are indistinguishable here. PRESENT is evidence;');
  console.log('  ABSENT is proof — a key that is not in the binary cannot be what a gate compares to.');
}

function wrap(s, width) {
  const words = s.split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

function usage() {
  console.log(`
verify-program-constants — which pubkeys are baked into a Solana program binary?

  --so <path.so>          check a local artifact BEFORE spending rent
  --deployed <programId>  audit what is actually live (needs SOLANA_RPC_URL)
  --self-test             prove the matcher can still both pass and fail (CI)
  --roster <name>         ${Object.keys(ROSTERS).join(' | ')}   (inferred where possible)
  --json                  machine-readable report

A pubkey constant is 32 raw bytes in the program's rodata. It cannot be read from an
account or an explorer, and a reproducible build of a WRONG constant still reproduces
and still hashes correctly. Searching the bytes is the only check that works.
`);
}

// ── main ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function pickRoster(flags) {
  if (typeof flags.roster === 'string') {
    if (!ROSTERS[flags.roster]) throw new Error(`unknown --roster "${flags.roster}". Known: ${Object.keys(ROSTERS).join(', ')}`);
    return flags.roster;
  }
  if (typeof flags.deployed === 'string') {
    const hit = Object.entries(ROSTERS).find(([, r]) => r.programId === flags.deployed);
    if (hit) return hit[0];
    throw new Error(
      `${flags.deployed} is not a program id this script has a roster for.\n` +
        `  Known: ${Object.entries(ROSTERS).map(([n, r]) => `${n} = ${r.programId}`).join('\n         ')}\n` +
        '  Pass --roster explicitly if you are checking a rebuild at a new address.',
    );
  }
  if (typeof flags.so === 'string') {
    const hit = Object.entries(ROSTERS).find(([, r]) => flags.so.replace(/\\/g, '/').endsWith(`/${r.artifact}`) || flags.so === r.artifact);
    if (hit) return hit[0];
    throw new Error(
      `could not infer the roster from "${flags.so}".\n` +
        `  Expected a filename ending in ${Object.values(ROSTERS).map((r) => r.artifact).join(' or ')}.\n` +
        '  Pass --roster explicitly. Guessing here would check the wrong key set and report a confident pass.',
    );
  }
  throw new Error('nothing to check — pass --so, --deployed or --self-test');
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h || process.argv.length === 2) {
    usage();
    return 0;
  }
  if (flags['self-test']) return selfTest() ? 0 : 1;

  const rosterName = pickRoster(flags);
  const roster = ROSTERS[rosterName];
  const { bin, note, upgradeAuthority } =
    typeof flags.so === 'string' ? fromFile(flags.so) : await fromChain(String(flags.deployed));

  const evaluated = evaluate(roster, bin);

  if (flags.json) {
    console.log(JSON.stringify({ roster: rosterName, source: note, upgradeAuthority: upgradeAuthority ?? null, ok: evaluated.ok, results: evaluated.results.map(({ id, address, expect, state, verdict }) => ({ id, address, expect, state, verdict })) }, null, 2));
    return evaluated.ok ? 0 : 1;
  }

  report(rosterName, roster, note, evaluated, upgradeAuthority);

  if (evaluated.ok) {
    console.log('  RESULT: every required key is present and no forbidden key is.\n');
    return 0;
  }
  console.error(`  RESULT: ${evaluated.failures.length} FAILURE(S) — do not deploy / this binary needs an upgrade:`);
  for (const f of evaluated.failures) {
    console.error(`    x ${f.id} is ${f.state}, expected ${f.expect === 'required' ? 'present' : 'absent'}`);
  }
  console.error('');
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`\n[verify-program-constants] ERROR: ${e.message}\n`);
    process.exitCode = 1;
  });
