#!/usr/bin/env node
// READ-ONLY. It loads no key and sends nothing: three JSON-RPC reads of mainnet.
//
// It prints the four facts the runbook's table "The upgrade as it executed" needs
// (solana/tegridy-amm/MAINNET_RUNBOOK.md, section 4b), ready to paste, and ONLY when the
// pool program on mainnet hashes to the new build. Before the upgrade it says so, prints
// no table row, and exits 2.
//
//   node frontend/scripts/solana-localnet/read-upgrade-record.mjs
//   RPC_URL=<endpoint> node ...          another endpoint (it must still be mainnet)
//   node ... --rehearse-on-old           walk the whole lookup BEFORE the upgrade, on the
//                                        first deploy. What it prints then is NOT a record.
//
// It is a second reader, not the gate. The gate is the upgrade pack's own check after the
// upgrade, and the address registry's chain check (verify-addresses.mjs --onchain), which
// hashes the same bytes against the same build.
//
// Why it lives beside the local harness: these scripts are where the pool program's pins
// are (start-validator.sh, genesis-accounts.mjs), and the day they move is the day this
// is run. It used to sit in a temp folder, which a tidy-up would have taken.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactRpcUrl } from '../../../scripts/lib/redact-url.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const PROGRAM_DATA = 'F475omgJMd5mnDXJFyjHTkg9zs7WSb6ek9dFoUmUvi5V';
/** The upgradeable loader's header in front of a program: tag (4), last deployed slot (8), authority (1 + 32). */
export const HEADER = 45;
const PROGRAMDATA_TAG = 3;

/** The build mainnet ran from 2026-09-29 until the upgrade. It is also the roll-back build. */
export const OLD_BUILD = { sha256: '88b98aa91559824c682f6e6c31906abf222d189ce7a45f16af117368b33db882', bytes: 691640 };

/**
 * The build the upgrade installs. Not typed here a second time: it is the build the address
 * registry sends its chain check looking for, on this same account's row.
 */
