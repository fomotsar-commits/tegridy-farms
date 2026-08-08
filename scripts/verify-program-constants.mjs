#!/usr/bin/env node
/**
 * Baked-constant auditor for the Solana programs.
 *
 * WHY THIS EXISTS — the 2026-08-08 deploy.
 *
 * cp-swap pins its authorities as `pubkey!(...)` constants compiled INTO the binary.
 * They cannot be read back from any account, changed by any transaction, or seen in any
 * explorer. The only way to know which keys a deployed program trusts is to search its
 * bytecode for the raw 32 bytes.
 *
 * Nobody did, so nobody noticed that `admin::ID` and
 * `create_support_mint_associated_owner::ID` had been set to the Squads MULTISIG ACCOUNT
 * (EVGSnRZ...) instead of the Squads VAULT PDA (GRMtSxg...). The operator note in the
 * source said "set Squads multisig", and that is exactly what shipped.
 *
 * All nine admin instructions declare `owner: Signer` with `address = admin::ID`, and the
 * create_* ones also use it as `payer`. The multisig account can do neither — Squads v4
 * signs CPIs with the vault PDA, and a 495-byte program-owned account cannot source a
 * System transfer. So the entire admin surface was bricked on a program holding real
 * money, and `migrate_to_amm` returned AmmNotConfigured (6015) forever: no launch could
 * ever graduate. It cost a full redeploy to fix.
 *
 * The deploy succeeded. The tests passed. The bytecode hash matched its CI artifact. Every
 * check that existed was green, because every check compared the binary to ITSELF rather
 * than to the addresses we actually control. This one compares it to the roster.
 *
 * RUN IT BEFORE YOU SPEND DEPLOY RENT:
 *
 *   node scripts/verify-program-constants.mjs --so target/deploy/raydium_cp_swap.so --program cp-swap
 *   node scripts/verify-program-constants.mjs --deployed            (audit what is live now)
 *   node scripts/verify-program-constants.mjs --deployed cp-swap
 *   node scripts/verify-program-constants.mjs --self-test           (prove the table; no network)
 *
 * Exit: 0 clean · 1 a constant is wrong · 2 could not read (never confused with clean).
 *
 * ── WHAT THIS CAN AND CANNOT TELL YOU ───────────────────────────────────────────
 *
 * It checks the SET of pubkeys present in the binary, not which constant each one came
 * from. It cannot do better: rustc folds identical constants into ONE rodata entry, so
 * after this fix `admin::ID` and `create_support_mint_associated_owner::ID` are literally
 * the same 32 bytes and no byte search can tell them apart. Stated plainly because a tool
 * that implies more precision than it has is how the next one of these gets missed.
 *
 * What that still buys you, and it is the whole ballgame here:
 *   REQUIRED — a key we control is missing  → the program does not trust who we think.
 *   FORBIDDEN — a key we do NOT control, or a devnet key, is present → it trusts someone
 *               else, or a `--features devnet` build is about to hit mainnet.
 */

import { readFileSync } from 'node:fs';

// ── base58, no dependency (this must run from a bare checkout, pre-deploy) ───────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  // The zero case must be handled BEFORE the odd-length pad, not after. Padding first
  // turns "0" into "00", which is one byte, and that byte is then appended to the
  // leading-zero run — so an all-'1' key (the System program) decodes to 33 bytes and
  // gets reported as "not a Solana address". Exactly the 33-byte false positive this
  // tooling exists to catch, aimed at ourselves.
  let body = [];
  if (n !== 0n) {
    let hex = n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    body = Array.from(Buffer.from(hex, 'hex'));
  }
  let leading = 0;
  for (const ch of s) { if (ch === '1') leading++; else break; }
  return Buffer.from([...new Array(leading).fill(0), ...body]);
}

export function base58Encode(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out || '1';
}

/** A pubkey is 32 bytes. Anything else in this file is a bug, so say so loudly. */
function key(b58) {
  const b = base58Decode(b58);
  if (!b || b.length !== 32) throw new Error(`manifest holds a non-pubkey: ${b58}`);
  return b58;
}

// ── the roster ──────────────────────────────────────────────────────────────────
//
// Every address here is in frontend/scripts/addresses.json with a role and custody.
// Keep them in step: this file says what a BINARY must contain, that one says what the
// CHAIN must show, and a key that fails either is a key we do not actually control.

