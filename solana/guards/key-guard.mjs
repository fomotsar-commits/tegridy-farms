#!/usr/bin/env node
// No outside key in our copies of the two pool programs (cp-swap and tegridy-clmm).
//
// Every base58 string that decodes to 32 bytes is a key. Each key found in OUR copies must be
// on allowed-keys.json, and none may be a key the pinned upstream hard-codes (the deny-list,
// read from the upstream clones CI makes in the same job), unless allowed-keys.json keeps it
// by name for one file. A re-pin that brings a new upstream key therefore fails here until
// someone replaces it. --release also refuses the tegridy-clmm placeholder program id.
//
// node solana/guards/key-guard.mjs --allow <json> --ours <dir>... --upstream <dir>... [--release]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// Lockfiles carry checksums and commit hashes, not keys; clmm-provenance.sh holds Cargo.lock.
const SKIP_FILES = new Set(['Cargo.lock', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', '.anchor']);
const TEXT = /\.(rs|toml|ts|js|mjs|json|ini|md|yml|yaml|sh|txt)$/;
// A key the source builds from bytes would never match a base58 scan: refuse the shape.
const BYTE_KEY = /Pubkey::new_from_array\s*\(|\[u8;\s*32\]\s*=\s*\[/;

/** The 32 bytes a base58 string names, or null when it is not a 32-byte key. */
export function decodeKey(s) {
  let n = 0n;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return bytes.length === 32 ? Uint8Array.from(bytes) : null;
}

/** Every key literal in a text, in order of appearance. */
export function findKeys(text) {
  const out = [];
  for (const m of text.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,44}/g)) {
    const before = m.index > 0 ? text[m.index - 1] : '';
    const after = text[m.index + m[0].length] ?? '';
    // Part of a longer word (an identifier, a hash with a 0 in it) is not a key.
    if (/[0-9A-Za-z_]/.test(before) || /[0-9A-Za-z_]/.test(after)) continue;
    if (decodeKey(m[0])) out.push(m[0]);
  }
  return out;
}

function walk(dir, root = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, root, out);
    } else if (!SKIP_FILES.has(name) && TEXT.test(name)) {
      out.push({ path: p, rel: relative(root, p).split(sep).join('/') });
    }
  }
  return out;
}

/** key -> files it appears in, plus how many files were read and which build keys from bytes. */
export function scanTree(dir) {
  const keys = new Map();
  const byteKeys = [];
  const files = walk(dir);
  for (const f of files) {
    const text = readFileSync(f.path, 'utf-8');
    if (BYTE_KEY.test(text)) byteKeys.push(f.rel);
    for (const k of findKeys(text)) {
      if (!keys.has(k)) keys.set(k, new Set());
      keys.get(k).add(f.rel);
    }
  }
  return { keys, files: files.length, byteKeys };
}

/**
 * The verdict. `ours` and `upstream` are scanTree results keyed by a label; `allow` is
 * allowed-keys.json. Returns the problems found (empty = pass) and the counts it checked.
 */
