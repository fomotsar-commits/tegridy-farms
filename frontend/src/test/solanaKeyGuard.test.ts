// @vitest-environment node
//
// solana/guards/key-guard.mjs keeps every key in the four Solana programs (both pool copies,
// tegridy-launch, bayla-ladder) the venue's own or a named system address, and refuses any key
// the pinned upstream hard-codes (solana/guards/upstream/deny-keys.txt). This file pins its rules
// on fixtures and holds the allow-list exact against the real tree; solanaGuardTampers.test.ts
// holds every disguise an outside check tried.

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  decodeKey,
  findKeys,
  scanTree,
  judge,
  placeholderGate,
  testChainGate,
  readDeny,
  ancestorConfig,
  rustDisguises,
  cargoManifest,
  tomlKeys,
  buildFlags,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs guard script, deliberately untyped and outside src/
} from '../../../solana/guards/key-guard.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ALLOW = JSON.parse(readFileSync(join(REPO_ROOT, 'solana', 'guards', 'allowed-keys.json'), 'utf-8'));
const DENY: string[] = readDeny(readFileSync(join(REPO_ROOT, 'solana', 'guards', 'upstream', 'deny-keys.txt'), 'utf-8'));

const VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
const RAYDIUM_ADMIN = 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ';
const STRANGER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const PLACEHOLDER = 'RangePoo1PLACEHo1DERnotDep1oyed111111111111';

const made: string[] = [];
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'keyguard-'));
  made.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const UPSTREAM = () => ({ up: scanTree(tree({ 'src/lib.rs': `pubkey!("${RAYDIUM_ADMIN}")` })) });
const allowOnly = (ours: Record<string, string>) => ({ ours });

describe('what counts as a key', () => {
  it('decodes 32-byte keys and nothing shorter', () => {
    expect(decodeKey(VAULT)?.length).toBe(32);
    expect(decodeKey(PLACEHOLDER)?.length).toBe(32);
    expect(decodeKey('11111111111111111111111111111111')?.length).toBe(32);
    expect(decodeKey('MissingTickArrayBitmapExtensionAccount')).toBeNull();
    expect(decodeKey('0OIl')).toBeNull();
  });

  it('finds keys in code and comments, and a key glued to other letters', () => {
    expect(findKeys(`a = pubkey!("${VAULT}"); // ${STRANGER}`).keys).toEqual([VAULT, STRANGER]);
    // 0, l, I, O and _ are not base58, so a key beside one is still a whole key.
    expect(findKeys(`"0${VAULT}"[1..]`).keys).toEqual([VAULT]);
    expect(findKeys(`${VAULT}_x`).keys).toEqual([VAULT]);
    // Glued to a base58 letter, the run is longer than a key: refused, never skipped.
    expect(findKeys(`x${VAULT}`)).toEqual({ keys: [], hidden: [`x${VAULT}`] });
    expect(findKeys('MissingTickArrayBitmapExtensionAccount')).toEqual({ keys: [], hidden: [] });
  });
});

describe('a key in disguise is still a key', () => {
  const bytes = Array.from(decodeKey(RAYDIUM_ADMIN) as Uint8Array);
  const hex = bytes.map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ');
  const escaped = `${RAYDIUM_ADMIN.slice(0, 25)}\\x${RAYDIUM_ADMIN.charCodeAt(25).toString(16)}${RAYDIUM_ADMIN.slice(26)}`;

  it('resolves escapes in a string', () => {
    expect(rustDisguises(`let s = "${escaped}";`).keys).toContain(RAYDIUM_ADMIN);
  });
  it('joins the halves of a concat!', () => {
    expect(rustDisguises(`let s = concat!("${RAYDIUM_ADMIN.slice(0, 20)}", "${RAYDIUM_ADMIN.slice(20)}");`).keys).toContain(RAYDIUM_ADMIN);
  });
  it('reads 32 listed numbers as a key, and refuses a 64-number list', () => {
    expect(rustDisguises(`let b = [${hex}];`).keys).toContain(RAYDIUM_ADMIN);
    expect(rustDisguises(`let b = [${bytes.join(',')}];`).keys).toContain(RAYDIUM_ADMIN);
    expect(rustDisguises(`let b = [${[...bytes, ...bytes].join(', ')}];`).problems.join('\n')).toContain('list of 64 bytes');
  });
  it('refuses a key call given anything but one plain key, and a key built from bytes', () => {
    expect(rustDisguises(`Pubkey::from_str(&s[1..])`).problems.join('\n')).toContain('something other than one plain key');
    expect(rustDisguises(`pubkey!("${VAULT}")`).problems).toEqual([]);
    expect(rustDisguises(`Pubkey::from([k; 32])`).problems.join('\n')).toContain('builds a key from bytes');
  });
  it('reads every file, and refuses a build script or a file it cannot read', () => {
    const root = tree({ 'keys.dat': `${RAYDIUM_ADMIN}\n`, 'build.rs': 'fn main() {}\n' });
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 159, 146, 150]));
    const scan = scanTree(root);
    expect([...scan.keys.keys()]).toContain(RAYDIUM_ADMIN);
    expect(scan.problems.join('\n')).toContain('build.rs: cargo reads this on its own');
    expect(scan.problems.join('\n')).toContain('blob.bin: not text');
  });
});

