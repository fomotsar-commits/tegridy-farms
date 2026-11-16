// Start-up refusals: OneDrive paths, @noble resolving outside this folder or at another
// version, a mutation run's leftovers, and live mode's git checks (clean tree, HEAD at the
// pinned commit, house disclosed in the registry at that commit; a missing registry file
// means "not registered").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkLiveGit, checkNoble, checkNoMutant, checkNotOneDrive, NOBLE_SPECIFIERS, NOBLE_VERSIONS, registryEntry, SIGNER_ROOT,
} from '../src/preflight.mjs';
import { HOUSE, tempDir } from './support/helpers.mjs';

const refusedBy = (r, pin) => {
  assert.equal(r.ok, false, `expected ${pin}`);
  assert.equal(r.field, pin, `expected ${pin}, got ${r.field}: ${r.reason}`);
};

test('the real install passes: every @noble entry point resolves inside tools/house-signer/node_modules at the pinned version', () => {
  assert.deepEqual(checkNoble(), { ok: true });
  assert.deepEqual(NOBLE_VERSIONS, { '@noble/curves': '1.9.1', '@noble/hashes': '1.8.0' });
  for (const spec of NOBLE_SPECIFIERS) {
    const file = new URL(import.meta.resolve(spec)).pathname;
    assert.match(decodeURIComponent(file).replace(/\\/g, '/'), /tools\/house-signer\/node_modules\/@noble\//);
  }
});

test('PIN:B.onedrive any path inside OneDrive is refused', () => {
  refusedBy(checkNotOneDrive(['C:\\Users\\someone\\OneDrive\\Desktop\\repo\\tools\\house-signer']), 'B.onedrive');
  refusedBy(checkNotOneDrive(['C:\\x', 'C:\\Users\\someone\\onedrive - Company\\keys']), 'B.onedrive');
  assert.deepEqual(checkNotOneDrive([SIGNER_ROOT, 'C:\\Users\\someone\\evm-keys\\house-bidder']), { ok: true });
});

test('PIN:B.nobleOutside a @noble module found anywhere else (a parent node_modules, a planted copy) is refused', () => {
  const outside = pathToFileURL(path.join(SIGNER_ROOT, '..', '..', 'frontend', 'node_modules', '@noble', 'curves', 'esm', 'secp256k1.js')).href;
  refusedBy(checkNoble({ resolve: () => outside }), 'B.nobleOutside');
  const sibling = pathToFileURL(path.join(SIGNER_ROOT, 'node_modules_evil', '@noble', 'hashes', 'esm', 'sha3.js')).href;
  refusedBy(checkNoble({ resolve: () => sibling }), 'B.nobleOutside');
});

test('PIN:B.nobleVersion an installed @noble at another version is refused', () => {
  const readFile = (f) => (f.includes(`${path.sep}curves${path.sep}`) ? JSON.stringify({ version: '1.9.2' }) : JSON.stringify({ version: '1.8.0' }));
  refusedBy(checkNoble({ readFile }), 'B.nobleVersion');
  refusedBy(checkNoble({ readFile: () => { throw new Error('missing'); } }), 'B.nobleVersion');
});

test('PIN:B.mutant a mutation run cut short (its backups left behind) blocks start-up', () => {
  const root = tempDir('mutant');
  try {
    assert.deepEqual(checkNoMutant(root), { ok: true });
    fs.mkdirSync(path.join(root, 'test', '.mutate-backup'), { recursive: true });
    assert.deepEqual(checkNoMutant(root), { ok: true }, 'an empty folder is fine');
    fs.writeFileSync(path.join(root, 'test', '.mutate-backup', 'policy.mjs'), 'x');
    refusedBy(checkNoMutant(root), 'B.mutant');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const PIN = 'a'.repeat(40);
const registry = (wallets) => JSON.stringify({ version: 1, note: 'test', wallets });
function fakeGit({ status = '', head = PIN, registryText = registry([{ address: HOUSE, label: 'House bidder', collections: ['junglebay', 'gnssart'], since: '2026-11-16' }]) } = {}) {
  return (args) => {
    if (args[0] === 'status') return status;
    if (args[0] === 'rev-parse') return `${head}\n`;
    if (args[0] === 'show') {
      assert.equal(args[1], `${PIN}:frontend/src/lib/house/houseRegistry.json`, 'the registry is read at the pinned commit');
      if (registryText === null) throw new Error("fatal: path 'frontend/src/lib/house/houseRegistry.json' does not exist");
      return registryText;
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}
const live = (git, extra = {}) => checkLiveGit({ git, pinCommit: PIN, house: HOUSE, enabledSlugs: ['junglebay'], ...extra });

test('live mode passes on a clean tree at the pin with the house registered', () => {
  assert.deepEqual(live(fakeGit()), { ok: true });
});

test('PIN:B.pinFormat HOUSE_PIN_COMMIT must be a full commit hash', () => {
  refusedBy(live(fakeGit(), { pinCommit: 'abc123' }), 'B.pinFormat');
  refusedBy(live(fakeGit(), { pinCommit: null }), 'B.pinFormat');
});

test('PIN:B.dirty a changed or untracked file refuses live mode', () => {
  refusedBy(live(fakeGit({ status: ' M tools/house-signer/src/policy.mjs\n' })), 'B.dirty');
  refusedBy(live(fakeGit({ status: '?? tools/house-signer/src/extra.mjs\n' })), 'B.dirty');
});

test('PIN:B.pin a HEAD other than HOUSE_PIN_COMMIT refuses live mode', () => {
  refusedBy(live(fakeGit({ head: 'b'.repeat(40) })), 'B.pin');
});

test('PIN:B.registry a house not in the registry at the pin refuses live mode; a missing registry file means not registered', () => {
  refusedBy(live(fakeGit({ registryText: null })), 'B.registry');
  refusedBy(live(fakeGit({ registryText: registry([]) })), 'B.registry');
  refusedBy(live(fakeGit({ registryText: registry([{ address: '0x2222222222222222222222222222222222222222', collections: ['junglebay'] }]) })), 'B.registry');
  refusedBy(live(fakeGit({ registryText: '{broken' })), 'B.registry');
});

test('PIN:B.registryCollections the registry must disclose every collection the policy enables', () => {
  refusedBy(live(fakeGit({ registryText: registry([{ address: HOUSE, collections: ['gnssart'] }]) })), 'B.registryCollections');
});

test('registry lookups are case-insensitive and ignore junk entries', () => {
  const text = registry([null, { address: 'nope' }, { address: HOUSE.toUpperCase().replace('0X', '0x'), collections: [] }]);
  assert.ok(registryEntry(text, HOUSE));
  assert.equal(registryEntry('[]', HOUSE), null);
});
