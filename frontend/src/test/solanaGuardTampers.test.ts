// @vitest-environment node
//
// Every disguise the outside check of 2026-10-14 tried against solana/guards/, each on a fresh
// copy of the real tree. Each guard must refuse every tamper in its own field, alone: key-guard
// any key however it is written, provenance any file or lock change. A tamper refused only by
// the other guard is the gap that check found (a build.rs in cp-swap passed all three guards).

import { describe, it, expect, afterAll } from 'vitest';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  scanTree,
  judge,
  readDeny,
  ancestorConfig,
  decodeKey,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs guard script, deliberately untyped and outside src/
} from '../../../solana/guards/key-guard.mjs';
import {
  checkCopy,
  checkPins,
  undoPatch,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs guard script, deliberately untyped and outside src/
} from '../../../solana/guards/provenance.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GUARDS = join(REPO_ROOT, 'solana', 'guards');
const ALLOW = JSON.parse(readFileSync(join(GUARDS, 'allowed-keys.json'), 'utf-8'));
const DENY: string[] = readDeny(readFileSync(join(GUARDS, 'upstream', 'deny-keys.txt'), 'utf-8'));

const CLMM = 'solana/tegridy-clmm';
const CP = 'solana/tegridy-amm/programs/cp-swap';
const KEY = 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ'; // Raydium's CLMM admin
const VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
const DEVNET = 'GgE6AfEH2AVSrKGckyKMzC6mhtXWiAn39EzAikAsWq5a';
const BYTES = Array.from(decodeKey(KEY) as Uint8Array)
  .map((b) => `0x${b.toString(16).padStart(2, '0')}`)
  .join(', ');
const ESCAPED = `${KEY.slice(0, 25)}\\x${KEY.charCodeAt(25).toString(16)}${KEY.slice(26)}`;

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fresh copy of both programs under a scratch root, as the repo lays them out. */
function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), 'guard-tamper-'));
  made.push(root);
  for (const d of [CLMM, CP]) {
    cpSync(join(REPO_ROOT, d), join(root, d), { recursive: true, filter: (s) => !/[\\/]target$/.test(s) });
  }
  return root;
}

const at = (root: string, rel: string) => join(root, ...rel.split('/'));
const append = (root: string, rel: string, text: string) => appendFileSync(at(root, rel), text);
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(at(root, rel)), { recursive: true });
  writeFileSync(at(root, rel), text);
};
const replace = (root: string, rel: string, a: string, b: string) => {
  const t = readFileSync(at(root, rel), 'utf-8');
  if (!t.includes(a)) throw new Error(`tamper anchor missing in ${rel}: ${a}`);
  writeFileSync(at(root, rel), t.replace(a, b));
};

const CLMM_LIB = `${CLMM}/programs/amm/src/lib.rs`;
const CP_TOKEN = `${CP}/src/utils/token.rs`;
const MAINNET_ADMIN = `#[cfg(all(not(feature = "devnet"), not(feature = "localnet")))]\n    pub const ID: Pubkey = pubkey!("${VAULT}");`;

