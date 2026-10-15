#!/usr/bin/env node
// No outside key in the venue's Solana programs: both pool copies, tegridy-launch, bayla-ladder.
// Every key found must be on allowed-keys.json and none on upstream/deny-keys.txt. It reads a key
// written plain, glued, escaped, split across literals or as 32 numbers, and refuses the SHAPES
// that build one it cannot read. A second check, not the wall: compile-time Rust can make a key
// no scan follows. provenance.mjs is the wall for the two copies; a person reading the diff, for ours.
//
// node solana/guards/key-guard.mjs --allow <json> --deny <txt> --ours <dir>... [--workflow <yml>]... [--release]

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// Lockfiles carry checksums, not keys; provenance.mjs pins the ones the pool programs build with.
const SKIP_FILES = new Set(['Cargo.lock', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml']);
// Skipped only at the top of a scanned folder: build output, and the crate provenance.mjs holds
// byte for byte (its test numbers read as keys). The same name deeper down is read like any file.
const ROOT_SKIP = new Set(['.git', 'node_modules', 'target', '.anchor', 'vendor/uint']);
// Files cargo reads on its own: each can swap a source, run code, or name a key we never scan.
const BUILD_CONFIG = new Set(['build.rs', '.cargo', 'rust-toolchain', 'rust-toolchain.toml']);
// Shapes that build a key from something a base58 scan never sees. None is in any program today.
const SHAPES = [
  [/\binclude(?:_bytes)?!\s*\(/, 'reads a file into the build'],
  [/\bnew_from_array\b|\bPubkey\s*>?\s*::\s*from\s*\(/, 'builds a key from bytes, which this guard cannot read'],
  [/\[\s*u8\s*;\s*32\s*\]/, 'builds a key from bytes, which this guard cannot read: [u8; 32]'],
  [/\bPubkey\s+as\s+\w+|\btype\s+\w+\s*=\s*(?:[\w:]*::)?Pubkey\s*;/, 'renames the key type'],
  [/\bstringify!\s*\(/, 'turns code into text'],
  [/\bparse\s*::\s*<\s*Pubkey\s*>/, 'parses a key from text it builds'],
  [/#\s*!?\s*\[\s*path\s*=/, 'compiles a file from another path'],
];
// The one build-time value allowed: tegridy-clmm's localnet admin, in the arm only a localnet
// build compiles (and lib.rs refuses a localnet build without test-chain-keys).
const GATED_ENV = /#\[cfg\(feature = "localnet"\)\]\s*\n\s*pub const ID: Pubkey = Pubkey::from_str_const\(env!\(\s*"CLMM_LOCALNET_ADMIN"/g;
// Calls that turn their argument into a key; it must be one plain string literal.
const KEY_CALL = /\b(pubkey!|declare_id!|from_str_const|from_str)\s*\(/g;
// A byte as Rust may spell it: 0x41, 0b1000001, 0o101, 65, 65u8, 65 as u8.
const NUM = String.raw`(?:0x[0-9a-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*)(?:_?u8)?(?:\s+as\s+u8)?`;
const NUM_LIST = new RegExp(String.raw`\[\s*((?:${NUM}\s*,\s*){31,}${NUM})\s*,?\s*\]`, 'g');
// Settings that change what cargo compiles without changing any file the guards read.
const BUILD_FLAGS = /\b(?:RUSTFLAGS|RUSTC\w*|CARGO_[A-Z0-9_]+)\b|--config\b|--cfg\b|\.cargo\/config/g;

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

/** The base58 name of 32 bytes. */
export function encodeKey(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

/**
 * Every key in a text, plus the runs that could hide one. A run is a maximal stretch of base58
 * letters, so a key glued to `0`, `_` or a quote is still found. A run longer than a key, or one
 * with a key-length piece inside, is `hidden`: the caller refuses it.
 */
export function findKeys(text) {
  const keys = [];
  const hidden = [];
  for (const m of text.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,}/g)) {
    const run = m[0];
    if (run.length <= 44 && decodeKey(run)) {
      keys.push(run);
      continue;
    }
    if (run.length > 44) {
      hidden.push(run);
      continue;
    }
    for (let len = 32; len < run.length && !hidden.includes(run); len++) {
      for (let i = 0; i + len <= run.length; i++) {
        if (decodeKey(run.slice(i, i + len))) {
          hidden.push(run);
          break;
        }
      }
    }
  }
  return { keys, hidden };
}

/** A Rust string literal's text with its escapes resolved (\x41, \u{41}, \n and friends). */
export function unescapeRust(body) {
  return body.replace(/\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]{1,8}\}|[nrt0\\'"]|\r?\n\s*)/g, (_, e) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'u') return String.fromCodePoint(parseInt(e.slice(2, -1).replace(/_/g, ''), 16));
    if (/^\r?\n/.test(e)) return '';
    return { n: '\n', r: '\r', t: '\t', 0: '\0', '\\': '\\', "'": "'", '"': '"' }[e];
  });
}

const STRING = /(?:\bb)?"((?:[^"\\]|\\[\s\S])*)"/g;

/** The text inside the parentheses that open at `open` (the index of `(`), or null. */
function argument(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/** A byte as Rust spells it, or NaN. */
function byte(s) {
  const t = s.trim().replace(/\s+as\s+u8$/, '').replace(/_?u8$/, '').replace(/_/g, '');
  const base = { '0x': 16, '0b': 2, '0o': 8 }[t.slice(0, 2)];
  return base ? parseInt(t.slice(2), base) : /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
}

/** Keys and refusals in one Rust source text, beyond what the plain scan sees. */
export function rustDisguises(text) {
  const keys = [];
  const problems = [];
  // Escapes resolved, then scanned: `pubkey!("GThUX\x31...")`.
  for (const m of text.matchAll(STRING)) {
    if (!m[1].includes('\\')) continue;
    const found = findKeys(unescapeRust(m[1]));
    keys.push(...found.keys);
    if (found.hidden.length) problems.push('escapes a string into a run that could hide a key');
  }
  // concat!("half", "half") joined, then scanned.
  for (const m of text.matchAll(/concat!\s*\(/g)) {
    const arg = argument(text, m.index + m[0].length - 1) ?? '';
    const joined = [...arg.matchAll(STRING)].map((s) => unescapeRust(s[1])).join('');
    const found = findKeys(joined);
    keys.push(...found.keys);
    if (found.hidden.length) problems.push('joins text with concat! into a run that could hide a key');
  }
  // A key split across literals side by side: ["half", "half"].concat(), "half" + "half".
  const lits = [...text.matchAll(/"((?:[^"\\]|\\[\s\S])*)"/g)];
  for (let i = 0; i < lits.length; i++) {
    let joined = '';
    for (let j = i; j < lits.length && joined.length <= 44; j++) {
      const end = lits[j - 1] ? lits[j - 1].index + lits[j - 1][0].length : 0;
      if (j > i && !/^[\s,+[\]()&]*$/.test(text.slice(end, lits[j].index))) break;
      const piece = unescapeRust(lits[j][1]);
      if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(piece)) break;
      joined += piece;
      if (j > i && joined.length >= 32 && joined.length <= 44 && decodeKey(joined)) keys.push(joined);
    }
  }
  // 32 numbers between brackets are a key's bytes, however they are spelled.
  for (const m of text.matchAll(NUM_LIST)) {
    const bytes = m[1].split(',').map(byte);
    if (bytes.some((b) => !(b >= 0 && b <= 255))) continue;
    if (bytes.length === 32) keys.push(encodeKey(bytes));
    else problems.push(`holds a list of ${bytes.length} bytes, which could be a key pair`);
  }
  // A byte string of exactly 32 bytes is a key too.
  for (const m of text.matchAll(/\bb"((?:[^"\\]|\\[\s\S])*)"/g)) {
    const raw = unescapeRust(m[1]);
    if (raw.length === 32) keys.push(encodeKey([...raw].map((c) => c.charCodeAt(0) & 0xff)));
  }
  for (const [shape, why] of SHAPES) if (shape.test(text)) problems.push(why);
  // include_str! may read only a source file beside it, which this scan reads too.
  for (const m of text.matchAll(/\binclude_str!\s*\(/g)) {
    const arg = argument(text, m.index + m[0].length - 1) ?? '';
    if (!/^\s*"[\w-]+\.rs"\s*$/.test(arg)) problems.push(`include_str! reads ${arg.trim().slice(0, 40)}, not a source file beside it`);
  }
  const gated = new Set([...text.matchAll(GATED_ENV)].map((m) => m.index + m[0].indexOf('env!')));
  for (const m of text.matchAll(/\b(?:option_)?env!\s*\(/g)) {
    if (!gated.has(m.index)) problems.push('reads a value from the build environment outside the gated localnet arm');
  }
  for (const m of text.matchAll(KEY_CALL)) {
    const arg = argument(text, m.index + m[0].length - 1);
    if (arg === null) continue;
    const plain = /^\s*&?\s*"[1-9A-HJ-NP-Za-km-z]*"\s*$/.test(arg);
    const localnetEnv = /^\s*env!\(\s*"CLMM_LOCALNET_ADMIN"/.test(arg);
    if (!plain && !localnetEnv) problems.push(`${m[1]} is given something other than one plain key: ${arg.trim().slice(0, 60)}`);
  }
  return { keys, problems };
}

/**
 * Every key path a TOML text defines: table headers, keys and the keys inside inline tables,
 * each as its parts (`[ "patch" . crates-io ]` is patch, crates-io). Throws on text it cannot
 * read, so a spelling it does not know is refused rather than passed.
 */
export function tomlKeys(s) {
  let i = 0;
  let table = [];
  const out = [];
  const fail = (why) => {
    throw new Error(`${why} on line ${s.slice(0, i).split('\n').length}`);
  };
  const sp = () => {
    while (s[i] === ' ' || s[i] === '\t') i++;
  };
  const comment = () => {
    if (s[i] === '#') while (i < s.length && s[i] !== '\n') i++;
  };
  const gap = () => {
    for (;;) {
      sp();
      comment();
      if (s[i] !== '\r' && s[i] !== '\n') return;
      i++;
    }
  };
  const lineEnd = () => {
    sp();
    comment();
    if (s[i] === '\r') i++;
    if (i < s.length && s[i] !== '\n') fail('more text after a value');
    i++;
  };
  const str = () => {
    const q = s[i];
    const triple = s.startsWith(q.repeat(3), i);
    i += triple ? 3 : 1;
    let v = '';
    for (;;) {
      if (i >= s.length) fail('a string that never closes');
      if (triple && s.startsWith(q.repeat(3), i)) {
        i += 3;
        while (s[i] === q) (v += q), i++;
        return v;
      }
      if (!triple && s[i] === q) return i++, v;
      if (!triple && s[i] === '\n') fail('a line break inside a string');
      if (q === '"' && s[i] === '\\') {
        const e = s[i + 1];
        const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' }[e];
        const width = { x: 2, u: 4, U: 8 }[e];
        if (simple !== undefined) (v += simple), (i += 2);
        else if (width && /^[0-9a-fA-F]+$/.test(s.slice(i + 2, i + 2 + width)) && s.slice(i + 2, i + 2 + width).length === width) {
          v += String.fromCodePoint(parseInt(s.slice(i + 2, i + 2 + width), 16));
          i += 2 + width;
        } else if (triple && /[ \t\r\n]/.test(e)) for (i++; /[ \t\r\n]/.test(s[i] ?? ''); i++);
        else fail('an escape it cannot read');
        continue;
      }
      v += s[i++];
    }
  };
  const key = () => {
    const parts = [];
    for (;;) {
      sp();
      if (s[i] === '"' || s[i] === "'") {
        if (s.startsWith(s[i].repeat(3), i)) fail('a key written as a multi-line string');
        parts.push(str());
      } else {
        const start = i;
        while (i < s.length && /[A-Za-z0-9_-]/.test(s[i])) i++;
        if (i === start) fail('a key it cannot read');
        parts.push(s.slice(start, i));
      }
      sp();
      if (s[i] !== '.') return parts;
      i++;
    }
  };
  const value = (path) => {
    if (s[i] === '"' || s[i] === "'") return void str();
    if (s[i] === '[' || s[i] === '{') {
      const close = s[i++] === '[' ? ']' : '}';
      for (;;) {
        gap();
        if (s[i] === close) return void i++;
        if (close === '}') {
          const k = key();
          out.push([...path, ...k]);
          if (s[i++] !== '=') fail('a key with no value');
          sp();
          value([...path, ...k]);
        } else value(path);
        gap();
        if (s[i] === ',') i++;
        else if (s[i] !== close) fail(`a list it cannot read`);
      }
    }
    const start = i;
    while (i < s.length && !/[,\]}#\r\n]/.test(s[i])) i++;
    if (!/^[\w.:+-]+(?: [\w.:+-]+)?$/.test(s.slice(start, i).trim())) fail('a value it cannot read');
  };
  for (;;) {
    gap();
    if (i >= s.length) return out;
    if (s[i] === '[') {
      const double = s[i + 1] === '[';
      i += double ? 2 : 1;
      table = key();
      if (s[i] !== ']' || (double && s[i + 1] !== ']')) fail('a table name it cannot read');
      i += double ? 2 : 1;
      out.push(table);
    } else {
      const k = key();
      if (s[i++] !== '=') fail('a key with no value');
      sp();
      value([...table, ...k]);
      out.push([...table, ...k]);
    }
    lineEnd();
  }
}

/** What a Cargo.toml asks of cargo that this guard refuses, however the TOML spells it. */
export function cargoManifest(text) {
  let keys;
  try {
    keys = tomlKeys(text);
  } catch (e) {
    return [`cannot be read as TOML (${e.message}), so it cannot be cleared`];
  }
  const problems = [];
  if (keys.some((k) => ['patch', 'replace', 'source'].includes(k[0]))) problems.push("swaps a dependency's source");
  if (keys.some((k) => k[0] === 'package' && k[1] === 'build')) problems.push('names a build script');
  return problems;
}

/** A workflow setting that changes what cargo compiles without changing a file we read. */
export function buildFlags(text) {
  return [...new Set([...text.matchAll(BUILD_FLAGS)].map((m) => m[0]))].map((f) => `sets ${f}, which changes what cargo compiles without changing any file the guards read`);
}

function walk(dir, root = dir, out = { files: [], refused: [] }) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const rel = relative(root, p).split(sep).join('/');
    if (BUILD_CONFIG.has(name)) out.refused.push(`${rel}: cargo reads this on its own, and no copy of ours may carry one`);
    if (statSync(p).isDirectory()) {
      if (!ROOT_SKIP.has(rel)) walk(p, root, out);
    } else if (!SKIP_FILES.has(name)) {
      out.files.push({ path: p, rel });
    }
  }
  return out;
}

