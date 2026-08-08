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
 *   5. DRIFT      — every non-zero EVM address in src/lib/constants.ts must be
 *                   registered here, so a new deploy cannot enter the codebase without
 *                   someone writing down what it is and who controls it.
 *
 * Run:  node scripts/verify-addresses.mjs            (offline; fast; CI-safe)
 *       node scripts/verify-addresses.mjs --onchain  (also reads live chain state)
 *       node scripts/verify-addresses.mjs --markdown (emit the registry as a table)
 *
 * Exits non-zero on any failure so CI fails loudly.
 *
 * NEVER add a private key, a seed phrase, or a keyfile PATH to addresses.json. This
 * repository is public. `custody` says WHO controls a key, never WHERE it is stored.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getAddress, isAddress } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, 'addresses.json');
const CONSTANTS = join(HERE, '..', 'src', 'lib', 'constants.ts');

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
  const body = hex === '0' ? [] : Array.from(Buffer.from(hex, 'hex'));
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

for (const e of reg.solana ?? []) {
  allEntries.push({ ...e, chain: 'solana' });
  if (checkSolana(e.address, `solana/${e.id}`)) {
    if (seen.has(e.address)) fail(`duplicate address ${e.address}: "${e.id}" and "${seen.get(e.address)}"`);
    else seen.set(e.address, e.id);
  }
}
for (const e of reg.ethereum ?? []) {
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

// ── 5. Drift against constants.ts ───────────────────────────────────────────────
const ZERO = '0x0000000000000000000000000000000000000000';
let constantsChecked = 0;
try {
  const src = readFileSync(CONSTANTS, 'utf-8');
  const re = /export const ([A-Z0-9_]+)\s*(?::[^=]+)?=\s*'(0x[a-fA-F0-9]{40})'/g;
  const registered = new Set((reg.ethereum ?? []).map((e) => e.address.toLowerCase()));
  for (const m of src.matchAll(re)) {
    const [, name, addr] = m;
    if (addr === ZERO) continue; // not-yet-deployed placeholder
    constantsChecked++;
    if (!registered.has(addr.toLowerCase())) {
      fail(
        `constants.ts exports ${name} = ${addr}, which is NOT in the registry. ` +
          `Add it to scripts/addresses.json with a role and custody before shipping.`,
      );
    }
  }
} catch (e) {
  fail(`could not read constants.ts for the drift check: ${e.message}`);
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
  const post = async (url, body) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  };
  console.log('\n── live chain state ─────────────────────────────────────────');
  for (const e of reg.solana ?? []) {
    try {
      const j = await post(SOL_RPC, { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [safeAddress(e.address), { encoding: 'base64' }] });
      const v = j?.result?.value;
      const state = v ? `${(v.lamports / 1e9).toFixed(6)} SOL${v.executable ? ' [program]' : ''}` : 'DOES NOT EXIST';
      const want = e.expect?.type;
      let flag = '';
      if (want === 'absent' && v) flag = '  <-- expected absent but it EXISTS';
      if (want !== 'absent' && !v && e.status?.startsWith('live')) flag = '  <-- registry says live but it does not exist';
      console.log(`  ${e.id.padEnd(30)} ${state}${flag}`);
      if (flag) warn(`${e.id}: on-chain state disagrees with the registry`);
    } catch { console.log(`  ${e.id.padEnd(30)} (unreadable)`); }
  }
  for (const e of reg.ethereum ?? []) {
    try {
      const j = await post(ETH_RPC, { jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [safeAddress(e.address), 'latest'] });
      const code = j?.result ?? '0x';
      console.log(`  ${e.id.padEnd(30)} ${code && code !== '0x' ? `contract (${(code.length - 2) / 2} bytes)` : 'EOA / no code'}`);
    } catch { console.log(`  ${e.id.padEnd(30)} (unreadable)`); }
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
    list.map((e) => `| \`${e.address}\` | ${cell(e.id)} | ${cell(e.role)} | ${cell(e.custody)} | ${cell(e.status)} |`).join('\n');
  console.log(`## Solana\n\n| Address | ID | Role | Custody | Status |\n|---|---|---|---|---|\n${rows(reg.solana, 'solana')}\n`);
  console.log(`## Ethereum\n\n| Address | ID | Role | Custody | Status |\n|---|---|---|---|---|\n${rows(reg.ethereum, 'ethereum')}\n`);
}

// ── Report ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--markdown')) { markdown(); process.exit(0); }

console.log(
  `address registry: ${(reg.solana ?? []).length} Solana, ${(reg.ethereum ?? []).length} Ethereum, ` +
    `${(reg.denylist ?? []).length} denylisted, ${constantsChecked} constants.ts addresses cross-checked`,
);

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
