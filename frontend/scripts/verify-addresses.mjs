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
 *   1. STRUCTURE  — every address decodes. EVM to 20 bytes with a valid EIP-55
 *                   checksum; Solana base58 to exactly 32 bytes. This is the check that
 *                   would have caught the fabrication.
 *   2. NO TRUNCATION — any '…' or '...' anywhere in the registry is a hard failure.
 *                   Truncation is what started the whole incident.
 *   3. NO DUPLICATES — the same address under two ids means two people think they own
 *                   different things.
 *   4. DENYLIST   — the fabricated address and the burned keypair can never be
 *                   reintroduced, even by an honest copy-paste.
 *   5. DRIFT (code → registry)
 *                 — every non-zero EVM address LITERAL in src/lib/constants.ts must be
 *                   registered here, so a new deploy cannot enter the codebase without
 *                   someone writing down what it is and who controls it.
 *   6. DRIFT (chain → registry)
 *                 — every contract this repo has actually CREATED on mainnet, read out
 *                   of the Foundry broadcast receipts, must be a live entry, denylisted,
 *                   or explicitly retired in `retiredDeploys`.
 *
 * WHY 6 EXISTS — the guard used to be one-directional and could not fail on a missing
 * entry. Check 5 walks constants.ts and asks the registry about each address it finds
 * there, so its reach is exactly "addresses the frontend already imports, written in one
 * particular syntax". Two whole classes of live contract were invisible to it:
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
 * Run:  node scripts/verify-addresses.mjs             (offline; fast; CI-safe)
 *       node scripts/verify-addresses.mjs --onchain   (also reads live chain state)
 *       node scripts/verify-addresses.mjs --markdown  (emit the registry as a table)
 *       node scripts/verify-addresses.mjs --self-test (prove 5, 5b, 6 and 7 can still fail)
 *
 * Exits non-zero on any failure so CI fails loudly.
 *
 * NEVER add a private key, a seed phrase, or a keyfile PATH to addresses.json. This
 * repository is public. `custody` says WHO controls a key, never WHERE it is stored.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getAddress, isAddress } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, 'addresses.json');
const CONSTANTS = join(HERE, '..', 'src', 'lib', 'constants.ts');
const CURVE_PROGRAM = join(HERE, '..', 'src', 'lib', 'launcher', 'solana', 'curve', 'program.ts');
const BROADCAST = join(HERE, '..', '..', 'contracts', 'broadcast');
/** Ethereum mainnet. Foundry files broadcasts under broadcast/<script>/<chainId>/. */
const MAINNET_CHAIN_DIR = '1';

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

// ── 1 + 2. Structure and truncation ─────────────────────────────────────────────
const seen = new Map();
const allEntries = [];

// A section note — `{ "$comment": "…" }` with no address — is a legal row in either
// list. It carries no address and must be skipped rather than validated, or the
// registry cannot explain itself inline. It must NOT be able to smuggle an entry
// through: anything with an `address` is validated no matter what else it holds.
const isNote = (e) => e && e.$comment !== undefined && e.address === undefined;

for (const e of reg.solana ?? []) {
  if (isNote(e)) continue;
  allEntries.push({ ...e, chain: 'solana' });
  if (checkSolana(e.address, `solana/${e.id}`)) {
    if (seen.has(e.address)) fail(`duplicate address ${e.address}: "${e.id}" and "${seen.get(e.address)}"`);
    else seen.set(e.address, e.id);
  }
}
for (const e of reg.ethereum ?? []) {
  if (isNote(e)) continue;
  allEntries.push({ ...e, chain: 'ethereum' });
  if (checkEvm(e.address, `ethereum/${e.id}`)) {
    const k = e.address.toLowerCase();
    if (seen.has(k)) fail(`duplicate address ${e.address}: "${e.id}" and "${seen.get(k)}"`);
    else seen.set(k, e.id);
  }
}
for (const [chain, toks] of Object.entries(reg.heatRegistry ?? {})) {
  if (!Array.isArray(toks)) continue;
  for (const t of toks) checkEvm(getAddress(t.address), `heatRegistry/${chain}/${t.symbol}`);
}

// ── 3. Every entry must actually say what it is and who holds it ────────────────
for (const e of allEntries) {
  if (!e.id) fail(`an entry has no id: ${JSON.stringify(e).slice(0, 80)}`);
  if (!e.role) fail(`${e.chain}/${e.id}: no role — an unexplained address is how this incident started`);
  if (!e.status) fail(`${e.chain}/${e.id}: no status`);
}

