// @vitest-environment node
//
// Every disguise the two outside checks of 2026-10-14 tried against solana/guards/, each on a
// fresh copy of the real tree. Each guard must refuse every tamper in its own field, alone:
// key-guard any key however it is written, provenance any file, lock or workspace change. The
// second check's 22 (A1 to A10 around the copies, B1 to B12 inside them) close the list.

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
  buildFlags,
  decodeKey,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs guard script, deliberately untyped and outside src/
} from '../../../solana/guards/key-guard.mjs';
import {
  checkCopy,
  checkPins,
  repinAlone,
  undoPatch,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs guard script, deliberately untyped and outside src/
} from '../../../solana/guards/provenance.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GUARDS = join(REPO_ROOT, 'solana', 'guards');
const ALLOW = JSON.parse(readFileSync(join(GUARDS, 'allowed-keys.json'), 'utf-8'));
const DENY: string[] = readDeny(readFileSync(join(GUARDS, 'upstream', 'deny-keys.txt'), 'utf-8'));

const CLMM = 'solana/tegridy-clmm';
const WS = 'solana/tegridy-amm';
const CP = `${WS}/programs/cp-swap`;
const LAUNCH = `${WS}/programs/tegridy-launch`;
const LADDER = `${WS}/programs/bayla-ladder`;
const WORKFLOWS = ['.github/workflows/solana-ci.yml', '.github/workflows/solana-deploy-artifact.yml'];
const KEY = 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ'; // Raydium's CLMM admin
const PROJ = 'projjosVCPQH49d5em7VYS7fJZzaqKixqKtus7yk416'; // Raydium's CLMM protocol-fee owner
const VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
const DEVNET = 'GgE6AfEH2AVSrKGckyKMzC6mhtXWiAn39EzAikAsWq5a';
const KB = Array.from(decodeKey(KEY) as Uint8Array);
const PB = Array.from(decodeKey(PROJ) as Uint8Array);
const HEX = KB.map((b) => b.toString(16).padStart(2, '0')).join('');
const BYTES = KB.map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ');
const ESCAPED = `${KEY.slice(0, 25)}\\x${KEY.charCodeAt(25).toString(16)}${KEY.slice(26)}`;

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fresh copy of the four programs, their workspace files and the build workflows. */
function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), 'guard-tamper-'));
  made.push(root);
  for (const d of [CLMM, CP, LAUNCH, LADDER, `${WS}/Cargo.toml`, `${WS}/Cargo.lock`, ...WORKFLOWS]) {
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

const prepend = (root: string, rel: string, text: string) => writeFileSync(at(root, rel), text + readFileSync(at(root, rel), 'utf-8'));

const CLMM_LIB = `${CLMM}/programs/amm/src/lib.rs`;
const CLMM_POOL = `${CLMM}/programs/amm/src/states/pool.rs`;
const CP_TOKEN = `${CP}/src/utils/token.rs`;
const WS_TOML = `${WS}/Cargo.toml`;
const EVIL_CRATE = (root: string, name: string, body: string, extra = '') => {
  write(root, `${WS}/vendor-evil/${name}/Cargo.toml`, `[package]\nname = "${name}"\nversion = "0.32.1"\nedition = "2021"\n${extra}`);
  write(root, `${WS}/vendor-evil/${name}/src/lib.rs`, body);
};
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

  // A: around the copies, where the second check found every guard passing.
  'A1 [ patch ] with spaces, an edited anchor-lang': [
    (r) => {
      append(r, WS_TOML, '\n[ patch.crates-io ]\nanchor-lang = { path = "vendor-evil/anchor-lang" }\n');
      EVIL_CRATE(r, 'anchor-lang', `pub const ADMIN_OVERRIDE: &str = "${KEY}";\n`);
    },
    true,
    true,
  ],
  'A2 a top-level dotted patch key to a Raydium git crate': [
    (r) => prepend(r, WS_TOML, 'patch.crates-io.uint = { git = "https://github.com/raydium-io/parity-common", rev = "43a0303b9c2a23a00508816bd6d5a2e9381f143c" }\n'),
    true,
    true,
  ],
  'A3 a quoted table name ["patch".crates-io]': [
    (r) => {
      append(r, WS_TOML, '\n["patch".crates-io]\narrayref = { path = "vendor-evil/arrayref" }\n');
      EVIL_CRATE(r, 'arrayref', `pub const K: &str = "${KEY}";\n`);
    },
    true,
    true,
  ],
  'A4 a tab-spaced patch of the declare_id! macro crate': [
    (r) => {
      append(r, WS_TOML, '\n[\tpatch . "crates-io" ]\nanchor-attribute-account = { path = "vendor-evil/anchor-attribute-account" }\n');
      EVIL_CRATE(r, 'anchor-attribute-account', `// emits "${KEY.slice(0, 20)}" + "${KEY.slice(20)}" whatever id it is given\n`, '\n[lib]\nproc-macro = true\n');
    },
    true,
    true,
  ],
  'A5 a new workspace member turning on cp-swap devnet': [
    (r) => {
      write(r, `${WS}/programs/zz-helper/Cargo.toml`, '[package]\nname = "zz-helper"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nraydium-cp-swap = { path = "../cp-swap", features = ["devnet", "no-entrypoint"] }\n');
      write(r, `${WS}/programs/zz-helper/src/lib.rs`, '\n');
    },
    false,
    true,
  ],
  'A6 overflow checks off in the release profile': [(r) => replace(r, WS_TOML, 'overflow-checks = true', 'overflow-checks = false'), false, true],
  'A7 RUSTFLAGS --cfg in the deploy workflow': [
    (r) => replace(r, WORKFLOWS[1], 'env:\n  SOLANA_VERSION', 'env:\n  RUSTFLAGS: --cfg feature="devnet" --cfg feature="test-chain-keys"\n  SOLANA_VERSION'),
    true,
    false,
  ],
  'A8 a crate version changed in the shared lock': [(r) => replace(r, `${WS}/Cargo.lock`, 'name = "arrayref"\nversion = "0.3.9"', 'name = "arrayref"\nversion = "0.3.7"'), false, true],
  'A9 files planted in a build folder': [
    (r) => {
      write(r, `${CLMM}/target/release/.fingerprint/anchor-lang-0000/lib-anchor_lang`, `${KEY}\n`);
      write(r, `${CLMM}/target/k.rs`, `pub const K: &str = "${KEY}";\n`);
    },
    false,
    true,
  ],
  'A10 a Raydium key in tegridy-launch': [(r) => append(r, `${LAUNCH}/src/lib.rs`, `\npub mod fee_override { use anchor_lang::prelude::*; pub const ID: Pubkey = pubkey!("${KEY}"); }\n`), true, false],

  // B: inside the copies. Provenance refused each; the key guard must too, alone.
  'B1 a renamed key type and two halves joined by a const fn': [
    (r) =>
      append(
        r,
        CP_TOKEN,
        `\nuse anchor_lang::prelude::Pubkey as P;\nconst HA: [u8; 16] = [${KB.slice(0, 16).join(', ')}];\nconst HB: [u8; 16] = [${KB.slice(16).join(', ')}];\nconst fn join_halves(a: [u8; 16], b: [u8; 16]) -> [u8; 32] { let mut o = [0u8; 32]; let mut i = 0; while i < 16 { o[i] = a[i]; o[i + 16] = b[i]; i += 1; } o }\npub const EVIL_B1: P = P::new_from_array(join_halves(HA, HB));\n`,
      ),
    true,
    true,
  ],
  'B2 binary numbers, [u8; 32 ] spacing, Pubkey::from(name)': [
    (r) => append(r, CLMM_POOL, `\nconst K_B2: [u8; 32 ] = [${KB.map((b) => `0b${b.toString(2)}`).join(', ')}];\npub const EVIL_B2: Pubkey = Pubkey::from(K_B2);\n`),
    true,
    true,
  ],
  'B3 hex with underscores decoded by a const fn': [
    (r) =>
      append(
        r,
        CP_TOKEN,
        `\nconst HEX_B3: &[u8] = b"${HEX.match(/.{16}/g)?.join('_')}";\nconst fn nib(c: u8) -> u8 { if c >= b'a' { c - b'a' + 10 } else { c - b'0' } }\nconst fn unhex(h: &[u8]) -> [u8; 32] { let mut o = [0u8; 32]; let (mut i, mut n) = (0, 0); while i < h.len() { if h[i] == b'_' { i += 1; continue; } o[n] = nib(h[i]) << 4 | nib(h[i + 1]); n += 1; i += 2; } o }\npub const EVIL_B3: Pubkey = <Pubkey>::new_from_array(unhex(HEX_B3));\n`,
      ),
    true,
    true,
  ],
  'B4 concat!(stringify!(name), "rest") through a const': [
    (r) => append(r, CLMM_LIB, `\nconst S_B4: &str = concat!(stringify!(${KEY.slice(0, 16)}), "${KEY.slice(16)}");\npub const EVIL_B4: Pubkey = Pubkey::from_str_const(S_B4);\n`),
    true,
    true,
  ],
  'B5 include_str! of two text files': [
    (r) => {
      write(r, `${CP}/src/k1.txt`, KEY.slice(0, 22));
      write(r, `${CP}/src/k2.txt`, KEY.slice(22));
      append(r, CP_TOKEN, '\nconst S_B5: &str = concat!(include_str!("../k1.txt"), include_str!("../k2.txt"));\npub const EVIL_B5: Pubkey = Pubkey::from_str_const(S_B5);\n');
    },
    true,
    true,
  ],
  'B6 include_bytes! of a hex file': [
    (r) => {
      write(r, `${CLMM}/programs/amm/src/k.hex`, `${HEX.match(/.{16}/g)?.join('\n')}\n`);
      append(r, CLMM_LIB, '\nconst HEX_B6: &[u8] = include_bytes!("k.hex");\npub const EVIL_B6: Pubkey = Pubkey::from(unhex6(HEX_B6));\n');
    },
    true,
    true,
  ],
  'B7 the mainnet admin read from env! under the allowed name': [
    (r) => replace(r, CLMM_LIB, `pub const ID: Pubkey = pubkey!("${VAULT}");\n}\n\npub mod limit_order_admin`, `pub const ID: Pubkey = Pubkey::from_str_const(env!("CLMM_LOCALNET_ADMIN"));\n}\n\npub mod limit_order_admin`),
    true,
    true,
  ],
  'B8 env! of any name through a const': [(r) => append(r, CP_TOKEN, '\nconst S_B8: &str = env!("EVIL_ADMIN");\npub const EVIL_B8: Pubkey = Pubkey::from_str_const(S_B8);\n'), true, true],
  'B9 a key split across lines and parsed at run time': [
    (r) => append(r, CP_TOKEN, `\npub fn evil_b9() -> Pubkey {\n    [\n        "${KEY.slice(0, 16)}",\n        "${KEY.slice(16, 28)}",\n        "${KEY.slice(28)}",\n    ]\n    .concat()\n    .parse()\n    .unwrap()\n}\n`),
    true,
    true,
  ],
  'B10 a new crate under vendor/': [
    (r) => {
      write(r, `${CLMM}/vendor/evil/Cargo.toml`, '[package]\nname = "evil"\nversion = "0.1.0"\nedition = "2021"\n');
      write(r, `${CLMM}/vendor/evil/src/lib.rs`, `pub const K: &str = "${KEY}";\n`);
    },
    true,
    true,
  ],
  'B11 a renamed module, 32 "N as u8" behind a type alias': [
    (r) => append(r, CLMM_LIB, `\npub mod venue_reserve {\n    use super::Pubkey;\n    type Key = [u8; 32];\n    const K: Key = [${PB.map((b) => `${b} as u8`).join(', ')}];\n    pub const ID: Pubkey = Pubkey::from(K);\n}\n`),
    true,
    true,
  ],
  'B12 a nested target/ folder inside src': [(r) => write(r, `${CP}/src/target/evil.rs`, `pub const K: &str = "${KEY}";\n`), true, true],
};

