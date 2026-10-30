// WEEK 1 IS WATCH-ONLY, and this file is what keeps it so.
//
// The keeper is meant to go live later, with a key the owner creates and funds
// himself. Until he says so, nothing the keeper runs may be able to sign or send.
// This is an ALLOWLIST where it can be and a ban list where it cannot:
//   - network calls only from rpc.js, jupiter.js, alert.js and the fixture recorder;
//   - only four hosts, and on Jupiter only the three read paths the keeper uses;
//   - both RPC clients have a closed list of read methods;
//   - no npm package, no dynamic import, require, eval, child process, crypto
//     signing or environment trickery in any file the keeper runs, and that
//     includes the site's math.ts, which it imports;
//   - the known constructs that produce or use a signing key, nowhere in keeper/.
// A ban list cannot see every possible spelling, so this is "the known ways", and
// review still matters. Going live is a deliberate edit to THIS file, in its own
// reviewed change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_METHODS, makeRpc } from '../src/rpc.js';
import { readEnv } from '../src/config.js';
import { pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO = resolve(ROOT, '..');
const THIS = fileURLToPath(import.meta.url);
const CODE = /\.(c|m)?(j|t)s$/;

function files(dir, pattern = /\.((c|m)?(j|t)s|json)$/) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'log') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, pattern));
    else if (pattern.test(name)) out.push(p);
  }
  return out;
}

/** Every file the keeper runs: src/ and scripts/, and whatever they import, followed to the end. */
function reached() {
  const seen = new Set();
  const queue = [...files(join(ROOT, 'src'), CODE), ...files(join(ROOT, 'scripts'), CODE)];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(/(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
      if (!m[1].startsWith('.')) continue;
      const target = resolve(dirname(f), m[1]);
      assert.ok(existsSync(target), `${relative(REPO, f)} imports ${m[1]}, which does not exist`);
      queue.push(target);
    }
  }
  return [...seen];
}

