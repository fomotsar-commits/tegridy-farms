#!/usr/bin/env node
/**
 * Address registry verifier.
 *
 * WHY THIS EXISTS — the incident, 2026-08-08.
 * An operator wallet holding 0.496 SOL was recorded in a session note only as a
 * TRUNCATED string, "5hNA2MXk…927v". Nobody could look it up, spend from it, or prove
 * it was the right wallet. Then a later session, asked to expand it, INVENTED a full
 * address that fit the pattern: 45 characters decoding to 33 bytes — not a valid Solana
 * pubkey at all. It sat in the notes looking entirely plausible next to the real one.
 *
 * Nobody funded it, so nothing was lost. That was luck, not process.
 *
 * A markdown table would not have caught it, because a wrong address looks exactly like
 * a right one. Only decoding does. So this is a CHECK, not a document:
 *
 *   0. EVERY SECTION IS READ — each top-level key of addresses.json is either a row
 *                   section in ROW_SECTIONS or a named non-row key. An unknown key is a
 *                   hard failure, because rows the checks below never iterate are
 *                   unchecked whatever `expect` they carry. That was true of every
 *                   `base` and `robinhood` row until 2026-09-17.
 *   1. STRUCTURE  — every address decodes. EVM to 20 bytes with a valid EIP-55
 *                   checksum; Solana base58 to exactly 32 bytes. This is the check that
 *                   would have caught the fabrication.
 *   2. NO TRUNCATION — any '…' or '...' in an address field is a hard failure.
 *                   Truncation is what started the whole incident.
 *   3. NO DUPLICATES — the same address under two ids ON THE SAME CHAIN means two people
 *                   think they own different things. Keyed per chain, because a CREATE
 *                   address depends only on deployer + nonce: one deployer's nonce 7 is
 *                   a different contract on mainnet, Base and Robinhood.
 *   4. DENYLIST   — the fabricated address and the burned keypair can never be
 *                   reintroduced, even by an honest copy-paste.
 *   5. DRIFT (code → registry)
 *                 — every non-zero EVM address LITERAL in src/lib/constants.ts and in
 *                   src/lib/yield/protocols.ts must be registered here, so an address
 *                   cannot enter the codebase without someone writing down what it is and
 *                   who controls it. The scan is a LIST of files, and the list is the
 *                   whole of its reach: a file carrying live mainnet addresses that is not
 *                   named in it is not "clean", it is unlooked-at.
 *   6. DRIFT (chain → registry)
 *                 — every contract this repo has actually CREATED on mainnet, Base or
 *                   Robinhood, read out of the Foundry broadcast receipts (including
 *                   the ones created inside a transaction), must be a
 *                   registry row ON THAT CHAIN, denylisted, or (mainnet only) retired
 *                   in `retiredDeploys`.
 *
 * WHY 6 EXISTS — the guard used to be one-directional and could not fail on a missing
 * entry. Check 5 walks a fixed list of source files and asks the registry about each
 * address it finds in them, so its reach is exactly "addresses written down in the files
 * it was told to open". Two whole classes of live contract were invisible to it:
 *
 *   • Anything the frontend never names. The four DELEGATECALL libraries linked into
 *     TegridyStaking / TegridyFactory / SwapFeeRouter, and TegridyStakingJbacVault which
 *     custodies users' JBAC NFTs, are live mainnet code that constants.ts has no reason
 *     to mention. All five were unregistered under a green CI.
 *   • Anything not written as a bare top-level `export const NAME = '0x…'`. The old
 *     pattern missed array and object members outright — which is how the two retired
 *     staking deployments that STILL CUSTODY USER POSITIONS
 *     (LEGACY_STAKING_ADDRESSES) stayed unregistered.
 *
 * Seven live contracts, none of them noticeable by a check that only ever looks at the
 * addresses the code already knows about. Check 6 starts from the DEPLOYMENT RECORD
 * instead, which is the only source that grows when a new contract goes live. Check 5
 * was also widened to any literal shape, with comments stripped first so a historical
 * "Prev: 0x…" note is not mistaken for a live reference.
 *
 * There was a THIRD class, and it was the same hole from the other side: a file the scan
 * had simply never been told about. src/lib/yield/protocols.ts carries twenty-seven live
 * mainnet addresses belonging to eight outside protocols, seven of which /yield sends a
 * visitor's ETH or USDC to. Not one of them is in constants.ts, so check 5 passed on a
 * file it had never opened — and a check that passes because it did not look is not a
 * pass, it is silence. It is a list now (EVM_LITERAL_SOURCES), each file counted
 * separately, and a source that yields ZERO literals is a hard failure rather than a
 * quiet clean bill: a moved or renamed file must not be able to drop its own coverage.
 *
 * ── THE CHAIN READ: THREE OUTCOMES, NOT TWO ─────────────────────────────────────
 *
 * Checks 1-6 prove an address is WELL FORMED and WRITTEN DOWN. None can prove it is the
 * RIGHT one. Flip the last character of a program id and every one still passes: valid
 * base58, 32 bytes, unique, registered, absent from every broadcast receipt. It is
 * simply an address where nothing was ever deployed. Only reading the chain sees that.
 *
 * `--onchain` is passed by .github/workflows/registry-onchain.yml — daily, on demand,
 * and on any change to the registry or the constants it mirrors. Scoping it there rather
 * than defaulting it on is deliberate: a PR that touches no addresses should not take a
 * network dependency, and that workflow already asserts the chain section appeared.
 *
 * What this file owns is what happens once the read runs. Public RPCs rate-limit and CI
 * runners share buckets, so a read that does not complete must not FAIL — and must not
 * PASS either. A gate that goes red on a bad minute gets switched off, which lands you
 * back at blind, so the two are separated structurally:
 *
 *   the RPC answered, element is null  ->  ABSENT. Definitive. FAIL.
 *   anything else                      ->  UNKNOWN. Skip, warn, exit 0, and say how many.
 *
 * Batched into two requests (Solana getMultipleAccounts with a zero-length dataSlice,
 * Ethereum a JSON-RPC array batch), which is what keeps the skip path rare: sixty
 * sequential calls to a free endpoint will eventually draw a limit; two will not.
 *
 * One more read, only for a row that says WHICH program a data account holds
 * (`expect.holdsProgram`, check 3c): the program's bytes are fetched once and hashed.
 * The registry can then be wrong about the chain in a way no typing can put right. A row
 * that names a build mainnet does not run is red until mainnet runs it.
 *
 * Run:  node scripts/verify-addresses.mjs             (offline; fast; CI-safe)
 *       node scripts/verify-addresses.mjs --onchain   (also reads live chain state)
 *       node scripts/verify-addresses.mjs --markdown  (emit the registry as a table)
 *       node scripts/verify-addresses.mjs --self-test (prove 0-3c, 5, 5b, 6 and 7 can still fail)
 *
 * Exits non-zero on any failure so CI fails loudly.
 *
 * NEVER add a private key, a seed phrase, or a keyfile PATH to addresses.json. This
 * repository is public. `custody` says WHO controls a key, never WHERE it is stored.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { getAddress, getContractAddress, isAddress } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, 'addresses.json');
const CONSTANTS = join(HERE, '..', 'src', 'lib', 'constants.ts');
const YIELD_PROTOCOLS = join(HERE, '..', 'src', 'lib', 'yield', 'protocols.ts');
const CURVE_PROGRAM = join(HERE, '..', 'src', 'lib', 'launcher', 'solana', 'curve', 'program.ts');
const BROADCAST = join(HERE, '..', '..', 'contracts', 'broadcast');
/**
 * The EVM chains this file can check, by chain id. Foundry files broadcasts under
 * broadcast/<script>/<chainId>/, and a registry row names its chain through the section
 * it sits in (ROW_SECTIONS) or, in `ethereum`, through its own `chainId`.
 */
const EVM_CHAINS = { 1: 'mainnet', 8453: 'Base', 4663: 'Robinhood' };
const MAINNET = 1;

/**
 * Every top-level list of registry ROWS, and the chain its rows live on. A section
 * missing from here is a section no check reads, so check 0 fails on any top-level key
 * that is neither a row section nor one of NON_ROW_KEYS.
 *
 * In `base` and `robinhood` the section IS the chain. In `ethereum` the row says: a
 * `chainId` (number or array, default 1) is how the CREATE2-twin L2 Safes name both
 * chains from one row.
 */
const ROW_SECTIONS = {
  solana: { kind: 'solana' },
  ethereum: { kind: 'evm' },
  base: { kind: 'evm', chainId: 8453 },
  robinhood: { kind: 'evm', chainId: 4663 },
};
/** Top-level keys that hold no rows. Each is checked (or deliberately not) further down. */
const NON_ROW_KEYS = new Set(['$comment', 'denylist', 'retiredDeploys', 'heatRegistry']);

/**
 * AUDIT FIX TF-058: pick the newest receipt by its OWN `timestamp`, not by the
 * filename `run-latest.json`.
 *
 * Foundry writes `run-latest.json` as a COPY of the run it just performed. A
 * later re-broadcast of a *different* script, an interrupted run, or a manual
 * file shuffle can leave `run-latest` pointing at a superseded deploy — and
 * three scripts in this repo are in exactly that state, so this check has been
 * reading addresses that were replaced. A receipt naming a bricked contract
 * reads identically to one naming the live one; only the timestamp separates
 * them.
 *
 * Returns the parsed receipt with the greatest `timestamp` across every
 * `run-*.json` in the directory, falling back to `run-latest.json` when no
 * timestamped sibling parses.
 */
function newestReceipt(dir) {
  let best = null;
  let bestPath = null;
  let entries = [];
  try {
    entries = readdirSync(dir).filter((f) => /^run-.*\.json$/.test(f));
  } catch {
    return null;
  }
  for (const f of entries) {
    const p = join(dir, f);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      continue; // an unparseable sibling is reported by the caller's own guard
    }
    const ts = Number(parsed?.timestamp ?? 0);
    if (!best || ts > Number(best.timestamp ?? 0)) {
      best = parsed;
      bestPath = p;
    }
  }
  return best ? { parsed: best, path: bestPath } : null;
}

const reg = JSON.parse(readFileSync(REGISTRY, 'utf-8'));
const failures = [];
const warnings = [];
const fail = (m) => failures.push(m);
const warn = (m) => warnings.push(m);

// ── base58 → bytes. No dependency: the whole point is that this check is trivial to
// run, so there is never an excuse not to. A Solana pubkey is EXACTLY 32 bytes.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null; // includes '0', 'O', 'I', 'l' and any '…'
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  // `n === 0n`, NOT `hex === '0'`. The odd-length pad on the line above rewrites "0" to
  // "00" BEFORE the test, so the zero branch was unreachable and every all-'1' address
  // picked up a spurious trailing zero byte — `11111111111111111111111111111111` (the
  // System Program, and tegridy-launch's fail-closed deployer sentinel) decoded to 33
  // bytes and would have been rejected here as "NOT A SOLANA ADDRESS". Exactly the
  // verdict this function exists to reserve for a fabricated key.
  const body = n === 0n ? [] : Array.from(Buffer.from(hex, 'hex'));
  let leading = 0;
  for (const ch of s) { if (ch === '1') leading++; else break; }
  return new Uint8Array([...new Array(leading).fill(0), ...body]);
}

const TRUNCATION = /[…]|\.\.\./;

function checkSolana(address, label) {
  if (TRUNCATION.test(address)) { fail(`${label}: TRUNCATED address "${address}" — store it in full`); return false; }
  const bytes = base58Decode(address);
  if (bytes === null) { fail(`${label}: "${address}" is not valid base58`); return false; }
  if (bytes.length !== 32) {
    fail(`${label}: "${address}" decodes to ${bytes.length} bytes, not 32 — THIS IS NOT A SOLANA ADDRESS`);
    return false;
  }
  return true;
}

function checkEvm(address, label) {
  if (TRUNCATION.test(address)) { fail(`${label}: TRUNCATED address "${address}" — store it in full`); return false; }
  if (!isAddress(address)) { fail(`${label}: "${address}" is not a valid EVM address`); return false; }
  try {
    if (getAddress(address) !== address) {
      // Not fatal on its own, but a wrong checksum is how a typo hides in plain sight.
      warn(`${label}: "${address}" is not EIP-55 checksummed (expected ${getAddress(address)})`);
    }
  } catch {
    fail(`${label}: "${address}" failed checksum validation`);
    return false;
  }
  return true;
}