describe('the verdict', () => {
  it('passes a copy whose every key is allowed and none is upstream\'s', () => {
    const ours = { ours: scanTree(tree({ 'src/lib.rs': `pubkey!("${VAULT}")` })) };
    expect(judge({ ours, upstream: UPSTREAM(), allow: allowOnly({ [VAULT]: 'the venue vault' }) }).problems).toEqual([]);
  });

  it('refuses a key upstream hard-codes, even when someone lists it as ours', () => {
    const ours = { ours: scanTree(tree({ 'src/lib.rs': `pubkey!("${RAYDIUM_ADMIN}")` })) };
    const { problems } = judge({ ours, upstream: UPSTREAM(), allow: allowOnly({ [RAYDIUM_ADMIN]: 'claimed as ours' }) });
    expect(problems.join('\n')).toContain(`${RAYDIUM_ADMIN} is hard-coded by upstream`);
  });

  it('refuses a key on no list', () => {
    const ours = { ours: scanTree(tree({ 'src/a.rs': `// ${STRANGER}` })) };
    const { problems } = judge({ ours, upstream: UPSTREAM(), allow: {} });
    expect(problems.join('\n')).toContain(`${STRANGER} is on no allow-list`);
  });

  it('keeps an upstream key only in the one file it is named for', () => {
    const allow = { keptUpstream: { [RAYDIUM_ADMIN]: { why: 'kept on purpose here', only_in: ['ours/src/keep.rs'] } } };
    const ok = { ours: scanTree(tree({ 'src/keep.rs': `"${RAYDIUM_ADMIN}"` })) };
    expect(judge({ ours: ok, upstream: UPSTREAM(), allow }).problems).toEqual([]);
    const stray = { ours: scanTree(tree({ 'src/keep.rs': `"${RAYDIUM_ADMIN}"`, 'src/other.rs': `"${RAYDIUM_ADMIN}"` })) };
    expect(judge({ ours: stray, upstream: UPSTREAM(), allow }).problems.join('\n')).toContain('ours/src/other.rs');
  });

  it('keeps the list exact: an entry nothing uses, or one with no reason, fails', () => {
    const ours = { ours: scanTree(tree({ 'src/lib.rs': `pubkey!("${VAULT}")` })) };
    const unused = judge({ ours, upstream: UPSTREAM(), allow: allowOnly({ [VAULT]: 'the venue vault', [STRANGER]: 'never used anywhere' }) });
    expect(unused.problems.join('\n')).toContain(`${STRANGER} appears nowhere`);
    const bare = judge({ ours, upstream: UPSTREAM(), allow: allowOnly({ [VAULT]: '' }) });
    expect(bare.problems.join('\n')).toContain('has no explanation');
  });

  it('cannot pass on an upstream it failed to read', () => {
    const ours = { ours: scanTree(tree({ 'src/lib.rs': `pubkey!("${VAULT}")` })) };
    const empty = { up: scanTree(tree({ 'README.md': 'no keys here' })) };
    expect(judge({ ours, upstream: empty, allow: allowOnly({ [VAULT]: 'the venue vault' }) }).problems.join('\n')).toContain('deny-list would be empty');
  });

  it('refuses a key built from bytes, which no scan can read', () => {
    const ours = { ours: scanTree(tree({ 'src/lib.rs': `const K: [u8; 32] = [1; 32]; pubkey!("${VAULT}")` })) };
    expect(judge({ ours, upstream: UPSTREAM(), allow: allowOnly({ [VAULT]: 'the venue vault' }) }).problems.join('\n')).toContain('builds a key from bytes');
  });

  it('lets a release refuse the placeholder program id', () => {
    const ours = { ours: scanTree(tree({ 'src/lib.rs': `declare_id!("${PLACEHOLDER}");` })) };
    const allow = { placeholder: { [PLACEHOLDER]: 'not a real program id' } };
    expect(judge({ ours, upstream: UPSTREAM(), allow }).problems).toEqual([]);
    expect(judge({ ours, upstream: UPSTREAM(), allow, release: true }).problems.join('\n')).toContain('is the placeholder program id');
  });
});