const VAULT = key('GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd');
const MULTISIG = key('EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK');
const FEE_ATA = key('2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa');
const DEPLOY_AUTH = key('Dcjink4RGNUBpRVV4AX8mzxNLpUF2ik5h8Em6usv7kZ7');

const DEVNET_ADMIN = key('GgE6AfEH2AVSrKGckyKMzC6mhtXWiAn39EzAikAsWq5a');
const DEVNET_FEE_ATA = key('27AC7YwwAULHQcQXGErV7rHMsLZAUBWF6ozDNhSpTQE9');
const DEVNET_DECLARE_ID = key('BvBkt84ZiKmiPSuWrdefxbxPTX5YiLnU6YEGtY6pDodL');
const LAUNCH_PLACEHOLDER = key('8YVjjc5ibXQRewh7xtUQMTVR9rrBJjBj4kBMLpbr3kV8');

export const MANIFEST = {
  'cp-swap': {
    programId: key('3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y'),
    require: [
      { pk: '3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y', what: 'declare_id!', why: 'a binary built for a different program id will deploy and then fail every PDA check' },
      { pk: VAULT, what: 'admin::ID + create_support_mint_associated_owner::ID', why: 'the Squads VAULT PDA — the only thing that can sign AND pay for the nine admin instructions' },
      { pk: FEE_ATA, what: 'create_pool_fee_reveiver::ID', why: "the treasury's WSOL ATA; create_pool deserializes it as a token account and calls sync_native" },
    ],
    forbid: [
      { pk: MULTISIG, what: 'the Squads MULTISIG ACCOUNT', why: 'THIS IS THE 2026-08-08 BUG. It can neither sign (Squads v4 signs with the vault PDA) nor pay (495-byte program-owned account). Its presence means every admin instruction is bricked.' },
      { pk: DEVNET_ADMIN, what: 'the devnet admin key', why: 'a --features devnet build is about to be deployed to mainnet' },
      { pk: DEVNET_FEE_ATA, what: 'the devnet fee ATA', why: 'same — this is a devnet build' },
      { pk: DEVNET_DECLARE_ID, what: 'the devnet/placeholder declare_id', why: 'declare_id! is NOT fail-closed; shipping it deploys to an address someone else may hold' },
    ],
  },
  'tegridy-launch': {
    programId: key('CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED'),
    require: [
      { pk: 'CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED', what: 'declare_id!', why: 'as above' },
      { pk: DEPLOY_AUTH, what: 'deployer::ID', why: 'baked at build time, so moving upgrade authority to Squads did NOT move it; this key is still the only signer for initialize_global' },
    ],
    forbid: [
      { pk: LAUNCH_PLACEHOLDER, what: 'the declare_id! placeholder', why: 'a placeholder build; nobody holds this address' },
      { pk: DEVNET_DECLARE_ID, what: 'the devnet declare_id', why: 'a devnet build' },
      { pk: DEVNET_ADMIN, what: 'the devnet admin key', why: 'a devnet build' },
    ],
  },
};

// ── the decision table. Pure, so --self-test proves it with no chain and no build. ──

/**
 * @param spec   one MANIFEST entry
 * @param has    (base58) => boolean — is this pubkey present in the binary?
 * @returns { ok, findings: [{level, message}] }
 */
export function assess(spec, has) {
  const findings = [];
  for (const r of spec.require) {
    if (!has(r.pk)) {
      findings.push({
        level: 'fail',
        message: `MISSING ${r.what} (${r.pk}) — ${r.why}`,
      });
    }
  }
  for (const f of spec.forbid) {
    if (has(f.pk)) {
      findings.push({
        level: 'fail',
        message: `PRESENT ${f.what} (${f.pk}) — ${f.why}`,
      });
    }
  }
  return { ok: findings.length === 0, findings };
}

/** Count occurrences of a 32-byte key in a binary. */
export function occurrences(binary, b58) {
  const needle = base58Decode(b58);
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = binary.indexOf(needle, i)) !== -1) { n++; i++; }
  return n;
}

const hasIn = (binary) => (b58) => occurrences(binary, b58) > 0;

// ── reading a binary ────────────────────────────────────────────────────────────