// ── 0. Every top-level key is read by something ─────────────────────────────────
//
// Until 2026-09-17 every check below walked `reg.solana` and `reg.ethereum` by name, so
// the `base` and `robinhood` arrays were never read. A truncated address, a non-address,
// a duplicate, `expect.type: "contarct"` and a deleted `role` in a base row all exited 0,
// and every `expect` there was inert. Naming the sections one more time would fix those
// two and leave the next one (`arbitrum`, `solanaDevnet`) exactly as blind, so the key
// set is closed instead: a key nothing reads is a failure, not a quiet extra.
function checkTopLevelKeys(registry) {
  for (const key of Object.keys(registry)) {
    if (Object.hasOwn(ROW_SECTIONS, key) || NON_ROW_KEYS.has(key)) continue;
    fail(
      `addresses.json has a top-level "${key}" that no check reads, so every row under it is ` +
        `UNCHECKED whatever \`expect\` it carries. Add it to ROW_SECTIONS with its chain, or ` +
        `move its rows into a section that is read.`,
    );
  }
}

// ── 1 + 2. Structure and truncation, 3. per-chain duplicates ────────────────────

// A section note — `{ "$comment": "…" }` with no address — is a legal row in any
// section. It carries no address and must be skipped rather than validated, or the
// registry cannot explain itself inline. It must NOT be able to smuggle an entry
// through: anything with an `address` is validated no matter what else it holds.
const isNote = (e) => e && e.$comment !== undefined && e.address === undefined;

const chainName = (c) => (c === 'solana' ? 'Solana' : `${EVM_CHAINS[c]} (${c})`);

/**
 * The chain(s) a row's address lives on, or null (after failing) when the row names a
 * chain this file cannot read. That must not be a quiet skip: the chain also keys the
 * duplicate check, so a typo'd `8543` would dodge that as well as the chain read.
 */
function rowChains(section, e, label) {
  const spec = ROW_SECTIONS[section];
  if (spec.kind === 'solana') return ['solana'];
  if (spec.chainId !== undefined) {
    if (e.chainId !== undefined && e.chainId !== spec.chainId) {
      fail(`${label}: chainId ${JSON.stringify(e.chainId)} contradicts its section, which is chain ${spec.chainId}`);
      return null;
    }
    return [spec.chainId];
  }
  const ids = Array.isArray(e.chainId) ? e.chainId : [e.chainId ?? MAINNET];
  if (!ids.length || !ids.every((c) => Number.isInteger(c) && Object.hasOwn(EVM_CHAINS, c))) {
    fail(`${label}: chainId ${JSON.stringify(e.chainId)} names no chain this checker reads (${Object.keys(EVM_CHAINS).join(', ')})`);
    return null;
  }
  return ids;
}

/**
 * Validate every row of every ROW_SECTIONS section and return the rows tagged with
 * `section`, `kind` and `chains`. It reports only through `fail`/`warn`, so --self-test
 * can run it on a synthetic registry.
 *
 * Duplicates are keyed by (chain, address), never by address alone. A CREATE address
 * depends only on deployer and nonce, so 0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3 is
 * three different contracts: tegridy-staking-admin on mainnet, the router on Base and the
 * factory on Robinhood. CREATE2 twins such as tegridy-factory-lib are the same code at
 * the same address on 1 and 8453. Both are correct rows, and one global map would call
 * them duplicates.
 */
function checkRows(registry) {
  const seen = new Map();
  const entries = [];
  for (const [section, spec] of Object.entries(ROW_SECTIONS)) {
    const rows = registry[section];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) {
      fail(`"${section}" must be an array of rows; it is ${typeof rows}, so none of it was checked`);
      continue;
    }
    for (const e of rows) {
      if (isNote(e)) continue;
      const label = `${section}/${e.id}`;
      const chains = rowChains(section, e, label);
      entries.push({ ...e, section, kind: spec.kind, chains: chains ?? [] });
      const ok = spec.kind === 'solana' ? checkSolana(e.address, label) : checkEvm(e.address, label);
      if (!ok || !chains) continue;
      const addr = spec.kind === 'solana' ? e.address : e.address.toLowerCase();
      for (const c of chains) {
        const k = `${c}:${addr}`;
        if (seen.has(k)) fail(`duplicate address ${e.address} on ${chainName(c)}: "${label}" and "${seen.get(k)}"`);
        else seen.set(k, label);
      }
    }
  }
  return entries;
}

// ── 3. Every entry must actually say what it is and who holds it ────────────────
function checkRoles(entries) {
  for (const e of entries) {
    if (!e.id) fail(`an entry has no id: ${JSON.stringify(e).slice(0, 80)}`);
    if (!e.role) fail(`${e.section}/${e.id}: no role — an unexplained address is how this incident started`);
    if (!e.status) fail(`${e.section}/${e.id}: no status`);
  }
}

// ── 3b. An `expect.type` the chain read does not understand is WORSE than none ──
//
// Runs OFFLINE, on every invocation, because it is a spelling check on this file and
// has nothing to do with whether an RPC answered.
//
// The chain read dispatches on `expect.type` with a chain of `if (want === '…')`, so an
// unrecognised value — `"contarct"`, or a plausible-but-unimplemented `"safe"` — matches
// no branch and asserts NOTHING. It is not a loud failure; it is silence that LOOKS like
// coverage: the entry prints the same green line as a real assertion, and any
// "how many entries are unasserted" tally counts it as asserted because `expect.type`
// is truthy. One typo converts a check into a claim that a check happened.
//
// So the accepted set is written down once, here, and anything outside it is a hard
// failure that names the alternatives. `contract` and `eoa` are the only two the
// EVM path implements today (every EVM section: ethereum, base, robinhood) — `absent`
// is deliberately NOT accepted for an EVM entry, because eth_getCode cannot tell "never
// deployed" from "EOA": both answer 0x. An EVM address that must not exist belongs in
// `denylist`, which is enforced.
const EXPECT_TYPES = {
  solana: new Set(['wallet', 'program-owned', 'token-account', 'executable', 'absent']),
  evm: new Set(['contract', 'eoa']),
};
function checkExpectTypes(entries) {
  for (const e of entries) {
    const want = e.expect?.type;
    if (want === undefined) continue; // unasserted is honest; it is counted elsewhere
    const allowed = EXPECT_TYPES[e.kind];
    if (!allowed.has(want)) {
      fail(
        `${e.section}/${e.id}: expect.type "${want}" is not one of ${[...allowed].join(', ')} — ` +
          `it would match no branch in the chain read and assert NOTHING, while still counting ` +
          `as an asserted entry. Fix the value or drop the expect block.`,
      );
    }
  }
}

// ── 3c. WHICH program a data account holds ───────────────────────────────────────
//
// `executable` on a program and `program-owned` on its data account say that A program
// is there. Neither says which one. Until 2026-10-09 the pool program's rows named a
// build in their `status` prose ("expected bytecode sha256 99a9e73d…") that mainnet did
// not run yet, and the chain read was green all the same: prose is not read.
//
// `expect.holdsProgram: { bytes, sha256 }` on a data account's row is that claim in a
// form the chain read checks. The upgradeable loader keeps a 45-byte header in front of
// the program (a 4-byte tag, the slot of the last deploy, the upgrade authority). The
// first `bytes` bytes after it must hash to `sha256`.
//
// Why a hash and not "last deployed after slot N": making a program account larger
// re-deploys the program in that slot, any wallet may do it, and the old program is
// still what runs afterwards. A slot check would go green on a stranger's enlarge. The
// same goes for the account's size. Only the bytes say which build is there.
//
// The offline half lives here because, like 3b, it is a spelling check on this file. A
// misspelled key matches no branch of the chain read and asserts nothing, so the keys an
// `expect` block may carry are a closed set, and a `holdsProgram` that could not be
// checked (wrong kind of row, no hash, a size that is not a number) is a hard failure.
const EXPECT_KEYS = {
  solana: new Set(['type', 'funded', 'holdsProgram']),
  evm: new Set(['type']),
};
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
/** The loader's header in front of a program: tag (4), last deployed slot (8), authority (1 + 32). */
const PROGRAMDATA_HEADER = 45;
const PROGRAMDATA_TAG = 3;
/** The loader takes no program account larger than 10 MiB. */
const LARGEST_PROGRAM = 10 * 1024 * 1024;
function checkExpectKeys(entries) {
  for (const e of entries) {
    if (e.expect === undefined) continue;
    const label = `${e.section}/${e.id}`;
    if (e.expect === null || typeof e.expect !== 'object' || Array.isArray(e.expect)) {
      fail(`${label}: expect must be an object; as written the chain read asserts NOTHING for this row`);
      continue;
    }
    const allowed = EXPECT_KEYS[e.kind];
    for (const k of Object.keys(e.expect)) {
      if (!allowed.has(k)) {
        fail(
          `${label}: expect.${k} is not one of ${[...allowed].join(', ')}. The chain read has no branch for it, ` +
            `so it would assert NOTHING while the row still reads as asserted. Fix the key or remove it.`,
        );
      }
    }
    const hp = e.expect.holdsProgram;
    if (hp === undefined) continue;
    if (e.kind !== 'solana') continue; // already failed above: not a key an EVM row may carry
    if (hp === null || typeof hp !== 'object' || Array.isArray(hp)) {
      fail(`${label}: expect.holdsProgram must be { bytes, sha256 }`);
      continue;
    }
    if (e.expect.type !== 'program-owned') {
      fail(`${label}: expect.holdsProgram belongs on a program's DATA account, which is expect.type "program-owned"; this row is "${e.expect.type}"`);
    }
    const extra = Object.keys(hp).filter((k) => k !== 'bytes' && k !== 'sha256');
    if (extra.length) fail(`${label}: expect.holdsProgram carries ${extra.join(', ')}, which nothing reads; it takes bytes and sha256 only`);
    if (!Number.isInteger(hp.bytes) || hp.bytes < 1 || hp.bytes > LARGEST_PROGRAM) {
      fail(`${label}: expect.holdsProgram.bytes is ${JSON.stringify(hp.bytes)}; it must be the program's size, a whole number of bytes from 1 to ${LARGEST_PROGRAM}`);
    }
    if (typeof hp.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(hp.sha256)) {
      fail(`${label}: expect.holdsProgram.sha256 must be the program's full sha256, 64 lowercase hex characters (never a shortened one)`);
    }
  }
}

checkTopLevelKeys(reg);
const allEntries = checkRows(reg);
checkRoles(allEntries);
checkExpectTypes(allEntries);
checkExpectKeys(allEntries);
for (const [chain, toks] of Object.entries(reg.heatRegistry ?? {})) {
  if (!Array.isArray(toks)) continue;
  for (const t of toks) checkEvm(getAddress(t.address), `heatRegistry/${chain}/${t.symbol}`);
}

// ── 4. Denylist ─────────────────────────────────────────────────────────────────
for (const d of reg.denylist ?? []) {
  if (!d.reason) fail(`denylist entry ${d.address} has no reason`);
  // A denylisted address may be structurally invalid — that is often WHY it is
  // denylisted — so validation is opt-out here, but it must never appear as a live entry.
  const live = allEntries.find(
    (e) => e.address === d.address || e.address?.toLowerCase?.() === d.address.toLowerCase(),
  );
  if (live) fail(`DENYLISTED address ${d.address} is present as live entry "${live.section}/${live.id}" — ${d.reason}`);
  if (!d.skipValidation && d.chain === 'solana') {
    const b = base58Decode(d.address);
    if (b && b.length === 32) {
      // fine — a real address that we simply refuse to use
    }
  }
}

// ── The two drift directions ────────────────────────────────────────────────────
const ZERO = '0x0000000000000000000000000000000000000000';