describe('the placeholder gate', () => {
  const gated = `#[cfg(not(any(test, feature = "placeholder-id")))]\ncompile_error!("x");\ndeclare_id!("${PLACEHOLDER}");`;
  it('requires the compile_error! gate while the placeholder is declared', () => {
    expect(placeholderGate(gated, PLACEHOLDER)).toEqual([]);
    expect(placeholderGate(`declare_id!("${PLACEHOLDER}");`, PLACEHOLDER).join('\n')).toContain('without the compile_error! gate');
  });
  it('asks nothing once a real id is declared', () => {
    expect(placeholderGate(`declare_id!("${VAULT}");`, PLACEHOLDER)).toEqual([]);
  });
});

describe('the test-chain gate', () => {
  const lib = '#[cfg(all(any(feature = "devnet", feature = "localnet"), not(feature = "test-chain-keys")))]\ncompile_error!("x");';
  const toml = (extra: string) => `[features]\ndefault = []\ndevnet = []\nlocalnet = []\ntest-chain-keys = []\n${extra}\n[dependencies]\n`;
  it('requires the compile_error! gate and a test-chain-keys feature nothing else turns on', () => {
    expect(testChainGate(lib, toml(''))).toEqual([]);
    expect(testChainGate('', toml('')).join('\n')).toContain('lacks the compile_error! gate');
    expect(testChainGate(lib, '[features]\ndevnet = []\n').join('\n')).toContain('test-chain-keys = []');
  });
  it('refuses a feature, default included, that turns on devnet, localnet or the opt-in', () => {
    expect(testChainGate(lib, toml('').replace('default = []', 'default = ["devnet"]')).join('\n')).toContain('feature default turns on');
    expect(testChainGate(lib, toml('cpi = ["test-chain-keys"]')).join('\n')).toContain('feature cpi turns on');
  });
});

describe('cargo config above a program', () => {
  it('refuses a .cargo folder or a source swap between the program and the root', () => {
    const root = tree({ 'solana/.cargo/config.toml': '[source.crates-io]\n', 'solana/prog/src/lib.rs': '' });
    expect(ancestorConfig(join(root, 'solana', 'prog'), root).join('\n')).toContain('.cargo: cargo reads this');
    const patched = tree({ 'ws/Cargo.toml': '[patch.crates-io]\nuint = { path = "x" }\n', 'ws/prog/src/lib.rs': '' });
    expect(ancestorConfig(join(patched, 'ws', 'prog'), patched).join('\n')).toContain('swaps a dependency');
  });
});