// ── 4. Denylist ─────────────────────────────────────────────────────────────────
for (const d of reg.denylist ?? []) {
  if (!d.reason) fail(`denylist entry ${d.address} has no reason`);
  // A denylisted address may be structurally invalid — that is often WHY it is
  // denylisted — so validation is opt-out here, but it must never appear as a live entry.
  const live = allEntries.find(
    (e) => e.address === d.address || e.address?.toLowerCase?.() === d.address.toLowerCase(),
  );
  if (live) fail(`DENYLISTED address ${d.address} is present as live entry "${live.id}" — ${d.reason}`);
  if (!d.skipValidation && d.chain === 'solana') {
    const b = base58Decode(d.address);
    if (b && b.length === 32) {
      // fine — a real address that we simply refuse to use
    }
  }
}

// ── The two drift directions ────────────────────────────────────────────────────
const ZERO = '0x0000000000000000000000000000000000000000';

/** Every EVM address registered as LIVE, lowercased. */
const registeredLive = new Set(
  (reg.ethereum ?? []).filter((e) => e.address).map((e) => e.address.toLowerCase()),
);
/** Deliberately retired, plus denylisted. Known-about, but never a live reference. */
const retired = new Set(
  (reg.retiredDeploys?.addresses ?? []).map((e) => e.address.toLowerCase()),
);
const denylisted = new Set((reg.denylist ?? []).map((d) => String(d.address).toLowerCase()));

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
let constantsChecked = 0;
try {
  const src = stripComments(readFileSync(CONSTANTS, 'utf-8'));
  // Capture a little leading context so the failure names something a human can find.
  const re = /(?:([A-Za-z0-9_]+)\s*[:=]\s*)?['"](0x[a-fA-F0-9]{40})['"]/g;
  for (const m of src.matchAll(re)) {
    const [, name, addr] = m;
    if (addr.toLowerCase() === ZERO) continue; // not-yet-deployed placeholder
    constantsChecked++;
    if (!registeredLive.has(addr.toLowerCase())) {
      const where = name ? `${name} = ${addr}` : `${addr} (inside an array or literal)`;
      fail(
        `constants.ts references ${where}, which is NOT in the registry. ` +
          `Add it to scripts/addresses.json with a role and custody before shipping.`,
      );
    }
  }
} catch (e) {
  fail(`could not read constants.ts for the drift check: ${e.message}`);
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
// broadcast/<script>/1/run-latest.json is the address the transaction actually
// produced, written by the tool that produced it. Nobody transcribes it, so it cannot
// carry a typo, and it appears the moment a deploy happens.
//
// `dry-run/` is deliberately excluded: those are simulated addresses that were never
// created on mainnet, and demanding registry entries for them would flood the registry
// with fiction.
let broadcastsChecked = 0;
const unclassified = new Map();
try {
  if (!existsSync(BROADCAST)) {
    warn(`no contracts/broadcast directory at ${BROADCAST} — check 6 (chain → registry) did NOT run`);
  } else {
    for (const script of readdirSync(BROADCAST)) {
      const runLatest = join(BROADCAST, script, MAINNET_CHAIN_DIR, 'run-latest.json');
      if (!existsSync(runLatest)) continue;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(runLatest, 'utf-8'));
      } catch (e) {
        fail(`${script}/1/run-latest.json is unreadable (${e.message}) — a broadcast receipt that cannot be parsed is an UNCHECKED deploy, not an absent one`);
        continue;
      }
      for (const tx of parsed.transactions ?? []) {
        if (tx.transactionType !== 'CREATE' && tx.transactionType !== 'CREATE2') continue;
        if (!tx.contractAddress) continue;
        const addr = tx.contractAddress.toLowerCase();
        broadcastsChecked++;
        if (registeredLive.has(addr) || retired.has(addr) || denylisted.has(addr)) continue;
        if (!unclassified.has(addr)) {
          unclassified.set(addr, { name: tx.contractName ?? '(unnamed)', script });
        }
      }
    }
    for (const [addr, { name, script }] of unclassified) {
      fail(
        `${script} created ${name} at ${getAddress(addr)} on mainnet, and it is in NEITHER the ` +
          `registry NOR retiredDeploys. Every contract this repo has put on mainnet must be ` +
          `classified: add it to "ethereum" with a role and custody if it is live, or to ` +
          `"retiredDeploys" if it is abandoned.`,
      );
    }
  }
} catch (e) {
  fail(`could not scan contracts/broadcast for the reverse drift check: ${e.message}`);
}