const OURS = [CP, CLMM, LAUNCH, LADDER];
function keyGuard(root: string): string[] {
  const ours = Object.fromEntries(OURS.map((d) => [d, scanTree(at(root, d))]));
  return [
    ...judge({ ours, deny: DENY, allow: ALLOW }).problems,
    ...OURS.flatMap((d) => ancestorConfig(at(root, d), root)),
    ...WORKFLOWS.flatMap((w) => buildFlags(readFileSync(at(root, w), 'utf-8'))),
  ];
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

describe('a pin, the reviewed patch or the allow-list changes in a pull request of its own', () => {
  it('refuses other work beside a changed guard file, and passes one that is new or alone', () => {
    const pin = 'M\tsolana/guards/upstream/cp-swap.diff\nM\tsolana/tegridy-amm/programs/cp-swap/src/lib.rs\n';
    expect(repinAlone(pin)).toEqual([]);
    expect(repinAlone(`${pin}M\tsolana/tegridy-amm/tests/tegridy-launch-migration.test.ts\n`)).toEqual([]);
    expect(repinAlone(`${pin}M\tfrontend/src/App.tsx\n`).join('\n')).toContain('frontend/src/App.tsx: this pull request changes solana/guards/upstream/cp-swap.diff');
    expect(repinAlone('M\tsolana/guards/allowed-keys.json\nM\t.github/workflows/ci.yml\n')).toHaveLength(1);
    expect(repinAlone('A\tsolana/guards/key-guard.mjs\nM\tfrontend/src/App.tsx\n')).toEqual([]);
  });
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