/** key -> files it appears in, how many files were read, and what was refused. */
export function scanTree(dir) {
  const keys = new Map();
  const add = (k, rel) => {
    if (!keys.has(k)) keys.set(k, new Set());
    keys.get(k).add(rel);
  };
  const { files, refused } = walk(dir);
  const problems = [...refused];
  for (const f of files) {
    const buf = readFileSync(f.path);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      text = null;
    }
    if (text === null || text.includes('\0')) {
      problems.push(`${f.rel}: not text, so this guard cannot read it`);
      continue;
    }
    const found = findKeys(text);
    for (const k of found.keys) add(k, f.rel);
    for (const h of found.hidden) problems.push(`${f.rel}: a run of letters that could hide a key: ${h.slice(0, 60)}`);
    if (f.rel.endsWith('.rs')) {
      const r = rustDisguises(text);
      for (const k of r.keys) add(k, f.rel);
      for (const p of r.problems) problems.push(`${f.rel}: ${p}`);
    }
    if (/(^|\/)Cargo\.toml$/.test(f.rel)) for (const p of cargoManifest(text)) problems.push(`${f.rel}: ${p}`);
  }
  return { keys, files: files.length, problems };
}

/** Cargo also reads config from every folder above a package: refuse any between it and root. */
export function ancestorConfig(dir, root) {
  const problems = [];
  const top = resolve(root);
  let d = resolve(dir);
  if (relative(top, d).startsWith('..')) return problems;
  while (true) {
    d = dirname(d);
    if (relative(top, d).startsWith('..')) break;
    for (const name of BUILD_CONFIG) {
      if (name !== 'build.rs' && existsSync(join(d, name))) problems.push(`${relative(top, join(d, name)) || name}: cargo reads this for ${relative(top, dir)}`);
    }
    const toml = join(d, 'Cargo.toml');
    if (existsSync(toml)) {
      for (const p of cargoManifest(readFileSync(toml, 'utf-8'))) problems.push(`${relative(top, toml)}: ${p}, for ${relative(top, dir)}`);
    }
    if (d === top) break;
  }
  return problems;
}