/** Constructs that produce, unlock or use a signing key. */
const KEY_CONSTRUCTS = [
  /new\s+Wallet\s*\(/,
  /Wallet\.(fromPhrase|fromEncryptedJson|createRandom)\s*\(/,
  /HDNodeWallet\./,
  /privateKeyToAccount\s*\(/,
  /mnemonicToAccount\s*\(/,
  /mnemonicToSeed(Sync)?\s*\(/,
  /generateMnemonic\s*\(/,
  /Keypair\.(fromSecretKey|fromSeed|generate)\s*\(/,
  /\.signTransaction\s*\(/,
  /\.signAllTransactions\s*\(/,
  /\.signTypedData\s*\(/,
  /\.sendTransaction\s*\(/,
  /createECDH\s*\(/,
  /generateKeyPair(Sync)?\s*\(/,
  /createPrivateKey\s*\(/,
  /\bsubtle\b/,
];
/** Ways to put a transaction on the chain. */
const SEND_CONSTRUCTS = [/sendTransaction/, /sendRawTransaction/, /requestAirdrop/, /sendBundle/, /\/execute\b/, /simulateTransaction/, /\/ultra\b/, /\/order\b/, /\/trigger\b/];
/** Identifiers being assigned key material. */
const KEY_ASSIGNMENTS = [/\bprivateKey\s*[:=]/, /\bsecretKey\s*[:=]/, /\bsecret_key\s*[:=]/, /\bmnemonic\s*[:=]/, /\bseedPhrase\s*[:=]/, /\bkeypair\s*[:=]/i];
/** Ways around the checks above, banned in every file the keeper runs. */
const ESCAPES = [
  /child_process/,
  /['"](node:)?crypto['"]/,
  /\beval\s*\(/,
  /new\s+Function\b/,
  /\bFunction\s*\(/,
  /\bimport\s*\(/,
  /createRequire/,
  /\brequire\s*\(/,
  /process\.env\s*\[/,
  /\}\s*=\s*process\.env\b/,
  /['"`][^'"`]*keypair[^'"`]*\.json/i,
];

test('no file under keeper/ names a known way to produce or use a signing key', () => {
  const hits = [];
  for (const f of files(ROOT)) {
    if (f === THIS) continue; // this file names the patterns it bans
    const src = readFileSync(f, 'utf8');
    for (const re of [...KEY_CONSTRUCTS, ...KEY_ASSIGNMENTS]) if (re.test(src)) hits.push(`${relative(REPO, f)}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('nothing the keeper runs can send, sign, or reach around these checks', () => {
  const run = reached();
  assert.ok(run.some((f) => f.endsWith(join('cpswap', 'math.ts'))), 'the walk must reach the site’s math.ts');
  const hits = [];
  for (const f of run) {
    const src = readFileSync(f, 'utf8');
    for (const re of [...KEY_CONSTRUCTS, ...SEND_CONSTRUCTS, ...KEY_ASSIGNMENTS, ...ESCAPES]) if (re.test(src)) hits.push(`${relative(REPO, f)}: ${re}`);
    // Every import is relative or node's own: no npm package, anywhere the walk goes.
    for (const m of src.matchAll(/(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
      if (!m[1].startsWith('.') && !m[1].startsWith('node:')) hits.push(`${relative(REPO, f)} imports ${m[1]}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('the site’s math.ts imports nothing at all', () => {
  const math = readFileSync(join(REPO, 'frontend', 'src', 'lib', 'solana', 'cpswap', 'math.ts'), 'utf8');
  assert.equal(/(^|\n)\s*import\b|\brequire\s*\(|\bimport\s*\(/.test(math), false);
});

test('network calls come only from the four files allowed to make them, to four hosts', () => {
  const allowedCallers = ['src/rpc.js', 'src/jupiter.js', 'src/alert.js', 'scripts/record-fixtures.mjs'].map((p) => join(ROOT, p));
  const hosts = new Set(['api.mainnet-beta.solana.com', 'api.jup.ag', 'lite-api.jup.ag', 'api.telegram.org']);
  const hits = [];
  for (const f of reached()) {
    const src = readFileSync(f, 'utf8');
    if (/\bfetch(Impl)?\s*\(/.test(src) && !allowedCallers.includes(f)) hits.push(`${relative(REPO, f)} makes a network call`);
    if (/\bnode:(http|https|net|tls|dgram)\b|WebSocket/.test(src)) hits.push(`${relative(REPO, f)} opens its own connection`);
    for (const m of src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) if (!hosts.has(m[1])) hits.push(`${relative(REPO, f)} names host ${m[1]}`);
  }
  assert.deepEqual(hits, []);
  // Only the watch's own log writes a file. The fixture recorder PRINTS what it checked
  // (CodeQL js/http-to-file-access): network data reaches disk only by the operator's redirect.
  const writers = reached().filter((f) => /\b(writeFile|appendFile|createWriteStream|copyFile|rename)(Sync)?\s*\(/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(writers.map((f) => relative(ROOT, f).replace(/\\/g, '/')), ['src/watch.js']);
  // On Jupiter, only the three read paths; on Telegram, only sendMessage.
  const jup = readFileSync(join(ROOT, 'src', 'jupiter.js'), 'utf8');
  const paths = new Set([...jup.matchAll(/\/swap\/v\d\/[\w-]+/g)].map((m) => m[0]));
  assert.deepEqual([...paths].sort(), ['/swap/v1/program-id-to-label', '/swap/v1/quote', '/swap/v2/build']);
  const tg = readFileSync(join(ROOT, 'src', 'alert.js'), 'utf8');
  assert.deepEqual([...new Set([...tg.matchAll(/\/bot\$\{token\}\/(\w+)/g)].map((m) => m[1]))], ['sendMessage']);
});

test('the keeper ships no npm dependency at all', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
    assert.equal(pkg[k], undefined, `package.json has ${k}`);
  }
  for (const s of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts?.[s], undefined, `package.json runs ${s}`);
});

test('both RPC clients can only read, and refuse a write before anything leaves', async () => {
  assert.deepEqual([...ALLOWED_METHODS].sort(), ['getAccountInfo', 'getMultipleAccounts', 'getSlot']);
  // The recorder is read as text, never imported here: it is a script that talks to mainnet.
  const recorder = readFileSync(join(ROOT, 'scripts', 'record-fixtures.mjs'), 'utf8');
  const list = recorder.match(/export const READ_METHODS = Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(list, 'the recorder no longer declares READ_METHODS');
  const methods = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(methods, ['getAccountInfo', 'getMultipleAccounts', 'getSignaturesForAddress', 'getTransaction']);
  assert.match(recorder, /if \(!READ_METHODS\.includes\(method\)\) throw/);
  let sent = 0;
  const rpc = makeRpc('http://unused', { fetchImpl: async () => { sent++; return new Response('{}'); } });
  for (const m of ['sendTransaction', 'simulateTransaction', 'requestAirdrop']) {
    await assert.rejects(rpc(m, []), /does not call/);
  }
  assert.equal(sent, 0);
});

test('loading any keeper file makes no network call: tests and imports stay off the network', async () => {
  // The fixture recorder once ran in full when this file imported it, so every test
  // run re-recorded mainnet. Every module under src/ and scripts/ is loaded here with
  // fetch switched off; only starting a script on purpose may reach the network.
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('no network while loading');
  };
  try {
    for (const f of [...files(join(ROOT, 'src'), CODE), ...files(join(ROOT, 'scripts'), CODE)]) {
      await import(`${pathToFileURL(f).href}?load-only`);
    }
    await new Promise((r) => setTimeout(r, 50)); // let any stray top-level promise start
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(calls, 0);
});

test('the keeper reads no key from its environment', () => {
  const names = new Set();
  for (const f of reached()) {
    for (const m of readFileSync(f, 'utf8').matchAll(/env\.([A-Z0-9_]+)/g)) names.add(m[1]);
  }
  assert.deepEqual([...names].sort(), ['JUPITER_API_KEY', 'KEEPER_INTERVAL_SECONDS', 'KEEPER_LOG_DIR', 'KEEPER_RPC_URL', 'KEEPER_TAKER', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  const env = readEnv({ KEEPER_TAKER: 'x', SOLANA_PRIVATE_KEY: 'should-be-ignored' });
  assert.equal(JSON.stringify(env).includes('should-be-ignored'), false);
});
