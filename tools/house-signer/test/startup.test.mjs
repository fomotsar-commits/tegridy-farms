// What the signer checks, shows and asks before it serves: the read endpoints' chain, that
// --dev never holds the real house key, and the limits the owner confirms by typing yes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkDevKeys, checkReadEndpoints, SIGNER_ROOT } from '../src/preflight.mjs';
import { checkConfirmation, limitsSummary } from '../src/policy.mjs';
import { FUNDING, HOUSE, makePolicy, rawPolicy, tempDir } from './support/helpers.mjs';

const refusedBy = (r, pin) => {
  assert.equal(r.ok, false, `expected ${pin}`);
  assert.equal(r.field, pin, `expected ${pin}, got ${r.field}: ${r.reason}`);
};

// --- read endpoints ---------------------------------------------------------------------

test('PIN:B.chainId a read endpoint that answers with another chain id refuses start-up', () => {
  refusedBy(checkReadEndpoints([{ host: 'a.example', chainId: 1n }, { host: 'b.example', chainId: 11155111n }]), 'B.chainId');
});

test('PIN:B.chainNone start-up needs at least one read endpoint to answer', () => {
  refusedBy(checkReadEndpoints([{ host: 'a.example', chainId: null, error: 'a.example: could not be reached' }]), 'B.chainNone');
});

test('a read endpoint that does not answer is left out, not fatal: one provider\'s outage must not stop the kill', () => {
  const r = checkReadEndpoints([{ host: 'up.example', chainId: 1n }, { host: 'down.example', chainId: null, error: 'down.example: could not be reached' }]);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.skipped.map((s) => s.host), ['down.example']);
});

// --- --dev never holds the real house key -----------------------------------------------

const DEFAULT_KEYS = path.join('C:\\Users\\someone', 'evm-keys', 'house-bidder');
const registry = (wallets) => JSON.stringify({ version: 1, note: 'test', wallets });

test('PIN:B.devDefault --dev never runs on the default keys folder, where the real house key lives', () => {
  refusedBy(checkDevKeys({ keysDir: DEFAULT_KEYS, defaultKeysDir: DEFAULT_KEYS, house: HOUSE }), 'B.devDefault');
  refusedBy(checkDevKeys({ keysDir: `${DEFAULT_KEYS.toUpperCase()}${path.sep}`, defaultKeysDir: DEFAULT_KEYS, house: HOUSE }), 'B.devDefault');
  assert.deepEqual(checkDevKeys({ keysDir: path.join('C:\\dev', 'throwaway-keys'), defaultKeysDir: DEFAULT_KEYS, house: HOUSE, registryTexts: [registry([])] }), { ok: true });
});

test('PIN:B.devRegistry --dev refuses a house the site\'s registry lists', () => {
  const listed = registry([{ address: HOUSE, label: 'House bidder', collections: ['junglebay'] }]);
  refusedBy(checkDevKeys({ keysDir: path.join('C:\\dev', 'keys'), defaultKeysDir: DEFAULT_KEYS, house: HOUSE, registryTexts: [registry([]), listed] }), 'B.devRegistry');
});

test('PIN:B.devDefault serve --dev on the default keys folder is refused before the password is asked', () => {
  // A home folder of its own, so "the default keys folder" is a temp one with a test key's policy.
  const home = tempDir('home');
  const keys = path.join(home, 'evm-keys', 'house-bidder');
  fs.mkdirSync(keys, { recursive: true });
  fs.writeFileSync(path.join(keys, 'house-bidder.env'), 'HOUSE_RPC_HTTP=http://127.0.0.1:9\nHOUSE_SEND_URLS=http://127.0.0.1:9\n');
  fs.writeFileSync(path.join(keys, 'policy.json'), JSON.stringify(rawPolicy()));
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [path.join(SIGNER_ROOT, 'src', 'cli.mjs'), 'serve', '--dev'], { cwd: SIGNER_ROOT, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 1, `${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /refused \(B\.devDefault\)/);
  assert.doesNotMatch(r.stderr, /password/);
});

// --- the limits the owner confirms --------------------------------------------------------

test('the start-up summary shows in full what the live signer enforces: funding wallet, each enabled collection\'s ceiling, quantity and inventory cap, the approval cap and the fee lines', () => {
  const policy = makePolicy((p) => {
    p.collections.junglebay.creatorFee = { recipient: '0xa3cc58eaa3800dc163726e031a2da49a9bb64eb3', bps: 700 };
    p.venueFee = { recipient: '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d', bps: 50 };
  });
  const text = limitsSummary(policy, { pinCommit: 'c'.repeat(40) });
  assert.ok(text.includes(FUNDING), 'the funding wallet, all 40 hex digits');
  assert.ok(text.toLowerCase().includes(HOUSE.toLowerCase()), 'the house');
  assert.ok(text.includes('c'.repeat(40)), 'the whole pinned commit');
  assert.match(text, /junglebay.*45000000000000000 wei.*at most 2 per bid.*holds at most 3/);
  assert.match(text, /gnssart.*switched off/);
  assert.match(text, /150000000000000000 wei/);
  assert.match(text, /OpenSea 1% to 0x0000a26b00c1F0DF003000390027140000fAa719/);
  assert.match(text, /creator 7% to 0xA3cc58eaa3800Dc163726e031a2DA49a9bb64Eb3/);
  assert.match(text, /venue 0\.5% to 0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d/);
  assert.match(text, /20 transactions/);
});

test('PIN:B.confirm the live signer serves only after the owner types yes', () => {
  assert.equal(checkConfirmation('yes').ok, true);
  assert.equal(checkConfirmation(' YES ').ok, true);
  for (const typed of ['', 'y', 'no', 'yes please', 'ye s']) refusedBy(checkConfirmation(typed), 'B.confirm');
});