// A retired entry that no longer corresponds to any receipt is stale bookkeeping: it
// silently widens the allow-set for check 6 forever. Warn rather than fail — a receipt
// can legitimately be pruned from the repo — but never let it pass unmentioned.
if (broadcastsChecked > 0) {
  const deployed = new Set();
  for (const script of existsSync(BROADCAST) ? readdirSync(BROADCAST) : []) {
    const runLatest = join(BROADCAST, script, MAINNET_CHAIN_DIR, 'run-latest.json');
    if (!existsSync(runLatest)) continue;
    try {
      for (const tx of JSON.parse(readFileSync(runLatest, 'utf-8')).transactions ?? []) {
        if (tx.contractAddress) deployed.add(tx.contractAddress.toLowerCase());
      }
    } catch { /* already reported as a failure above */ }
  }
  for (const e of reg.retiredDeploys?.addresses ?? []) {
    if (!checkEvm(e.address, `retiredDeploys/${e.contract ?? e.address}`)) continue;
    if (registeredLive.has(e.address.toLowerCase())) {
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
  const postOnce = async (url, body) => {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
      return { ok: true, json: await r.json() };
    } catch (err) {
      return { ok: false, reason: err?.name === 'TimeoutError' ? `timed out after ${RPC_TIMEOUT_MS}ms` : err?.message || 'request failed' };
    }
  };
  const post = async (url, body) => {
    const first = await postOnce(url, body);
    if (first.ok) return first;
    await new Promise((res) => setTimeout(res, 900));
    const second = await postOnce(url, body);
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
    return null;
  };

  console.log('\n── live chain state ─────────────────────────────────────────');
  const skipped = [];
  const solEntries = (reg.solana ?? []).filter((x) => !isNote(x));
  const ethEntries = (reg.ethereum ?? []).filter((x) => !isNote(x));

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
    });
  }

  for (const group of chunk(ethEntries, 50)) {
    const res = await post(
      ETH_RPC,
      group.map((e, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_getCode', params: [safeAddress(e.address), 'latest'] })),
    );
    const cls = res.ok ? classifyEvmBatch(res.json) : unanswered(res.reason);
    if (!cls.answered) {
      warn(`Ethereum chain read SKIPPED for ${group.length} address(es): ${cls.reason}`);
      for (const e of group) { console.log(`  ${e.id.padEnd(30)} (NOT CHECKED)`); skipped.push(`ethereum/${e.id}`); }
      continue;
    }
    group.forEach((e, i) => {
      if (!cls.byId.has(i)) {
        console.log(`  ${e.id.padEnd(30)} (NOT CHECKED)`);
        skipped.push(`ethereum/${e.id}`);
        return;
      }
      const code = cls.byId.get(i);
      const hasCode = code !== '0x' && !/^0x0*$/.test(code);
      console.log(`  ${e.id.padEnd(30)} ${hasCode ? `contract (${(code.length - 2) / 2} bytes)` : 'EOA / no code'}`);
      // Ethereum entries carry no `expect` block today, so only what the registry
      // actually states is enforced. Add `"expect": {"type": "contract"|"eoa"}`
      // to an entry and it is checked from that moment on.
      const want = e.expect?.type;
      if (want === 'contract' && !hasCode) fail(`ethereum/${e.id}: registry expects a CONTRACT; the address has no code`);
      if (want === 'eoa' && hasCode) fail(`ethereum/${e.id}: registry expects an EOA; the address HAS code`);
    });
  }

  // Never let "not checked" read as "checked and fine". Printed unconditionally, so a
  // zero is stated rather than inferred from the absence of a warning.
  console.log(`\n  chain read: ${solEntries.length + ethEntries.length} considered, ${skipped.length} NOT CHECKED (the RPC did not answer)`);
  if (skipped.length) console.log(`    ${skipped.join(', ')}`);

  // Same principle applied to coverage rather than availability: an entry with no
  // `expect` is READ but nothing about it is ASSERTED, and a green line next to it
  // means only that a request succeeded. Count it out loud so the gap stays visible
  // instead of looking like 39 passing checks.
  const unasserted = ethEntries.filter((e) => !e.expect?.type).length;
  if (unasserted) {
    console.log(`  ${unasserted} of ${ethEntries.length} Ethereum entries declare no expect.type — read, but NOT asserted`);
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
  console.log(`## Solana\n\n| Address | ID | Role | Custody | Status |\n|---|---|---|---|---|\n${rows(reg.solana)}\n`);
  console.log(`## Ethereum\n\n| Address | ID | Role | Custody | Status |\n|---|---|---|---|---|\n${rows(reg.ethereum)}\n`);
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
  `address registry: ${(reg.solana ?? []).filter((e) => !isNote(e)).length} Solana, ` +
    `${(reg.ethereum ?? []).filter((e) => !isNote(e)).length} Ethereum, ` +
    `${(reg.retiredDeploys?.addresses ?? []).length} retired, ${(reg.denylist ?? []).length} denylisted`,
);
console.log(
  `  drift: ${constantsChecked} constants.ts literals -> registry, ` +
    `${solanaLiteralsChecked} curve/program.ts Solana literals -> registry, ` +
    `${broadcastsChecked} mainnet CREATEs from broadcast receipts -> registry`,
);
// A count of zero on either side means the check found nothing to look at, which is
// not the same as finding nothing wrong. Say so rather than print "all checks passed".
if (constantsChecked === 0) fail('check 5 scanned ZERO address literals in constants.ts — the scan is broken, not the file clean');
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