export function judge({ ours, upstream, allow, release = false }) {
  const problems = [];
  const system = new Map(Object.entries(allow.system ?? {}));
  const named = new Map([
    ...Object.entries(allow.ours ?? {}),
    ...system,
    ...Object.entries(allow.placeholder ?? {}),
  ]);
  const kept = new Map(Object.entries(allow.keptUpstream ?? {}));
  for (const [k, v] of [...named, ...kept]) {
    const why = typeof v === 'string' ? v : v?.why;
    if (!decodeKey(k)) problems.push(`allow-list entry ${k} is not a 32-byte key`);
    if (!why || why.trim().length < 8) problems.push(`allow-list entry ${k} has no explanation`);
  }

  const deny = new Set();
  for (const [label, scan] of Object.entries(upstream)) {
    if (scan.files === 0 || scan.keys.size === 0) problems.push(`upstream ${label}: read no file or no key, so the deny-list would be empty`);
    for (const k of scan.keys.keys()) if (!system.has(k)) deny.add(k);
  }

  const seen = new Set();
  for (const [label, scan] of Object.entries(ours)) {
    if (scan.files === 0) problems.push(`ours ${label}: read no file`);
    for (const f of scan.byteKeys) problems.push(`${label}/${f}: builds a key from bytes, which this guard cannot read`);
    for (const [k, files] of scan.keys) {
      seen.add(k);
      const where = [...files].map((f) => `${label}/${f}`);
      const keep = kept.get(k);
      if (keep) {
        const stray = where.filter((w) => !keep.only_in?.includes(w));
        if (stray.length) problems.push(`${k} (${keep.why}) is kept only in ${keep.only_in}, but appears in ${stray.join(', ')}`);
        continue;
      }
      if (deny.has(k)) problems.push(`${k} is hard-coded by upstream and must be replaced: ${where.join(', ')}`);
      else if (!named.has(k)) problems.push(`${k} is on no allow-list: ${where.join(', ')}`);
      if (release && allow.placeholder?.[k]) problems.push(`${k} is the placeholder program id; a release build refuses it: ${where.join(', ')}`);
    }
  }
  for (const k of [...named.keys(), ...kept.keys()]) {
    if (!seen.has(k)) problems.push(`allow-list entry ${k} appears nowhere in our copies: drop it, so the list stays exact`);
  }
  return { problems, counts: { found: seen.size, deny: deny.size, allowed: named.size + kept.size } };
}

/** While lib.rs declares the placeholder id, the gate that stops a release build must be there. */
export function placeholderGate(libRs, placeholder) {
  const declared = [...libRs.matchAll(/declare_id!\("([^"]+)"\)/g)].map((m) => m[1]);
  if (declared.length === 0) return ['lib.rs declares no program id'];
  if (!declared.includes(placeholder)) return [];
  const gate = /#\[cfg\(not\(any\(test, feature = "placeholder-id"\)\)\)\]\s*\ncompile_error!\(/;
  return gate.test(libRs) ? [] : ['lib.rs declares the placeholder id without the compile_error! gate that stops a release build'];
}

function args(argv) {
  const out = { ours: [], upstream: [], release: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--release') out.release = true;
    else if (a === '--allow') out.allow = argv[++i];
    else if (a === '--ours') out.ours.push(argv[++i]);
    else if (a === '--upstream') out.upstream.push(argv[++i]);
    else if (a === '--clmm-lib') out.clmmLib = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.allow || out.ours.length === 0 || out.upstream.length === 0) {
    throw new Error('usage: key-guard.mjs --allow <json> --ours <dir>... --upstream <dir>... [--clmm-lib <lib.rs>] [--release]');
  }
  return out;
}

function main() {
  const a = args(process.argv.slice(2));
  const allow = JSON.parse(readFileSync(a.allow, 'utf-8'));
  const ours = Object.fromEntries(a.ours.map((d) => [d.replace(/\/+$/, ''), scanTree(d)]));
  const upstream = Object.fromEntries(a.upstream.map((d) => [d.replace(/\/+$/, ''), scanTree(d)]));
  const { problems, counts } = judge({ ours, upstream, allow, release: a.release });
  if (a.clmmLib) {
    const ph = Object.keys(allow.placeholder ?? {})[0];
    problems.push(...placeholderGate(readFileSync(a.clmmLib, 'utf-8'), ph));
  }
  for (const [label, scan] of Object.entries(ours)) console.log(`ours     ${label}: ${scan.files} files, ${scan.keys.size} distinct keys`);
  for (const [label, scan] of Object.entries(upstream)) console.log(`upstream ${label}: ${scan.files} files, ${scan.keys.size} distinct keys`);
  console.log(`checked ${counts.found} distinct key(s) in our copies against ${counts.allowed} allowed and ${counts.deny} denied`);
  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`);
    process.exit(1);
  }
  console.log('no outside key in our copies');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