/** The deny-list file: one key per line, `#` starts a comment. */
export function readDeny(text) {
  return text.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
}

/**
 * The verdict. `ours` and `upstream` are scanTree results keyed by a label, `deny` a list of
 * upstream keys, `allow` is allowed-keys.json. Returns the problems found (empty = pass).
 */
export function judge({ ours, upstream = {}, deny: denyList = /** @type {string[]} */ ([]), allow, release = false }) {
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
  for (const k of denyList) {
    if (!decodeKey(k)) problems.push(`deny-list entry ${k} is not a 32-byte key`);
    if (!system.has(k)) deny.add(k);
  }
  for (const [label, scan] of Object.entries(upstream)) {
    if (scan.files === 0 || scan.keys.size === 0) problems.push(`upstream ${label}: read no file or no key`);
    for (const k of scan.keys.keys()) if (!system.has(k)) deny.add(k);
  }
  if (deny.size === 0) problems.push('the deny-list would be empty, so no upstream key could be refused');

  const seen = new Set();
  for (const [label, scan] of Object.entries(ours)) {
    if (scan.files === 0) problems.push(`ours ${label}: read no file`);
    for (const p of scan.problems) problems.push(`${label}/${p}`);
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

/**
 * `devnet` gives every power to one test key and `localnet` reads the admin from the build's
 * environment. Neither may compile unless `test-chain-keys` is asked for by name, and nothing
 * may turn that on for you: not `default`, not another feature.
 */
export function testChainGate(libRs, cargoToml) {
  const problems = [];
  const gate = /#\[cfg\(all\(any\(feature = "devnet", feature = "localnet"\), not\(feature = "test-chain-keys"\)\)\)\]\s*\ncompile_error!\(/;
  if (!gate.test(libRs)) problems.push('lib.rs lacks the compile_error! gate that refuses a devnet or localnet build without test-chain-keys');
  const features = /^\[features\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargoToml)?.[1] ?? '';
  if (!/^test-chain-keys\s*=\s*\[\s*\]\s*$/m.test(features)) problems.push('Cargo.toml must declare `test-chain-keys = []` on its own');
  for (const line of features.split(/\r?\n/)) {
    const m = /^([\w-]+)\s*=\s*\[(.*)\]/.exec(line.trim());
    if (!m) continue;
    if (m[1] !== 'test-chain-keys' && /test-chain-keys|"devnet"|"localnet"/.test(m[2])) {
      problems.push(`Cargo.toml feature ${m[1]} turns on ${m[2].trim()}: devnet, localnet and test-chain-keys are asked for by name only`);
    }
  }
  return problems;
}

function args(argv) {
  const out = { ours: [], upstream: [], deny: [], workflows: [], release: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--release') out.release = true;
    else if (a === '--allow') out.allow = argv[++i];
    else if (a === '--deny') out.deny.push(argv[++i]);
    else if (a === '--ours') out.ours.push(argv[++i]);
    else if (a === '--upstream') out.upstream.push(argv[++i]);
    else if (a === '--clmm-lib') out.clmmLib = argv[++i];
    else if (a === '--workflow') out.workflows.push(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.allow || out.ours.length === 0 || out.deny.length + out.upstream.length === 0) {
    throw new Error('usage: key-guard.mjs --allow <json> --deny <txt> --ours <dir>... [--upstream <dir>] [--clmm-lib <lib.rs>] [--workflow <yml>]... [--release]');
  }
  return out;
}

function main() {
  const a = args(process.argv.slice(2));
  const allow = JSON.parse(readFileSync(a.allow, 'utf-8'));
  const deny = a.deny.flatMap((f) => readDeny(readFileSync(f, 'utf-8')));
  const ours = Object.fromEntries(a.ours.map((d) => [d.replace(/\/+$/, ''), scanTree(d)]));
  const upstream = Object.fromEntries(a.upstream.map((d) => [d.replace(/\/+$/, ''), scanTree(d)]));
  const { problems, counts } = judge({ ours, upstream, deny, allow, release: a.release });
  for (const d of a.ours) problems.push(...ancestorConfig(d, process.cwd()));
  for (const w of a.workflows) for (const p of buildFlags(readFileSync(w, 'utf-8'))) problems.push(`${w}: ${p}`);
  if (a.clmmLib) {
    const ph = Object.keys(allow.placeholder ?? {})[0];
    const lib = readFileSync(a.clmmLib, 'utf-8');
    problems.push(...placeholderGate(lib, ph));
    problems.push(...testChainGate(lib, readFileSync(join(dirname(a.clmmLib), '..', 'Cargo.toml'), 'utf-8')));
  }
  for (const [label, scan] of Object.entries(ours)) console.log(`ours     ${label}: ${scan.files} files, ${scan.keys.size} distinct keys`);
  for (const [label, scan] of Object.entries(upstream)) console.log(`upstream ${label}: ${scan.files} files, ${scan.keys.size} distinct keys`);
  console.log(`checked ${counts.found} distinct key(s) in our copies against ${counts.allowed} allowed and ${counts.deny} denied`);
  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`);
    process.exit(1);
  }
  console.log(`no outside key in our copies${a.workflows.length ? `, and no build flag in ${a.workflows.length} workflows` : ''}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