/** Every `ethereum`-section address, whatever its chainId, lowercased. Check 5's allow-set. */
const registeredLive = new Set(
  (reg.ethereum ?? []).filter((e) => e.address).map((e) => e.address.toLowerCase()),
);
/** Deliberately retired, plus denylisted. Known-about, but never a live reference. */
const retired = new Set(
  (reg.retiredDeploys?.addresses ?? []).map((e) => e.address.toLowerCase()),
);
const denylisted = new Set((reg.denylist ?? []).map((d) => String(d.address).toLowerCase()));

/**
 * EVM rows by the chain they live on: chain id -> Set of lowercased addresses. Check 6
 * classifies a chain's CREATEs against that chain's set and never the union, because a
 * row for 0x4B134C08… on mainnet says nothing about the contract at 0x4B134C08… on Base.
 */
function registeredByChain(entries) {
  const byChain = new Map();
  for (const e of entries) {
    if (e.kind !== 'evm' || typeof e.address !== 'string') continue;
    for (const c of e.chains) {
      if (!byChain.has(c)) byChain.set(c, new Set());
      byChain.get(c).add(e.address.toLowerCase());
    }
  }
  return byChain;
}
const registeredOnChain = registeredByChain(allEntries);

/**
 * Strip `//` and block comments before scanning for address literals.
 *
 * Load-bearing, not cosmetic. constants.ts documents superseded deployments inline
 * ("Prev V1: 0xaA16dF3d…", "Prev: 0x8f1Ba1eC…"). Those are history, not references —
 * counting them would demand a live registry entry for every address the project has
 * ever abandoned, and the only way to get CI green again would be to register dead
 * contracts as live. The check has to distinguish what the code USES from what a
 * comment MENTIONS, and the compiler's own rule is the honest place to draw that line.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

// ── 5. code → registry ──────────────────────────────────────────────────────────
//
// ANY address literal in real code, not just `export const NAME = '0x…'`. The old
// pattern was anchored to that one shape and so could not see LEGACY_STAKING_ADDRESSES,
// an array of two live contracts that still custody user positions.
//
// And ANY file that carries such a literal, not just constants.ts. The scan's reach is
// this list and nothing else, which is why the list is written out here rather than
// discovered: adding a file is a deliberate edit, and DROPPING one is a visible deletion
// rather than an address quietly ceasing to be checked. src/lib/yield/protocols.ts is
// here because it is the only file in the /yield surface that carries an address, and one
// of those addresses is where a visitor's ETH goes when they press a button — the same
// stakes as a deploy of our own, on code we do not control.
const EVM_LITERAL_SOURCES = [
  { label: 'constants.ts', path: CONSTANTS },
  { label: 'yield/protocols.ts', path: YIELD_PROTOCOLS },
];
/** literals seen per source, so a source that went blind is named rather than averaged away. */
const literalsChecked = new Map();
for (const source of EVM_LITERAL_SOURCES) {
  let n = 0;
  try {
    const src = stripComments(readFileSync(source.path, 'utf-8'));
    // Capture a little leading context so the failure names something a human can find.
    const re = /(?:([A-Za-z0-9_]+)\s*[:=]\s*)?['"](0x[a-fA-F0-9]{40})['"]/g;
    for (const m of src.matchAll(re)) {
      const [, name, addr] = m;
      if (addr.toLowerCase() === ZERO) continue; // not-yet-deployed placeholder
      n++;
      if (!registeredLive.has(addr.toLowerCase())) {
        const where = name ? `${name} = ${addr}` : `${addr} (inside an array or literal)`;
        fail(
          `${source.label} references ${where}, which is NOT in the registry. ` +
            `Add it to scripts/addresses.json with a role and custody before shipping.`,
        );
      }
    }
  } catch (e) {
    fail(`could not read ${source.label} for the drift check: ${e.message}`);
  }
  literalsChecked.set(source.label, n);
}

// ── 5b. Solana code → registry ──────────────────────────────────────────────────
//
// Check 5 reads constants.ts, which is EVM-only. Every Solana protocol address in the
// frontend therefore bypassed the registry entirely — including the two program ids the
// launcher actually talks to. That is a hole in exactly the chain this file exists to
// close: a fabricated or stale Solana id could enter the codebase with nothing to catch
// it, which is the fabricated-address incident with the chain swapped.
//
// It is not hypothetical. `PROGRAM_ID` in this module points at CpFnacr…zED, whose
// programdata was CLOSED on 2026-08-13 — an address that can never hold a program again.
// Registering it makes that a fact the registry states rather than one the frontend
// silently assumes.
//
// Well-known SPL/system ids are enumerated rather than pattern-matched, so adding one is
// a deliberate edit and not a widening that happens by accident.
const SOLANA_WELL_KNOWN = new Map([
  ['11111111111111111111111111111111', 'System program'],
  ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'SPL Token program'],
  ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'SPL Token-2022 program'],
  ['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'Associated Token Account program'],
  ['SysvarRent111111111111111111111111111111111', 'Rent sysvar'],
  ['So11111111111111111111111111111111111111112', 'Wrapped SOL mint'],
]);
// Named so a rename cannot silently drop coverage — the same reasoning as the
// interface-selector guard. A check that quietly stops checking is worse than none.
const CURVE_REQUIRED_EXPORTS = ['PROGRAM_ID', 'CP_SWAP_PROGRAM_ID'];

let solanaLiteralsChecked = 0;
try {
  const src = stripComments(readFileSync(CURVE_PROGRAM, 'utf-8'));
  const registeredSol = new Set((reg.solana ?? []).filter((e) => !isNote(e)).map((e) => e.address));

  const declared = new Map();
  for (const m of src.matchAll(/export const ([A-Z0-9_]+)\s*(?::[^=]+)?=\s*new PublicKey\(\s*'([1-9A-HJ-NP-Za-km-z]{32,44})'\s*\)/g)) {
    declared.set(m[1], m[2]);
  }
  for (const name of CURVE_REQUIRED_EXPORTS) {
    if (!declared.has(name)) {
      fail(
        `curve/program.ts no longer exports ${name} as a PublicKey literal. It is one of the ` +
          `protocol ids this drift check covers; renaming it would drop it from coverage silently. ` +
          `Update CURVE_REQUIRED_EXPORTS deliberately if the rename is intended.`,
      );
    }
  }

  const byAddress = new Map([...declared].map(([name, addr]) => [addr, name]));
  for (const m of src.matchAll(/new PublicKey\(\s*'([1-9A-HJ-NP-Za-km-z]{32,44})'\s*\)/g)) {
    const addr = m[1];
    if (SOLANA_WELL_KNOWN.has(addr)) continue;
    solanaLiteralsChecked++;
    if (!registeredSol.has(addr)) {
      fail(
        `curve/program.ts uses ${byAddress.get(addr) ?? 'an inline literal'} = ${addr}, which is ` +
          `NOT in the registry. Add it to scripts/addresses.json with a role, custody and expect.`,
      );
    }
  }
} catch (e) {
  fail(`could not read curve/program.ts for the Solana drift check: ${e.message}`);
}

// ── 6. chain → registry ─────────────────────────────────────────────────────────
//
// The direction that can actually notice a MISSING entry. Check 5 can only ever ask
// about addresses the frontend already imports; this one starts from what was really
// deployed. A live contract the frontend never names — a linked library, an escrow
// vault — is invisible to 5 and unmissable here.
//
// Source: Foundry's own receipts. `contractAddress` on a CREATE/CREATE2 in
// broadcast/<script>/<chainId>/run-latest.json is the address the transaction actually
// produced, written by the tool that produced it. Nobody transcribes it, so it cannot
// carry a typo, and it appears the moment a deploy happens.
//
// Every chain in EVM_CHAINS, each against ITS OWN rows. This read only `/1/` until
// 2026-09-17, so no Base or Robinhood deploy could fail it. A CREATE on Base is
// classified by a `base` row (or an `ethereum` row whose chainId names 8453), never by
// a mainnet row at the same address: the same deployer at the same nonce is a
// different contract on each chain. `retiredDeploys` is mainnet-only for that reason.
// A retired L2 contract stays in its section with a retired status, as the Base
// lighthouses do.
//
// `hash` is never read. Foundry can label a transaction with ANOTHER transaction's hash
// from the same run (10 of 14 in DeployBaseMVP's Base receipt), so a CREATE is checked
// by (from, nonce), which is what fixes its address. A receipt whose `contractAddress`
// disagrees with its own from/nonce is a failure, not something to trust.
//
// A contract created INSIDE a transaction is not a top-level CREATE. Foundry lists it
// under that transaction's `additionalContracts`: the template a factory's constructor
// deploys, the pair createPair makes, a Safe from createProxyWithNonce. Until
// 2026-09-18 this read only the top level, so five mainnet contracts had no row
// (two of them the live templates every launchpad-v2 drop and NFT pool clone runs),
// and the four L2 role Safes were never read at all.
//
// `dry-run/` is deliberately excluded: those are simulated addresses that were never
// created on-chain, and demanding registry entries for them would flood the registry
// with fiction.

/**
 * Every CREATE/CREATE2 in the newest receipt of each broadcast/<script>/<cid>/: the
 * top-level ones, and the ones made inside a transaction (`nested: true`).
 * It reports through `fail`/`warn` only, so --self-test can point it at a synthetic tree.
 */
function scanBroadcasts(root, cid) {
  const creates = [];
  for (const script of readdirSync(root)) {
    const dir = join(root, script, String(cid));
    const runLatest = join(dir, 'run-latest.json');
    if (!existsSync(runLatest)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(runLatest, 'utf-8'));
    } catch (e) {
      fail(`${script}/${cid}/run-latest.json is unreadable (${e.message}) — a broadcast receipt that cannot be parsed is an UNCHECKED deploy, not an absent one`);
      continue;
    }
    // AUDIT FIX TF-058: prefer the newest receipt BY TIMESTAMP. `run-latest`
    // is a copy of whichever run happened last in this directory, which is
    // not necessarily the newest deploy of this script.
    const newest = newestReceipt(dir);
    if (newest && Number(newest.parsed.timestamp ?? 0) > Number(parsed.timestamp ?? 0)) {
      warn(
        `${script}/${cid}/run-latest.json is STALE — ${basename(newest.path)} is newer ` +
          `(${newest.parsed.timestamp} > ${parsed.timestamp}); reading the newer receipt`,
      );
      parsed = newest.parsed;
    }
    for (const tx of parsed.transactions ?? []) {
      // Created INSIDE this transaction, whatever its own type. There is no from/nonce to
      // re-derive these from: the creator's nonce lives in its history and a CREATE2 salt
      // in the call's arguments. The trace wrote each address.
      const creator = tx.function
        ? `${tx.contractName ? `${tx.contractName}.` : ''}${tx.function}`
        : `the ${tx.contractName ?? '(unnamed)'} constructor`;
      for (const inner of tx.additionalContracts ?? []) {
        if (typeof inner?.address !== 'string' || !isAddress(inner.address, { strict: false })) {
          fail(
            `${script}/${cid}: an additionalContracts entry under ${creator} has no readable address ` +
              `(${JSON.stringify(inner?.address)}). A creation that cannot be read is an UNCHECKED deploy, not an absent one.`,
          );
          continue;
        }
        creates.push({
          addr: inner.address.toLowerCase(),
          name: `${inner.contractName ?? '(unnamed)'} (created by ${creator})`,
          script,
          nested: true,
        });
      }
      if (tx.transactionType !== 'CREATE' && tx.transactionType !== 'CREATE2') continue;
      if (!tx.contractAddress) continue;
      if (tx.transactionType === 'CREATE') {
        let derived = null;
        try {
          derived = getContractAddress({ from: tx.transaction.from, nonce: BigInt(tx.transaction.nonce) });
        } catch { /* no usable from/nonce: reported below */ }
        if (derived?.toLowerCase() !== tx.contractAddress.toLowerCase()) {
          fail(
            `${script}/${cid}: the receipt says ${tx.contractName ?? '(unnamed)'} was created at ` +
              `${tx.contractAddress}, but its from/nonce give ${derived ?? 'no address'}. The label ` +
              `cannot be trusted; key it by (from, nonce).`,
          );
          continue;
        }
      }
      creates.push({ addr: tx.contractAddress.toLowerCase(), name: tx.contractName ?? '(unnamed)', script });
    }
  }
  return creates;
}