/**
 * An upgradeable ProgramData account is a 45-byte header
 * (4 enum + 8 slot + 1 option + 32 authority) followed by the ELF. Strip it so offsets
 * and byte searches match a locally built .so exactly.
 */
export const PROGRAMDATA_HEADER_LEN = 45;

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${j.error.code}: ${j.error.message}`);
  return j.result;
}

async function fetchDeployed(programId) {
  const prog = await rpc('getAccountInfo', [programId, { encoding: 'base64' }]);
  if (!prog?.value) throw new Error(`program account ${programId} does not exist`);
  const d = Buffer.from(prog.value.data[0], 'base64');
  if (!prog.value.executable) throw new Error(`${programId} is not executable`);
  if (d.length < 36) throw new Error(`${programId} is not an upgradeable program account`);
  const programData = base58Encode(d.subarray(4, 36));
  const pd = await rpc('getAccountInfo', [programData, { encoding: 'base64' }]);
  if (!pd?.value) throw new Error(`programdata ${programData} does not exist`);
  const raw = Buffer.from(pd.value.data[0], 'base64');
  return {
    programData,
    upgradeAuthority: base58Encode(raw.subarray(13, 45)),
    binary: raw.subarray(PROGRAMDATA_HEADER_LEN),
  };
}

// ── self-test ───────────────────────────────────────────────────────────────────
function selfTest() {
  const cases = [];
  const ok = (n, c) => cases.push([n, c]);
  const setOf = (...pks) => (pk) => pks.includes(pk);

  const cp = MANIFEST['cp-swap'];
  const GOOD_CP = setOf(cp.programId, VAULT, FEE_ATA);
  const SHIPPED_CP = setOf(cp.programId, MULTISIG, FEE_ATA); // what is live right now

  // — the regression: exactly the binary that is deployed today must FAIL.
  const shipped = assess(cp, SHIPPED_CP);
  ok('REGRESSION: the 2026-08-08 cp-swap binary FAILS', shipped.ok === false);
  ok('REGRESSION: it fails for BOTH reasons — vault missing AND multisig present',
    shipped.findings.length === 2 &&
    shipped.findings.some((f) => f.message.includes('MISSING') && f.message.includes(VAULT)) &&
    shipped.findings.some((f) => f.message.includes('PRESENT') && f.message.includes(MULTISIG)));
  ok('REGRESSION: the fixed binary PASSES', assess(cp, GOOD_CP).ok === true);

  // — a devnet build must never pass as mainnet
  ok('a --features devnet cp-swap build FAILS',
    assess(cp, setOf(DEVNET_DECLARE_ID, DEVNET_ADMIN, DEVNET_FEE_ATA)).ok === false);
  ok('a mainnet build carrying the devnet admin FAILS',
    assess(cp, setOf(cp.programId, VAULT, FEE_ATA, DEVNET_ADMIN)).ok === false);

  // — wrong-program footgun
  ok('a binary built for the wrong program id FAILS',
    assess(cp, setOf(VAULT, FEE_ATA)).ok === false);

  // — tegridy-launch is CORRECT as deployed; it must not be flagged
  const tl = MANIFEST['tegridy-launch'];
  ok('the deployed tegridy-launch binary PASSES', assess(tl, setOf(tl.programId, DEPLOY_AUTH)).ok === true);
  ok('tegridy-launch without deployer::ID FAILS', assess(tl, setOf(tl.programId)).ok === false);
  ok('tegridy-launch still carrying the placeholder id FAILS',
    assess(tl, setOf(tl.programId, DEPLOY_AUTH, LAUNCH_PLACEHOLDER)).ok === false);

  // — byte search
  const needle = base58Decode(VAULT);
  ok('occurrences finds a key at offset 0', occurrences(Buffer.concat([needle, Buffer.alloc(64)]), VAULT) === 1);
  ok('occurrences finds a key mid-buffer', occurrences(Buffer.concat([Buffer.alloc(97), needle, Buffer.alloc(13)]), VAULT) === 1);
  ok('occurrences counts duplicates', occurrences(Buffer.concat([needle, needle]), VAULT) === 2);
  ok('occurrences returns 0 for an absent key', occurrences(Buffer.alloc(4096), VAULT) === 0);
  ok('a one-bit difference is not a match', (() => {
    const near = Buffer.from(needle); near[31] ^= 1;
    return occurrences(near, VAULT) === 0;
  })());

  // — base58 round trip
  ok('base58 round-trips the vault', base58Encode(base58Decode(VAULT)) === VAULT);
  ok('base58 round-trips a leading-zero key', base58Encode(base58Decode('11111111111111111111111111111111')) === '11111111111111111111111111111111');
  ok('base58Decode rejects non-base58', base58Decode('0OIl') === null);
  ok('every manifest key decodes to 32 bytes', Object.values(MANIFEST).every((s) =>
    [...s.require, ...s.forbid].every((e) => base58Decode(e.pk)?.length === 32)));
  ok('no key is both required and forbidden', Object.values(MANIFEST).every((s) => {
    const req = new Set(s.require.map((e) => e.pk));
    return s.forbid.every((e) => !req.has(e.pk));
  }));

  let failed = 0;
  for (const [name, pass] of cases) if (!pass) { failed++; console.error(`  x ${name}`); }
  if (failed) {
    console.error(`\n❌ verify-program-constants self-test: ${failed}/${cases.length} failed`);
    process.exit(1);
  }
  console.log(`✅ verify-program-constants self-test: ${cases.length}/${cases.length} passed`);
  process.exit(0);
}

// ── main ────────────────────────────────────────────────────────────────────────
function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

function report(name, spec, binary, extra) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`);
  for (const [k, v] of Object.entries(extra ?? {})) console.log(`   ${k}: ${v}`);
  console.log(`   binary: ${binary.length} bytes`);
  const { ok, findings } = assess(spec, hasIn(binary));
  for (const r of spec.require) {
    const n = occurrences(binary, r.pk);
    console.log(`   ${n ? 'ok  ' : 'MISS'} require ${r.pk}  ${r.what}${n > 1 ? `  (x${n})` : ''}`);
  }
  for (const f of spec.forbid) {
    const n = occurrences(binary, f.pk);
    if (n) console.log(`   BAD  forbid  ${f.pk}  ${f.what}  (x${n})`);
  }
  if (!ok) for (const f of findings) console.error(`   x ${f.message}`);
  return ok;
}