describe('a Cargo.toml is read as TOML, so no spelling hides a source swap', () => {
  it('finds a [patch] table however it is written', () => {
    for (const t of [
      '[patch.crates-io]\nuint = { path = "x" }\n',
      '[ patch.crates-io ]\nuint = { path = "x" }\n',
      '[\tpatch . "crates-io" ]\nuint = { path = "x" }\n',
      '["patch".crates-io]\nuint = { path = "x" }\n',
      "['patch'.crates-io]\nuint = { path = 'x' }\n",
      '["p\\u0061tch".crates-io]\nuint = { path = "x" }\n',
      'patch.crates-io.uint = { git = "https://example.com/u" }\n[package]\nname = "a"\n',
      'patch = { crates-io = { uint = { path = "x" } } }\n',
      '[[replace]]\nx = 1\n',
    ]) {
      expect(cargoManifest(t), t).toEqual(["swaps a dependency's source"]);
    }
  });
  it('finds a build script however it is written, and passes a plain manifest', () => {
    expect(cargoManifest('[package]\n"build" = "b.rs"\n')).toEqual(['names a build script']);
    expect(cargoManifest('package.build = "b.rs"\n')).toEqual(['names a build script']);
    expect(cargoManifest('[package]\nname = "a" # x\n[dependencies]\nb = { version = "1", features = ["c"] }\nd = [\n  "e", # f\n]\n')).toEqual([]);
    expect(tomlKeys('[workspace]\nmembers = ["programs/*"]\n[profile.release]\nlto = "fat"\n')).toEqual([['workspace'], ['workspace', 'members'], ['profile', 'release'], ['profile', 'release', 'lto']]);
  });
  it('refuses a manifest it cannot read rather than passing it', () => {
    expect(cargoManifest('[patch\n').join('\n')).toContain('cannot be read as TOML');
    expect(cargoManifest('x = [\n  ["a"]\n]]\n').join('\n')).toContain('cannot be read as TOML');
  });
});

describe('shapes that build a key the scan cannot read', () => {
  it('refuses files read into the build, outside env!, renamed key types and stringify!', () => {
    const why = (t: string) => rustDisguises(t).problems.join('\n');
    expect(why('const S: &str = include_str!("../k.txt");')).toContain('not a source file beside it');
    expect(why('let src = include_str!("lib.rs");')).toBe('');
    expect(why('const B: &[u8] = include_bytes!("k.hex");')).toContain('reads a file into the build');
    expect(why('const S: &str = env!("EVIL_ADMIN");')).toContain('outside the gated localnet arm');
    expect(why('#[cfg(feature = "localnet")]\n    pub const ID: Pubkey = Pubkey::from_str_const(env!(\n        "CLMM_LOCALNET_ADMIN",\n        "x"\n    ));')).toBe('');
    expect(why('use x::Pubkey as P;')).toContain('renames the key type');
    expect(why('const K: [u8; 32 ] = [0; 32];')).toContain('builds a key from bytes');
    expect(why('pub const X: Pubkey = <Pubkey>::new_from_array(K);')).toContain('builds a key from bytes');
    expect(why('const S: &str = concat!(stringify!(abc), "d");')).toContain('turns code into text');
    expect(why('Pubkey::from_str_const(S)')).toContain('something other than one plain key');
  });
  it('reads a key split across side-by-side literals, and 32 bytes in binary or "as u8"', () => {
    const bytes = Array.from(decodeKey(RAYDIUM_ADMIN) as Uint8Array);
    expect(rustDisguises(`["${RAYDIUM_ADMIN.slice(0, 10)}",\n "${RAYDIUM_ADMIN.slice(10, 30)}", "${RAYDIUM_ADMIN.slice(30)}"].concat()`).keys).toContain(RAYDIUM_ADMIN);
    expect(rustDisguises(`let b = [${bytes.map((b) => `0b${b.toString(2)}`).join(', ')}];`).keys).toContain(RAYDIUM_ADMIN);
    expect(rustDisguises(`let b = [${bytes.map((b) => `${b} as u8`).join(', ')}];`).keys).toContain(RAYDIUM_ADMIN);
  });
  it('reads a vendor/ or target/ folder below the top of a program', () => {
    const root = tree({ 'vendor/evil/src/lib.rs': `"${RAYDIUM_ADMIN}"`, 'src/target/x.rs': `"${STRANGER}"`, 'target/out.rs': `"${VAULT}"`, 'vendor/uint/x.rs': `"${VAULT}"` });
    expect([...scanTree(root).keys.keys()].sort()).toEqual([RAYDIUM_ADMIN, STRANGER].sort());
  });
  it('refuses a build workflow that sets flags cargo compiles with', () => {
    expect(buildFlags('env:\n  RUSTFLAGS: --cfg feature="devnet"\n').join('\n')).toContain('sets RUSTFLAGS');
    expect(buildFlags('run: cargo build-sbf -- --config x').join('\n')).toContain('sets --config');
    expect(buildFlags('run: cargo build-sbf --features devnet -- --locked')).toEqual([]);
  });
});

