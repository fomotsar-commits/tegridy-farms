// @vitest-environment node
//
// solana/guards/key-guard.mjs keeps every key in our copies of the two pool programs
// (cp-swap and tegridy-clmm) the venue's own or a named system address, and refuses any key
// the pinned upstream hard-codes. solana-ci runs it against fresh upstream clones; this file
// pins its rules on fixtures and holds the allow-list exact against the real tree.

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
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs guard script, deliberately untyped and outside src/
} from '../../../solana/guards/key-guard.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ALLOW = JSON.parse(readFileSync(join(REPO_ROOT, 'solana', 'guards', 'allowed-keys.json'), 'utf-8'));

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

  it('finds keys in code and comments, never inside a longer word', () => {
    expect(findKeys(`a = pubkey!("${VAULT}"); // ${STRANGER}`)).toEqual([VAULT, STRANGER]);
    expect(findKeys(`x${VAULT}`)).toEqual([]);
    expect(findKeys(`${VAULT}0`)).toEqual([]);
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

describe('the real tree', () => {
  const OURS = {
    'solana/tegridy-amm/programs/cp-swap': scanTree(join(REPO_ROOT, 'solana', 'tegridy-amm', 'programs', 'cp-swap')),
    'solana/tegridy-clmm': scanTree(join(REPO_ROOT, 'solana', 'tegridy-clmm')),
  };

  it('every key in both copies is on allowed-keys.json, and every entry is used', () => {
    // CI judges against real upstream clones; here the deny-list is one Raydium key, so this
    // pins the allow-list itself.
    expect(judge({ ours: OURS, upstream: UPSTREAM(), allow: ALLOW }).problems).toEqual([]);
  });

  it('puts the venue vault, and no Raydium key, in tegridy-clmm', () => {
    const clmm = [...OURS['solana/tegridy-clmm'].keys.keys()];
    expect(clmm).toContain(VAULT);
    expect(clmm).not.toContain(RAYDIUM_ADMIN);
    expect(clmm).not.toContain('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
  });

  it('keeps the placeholder gate in tegridy-clmm while its id is the placeholder', () => {
    const lib = readFileSync(join(REPO_ROOT, 'solana', 'tegridy-clmm', 'programs', 'amm', 'src', 'lib.rs'), 'utf-8');
    expect(placeholderGate(lib, Object.keys(ALLOW.placeholder)[0])).toEqual([]);
  });
});