// name -> [tamper, key-guard must refuse, provenance must refuse]
const TAMPERS: Record<string, [(root: string) => void, boolean, boolean]> = {
  'comment-clmm': [(r) => append(r, CLMM_LIB, `\n// ${KEY}\n`), true, true],
  'comment-cp': [(r) => append(r, CP_TOKEN, `\n// ${KEY}\n`), true, true],
  'bytes-from-cp': [(r) => append(r, CP_TOKEN, `\npub const X: Pubkey = Pubkey::from([${BYTES}]);\n`), true, true],
  'bytes-from-clmm': [(r) => append(r, CLMM_LIB, `\npub const X: Pubkey = Pubkey::from([${BYTES}]);\n`), true, true],
  'boundary-cp': [(r) => append(r, CP_TOKEN, `\npub fn x() -> Pubkey { Pubkey::from_str(&"0${KEY}"[1..]).unwrap() }\n`), true, true],
  'concat-cp': [(r) => append(r, CP_TOKEN, `\npub const Y: Pubkey = Pubkey::from_str_const(concat!("${KEY.slice(0, 20)}", "${KEY.slice(20)}"));\n`), true, true],
  'escape-clmm': [(r) => replace(r, CLMM_LIB, MAINNET_ADMIN, MAINNET_ADMIN.replace(VAULT, ESCAPED)), true, true],
  'escape-cp': [(r) => append(r, CP_TOKEN, `\npub const Z: Pubkey = pubkey!("${ESCAPED}");\n`), true, true],
  'renamed-const-clmm': [
    (r) => append(r, CLMM_LIB, '\npub mod venue_fee_owner { use super::{pubkey, Pubkey}; pub const ID: Pubkey = pubkey!("projjosVCPQH49d5em7VYS7fJZzaqKixqKtus7yk416"); }\n'),
    true,
    true,
  ],
  'testfile-clmm': [(r) => write(r, `${CLMM}/programs/amm/tests/evil.rs`, `// ${KEY}\n`), true, true],
  'testfile-cp': [(r) => write(r, `${CP}/tests/evil.rs`, `const K: &str = "${KEY}";\n`), true, true],
  'buildrs-cp': [(r) => write(r, `${CP}/build.rs`, `fn main() { let k: [u8; 32] = [${BYTES}]; let _ = k; }\n`), true, true],
  'buildrs-cp-from': [(r) => write(r, `${CP}/build.rs`, `fn main() { let _ = solana_pubkey::Pubkey::from([${BYTES}]); }\n`), true, true],
  'newfile-dat-cp': [(r) => write(r, `${CP}/keys.dat`, `${KEY}\n`), true, true],
  'newfile-dat-clmm': [(r) => write(r, `${CLMM}/programs/amm/keys.dat`, `${KEY}\n`), true, true],
  'parent-cargo-config': [(r) => write(r, 'solana/.cargo/config.toml', '[source.crates-io]\nreplace-with = "patched"\n[source.patched]\ndirectory = "../vendor-patched"\n'), true, false],
  'lock-swap': [(r) => replace(r, `${CLMM}/Cargo.lock`, 'name = "strsim"\nversion = "0.11.1"', 'name = "strsim"\nversion = "0.8.0"'), false, true],
  // Not among the 17: a power moved to a key the allow-list does name. Only provenance can see it.
  'admin-to-devnet-key': [(r) => replace(r, CLMM_LIB, MAINNET_ADMIN, MAINNET_ADMIN.replace(VAULT, DEVNET)), false, true],
  'vendored-uint-changed': [(r) => append(r, `${CLMM}/vendor/uint/src/uint.rs`, '\n// one more line\n'), false, true],
};

function keyGuard(root: string): string[] {
  const ours = { [CP]: scanTree(at(root, CP)), [CLMM]: scanTree(at(root, CLMM)) };
  return [...judge({ ours, deny: DENY, allow: ALLOW }).problems, ...[CP, CLMM].flatMap((d) => ancestorConfig(at(root, d), root))];
}
const provenance = (root: string): string[] => ['tegridy-clmm', 'uint', 'cp-swap'].flatMap((n) => checkCopy(n, undefined, root).problems);

describe('the untouched copy', () => {
  it('passes both guards, so every refusal below is the tamper', () => {
    const root = fresh();
    expect(keyGuard(root)).toEqual([]);
    expect(provenance(root)).toEqual([]);
    expect(checkPins()).toEqual([]);
  });
});

describe('every tamper is refused by the guard whose field it is', () => {
  for (const [name, [tamper, byKeyGuard, byProvenance]] of Object.entries(TAMPERS)) {
    it(name, () => {
      const root = fresh();
      tamper(root);
      if (byKeyGuard) expect(keyGuard(root), 'key-guard').not.toEqual([]);
      if (byProvenance) expect(provenance(root), 'provenance').not.toEqual([]);
    });
  }
});

describe('undoing the reviewed patch is strict', () => {
  const hunk = ['2c2', '< b', '---', '> B'];
  it('gives back upstream from our file and the patch', () => {
    expect(undoPatch('a\nB\nc\n', hunk)).toBe('a\nb\nc\n');
    expect(undoPatch('a\nb\nc\nd\n', ['3a4', '> d'])).toBe('a\nb\nc\n');
  });
  it('refuses a line the patch says is ours but is not', () => {
    expect(() => undoPatch('a\nX\nc\n', hunk)).toThrow('is not the reviewed one');
    expect(() => undoPatch('a\n', hunk)).toThrow();
  });
});