export function registeredBuild(registryPath = join(HERE, '..', 'addresses.json')) {
  const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  const row = (registry.solana ?? []).find((e) => e.address === PROGRAM_DATA);
  const want = row?.expect?.holdsProgram;
  if (!want || !Number.isInteger(want.bytes) || !/^[0-9a-f]{64}$/.test(want.sha256 ?? '')) {
    throw new Error(`addresses.json has no expect.holdsProgram { bytes, sha256 } on the row for ${PROGRAM_DATA}: this reader does not know which build to look for`);
  }
  return { sha256: want.sha256, bytes: want.bytes };
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const num = (n) => Number(n).toLocaleString('en-US');

/** What a program data account's own bytes say. Throws when they are not a ProgramData account. */
export function readProgramData(data, builds) {
  if (data.length < HEADER || data.readUInt32LE(0) !== PROGRAMDATA_TAG) throw new Error('that account is not a ProgramData account');
  const program = data.subarray(HEADER);
  return {
    size: data.length,
    deploySlot: Number(data.readBigUInt64LE(4)),
    asNew: program.length >= builds.new.bytes ? sha(program.subarray(0, builds.new.bytes)) : null,
    asOld: program.length >= builds.old.bytes ? sha(program.subarray(0, builds.old.bytes)) : null,
  };
}

/**
 * Which build that is. Only "upgraded" may lead to a record.
 *
 * "not-upgraded" covers the program as first deployed AND the program after an enlarge
 * alone: the account is then large enough and its last-deployed slot is new, but the bytes
 * are still the old build followed by zeros. The slot and the size are not evidence.
 */
export function verdict(read, builds) {
  if (read.asNew === builds.new.sha256) return 'upgraded';
  if (read.asOld === builds.old.sha256) return 'not-upgraded';
  return 'neither';
}

/** The one successful transaction on the account in the slot it was last deployed in. */
export function pickExecute(signatures, deploySlot) {
  const inSlot = signatures.filter((s) => s.slot === deploySlot && s.err === null);
  return inSlot.length === 1 ? { ok: true, execute: inSlot[0] } : { ok: false, found: inSlot.length };
}

/** The four rows, in the shape of the runbook's table. */
export function recordRows({ day, deploySlot, signature, size }) {
  return [
    `| Day of the execute (UTC) | \`${day}\` |`,
    `| Slot of the execute (the program's "Last Deployed In Slot") | \`${num(deploySlot)}\` |`,
    `| Transaction of the execute (its signature) | \`${signature}\` |`,
    `| Size of the program's data account afterwards (bytes) | \`${num(size)}\` |`,
  ];
}

/**
 * The whole read. `rpc(method, params)` returns a JSON-RPC result or throws. Returns the
 * exit code: 0 a record was printed, 2 there is no record to print, 3 the execute could
 * not be told apart. Everything it says goes through `log`.
 */
export async function run({ rpc, builds, rehearse = false, endpoint = '', log = console.log }) {
  const genesis = await rpc('getGenesisHash', []);
  if (genesis !== MAINNET_GENESIS) throw new Error(`${endpoint || 'that endpoint'} is not mainnet (genesis ${genesis})`);

  const info = await rpc('getAccountInfo', [PROGRAM_DATA, { encoding: 'base64', commitment: 'finalized' }]);
  if (!info?.value) throw new Error('the program data account does not exist');
  const read = readProgramData(Buffer.from(info.value.data[0], 'base64'), builds);
  const is = verdict(read, builds);

  log(`mainnet, finalized, read at slot ${num(info.context.slot)}${endpoint ? ` through ${endpoint}` : ''}`);
  log(`program data account ${PROGRAM_DATA}: ${num(read.size)} bytes, last deployed in slot ${num(read.deploySlot)}`);
  log(`  first ${num(builds.new.bytes)} bytes of the program: ${read.asNew ?? '(the account is too small to hold the new build)'}`);
  log(`  first ${num(builds.old.bytes)} bytes of the program: ${read.asOld ?? '(the account is too small to hold the old build)'}`);

  // --rehearse-on-old: walk the rest BEFORE the upgrade, by treating the build mainnet runs
  // today as if it were the target. What it prints is the 2026-09-29 DEPLOY (or an enlarge),
  // never a record to paste. It exists so the lookup below has been seen working on the chain.
  const rehearsing = rehearse && is === 'not-upgraded';
  if (rehearsing) {
    log('\nREHEARSAL ONLY (--rehearse-on-old): the lines below describe the LAST DEPLOY OF THE OLD BUILD, not the upgrade. Do not paste them.');
  } else if (is !== 'upgraded') {
    log(
      is === 'not-upgraded'
        ? `\nNOT UPGRADED: mainnet runs the build from before the upgrade (${builds.old.sha256.slice(0, 8)}...). There is no record to write yet.`
        : '\nSTOP: the program on mainnet is NEITHER the new build nor the old one. Do not fill anything in.',
    );
    return 2;
  }

  const signatures = await rpc('getSignaturesForAddress', [PROGRAM_DATA, { limit: 50, commitment: 'finalized' }]);
  const picked = pickExecute(signatures, read.deploySlot);
  if (!picked.ok) {
    log(`\nSTOP: expected ONE successful transaction on the program data account in slot ${num(read.deploySlot)}, found ${picked.found}. Read them by hand:`);
    for (const s of signatures.slice(0, 10)) log(`  slot ${num(s.slot)} err ${JSON.stringify(s.err)} ${s.signature}`);
    return 3;
  }
  if (!picked.execute.blockTime) throw new Error('that transaction has no block time yet: ask again in a minute');
  const at = new Date(picked.execute.blockTime * 1000);

  log(
    rehearsing
      ? '\nREHEARSAL ONLY: this is the shape of the record, filled with the LAST DEPLOY OF THE OLD BUILD. NOT the upgrade:'
      : `\nUPGRADED: the program on mainnet is the new build (${builds.new.sha256.slice(0, 8)}...). The record:`,
  );
  for (const row of recordRows({ day: at.toISOString().slice(0, 10), deploySlot: read.deploySlot, signature: picked.execute.signature, size: read.size })) log(row);
  log(`\n(the execute's block time: ${at.toISOString()})`);
  return rehearsing ? 2 : 0;
}

/** A JSON-RPC client that can only read: the three methods above and nothing else. */
function readOnlyRpc(url) {
  const allowed = new Set(['getGenesisHash', 'getAccountInfo', 'getSignaturesForAddress']);
  return async (method, params) => {
    if (!allowed.has(method)) throw new Error(`${method} is not a read this script makes`);
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  try {
    process.exitCode = await run({
      rpc: readOnlyRpc(url),
      builds: { new: registeredBuild(), old: OLD_BUILD },
      rehearse: process.argv.includes('--rehearse-on-old'),
      endpoint: redactRpcUrl(url),
    });
  } catch (e) {
    console.error(`COULD NOT READ: ${e instanceof Error ? e.message : String(e)}. That is not a pass and not a record. Run it again.`);
    process.exitCode = 1;
  }
}