async function main(argv) {
  if (argv.includes('--self-test')) selfTest();

  const soPath = arg(argv, '--so');
  if (soPath) {
    const name = arg(argv, '--program');
    if (!name || !MANIFEST[name]) {
      console.error(`--so needs --program <${Object.keys(MANIFEST).join('|')}>`);
      process.exit(2);
    }
    let binary;
    try {
      binary = readFileSync(soPath);
    } catch (e) {
      console.error(`could not read ${soPath}: ${e.message}`);
      process.exit(2);
    }
    const ok = report(`${name}  (local artifact ${soPath})`, MANIFEST[name], binary);
    console.log(ok ? '\nSAFE TO DEPLOY: every constant matches the roster' : '\nDO NOT DEPLOY');
    process.exit(ok ? 0 : 1);
  }

  if (argv.includes('--deployed')) {
    const only = arg(argv, '--deployed');
    const names = only ? [only] : Object.keys(MANIFEST);
    let allOk = true;
    for (const name of names) {
      const spec = MANIFEST[name];
      if (!spec) { console.error(`unknown program "${name}"`); process.exit(2); }
      let live;
      try {
        live = await fetchDeployed(spec.programId);
      } catch (e) {
        // Exit 2, never 0. "I could not look" must never read as "it is fine" —
        // that conflation is what let the bad constant sit unnoticed.
        console.error(`\ncould not read ${name} (${spec.programId}): ${e.message}`);
        process.exit(2);
      }
      allOk =
        report(`${name}  (LIVE ${spec.programId})`, spec, live.binary, {
          programdata: live.programData,
          'upgrade authority': live.upgradeAuthority,
        }) && allOk;
    }
    console.log(allOk ? '\nevery deployed constant matches the roster' : '\nA DEPLOYED PROGRAM TRUSTS THE WRONG KEY');
    process.exit(allOk ? 0 : 1);
  }

  console.log(`usage:
  node scripts/verify-program-constants.mjs --so <file> --program <${Object.keys(MANIFEST).join('|')}>
  node scripts/verify-program-constants.mjs --deployed [name]
  node scripts/verify-program-constants.mjs --self-test`);
  process.exit(2);
}

await main(process.argv.slice(2));
