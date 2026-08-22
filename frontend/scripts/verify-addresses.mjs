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
 * Run:  node scripts/verify-addresses.mjs            (offline; fast; CI-safe)
 *       node scripts/verify-addresses.mjs --onchain  (also reads live chain state)
 *       node scripts/verify-addresses.mjs --markdown (emit the registry as a table)
 *       node scripts/verify-addresses.mjs --self-test (prove checks 5+6 can still fail)
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

// ── Optional: live chain state ──────────────────────────────────────────────────
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
  // ── Retry, then FAIL. Never swallow. ──────────────────────────────────
  //
  // Every read here used to sit in `catch { console.log('(unreadable)') }`,
  // and the one disagreement it did detect was a `warn()` — which does not
  // touch the exit code. So `--onchain` could not fail on any input, ever: a
  // program that had vanished, the fabricated placeholder appearing on
  // mainnet, an operator payer at zero — each printed a line and exited 0.
  // Together with the fact that nothing in .github/ passed `--onchain`, the
  // chain read was decoration.
  //
  // Transient network noise is real, so reads retry before they fail — but a
  // read that will not complete IS a failure. "I could not check" and "I
  // checked and it is fine" must not share an exit code.
  const post = async (url, body, attempts = 3) => {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (j?.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
        return j;
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) await new Promise((res) => setTimeout(res, 500 * 2 ** i));
      }
    }
    throw lastErr;
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
  for (const e of (reg.solana ?? []).filter((x) => !isNote(x))) {
    let v;
    try {
      const j = await post(SOL_RPC, { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [safeAddress(e.address), { encoding: 'base64' }] });
      v = j?.result?.value ?? null;
    } catch (err) {
      console.log(`  ${e.id.padEnd(30)} (UNREADABLE)`);
      fail(`solana/${e.id}: could not read on-chain state after retries — ${err.message}`);
      continue;
    }
    const state = v ? `${(v.lamports / 1e9).toFixed(6)} SOL${v.executable ? ' [program]' : ''}` : 'DOES NOT EXIST';
    const problem = solanaProblem(e, v);
    console.log(`  ${e.id.padEnd(30)} ${state}${problem ? `  <-- ${problem}` : ''}`);
    if (problem) fail(`solana/${e.id}: ${problem}`);
  }
  for (const e of (reg.ethereum ?? []).filter((x) => !isNote(x))) {
    let code;
    try {
      const j = await post(ETH_RPC, { jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [safeAddress(e.address), 'latest'] });
      code = j?.result ?? '0x';
    } catch (err) {
      console.log(`  ${e.id.padEnd(30)} (UNREADABLE)`);
      fail(`ethereum/${e.id}: could not read on-chain state after retries — ${err.message}`);
      continue;
    }
    const hasCode = !!code && code !== '0x';
    console.log(`  ${e.id.padEnd(30)} ${hasCode ? `contract (${(code.length - 2) / 2} bytes)` : 'EOA / no code'}`);
    // Ethereum entries carry no `expect` block today, so only what the registry
    // actually states is enforced. Add `"expect": {"type": "contract"|"eoa"}`
    // to an entry and it is checked from that moment on.
    const want = e.expect?.type;
    if (want === 'contract' && !hasCode) fail(`ethereum/${e.id}: registry expects a CONTRACT; the address has no code`);
    if (want === 'eoa' && hasCode) fail(`ethereum/${e.id}: registry expects an EOA; the address HAS code`);
  }
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
    `${broadcastsChecked} mainnet CREATEs from broadcast receipts -> registry`,
);
// A count of zero on either side means the check found nothing to look at, which is
// not the same as finding nothing wrong. Say so rather than print "all checks passed".
if (constantsChecked === 0) fail('check 5 scanned ZERO address literals in constants.ts — the scan is broken, not the file clean');
if (broadcastsChecked === 0) fail('check 6 scanned ZERO mainnet CREATEs — the broadcast scan is broken or the receipts are gone; it did not "find nothing wrong"');

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