/** A CREATE on chain `cid` is classified by a row ON THAT CHAIN, a denylist entry, or (mainnet only) retiredDeploys. */
function isClassified(addr, cid, known) {
  const a = addr.toLowerCase();
  return Boolean(known.byChain.get(cid)?.has(a) || (cid === MAINNET && known.retired.has(a)) || known.denylisted.has(a));
}

/** The registry section a chain's rows belong in, for the failure text. */
const sectionFor = (cid) => Object.entries(ROW_SECTIONS).find(([, s]) => s.chainId === cid)?.[0] ?? 'ethereum';

function unclassifiedCreateMessage({ addr, name, script }, cid) {
  if (cid === MAINNET) {
    return (
      `${script} created ${name} at ${getAddress(addr)} on mainnet, and it is in NEITHER the ` +
      `registry NOR retiredDeploys. Every contract this repo has put on mainnet must be ` +
      `classified: add it to "ethereum" with a role and custody if it is live, or to ` +
      `"retiredDeploys" if it is abandoned.`
    );
  }
  return (
    `${script} created ${name} at ${getAddress(addr)} on ${chainName(cid)}, and no row ON THAT ` +
    `CHAIN names it. A row for the same address on another chain does not count: it is a ` +
    `different contract there. Add it to "${sectionFor(cid)}" with a role and status ` +
    `(a retired status if it is abandoned).`
  );
}

/** CREATEs per chain id. Mainnet's count is the one the zero guard at the bottom requires. */
const createsScanned = new Map();
/** How many of those were created inside a transaction, per chain id. */
const nestedScanned = new Map();
const knownDeploys = { byChain: registeredOnChain, retired, denylisted };
try {
  if (!existsSync(BROADCAST)) {
    warn(`no contracts/broadcast directory at ${BROADCAST} — check 6 (chain → registry) did NOT run`);
  } else {
    for (const cid of Object.keys(EVM_CHAINS).map(Number)) {
      const creates = scanBroadcasts(BROADCAST, cid);
      createsScanned.set(cid, creates.length);
      nestedScanned.set(cid, creates.filter((c) => c.nested).length);
      const reported = new Set();
      for (const c of creates) {
        if (isClassified(c.addr, cid, knownDeploys) || reported.has(c.addr)) continue;
        reported.add(c.addr);
        fail(unclassifiedCreateMessage(c, cid));
      }
    }
  }
} catch (e) {
  fail(`could not scan contracts/broadcast for the reverse drift check: ${e.message}`);
}
const broadcastsChecked = createsScanned.get(MAINNET) ?? 0;

// A retired entry that no longer corresponds to any receipt is stale bookkeeping: it
// silently widens the allow-set for check 6 forever. Warn rather than fail — a receipt
// can legitimately be pruned from the repo — but never let it pass unmentioned.
if (broadcastsChecked > 0) {
  const deployed = new Set();
  for (const script of existsSync(BROADCAST) ? readdirSync(BROADCAST) : []) {
    const runLatest = join(BROADCAST, script, String(MAINNET), 'run-latest.json');
    if (!existsSync(runLatest)) continue;
    try {
      for (const tx of JSON.parse(readFileSync(runLatest, 'utf-8')).transactions ?? []) {
        if (tx.contractAddress) deployed.add(tx.contractAddress.toLowerCase());
        for (const inner of tx.additionalContracts ?? []) {
          if (typeof inner?.address === 'string') deployed.add(inner.address.toLowerCase());
        }
      }
    } catch { /* already reported as a failure above */ }
  }
  for (const e of reg.retiredDeploys?.addresses ?? []) {
    if (!checkEvm(e.address, `retiredDeploys/${e.contract ?? e.address}`)) continue;
    if (registeredOnChain.get(MAINNET)?.has(e.address.toLowerCase())) {
      fail(`${e.address} is listed BOTH as a live registry entry and in retiredDeploys — pick one`);
    }
    if (!deployed.has(e.address.toLowerCase())) {
      warn(`retiredDeploys lists ${e.address} (${e.contract ?? '?'}), which no mainnet broadcast receipt mentions — stale entry, or a pruned receipt`);
    }
  }
}

// ── "The RPC did not answer" is NOT "the account is not there" ──────────────────
//
// These two are the whole safety argument for gating on a live read, and the previous
// shape got the trade backwards in both directions: first it swallowed every error into
// `(unreadable)`, so an absent program looked like a pass; then the fix made a read that
// would not complete a hard FAILURE, so a rate-limited public endpoint turns a correct
// registry red. Neither is usable as a required check — one is blind, the other is noise,
// and a noisy gate gets switched off, which lands you back at blind.
//
// So the distinction is made explicitly and structurally:
//
//   the RPC answered, element is null   -> the account is ABSENT. Definitive. FAIL.
//   anything else                       -> UNKNOWN. Skip, warn, exit 0, and SAY how many.
//
// A missing account is a POSITIVE result — JSON-RPC returns a null element inside a
// SUCCESSFUL response, which is a different thing from a transport error, a rate-limit
// body, an RPC error object, or a truncated array. Every one of those is unknown.
//
// Both functions are pure and have no network in them, so `--self-test` proves the
// distinction on every CI run — including the runs where the network is down and the
// live read skips. That matters more than it sounds: a skipped check and a broken check
// produce identical output, so the only way "we skipped" stays trustworthy is if the
// decision table is verified separately from the thing it decides about.
const unanswered = (reason) => ({ answered: false, reason });

/** Classify a Solana `getMultipleAccounts` response. */
export function classifySolanaBatch(json, expectedCount) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return unanswered('response was not a JSON-RPC object');
  if (json.error) return unanswered(`RPC error ${json.error.code ?? '?'}: ${json.error.message ?? 'unknown'}`);
  const value = json.result?.value;
  if (!Array.isArray(value)) return unanswered('response carried no result.value array');
  // A short array is unknown for the WHOLE batch. Inferring absence from a truncated
  // body is exactly how flake would become a red build.
  if (value.length !== expectedCount) return unanswered(`asked about ${expectedCount} accounts, response carried ${value.length}`);
  for (const v of value) {
    if (v === null) continue;
    if (typeof v !== 'object' || Array.isArray(v)) return unanswered('an element was neither null nor an account object');
  }
  return { answered: true, values: value };
}

/**
 * The cheap half of `expect.holdsProgram`, from the batched read: every account in it
 * comes back with its size (`space`), and a data account smaller than header + program
 * cannot hold that program. Null when the size is enough, or was not stated.
 */
export function holdsProgramSpaceProblem(v, want) {
  if (!v || !Number.isInteger(v.space)) return null;
  const need = PROGRAMDATA_HEADER + want.bytes;
  if (v.space >= need) return null;
  return (
    `registry says it holds the ${want.bytes}-byte program ${want.sha256}; the account is ${v.space} bytes, ` +
    `too small for it (${need} needed): mainnet does NOT run that build`
  );
}

/**
 * The other half: a `getAccountInfo` of the data account, asked for its header and the
 * first `want.bytes` bytes of program. Same three outcomes as the batch: the RPC answered
 * and the bytes are that build (problem null), answered and they are not (a problem), or
 * no usable answer (not answered, so skipped and counted, never a pass).
 */
export function classifyProgramData(json, want) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return unanswered('response was not a JSON-RPC object');
  if (json.error) return unanswered(`RPC error ${json.error.code ?? '?'}: ${json.error.message ?? 'unknown'}`);
  if (json.result === null || typeof json.result !== 'object' || !('value' in json.result)) return unanswered('response carried no result.value');
  const v = json.result.value;
  if (v === null) return { answered: true, problem: 'registry expects a program data account here and it DOES NOT EXIST' };
  if (typeof v !== 'object' || Array.isArray(v)) return unanswered('the account was neither null nor an account object');
  if (v.owner !== UPGRADEABLE_LOADER) return { answered: true, problem: `expected a program data account of the upgradeable loader; owner is ${v.owner}` };
  if (!Array.isArray(v.data) || v.data[1] !== 'base64' || typeof v.data[0] !== 'string') return unanswered('the account came back without base64 data');
  const bytes = Buffer.from(v.data[0], 'base64');
  // A short body must never read as "the program is too small". When the RPC states the
  // account's size, the slice on the wire has to be all of what was asked for.
  const asked = PROGRAMDATA_HEADER + want.bytes;
  if (Number.isInteger(v.space) && bytes.length !== Math.min(v.space, asked)) {
    return unanswered(`asked for ${Math.min(v.space, asked)} bytes of the account, the response carried ${bytes.length}`);
  }
  if (bytes.length < PROGRAMDATA_HEADER || bytes.readUInt32LE(0) !== PROGRAMDATA_TAG) {
    return { answered: true, problem: 'the account is not a program data account (its loader tag is not ProgramData)' };
  }
  const slot = bytes.readBigUInt64LE(4);
  const room = bytes.length - PROGRAMDATA_HEADER;
  if (room < want.bytes) {
    return {
      answered: true,
      slot,
      problem: `it holds ${room} bytes of program, too few for the ${want.bytes}-byte program ${want.sha256}: mainnet does NOT run that build (last deployed in slot ${slot})`,
    };
  }
  const sha256 = createHash('sha256').update(bytes.subarray(PROGRAMDATA_HEADER, asked)).digest('hex');
  if (sha256 !== want.sha256) {
    return {
      answered: true,
      slot,
      sha256,
      problem: `the first ${want.bytes} bytes of the program hash to ${sha256}, not ${want.sha256}: mainnet does NOT run that build (last deployed in slot ${slot})`,
    };
  }
  return { answered: true, slot, sha256, problem: null };
}

/**
 * Classify a JSON-RPC array batch of `eth_getCode`.
 *
 * Per-id, because a batch can legitimately answer some ids and error on others. An id
 * that is missing, errored, or carrying a non-hex result simply is not in the map, and
 * the caller treats it as unknown — never as "no code".
 */
export function classifyEvmBatch(json) {
  if (!Array.isArray(json)) return unanswered('response was not a JSON-RPC array batch');
  const byId = new Map();
  for (const r of json) {
    if (r === null || typeof r !== 'object' || r.error) continue;
    if (typeof r.result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(r.result)) continue;
    byId.set(r.id, r.result);
  }
  return { answered: true, byId };
}

const chunk = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * One (entry, chain) read per chain an EVM row lives on, from the `chains` that
 * `checkRows` resolved. Pure, so --self-test can prove a `base` row is read on 8453 and
 * never on mainnet, where the same address is usually a different contract.
 */
export function evmReadPairs(entries) {
  return entries.filter((e) => e.kind === 'evm').flatMap((e) => e.chains.map((cid) => ({ e, cid })));
}