describe('the real tree', () => {
  const PROGRAMS = ['solana/tegridy-amm/programs/cp-swap', 'solana/tegridy-clmm', 'solana/tegridy-amm/programs/tegridy-launch', 'solana/tegridy-amm/programs/bayla-ladder'];
  const OURS = Object.fromEntries(PROGRAMS.map((d) => [d, scanTree(join(REPO_ROOT, ...d.split('/')))]));

  it('every key in all four programs is on allowed-keys.json, and every entry is used', () => {
    // The same verdict CI reaches: the committed deny-list, and every allow-list entry used.
    expect(judge({ ours: OURS, deny: DENY, allow: ALLOW }).problems).toEqual([]);
  });

  it('denies the 39 keys the two pinned Raydium repositories hard-code', () => {
    expect(DENY).toHaveLength(39);
    expect(DENY).toContain(RAYDIUM_ADMIN);
    expect(DENY).toContain('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
    expect(judge({ ours: OURS, deny: DENY, allow: ALLOW }).counts).toEqual({ found: 23, deny: 39, allowed: 23 });
  });

  it('finds no cargo config, toolchain file or source swap above any program', () => {
    for (const d of PROGRAMS) expect(ancestorConfig(join(REPO_ROOT, d), REPO_ROOT)).toEqual([]);
  });

  it('finds no build flag in the two workflows that build them', () => {
    for (const w of ['solana-ci.yml', 'solana-deploy-artifact.yml']) {
      expect(buildFlags(readFileSync(join(REPO_ROOT, '.github', 'workflows', w), 'utf-8'))).toEqual([]);
    }
  });

  it('keeps the devnet and localnet gate in tegridy-clmm', () => {
    const amm = join(REPO_ROOT, 'solana', 'tegridy-clmm', 'programs', 'amm');
    expect(testChainGate(readFileSync(join(amm, 'src', 'lib.rs'), 'utf-8'), readFileSync(join(amm, 'Cargo.toml'), 'utf-8'))).toEqual([]);
  });

  it('puts the venue vault, and no Raydium key, in tegridy-clmm', () => {
    const clmm = [...OURS['solana/tegridy-clmm'].keys.keys()];
    expect(clmm).toContain(VAULT);
    expect(clmm).not.toContain(RAYDIUM_ADMIN);
    expect(clmm).not.toContain('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
  });

  it('keeps the placeholder gate in tegridy-clmm while its id is the placeholder, and none once the id is real', () => {
    const lib = readFileSync(join(REPO_ROOT, 'solana', 'tegridy-clmm', 'programs', 'amm', 'src', 'lib.rs'), 'utf-8').replace(/\r/g, '');
    // The state is read from the source: the id a build with no features compiles.
    const release = /#\[cfg\(not\(feature = "devnet"\)\)\]\ndeclare_id!\("(\w+)"\);/.exec(lib)?.[1];
    if (!release) throw new Error('lib.rs has no declare_id! for a build with no features');
    if (release === PLACEHOLDER) {
      expect(placeholderGate(lib, PLACEHOLDER)).toEqual([]);
      return;
    }
    // After solana/clmm-deploy/program-id-change.mjs: the owner's id, no placeholder anywhere, no
    // gate left, and a devnet build's id that is not the release's.
    const devnet = /#\[cfg\(feature = "devnet"\)\]\ndeclare_id!\("(\w+)"\);/.exec(lib)?.[1];
    expect(ALLOW.ours[release]).toBeTruthy();
    expect(devnet).toBeTruthy();
    expect(devnet).not.toBe(release);
    expect(lib).not.toContain(PLACEHOLDER);
    expect(JSON.stringify(ALLOW)).not.toContain(PLACEHOLDER);
    expect(lib).not.toMatch(/placeholder-id/);
  });
});