// ── Live chain state. ON BY DEFAULT — see the dispatch at the bottom. ────────────
async function onchain() {
  const SOL_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
  const ETH_RPC = process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com';
  // Re-validate immediately before the request, not only at load time.
  //
  // CodeQL flags file data reaching an outbound network request, and the point
  // stands even though every address was validated above: that happens in a
  // different function, and nothing structurally stops a later edit from reordering
  // or short-circuiting it. This makes the network path unreachable with anything
  // that is not a well-formed address, independent of what ran earlier.
  // Self-contained on purpose: inlining the patterns rather than reaching for a
  // shared constant keeps this guard true even if the validation above is edited.
  const safeAddress = (a) => {
    const v = String(a);
    const evm = /^0x[a-fA-F0-9]{40}$/.test(v);
    const sol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
    if (!evm && !sol) {
      throw new Error(`refusing to send a malformed address in a network request: ${v}`);
    }
    return v;
  };
  // Retry, then SKIP — never swallow, and never go red on a bad minute.
  //
  // Every read here once sat in `catch { console.log('(unreadable)') }`, and the one
  // disagreement it detected was a `warn()`, which does not touch the exit code — so
  // the read could not fail on any input, ever. Nothing in .github/ passed `--onchain`
  // either, so it was decoration twice over.
  //
  // The correction to that must not overshoot into failing on transport errors. These
  // are free public endpoints and CI runners share rate-limit buckets; "I could not
  // check" and "I checked and it is fine" must not share an exit code, but neither
  // should "I could not check" and "this address is wrong". Three outcomes, not two.
  // Every unknown is counted and named at the end of the run.
  const RPC_TIMEOUT_MS = 12_000;
  // A whole program is about a megabyte of base64. It gets longer to arrive, not more tries.
  const PROGRAM_READ_TIMEOUT_MS = 45_000;
  const postOnce = async (url, body, timeoutMs) => {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
      return { ok: true, json: await r.json() };
    } catch (err) {
      return { ok: false, reason: err?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err?.message || 'request failed' };
    }
  };
  const post = async (url, body, timeoutMs = RPC_TIMEOUT_MS) => {
    const first = await postOnce(url, body, timeoutMs);
    if (first.ok) return first;
    await new Promise((res) => setTimeout(res, 900));
    const second = await postOnce(url, body, timeoutMs);
    return second.ok ? second : { ok: false, reason: `${first.reason}; retry: ${second.reason}` };
  };

  // What each `expect.type` claims, checked against the account the RPC
  // actually returns rather than against the fact that a line printed.
  const SYSTEM_PROGRAM = '11111111111111111111111111111111';
  const TOKEN_PROGRAMS = new Set([
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ]);
  const solanaProblem = (e, v) => {
    const want = e.expect?.type;
    // `absent` is enforced unconditionally — an address that must not exist on
    // mainnet must not exist on mainnet, whatever the status says.
    if (want === 'absent') return v ? 'expected ABSENT but the account EXISTS' : null;
    // The exemption is STRUCTURAL, never inferred from prose.
    //
    // This was `if (!e.status?.startsWith('live')) return null;`, and it disarmed
    // itself the moment somebody told the truth: rewriting deploy-authority's status
    // from "live, funded…" to "🔴 EMPTY…" stopped it starting with "live", so its
    // `expect: {funded: true}` was silently never evaluated and the job went GREEN on
    // exactly the entry the edit was flagging. An honesty edit must never be able to
    // switch off the check that would have caught the same thing.
    //
    // `devnet-*` entries carry mainnet-irrelevant expectations; enforcing those
    // against mainnet would be permanently red for a correct registry, which is how a
    // gate becomes noise and then gets switched off. That exemption is worth keeping —
    // but it is a property of WHICH CHAIN the entry describes, so key it on the id (or
    // an explicit `onchain: false`), both of which a status rewrite cannot touch.
    if (e.id?.startsWith('devnet-') || e.onchain === false) return null;
    if (!want) return !v ? 'registry says live but it does not exist' : null;
    if (!v) return 'registry expects this account to exist and it DOES NOT';
    if (want === 'executable' && !v.executable) return 'expected an EXECUTABLE program; the account is not executable';
    if (want === 'wallet' && v.owner !== SYSTEM_PROGRAM) return `expected a system-owned wallet; owner is ${v.owner}`;
    if (want === 'program-owned' && v.owner === SYSTEM_PROGRAM) return 'expected a program-owned account; it is system-owned';
    if (want === 'token-account' && !TOKEN_PROGRAMS.has(v.owner)) return `expected an SPL token account; owner is ${v.owner}`;
    if (e.expect?.funded === true && !(v.lamports > 0)) return 'registry says FUNDED; the balance is 0';
    // Check 3c, the cheap half: an account too small for the program it is said to hold.
    if (e.expect?.holdsProgram) return holdsProgramSpaceProblem(v, e.expect.holdsProgram);
    return null;
  };

  console.log('\n── live chain state ─────────────────────────────────────────');
  const skipped = [];
  const solEntries = (reg.solana ?? []).filter((x) => !isNote(x));
  const evmEntries = allEntries.filter((e) => e.kind === 'evm');
  // Rows whose program bytes are still to be hashed: they exist, they passed every check
  // above, and they say which program they hold.
  const programReads = [];

  // Batched: one request per chain, not one per address. That is not only cheaper —
  // it is what makes the skip path rare. Sixty sequential calls to a free endpoint
  // will eventually draw a rate-limit; two will usually not.
  //
  // `dataSlice` of zero length keeps account DATA off the wire while still returning
  // lamports / owner / executable, which is everything `solanaProblem` reads.
  for (const group of chunk(solEntries, 100)) {
    const res = await post(SOL_RPC, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getMultipleAccounts',
      params: [group.map((e) => safeAddress(e.address)), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }],
    });
    const cls = res.ok ? classifySolanaBatch(res.json, group.length) : unanswered(res.reason);
    if (!cls.answered) {
      warn(`Solana chain read SKIPPED for ${group.length} address(es): ${cls.reason}`);
      for (const e of group) { console.log(`  ${e.id.padEnd(30)} (NOT CHECKED)`); skipped.push(`solana/${e.id}`); }
      continue;
    }
    group.forEach((e, i) => {
      const v = cls.values[i];
      const state = v ? `${(v.lamports / 1e9).toFixed(6)} SOL${v.executable ? ' [program]' : ''}` : 'DOES NOT EXIST';
      const problem = solanaProblem(e, v);
      console.log(`  ${e.id.padEnd(30)} ${state}${problem ? `  <-- ${problem}` : ''}`);
      if (problem) fail(`solana/${e.id}: ${problem}`);
      else if (v && e.expect?.holdsProgram && !(e.id?.startsWith('devnet-') || e.onchain === false)) programReads.push(e);
    });
  }

  // Check 3c, the other half: WHICH program each such data account holds. One read per
  // row (there is one today), of the header and the program's own length and no more.
  // An answer that is not that build FAILS. No usable answer is NOT CHECKED: counted and
  // named below like every other skip, and never a pass.
  for (const e of programReads) {
    const want = e.expect.holdsProgram;
    const res = await post(
      SOL_RPC,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [safeAddress(e.address), { encoding: 'base64', dataSlice: { offset: 0, length: PROGRAMDATA_HEADER + want.bytes } }],
      },
      PROGRAM_READ_TIMEOUT_MS,
    );
    const cls = res.ok ? classifyProgramData(res.json, want) : unanswered(res.reason);
    const label = `${e.id} (program bytes)`;
    if (!cls.answered) {
      warn(`Solana program read SKIPPED for ${e.id}: ${cls.reason}. Whether it holds the registered build is NOT KNOWN from this run.`);
      console.log(`  ${label.padEnd(30)} (NOT CHECKED)`);
      skipped.push(`solana/${label}`);
      continue;
    }
    if (cls.problem) {
      console.log(`  ${label.padEnd(30)} <-- ${cls.problem}`);
      fail(`solana/${e.id}: ${cls.problem}`);
    } else {
      console.log(`  ${label.padEnd(30)} ${want.bytes} bytes, sha256 ${cls.sha256}, the registered build (last deployed in slot ${cls.slot})`);
    }
  }

  // EVM entries are per-CHAIN, and the chain comes from `rowChains`: the section for
  // `base` (8453) and `robinhood` (4663), the row's `chainId` (number or array; default
  // 1 = mainnet) in `ethereum`. The L2 role Safes are CREATE2 twins that must carry
  // code on BOTH 8453 and 4663, while the Robinhood-only curve launcher names 4663
  // alone. Before chainId, the read sent every ethereum-section address to the MAINNET
  // RPC, so an L2 entry was structurally unverifiable: "expects a CONTRACT; no code" —
  // true on chain 1, a lie about the entry. And until 2026-09-17 it read no `base` or
  // `robinhood` row at all, so their `expect` blocks asserted nothing. Keyed on the
  // entry itself like the Solana devnet exemption above (a property of which chain the
  // entry DESCRIBES), never inferred from prose. A chain with no RPC here is a hard
  // FAIL, not a skip — an unverifiable entry must never read as a verified one.
  const EVM_RPCS = {
    1: ETH_RPC,
    8453: process.env.BASE_RPC || 'https://mainnet.base.org',
    4663: process.env.RH_RPC || 'https://rpc.mainnet.chain.robinhood.com',
  };
  const evmPairs = [];
  for (const p of evmReadPairs(evmEntries)) {
    if (!EVM_RPCS[p.cid]) {
      fail(`${p.e.section}/${p.e.id}: chain ${p.cid} has no RPC in EVM_RPCS — teach the checker that chain or fix the entry`);
      continue;
    }
    evmPairs.push(p);
  }
  // `ethereum` rows print as they always have (bare id; `id@chain` off mainnet). Rows of
  // a chain's own section name the section instead, since their ids repeat per chain.
  const evmLabel = (e, cid) => (e.section !== 'ethereum' ? `${e.section}/${e.id}` : cid === MAINNET ? e.id : `${e.id}@${cid}`);
  const evmRef = (e, cid) => (e.section === 'ethereum' ? `ethereum/${evmLabel(e, cid)}` : evmLabel(e, cid));
  const byChain = new Map();
  for (const p of evmPairs) {
    if (!byChain.has(p.cid)) byChain.set(p.cid, []);
    byChain.get(p.cid).push(p);
  }
  // Per-chain batch ceilings. MEASURED 2026-09-17: mainnet.base.org answers a batch of
  // more than 10 with ONE error object, `-32014 maximum 10 calls in 1 batch`, so once the
  // `base` rows were read (20 Base pairs) every one of them came back NOT CHECKED. That
  // is the honest outcome, but a chain that is always skipped is as inert as a chain
  // that is never read. Other chains keep 50.
  const EVM_BATCH_MAX = { 8453: 10 };
  for (const [cid, pairs] of byChain) {
    for (const group of chunk(pairs, EVM_BATCH_MAX[cid] ?? 50)) {
      const res = await post(
        EVM_RPCS[cid],
        group.map((p, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_getCode', params: [safeAddress(p.e.address), 'latest'] })),
      );
      const cls = res.ok ? classifyEvmBatch(res.json) : unanswered(res.reason);
      if (!cls.answered) {
        warn(`EVM chain ${cid} read SKIPPED for ${group.length} address(es): ${cls.reason}`);
        for (const p of group) { console.log(`  ${evmLabel(p.e, p.cid).padEnd(30)} (NOT CHECKED)`); skipped.push(evmRef(p.e, p.cid)); }
        continue;
      }
      group.forEach((p, i) => {
        const { e, cid: pcid } = p;
        if (!cls.byId.has(i)) {
          console.log(`  ${evmLabel(e, pcid).padEnd(30)} (NOT CHECKED)`);
          skipped.push(evmRef(e, pcid));
          return;
        }
        const code = cls.byId.get(i);
        const hasCode = code !== '0x' && !/^0x0*$/.test(code);
        console.log(`  ${evmLabel(e, pcid).padEnd(30)} ${hasCode ? `contract (${(code.length - 2) / 2} bytes)` : 'EOA / no code'}`);
        // Only what the registry actually states is enforced. Add
        // `"expect": {"type": "contract"|"eoa"}` to an entry and it is checked from
        // that moment on — on EVERY chain the entry names.
        const want = e.expect?.type;
        if (want === 'contract' && !hasCode) fail(`${evmRef(e, pcid)}: registry expects a CONTRACT; the address has no code`);
        if (want === 'eoa' && hasCode) fail(`${evmRef(e, pcid)}: registry expects an EOA; the address HAS code`);
      });
    }
  }

  // Never let "not checked" read as "checked and fine". Printed unconditionally, so a
  // zero is stated rather than inferred from the absence of a warning. The EVM count
  // is (entry, chain) PAIRS — a two-chain Safe is two reads and counts as two.
  console.log(`\n  chain read: ${solEntries.length + programReads.length + evmPairs.length} considered, ${skipped.length} NOT CHECKED (the RPC did not answer)`);
  if (skipped.length) console.log(`    ${skipped.join(', ')}`);

  // Same principle applied to coverage rather than availability: an entry with no
  // `expect` is READ but nothing about it is ASSERTED, and a green line next to it
  // means only that a request succeeded. Count it out loud so the gap stays visible
  // instead of looking like 39 passing checks.
  for (const section of Object.keys(ROW_SECTIONS)) {
    const rows = evmEntries.filter((e) => e.section === section);
    const unasserted = rows.filter((e) => !e.expect?.type).length;
    if (unasserted) {
      console.log(`  ${unasserted} of ${rows.length} ${section} entries declare no expect.type — read, but NOT asserted`);
    }
  }
  const heat = Object.values(reg.heatRegistry ?? {}).filter(Array.isArray).flat().length;
  if (heat) console.log(`  heatRegistry: ${heat} third-party token(s) NOT chain-checked (Base + mainnet; structure only)`);
}

function markdown() {
  // Escape the BACKSLASH first, then the pipe.
  //
  // The original escaped only the pipe, which CodeQL flagged HIGH as incomplete
  // string escaping — correctly. A field containing a backslash would emit a stray
  // escape that swallows the next character, and a literal `\|` already in the text
  // would survive as a live table delimiter, breaking the row.
  //
  // Order is load-bearing: escaping the pipe first would then have ITS OWN backslash
  // escaped by the second pass, turning `\|` into `\\|` — a literal backslash
  // followed by a live delimiter, i.e. the bug it was meant to fix.
  const cell = (v) => String(v ?? '—').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  const rows = (list) =>
    (list ?? [])
      .filter((e) => !isNote(e))
      .map((e) => `| \`${e.address}\` | ${cell(e.id)} | ${cell(e.role)} | ${cell(e.custody)} | ${cell(e.status)} |`)
      .join('\n');
  for (const section of Object.keys(ROW_SECTIONS)) {
    const title = section[0].toUpperCase() + section.slice(1);
    console.log(`## ${title}\n\n| Address | ID | Role | Custody | Status |\n|---|---|---|---|---|\n${rows(reg[section])}\n`);
  }
  const retiredRows = (reg.retiredDeploys?.addresses ?? [])
    .map((e) => `| \`${e.address}\` | ${cell(e.contract)} | ${cell(e.script)} | ${cell(e.note)} |`)
    .join('\n');
  console.log(`## Retired mainnet deploys (DO NOT USE)\n\n| Address | Contract | Deployed by | Note |\n|---|---|---|---|\n${retiredRows}\n`);
}

/**
 * Prove checks 5 and 6 can still FAIL.
 *
 * Both were rewritten because the original could not fail on the thing it existed to
 * catch, and a passing CI step is not evidence that a check works — it is equally
 * consistent with the check being unable to see anything. Each case below forces the
 * failure condition against a synthetic input and asserts the checker produces a
 * failure naming it, with a control that the same shape passes when it should.
 */
function selfTest() {
  const rows = [];
  const t = (name, ok) => rows.push({ name, ok });

  const live = new Set(['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  const retiredSet = new Set(['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
  const scanConstants = (src) => {
    const out = [];
    for (const m of stripComments(src).matchAll(/(?:([A-Za-z0-9_]+)\s*[:=]\s*)?['"](0x[a-fA-F0-9]{40})['"]/g)) {
      const addr = m[2].toLowerCase();
      if (addr === ZERO) continue;
      if (!live.has(addr)) out.push(addr);
    }
    return out;
  };

  // 5a. The exact shape the old regex could not see: an address inside an ARRAY. This
  //     is how two live staking contracts holding user funds went unregistered.
  t(
    'check 5 catches an unregistered address inside an array literal',
    scanConstants("export const L = [\n  '0xcccccccccccccccccccccccccccccccccccccccc',\n] as const;").length === 1,
  );
  // 5b. …and inside an object member, the other shape it missed.
  t(
    'check 5 catches an unregistered address as an object value',
    scanConstants("export const M = { pool: '0xdddddddddddddddddddddddddddddddddddddddd' };").length === 1,
  );
  // 5c. CONTROL: a registered address in the same shapes must NOT fail, or 5a/5b prove
  //     nothing but "this function always returns a hit".
  t(
    'check 5 passes a registered address in those same shapes',
    scanConstants("export const L = ['0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'];\nexport const M = { a: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };").length === 0,
  );
  // 5d. A historical address in a COMMENT is not a live reference. Without this the
  //     only way to green CI would be registering dead contracts as live.
  t(
    'check 5 ignores an address mentioned only in a comment',
    scanConstants("// Prev V1: 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n/* also 0xffffffffffffffffffffffffffffffffffffffff */\nexport const X = 1;").length === 0,
  );
  // 5e. The zero address is a not-yet-deployed placeholder, not a missing entry.
  t('check 5 ignores the zero address', scanConstants(`export const Z = '${ZERO}';`).length === 0);
  // 5f. WHICH FILES the scan opens is the whole of its reach, and the failure mode is
  //     silent: drop a source and every address in it stops being checked while the run
  //     still prints a green line and a healthy-looking total. yield/protocols.ts carries
  //     the addresses /yield sends a visitor's ETH to, so the list is pinned by name here
  //     — the same reasoning as CURVE_REQUIRED_EXPORTS above.
  t(
    'check 5 opens BOTH constants.ts and yield/protocols.ts',
    ['constants.ts', 'yield/protocols.ts'].every((label) => EVM_LITERAL_SOURCES.some((s) => s.label === label)),
  );
  t(
    'every check-5 source names a file that exists',
    EVM_LITERAL_SOURCES.every((s) => existsSync(s.path)),
  );

  // 6a. THE MISSING-ENTRY CASE. A mainnet CREATE that is in neither list must fail.
  //     This is the one the one-directional guard structurally could not produce.
  const classify = (addr) => {
    const a = addr.toLowerCase();
    return live.has(a) || retiredSet.has(a) || denylisted.has(a);
  };
  t('check 6 fails on a mainnet CREATE that is in neither the registry nor retiredDeploys', !classify('0x1111111111111111111111111111111111111111'));
  // 6b/6c. CONTROLS in both directions.
  t('check 6 passes a live registry entry', classify('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
  t('check 6 passes an explicitly retired deploy', classify('0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'));

  // 7. A section note must be skipped, and must not become a way to smuggle an
  //    unvalidated address into the registry.
  t('a $comment row with no address is skipped', isNote({ $comment: 'x' }));
  t('a $comment row WITH an address is still validated', !isNote({ $comment: 'x', address: '0x00' }));

  // 5b. The Solana drift scan. constants.ts is EVM-only, so without this every Solana
  //     protocol address in the frontend is unregistered by construction.
  const scanSolana = (src, registered) => {
    const out = [];
    for (const m of stripComments(src).matchAll(/new PublicKey\(\s*'([1-9A-HJ-NP-Za-km-z]{32,44})'\s*\)/g)) {
      if (SOLANA_WELL_KNOWN.has(m[1])) continue;
      if (!registered.has(m[1])) out.push(m[1]);
    }
    return out;
  };
  const solReg = new Set(['CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED']);
  t(
    'check 5b catches an unregistered Solana program id',
    scanSolana("export const P = new PublicKey('8YVjjc5ibXQRewh7xtUQMTVR9rrBJjBj4kBMLpbr3kV8');", solReg).length === 1,
  );
  t(
    'check 5b passes a registered Solana program id',
    scanSolana("export const P = new PublicKey('CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED');", solReg).length === 0,
  );
  t(
    'check 5b ignores well-known SPL/system ids',
    scanSolana("const A = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');\nconst B = new PublicKey('11111111111111111111111111111111');", solReg).length === 0,
  );
  t(
    'check 5b ignores a Solana address mentioned only in a comment',
    scanSolana("// old: new PublicKey('8YVjjc5ibXQRewh7xtUQMTVR9rrBJjBj4kBMLpbr3kV8')\nexport const X = 1;", solReg).length === 0,
  );

  // 9. THE FLAKE DISTINCTION. This is the whole argument for running the chain read as a
  //    required check: an absent account must fail, and an RPC that did not answer must
  //    NOT. Both directions asserted, because getting either wrong makes the gate
  //    useless — one blind, the other noise.
  t('a null element is a POSITIVE absence, not an unknown', classifySolanaBatch({ result: { value: [null] } }, 1).values[0] === null);
  t('a happy Solana batch is answered', classifySolanaBatch({ jsonrpc: '2.0', result: { value: [null, { lamports: 1 }] } }, 2).answered === true);
  t('an RPC error object is NOT an answer', classifySolanaBatch({ error: { code: 429, message: 'Too many requests' } }, 2).answered === false);
  t('a missing result.value is NOT an answer', classifySolanaBatch({ jsonrpc: '2.0', id: 1 }, 2).answered === false);
  t('a TRUNCATED array is NOT an answer — absence is never inferred from a short body', classifySolanaBatch({ result: { value: [null] } }, 2).answered === false);
  t('an HTML rate-limit page is NOT an answer', classifySolanaBatch('<html>429</html>', 2).answered === false);
  t('a junk element is NOT an answer', classifySolanaBatch({ result: { value: ['nope'] } }, 1).answered === false);
  t('an EVM array batch resolves per id', classifyEvmBatch([{ id: 0, result: '0x60' }]).byId.get(0) === '0x60');
  t('an EVM per-id error leaves that id unknown, never "no code"', classifyEvmBatch([{ id: 0, error: { message: 'limit' } }]).byId.has(0) === false);
  t('an EVM non-hex result leaves that id unknown', classifyEvmBatch([{ id: 0, result: 'oops' }]).byId.has(0) === false);
  t('a non-array EVM body is NOT an answer', classifyEvmBatch({ error: 'x' }).answered === false);

  // 8. The base58 zero case that used to decode to 33 bytes and be rejected as a
  //    fabrication. The System Program is a legal registry entry.
  t('the all-zero Solana pubkey decodes to 32 bytes', base58Decode('11111111111111111111111111111111')?.length === 32);
  // CONTROL: the actual fabricated address from the incident still decodes to 33.
  t('the 2026-08-08 fabricated address still decodes to 33 bytes', base58Decode('5hNA2MXkoHo1Vf1c3ZE7cAsxsB4tCyahLcJnJ5NsD927v')?.length === 33);

  // 9. Check 3b: an `expect.type` outside the accepted set. The failure it guards is
  //    silent by construction — an unknown value matches no branch in the chain read,
  //    asserts nothing, and still reads as "this entry is asserted" to anything that
  //    counts truthy `expect.type`. So the check needs its own proof, plus controls in
  //    both directions, or a later refactor could delete it without a red anywhere.
  const badType = (kind, want) => !EXPECT_TYPES[kind].has(want);
  t('check 3b rejects a MISSPELLED evm expect.type', badType('evm', 'contarct'));
  t('check 3b rejects a plausible-but-unimplemented evm expect.type ("safe")', badType('evm', 'safe'));
  t('check 3b rejects "absent" on an EVM entry — eth_getCode cannot distinguish it from an EOA', badType('evm', 'absent'));
  t('check 3b rejects a Solana type used on an evm entry', badType('evm', 'executable'));
  // CONTROLS: every value the chain read actually implements must pass, or 3b would
  // simply be a check that always fires.
  t('check 3b passes both implemented evm types', !badType('evm', 'contract') && !badType('evm', 'eoa'));
  t(
    'check 3b passes every implemented solana type',
    ['wallet', 'program-owned', 'token-account', 'executable', 'absent'].every((v) => !badType('solana', v)),
  );

  // 10. EVERY SECTION IS READ, and duplicates are per CHAIN. Until 2026-09-17 checks
  //     1-3b and the chain read walked `solana` and `ethereum` by name, so a truncated
  //     address, a non-address, a duplicate, `expect.type: "contarct"` and a deleted
  //     `role` in a `base` row all exited 0. These cases run the REAL checkRows /
  //     checkRoles / checkExpectTypes on a synthetic registry and read back only the
  //     failures that run raised.
  const collect = (fn) => {
    const f0 = failures.length;
    const w0 = warnings.length;
    let value;
    try {
      value = fn();
    } finally {
      warnings.splice(w0);
    }
    return { failed: failures.splice(f0), value };
  };
  // Real cross-chain shapes. A is one deployer's CREATE at the same nonce on three
  // chains: three different contracts. B is a CREATE2 twin, the same code on 1 and 8453.
  const A = '0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3';
  const B = '0xf968e9d314848f19Dc3aB138493e8F62952d655f';
  const C = '0xB021651dACaD5dabf83ef587297E093DfA0c95Ec';
  const row = (id, address, extra = {}) => ({ id, address, role: 'r', status: 's', ...extra });
  const fixture = () => ({
    ethereum: [row('staking-admin', A), row('factory-lib', B)],
    base: [row('router', A), row('factory-lib', B), row('twap', C, { expect: { type: 'contract' } })],
    robinhood: [row('factory', A)],
  });
  const rowFailures = (mutate) => {
    const r = fixture();
    mutate(r);
    return collect(() => {
      const es = checkRows(r);
      checkRoles(es);
      checkExpectTypes(es);
    }).failed;
  };
  const failsWith = (mutate, ...parts) => rowFailures(mutate).some((m) => parts.every((p) => m.includes(p)));

  t(
    'CONTROL: one address on three chains, and a CREATE2 twin on two, are NOT duplicates',
    rowFailures(() => {}).length === 0,
  );
  t('check 1-2 reads base: a TRUNCATED base address fails', failsWith((r) => { r.base[2].address = '0xB021651d…c95Ec'; }, 'base/twap', 'TRUNCATED'));
  t('check 1 reads base: a non-address in a base row fails', failsWith((r) => { r.base[2].address = 'not-an-address'; }, 'base/twap', 'not a valid EVM address'));
  t('check 1-2 reads robinhood: a TRUNCATED robinhood address fails', failsWith((r) => { r.robinhood[0].address = '0x4B134C08…06f3'; }, 'robinhood/factory', 'TRUNCATED'));
  t('check 3 (dup) reads base: two base rows on one address fail', failsWith((r) => { r.base[2].address = A; }, 'duplicate', 'Base (8453)', 'base/twap'));
  t(
    'check 3 (dup) crosses sections on ONE chain: an ethereum row whose chainId names 4663 collides with the robinhood row',
    failsWith((r) => { r.ethereum.push(row('l2-x', A, { chainId: 4663 })); }, 'duplicate', 'Robinhood (4663)', 'ethereum/l2-x'),
  );
  t(
    'check 3 (dup) crosses sections for a chainId ARRAY: [8453, 4663] collides with the base row',
    failsWith((r) => { r.ethereum.push(row('l2-y', C, { chainId: [8453, 4663] })); }, 'duplicate', 'Base (8453)', 'ethereum/l2-y'),
  );
  t('check 3 reads base: a base row with no role fails', failsWith((r) => { delete r.base[2].role; }, 'base/twap: no role'));
  t('check 3 reads robinhood: a robinhood row with no status fails', failsWith((r) => { delete r.robinhood[0].status; }, 'robinhood/factory: no status'));
  t('check 3b reads base: expect.type "contarct" in a base row fails', failsWith((r) => { r.base[2].expect = { type: 'contarct' }; }, 'base/twap', 'contarct'));
  t('check 3b reads robinhood: expect.type "absent" on a robinhood (EVM) row fails', failsWith((r) => { r.robinhood[0].expect = { type: 'absent' }; }, 'robinhood/factory', 'absent'));
  t('a base row whose chainId contradicts its section fails', failsWith((r) => { r.base[0].chainId = 1; }, 'base/router', 'contradicts'));
  t('an ethereum chainId this checker cannot read (8543) fails rather than dodging the duplicate check', failsWith((r) => { r.ethereum[0].chainId = 8543; }, 'ethereum/staking-admin', 'names no chain'));
  t('an EMPTY chainId array fails rather than placing the row on no chain', failsWith((r) => { r.ethereum[0].chainId = []; }, 'ethereum/staking-admin', 'names no chain'));
  t('a section that is not an array fails rather than being skipped', failsWith((r) => { r.base = { router: A }; }, '"base" must be an array'));
  t(
    'EVERY ROW_SECTIONS section is iterated: a truncated address fails in each one',
    Object.keys(ROW_SECTIONS).every((s) =>
      collect(() => checkRows({ [s]: [row('x', 'abc…def')] })).failed.some((m) => m.includes(`${s}/x`) && m.includes('TRUNCATED')),
    ),
  );

  // 0. The closed key set. Naming base and robinhood above fixes those two; this is what
  //    stops the NEXT section from being as blind as they were.
  t(
    'check 0 fails on a top-level section no check reads',
    collect(() => checkTopLevelKeys({ ...fixture(), arbitrum: [row('x', A)] })).failed.some((m) => m.includes('"arbitrum"')),
  );
  t('CONTROL: check 0 passes every key of the real addresses.json', collect(() => checkTopLevelKeys(reg)).failed.length === 0);

  // 11. The chain read routes each row to ITS chain: a base row is read on 8453 and
  //     never on mainnet, where the same address is usually a different contract.
  const pairs = new Set(
    evmReadPairs(collect(() => checkRows(fixture())).value).map((p) => `${p.e.section}/${p.e.id}@${p.cid}`),
  );
  t('the chain read reads a base row on Base (8453)', pairs.has('base/twap@8453'));
  t('the chain read reads a robinhood row on Robinhood (4663)', pairs.has('robinhood/factory@4663'));
  t('the chain read does NOT read a base row on mainnet', !pairs.has('base/twap@1') && !pairs.has('base/router@1'));
  t('CONTROL: an ethereum row with no chainId is still read on mainnet', pairs.has('ethereum/staking-admin@1'));

  // 12. Check 6 per chain. A CREATE is classified only by a row on ITS chain; a mainnet
  //     row (or a retired mainnet deploy) at the same address says nothing about Base.
  const D = '0x1111111111111111111111111111111111111111';
  const onlyMainnetA = { ethereum: [row('staking-admin', A)], base: [row('twap', C)] };
  const known = {
    byChain: registeredByChain(collect(() => checkRows(onlyMainnetA)).value),
    retired: new Set([D]),
    denylisted: new Set(),
  };
  t('check 6: a Base CREATE at an address registered ONLY on mainnet is unclassified', !isClassified(A, 8453, known));
  t('CONTROL: check 6 classifies that address on mainnet', isClassified(A, 1, known));
  t('check 6: a Base CREATE registered in `base` is classified', isClassified(C, 8453, known));
  t('check 6: a `base` row does not classify a mainnet CREATE at the same address', !isClassified(C, 1, known));
  t('check 6: retiredDeploys (mainnet) does not classify a Base CREATE', isClassified(D, 1, known) && !isClassified(D, 8453, known));
  t(
    'check 6 scans every chain in EVM_CHAINS (mainnet, Base AND Robinhood receipts)',
    !existsSync(BROADCAST) || Object.keys(EVM_CHAINS).every((c) => createsScanned.has(Number(c))),
  );

  // 12b. scanBroadcasts end to end on a synthetic broadcast tree, so the directory it
  //      reads for each chain is proven rather than assumed.
  const tmp = mkdtempSync(join(tmpdir(), 'verify-addresses-'));
  try {
    const DEPLOYER = '0x14898258122C0740106391E6e8E4F17F3b6d456E';
    const at = (nonce) => getContractAddress({ from: DEPLOYER, nonce: BigInt(nonce) });
    const create = (nonce, contractAddress = at(nonce)) => ({
      transactionType: 'CREATE',
      contractName: `C${nonce}`,
      contractAddress,
      transaction: { from: DEPLOYER, nonce: `0x${nonce.toString(16)}` },
    });
    const put = (script, cid, file, body) => {
      mkdirSync(join(tmp, script, String(cid)), { recursive: true });
      writeFileSync(join(tmp, script, String(cid), file), JSON.stringify(body));
    };
    put('DeployL2.s.sol', 8453, 'run-latest.json', { timestamp: 1, transactions: [create(7)] });
    put('DeployL2.s.sol', 8453, 'run-2.json', { timestamp: 2, transactions: [create(8)] });
    put('DeployRh.s.sol', 4663, 'run-latest.json', { timestamp: 1, transactions: [create(19)] });
    put('DeployBad.s.sol', 1, 'run-latest.json', { timestamp: 1, transactions: [create(3, A)] });

    const base = collect(() => scanBroadcasts(tmp, 8453)).value.map((c) => c.addr);
    t('check 6 reads broadcast/*/8453/, and the NEWEST receipt there', base.length === 1 && base[0] === at(8).toLowerCase());
    const rh = collect(() => scanBroadcasts(tmp, 4663)).value.map((c) => c.addr);
    t('check 6 reads broadcast/*/4663/', rh.length === 1 && rh[0] === at(19).toLowerCase());
    t(
      'check 6 keys a CREATE by (from, nonce): a receipt whose contractAddress disagrees fails',
      collect(() => scanBroadcasts(tmp, 1)).failed.some((m) => m.includes('DeployBad.s.sol/1') && m.includes('(from, nonce)')),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // 12c. Contracts created INSIDE a transaction. Foundry records them under the parent's
  //      `additionalContracts`, never as a top-level CREATE: a template a factory's
  //      constructor deploys, the pair createPair makes, a Safe from createProxyWithNonce.
  //      Until 2026-09-18 check 6 read only the top level, so five mainnet contracts
  //      (two of them live templates every clone delegates to) passed with no row.
  const nestedTmp = mkdtempSync(join(tmpdir(), 'verify-addresses-nested-'));
  try {
    const DEPLOYER = '0x14898258122C0740106391E6e8E4F17F3b6d456E';
    const FACTORY = getContractAddress({ from: DEPLOYER, nonce: 30n });
    const TEMPLATE = getContractAddress({ from: FACTORY, nonce: 1n });
    const PAIR = getContractAddress({ from: FACTORY, nonce: 2n });
    const SAFE = getContractAddress({ from: FACTORY, nonce: 3n });
    const nested = (transactionType, contractName, address) => ({ transactionType, contractName, address, initCode: '0x' });
    const put = (script, cid, transactions) => {
      mkdirSync(join(nestedTmp, script, String(cid)), { recursive: true });
      writeFileSync(join(nestedTmp, script, String(cid), 'run-latest.json'), JSON.stringify({ timestamp: 1, transactions }));
    };
    put('DeployNested.s.sol', 1, [
      {
        transactionType: 'CREATE',
        contractName: 'Factory',
        contractAddress: FACTORY,
        transaction: { from: DEPLOYER, nonce: '0x1e' },
        additionalContracts: [nested('CREATE', 'Template', TEMPLATE)],
      },
      {
        transactionType: 'CALL',
        contractName: 'Factory',
        function: 'createPair(address,address)',
        contractAddress: FACTORY,
        transaction: { from: DEPLOYER, nonce: '0x1f' },
        additionalContracts: [nested('CREATE2', 'Pair', PAIR)],
      },
    ]);
    put('DeploySafes.s.sol', 8453, [
      {
        transactionType: 'CALL',
        contractName: null,
        function: 'createProxyWithNonce(address,bytes,uint256)',
        transaction: { from: DEPLOYER, nonce: '0x0' },
        additionalContracts: [nested('CREATE2', null, SAFE)],
      },
    ]);
    put('DeployUnreadable.s.sol', 4663, [
      { transactionType: 'CALL', transaction: { from: DEPLOYER, nonce: '0x0' }, additionalContracts: [{ transactionType: 'CREATE', contractName: 'X' }] },
    ]);

    const mainnetNested = collect(() => scanBroadcasts(nestedTmp, 1)).value.map((c) => c.addr);
    const baseNested = collect(() => scanBroadcasts(nestedTmp, 8453)).value.map((c) => c.addr);
    t('check 6 reads a contract a CONSTRUCTOR created (additionalContracts on a CREATE)', mainnetNested.includes(TEMPLATE.toLowerCase()));
    t('check 6 reads a contract a CALL created (createPair -> CREATE2 pair)', mainnetNested.includes(PAIR.toLowerCase()));
    t('check 6 still reads the top-level CREATE beside its nested one', mainnetNested.includes(FACTORY.toLowerCase()));
    t(
      'check 6 reads nested creations PER CHAIN: a Base Safe proxy is scanned on 8453 and not on 1',
      baseNested.includes(SAFE.toLowerCase()) && !mainnetNested.includes(SAFE.toLowerCase()),
    );
    t(
      'a nested creation with no readable address FAILS check 6 rather than being skipped',
      collect(() => scanBroadcasts(nestedTmp, 4663)).failed.some((m) => m.includes('DeployUnreadable.s.sol/4663') && m.includes('additionalContracts')),
    );
  } finally {
    rmSync(nestedTmp, { recursive: true, force: true });
  }

  // 13. Check 3c: WHICH program a data account holds. The chain half is a pure function
  //     of the RPC's answer, so every outcome is made here with made-up bytes. The case
  //     that matters most is the fourth: after an enlarge alone the account is large
  //     enough and its "last deployed" slot is new, and it must STILL be refused, because
  //     the old program is what runs.
  const newBuild = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) % 251));
  const oldBuild = newBuild.subarray(0, 3000);
  const want = { bytes: newBuild.length, sha256: createHash('sha256').update(newBuild).digest('hex') };
  const header = (slot, tag = PROGRAMDATA_TAG) => {
    const h = Buffer.alloc(PROGRAMDATA_HEADER);
    h.writeUInt32LE(tag, 0);
    h.writeBigUInt64LE(BigInt(slot), 4);
    h[12] = 1;
    return h;
  };
  // `wire` is the slice the RPC sends back; `space` is the size it states for the whole account.
  const info = (wire, space = wire.length, extra = {}) => ({
    jsonrpc: '2.0',
    result: { context: { slot: 1 }, value: { owner: UPGRADEABLE_LOADER, lamports: 1, executable: false, space, data: [wire.toString('base64'), 'base64'], ...extra } },
  });
  const held = (json) => classifyProgramData(json, want);
  const refuses = (json, ...parts) => {
    const r = held(json);
    return r.answered === true && typeof r.problem === 'string' && parts.every((p) => r.problem.includes(p));
  };
  const upgraded = held(info(Buffer.concat([header(700), newBuild])));
  t('check 3c accepts a data account that holds the registered build', upgraded.answered === true && upgraded.problem === null && upgraded.sha256 === want.sha256 && upgraded.slot === 700n);
  t(
    'check 3c accepts the registered build with spare room after it (someone enlarged further)',
    held(info(Buffer.concat([header(700), newBuild]), PROGRAMDATA_HEADER + newBuild.length + 10_240)).problem === null,
  );
  t(
    'check 3c REFUSES an account too small for the build: the program before the upgrade, never enlarged',
    refuses(info(Buffer.concat([header(100), oldBuild])), 'too few', 'does NOT run that build', 'slot 100'),
  );
  t(
    'check 3c REFUSES after an enlarge alone: large enough, a NEW last-deployed slot, and still the old program',
    refuses(info(Buffer.concat([header(650), oldBuild, Buffer.alloc(newBuild.length - oldBuild.length)])), 'hash to', 'does NOT run that build', 'slot 650'),
  );
  const oneByteOff = Buffer.from(newBuild);
  oneByteOff[2000] ^= 1;
  t('check 3c REFUSES the build with one byte changed', refuses(info(Buffer.concat([header(700), oneByteOff])), 'hash to'));
  t(
    'check 3c REFUSES an account the upgradeable loader does not own',
    refuses(info(Buffer.concat([header(700), newBuild]), undefined, { owner: '11111111111111111111111111111111' }), 'owner is 11111111111111111111111111111111'),
  );
  t('check 3c REFUSES a loader account that is not ProgramData (an upload buffer)', refuses(info(Buffer.concat([header(700, 1), newBuild])), 'not a program data account'));
  t('check 3c: a missing account is a definite refusal', refuses({ result: { value: null } }, 'DOES NOT EXIST'));
  t('check 3c: an RPC error is NOT an answer', held({ error: { code: 429, message: 'Too many requests' } }).answered === false);
  t('check 3c: a body with no result.value is NOT an answer', held({ jsonrpc: '2.0', id: 1 }).answered === false);
  t(
    'check 3c: a SHORT body is NOT an answer, and never "the program is too small"',
    held(info(Buffer.concat([header(700), newBuild]).subarray(0, 2000), PROGRAMDATA_HEADER + newBuild.length)).answered === false,
  );
  t(
    'check 3c: data in another encoding is NOT an answer',
    held({ result: { value: { owner: UPGRADEABLE_LOADER, space: 10, data: ['3Mc6vR', 'base58'] } } }).answered === false,
  );
  t('check 3c (batched read): an account smaller than header + program fails without the big read', (holdsProgramSpaceProblem({ space: PROGRAMDATA_HEADER + oldBuild.length }, want) ?? '').includes('too small'));
  t(
    'CONTROL: check 3c (batched read) passes an account of exactly header + program, a larger one, and one whose size was not stated',
    [{ space: PROGRAMDATA_HEADER + want.bytes }, { space: PROGRAMDATA_HEADER + want.bytes + 10_240 }, { lamports: 1 }].every((v) => holdsProgramSpaceProblem(v, want) === null),
  );

  // 13b. The offline half of 3c, on a synthetic registry through the REAL checkRows and
  //      checkExpectKeys: a claim about a program that the chain read could not check.
  const PD = 'F475omgJMd5mnDXJFyjHTkg9zs7WSb6ek9dFoUmUvi5V';
  const WALLET = 'Upmhw8i6RSLXoj4yGzq9ZYLXb4UzZMRm7BSX8BxCdEd';
  const solFixture = () => ({
    solana: [
      row('pool-program-data', PD, { expect: { type: 'program-owned', holdsProgram: { ...want } } }),
      row('some-wallet', WALLET, { expect: { type: 'wallet', funded: true } }),
    ],
    ethereum: [row('staking-admin', A, { expect: { type: 'contract' } })],
  });
  const keyFailures = (mutate) => {
    const r = solFixture();
    mutate(r);
    return collect(() => checkExpectKeys(checkRows(r))).failed;
  };
  const keyFailsWith = (mutate, ...parts) => keyFailures(mutate).some((m) => parts.every((p) => m.includes(p)));
  t('CONTROL: check 3c passes type, funded and a well-formed holdsProgram', keyFailures(() => {}).length === 0);
  t(
    'check 3c rejects a MISSPELLED expect key, which the chain read would never look at',
    keyFailsWith((r) => { r.solana[0].expect = { type: 'program-owned', holdsProgam: { ...want } }; }, 'solana/pool-program-data', 'expect.holdsProgam'),
  );
  t('check 3c rejects holdsProgram on a row that is not a data account', keyFailsWith((r) => { r.solana[0].expect.type = 'executable'; }, 'solana/pool-program-data', 'DATA account'));
  t('check 3c rejects a SHORTENED sha256', keyFailsWith((r) => { r.solana[0].expect.holdsProgram.sha256 = '99a9e73d…'; }, 'solana/pool-program-data', '64 lowercase hex'));
  t('check 3c rejects a size written as text', keyFailsWith((r) => { r.solana[0].expect.holdsProgram.bytes = '724,688'; }, 'solana/pool-program-data', 'whole number of bytes'));
  t('check 3c rejects a holdsProgram with no hash at all', keyFailsWith((r) => { delete r.solana[0].expect.holdsProgram.sha256; }, 'solana/pool-program-data', '64 lowercase hex'));
  t(
    'check 3c rejects an inner key nothing reads (a slot is not evidence of which build runs)',
    keyFailsWith((r) => { r.solana[0].expect.holdsProgram.deployedAfterSlot = 451_687_458; }, 'solana/pool-program-data', 'deployedAfterSlot'),
  );
  t('check 3c rejects holdsProgram on an EVM row', keyFailsWith((r) => { r.ethereum[0].expect.holdsProgram = { ...want }; }, 'ethereum/staking-admin', 'expect.holdsProgram'));
  t('check 3c rejects an expect that is not an object', keyFailsWith((r) => { r.solana[1].expect = 'wallet'; }, 'solana/some-wallet', 'must be an object'));
  t('CONTROL: check 3c passes every expect block of the real addresses.json', collect(() => checkExpectKeys(allEntries)).failed.length === 0);
  // 13c. The check is ARMED on the real registry: the pool program's data account says
  //      which build it holds, and it is the build the program's own row names in prose.
  //      Taking the expectation off that row would turn the chain read back into the
  //      type-only check that was green before the program had been upgraded at all.
  const poolData = allEntries.find((e) => e.section === 'solana' && e.id === 'cp-swap-programdata-restart');
  const poolProgram = allEntries.find((e) => e.section === 'solana' && e.id === 'cp-swap-program-restart');
  const armed = poolData?.expect?.holdsProgram;
  t('the real registry says WHICH build the pool program data account holds', /^[0-9a-f]{64}$/.test(armed?.sha256 ?? '') && Number.isInteger(armed?.bytes));
  t(
    'and that is the build the pool program row names in its status, hash and size',
    !!armed && (poolProgram?.status ?? '').includes(`expected bytecode sha256 ${armed.sha256}, ${armed.bytes.toLocaleString('en-US')} bytes`),
  );

  for (const r of rows) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  const bad = rows.filter((r) => !r.ok);
  if (bad.length) {
    console.error(`\n${bad.length} self-test FAILURE(S) — the drift guard cannot be trusted:`);
    for (const b of bad) console.error(`  x ${b.name}`);
    return false;
  }
  console.log(`\n${rows.length} self-test checks passed`);
  return true;
}

// ── Report ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--markdown')) { markdown(); process.exit(0); }
if (args.includes('--self-test')) { process.exit(selfTest() ? 0 : 1); }

console.log(
  `address registry: ` +
    Object.keys(ROW_SECTIONS)
      .map((s) => `${allEntries.filter((e) => e.section === s).length} ${s[0].toUpperCase()}${s.slice(1)}`)
      .join(', ') +
    `, ${(reg.retiredDeploys?.addresses ?? []).length} retired, ${(reg.denylist ?? []).length} denylisted`,
);
console.log(
  `  drift: ${[...literalsChecked].map(([label, n]) => `${n} ${label}`).join(' + ')} EVM literals -> registry, ` +
    `${solanaLiteralsChecked} curve/program.ts Solana literals -> registry, ` +
    `${[...createsScanned]
      .map(([cid, n]) => `${n} ${EVM_CHAINS[cid]}${nestedScanned.get(cid) ? ` (${nestedScanned.get(cid)} nested)` : ''}`)
      .join(' + ')} CREATEs from broadcast receipts -> registry`,
);
// An L2 with registry rows and no receipts is not a failure (the receipts may never
// have been committed), but it is a chain check 6 cannot see, and it says so every run.
for (const [cid, n] of createsScanned) {
  const rows = registeredOnChain.get(cid)?.size ?? 0;
  if (cid === MAINNET || n > 0 || rows === 0) continue;
  warn(
    `check 6 read ZERO ${EVM_CHAINS[cid]} CREATEs from contracts/broadcast/*/${cid}/ while ` +
      `the registry lists ${rows} ${EVM_CHAINS[cid]} address(es), so nothing here can notice an ` +
      `unregistered ${EVM_CHAINS[cid]} deploy`,
  );
}
// A count of zero on any side means the check found nothing to look at, which is
// not the same as finding nothing wrong. Say so rather than print "all checks passed".
// Per SOURCE, not summed: a total stays comfortably non-zero while one file of the two
// has silently stopped being read, which is the failure this whole change is about.
for (const [label, n] of literalsChecked) {
  if (n === 0) fail(`check 5 scanned ZERO address literals in ${label} — the scan is broken or the file moved, not the file clean`);
}
if (solanaLiteralsChecked === 0) fail('check 5b scanned ZERO Solana literals in curve/program.ts — the scan is broken, or the module moved; it did not "find nothing wrong"');
if (broadcastsChecked === 0) fail('check 6 scanned ZERO mainnet CREATEs — the broadcast scan is broken or the receipts are gone; it did not "find nothing wrong"');

// `--onchain` stays opt-in ON PURPOSE, and it is not the old hole.
//
// The old hole was that NOTHING passed the flag. That is fixed outside this file, by
// .github/workflows/registry-onchain.yml, which passes it daily, on demand, and on any
// change to the registry or the constants it mirrors — then asserts the chain section
// actually appeared, so a script that quietly stops reading cannot pass as "no
// disagreements found".
//
// Making the read default-on would fight that design rather than reinforce it: every
// unrelated PR would take a network dependency it has no reason to take, and the
// workflow's own offline structure step would read the chain twice. The scoping belongs
// in the trigger, not in the script.
if (args.includes('--onchain')) await onchain();

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):`);
  for (const f of failures) console.error(`  x ${f}`);
  process.exit(1);
}
console.log('\nall checks passed');
