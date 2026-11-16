#!/usr/bin/env node
// house-signer: create the house key, serve the signer, send the kill, read status.
//
//   node src/cli.mjs create  [--keys <dir>]
//   node src/cli.mjs address [--keys <dir>]
//   node src/cli.mjs serve   [--keys <dir>] [--dev] [--pipe <path>]
//   node src/cli.mjs kill    [--keys <dir>] [--dev]
//   node src/cli.mjs status  [--keys <dir>]
//
// The start-up refusals (preflight.mjs) run before any module that uses @noble is loaded,
// which is why those modules are imported with `await import(...)` further down.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLiveGit, checkNoble, checkNoMutant, checkNotOneDrive, SIGNER_ROOT } from './preflight.mjs';
import { defaultKeysDir, readEnv, readPolicyFile } from './config.mjs';
import { promptHidden } from './tty.mjs';

const COMMANDS = ['create', 'address', 'serve', 'kill', 'status'];
const USAGE = `usage: node src/cli.mjs <${COMMANDS.join('|')}> [--keys <dir>] [--dev] [--pipe <path>]
  create   make a new house key (password typed twice), print its address only
  address  print the address keystore.json holds
  serve    decrypt the key and answer the bot on \\\\.\\pipe\\house-signer (--dev: skip the
           live checks; sends only to a local test chain)
  kill     decrypt the key and send the kill now: revoke WETH, bump the Seaport counter,
           revoke NFT approvals; waits until mined
  status   the house's nonce, Seaport counter, WETH balance and allowance (no password)`;

export function parseArgs(argv) {
  const out = { command: null, keys: null, dev: false, pipe: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keys' || a === '--pipe') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = v;
    } else if (a === '--dev') {
      out.dev = true;
    } else if (a.startsWith('-')) {
      // Deliberately no --password: see tty.mjs.
      throw new Error(`unknown option ${a}`);
    } else if (out.command === null) {
      out.command = a;
    } else {
      throw new Error(`unexpected argument ${a}`);
    }
  }
  if (!COMMANDS.includes(out.command)) throw new Error(USAGE);
  if (out.dev && !['serve', 'kill'].includes(out.command)) throw new Error('--dev only applies to serve and kill');
  if (out.pipe && out.command !== 'serve') throw new Error('--pipe only applies to serve');
  return out;
}

// Errors end main() by throwing; the process then exits on its own with the exit code set.
// Not process.exit(): on Windows, exiting while fetch still holds a socket trips a libuv
// assertion (src\win\async.c) and the process dies with 127 instead of its real code.
class Stop extends Error {}

function fail(message) {
  throw new Stop(message);
}

function must(result) {
  if (!result.ok) fail(`refused (${result.field}): ${result.reason}`);
}

const git = (args) => execFileSync('git', args, { cwd: SIGNER_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

async function loadPolicy(keysDir) {
  const { validatePolicy } = await import('./policy.mjs');
  const { raw, sha256 } = readPolicyFile(keysDir);
  const v = validatePolicy(raw);
  must(v);
  return { policy: v.policy, policySha256: sha256 };
}

async function decryptHouseKey(keysDir) {
  const { decryptKeystore, KEYSTORE_FILE } = await import('./keystore.mjs');
  const file = path.join(keysDir, KEYSTORE_FILE);
  if (!fs.existsSync(file)) fail(`${file} is missing; run the create command first`);
  const password = await promptHidden('house key password: ');
  return decryptKeystore(fs.readFileSync(file, 'utf8'), password);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keysDir = path.resolve(args.keys ?? defaultKeysDir());
  must(checkNotOneDrive([SIGNER_ROOT, process.cwd(), keysDir]));
  must(checkNoMutant());
  must(checkNoble());

  if (args.command === 'create') {
    const { createKeystoreFile, passwordProblem } = await import('./keystore.mjs');
    fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    const first = await promptHidden('new house key password: ');
    const problem = passwordProblem(first);
    if (problem) fail(problem);
    const second = await promptHidden('the same password again: ');
    if (first !== second) fail('the two passwords differ; nothing was created');
    const address = await createKeystoreFile(keysDir, first);
    const { toChecksumAddress } = await import('./keccak.mjs');
    process.stdout.write(`${toChecksumAddress(address)}\n`);
    return;
  }

  if (args.command === 'address') {
    const { keystoreAddressField } = await import('./keystore.mjs');
    const { toChecksumAddress } = await import('./keccak.mjs');
    process.stdout.write(`${toChecksumAddress(keystoreAddressField(keysDir))}\n`);
    return;
  }

  const env = readEnv(keysDir, { dev: args.dev });
  const { policy, policySha256 } = await loadPolicy(keysDir);
  const { createChain } = await import('./chain.mjs');
  const chain = createChain({ readUrls: env.readUrls, sendUrls: env.sendUrls });

  if (args.command === 'status') {
    const [latest, counter, weth, allowance] = await Promise.all([
      chain.nonce(policy.house, 'latest'), chain.counter(policy.house), chain.wethBalance(policy.house), chain.wethAllowance(policy.house),
    ]);
    const { stopFilePresent } = await import('./signer.mjs');
    process.stdout.write(`${JSON.stringify({
      house: policy.house, stopped: stopFilePresent(keysDir), lastNonce: latest > 0n ? Number(latest - 1n) : null, counter: counter.toString(), wethBalance: weth.toString(), wethAllowance: allowance.toString(),
    }, null, 2)}\n`);
    return;
  }

  const live = !args.dev;
  if (args.command === 'serve' && live) {
    must(checkLiveGit({ git, pinCommit: env.pinCommit, house: policy.house, enabledSlugs: Object.values(policy.collections).filter((c) => c.enabled).map((c) => c.slug) }));
  }
  const ids = await chain.chainIds();
  const wrong = ids.filter((x) => x.chainId !== 1n);
  if (wrong.length > 0) fail(`these read endpoints are not on Ethereum mainnet: ${wrong.map((x) => x.host).join(', ')}`);

  const privateKey = await decryptHouseKey(keysDir);
  const { addressOf } = await import('./sign.mjs');
  const { createSigner } = await import('./signer.mjs');
  const house = addressOf(privateKey);
  if (house !== policy.house) {
    privateKey.fill(0);
    fail(`the keystore holds ${house}, but policy.house is ${policy.house}`);
  }
  if (live && args.command === 'serve' && (await chain.code(house)) !== '0x') {
    privateKey.fill(0);
    fail('the house address has code on chain (an EIP-7702 delegation?); refusing to serve');
  }
  const log = (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  const signer = createSigner({
    privateKey, policy, policySha256, keysDir, chain, sendUrls: env.sendUrls, mode: live ? 'live' : 'dev', pinCommit: live ? env.pinCommit : null, version: JSON.parse(fs.readFileSync(path.join(SIGNER_ROOT, 'package.json'), 'utf8')).version, log,
  });

  if (args.command === 'kill') {
    log(`sending the kill for ${house}`);
    const res = await signer.handle({ id: `cli-kill-${Date.now()}`, op: 'kill' });
    signer.close();
    privateKey.fill(0);
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return res.ok && res.allMined ? 0 : 2;
  }

  const { startServer, defaultPipePath } = await import('./server.mjs');
  const pipePath = args.pipe ?? defaultPipePath();
  const srv = await startServer({ pipePath, handle: signer.handle, log });
  log(`house-signer ${live ? 'LIVE' : 'dev'} for ${house}, policy sha256 ${policySha256.slice(0, 16)}..., ${live ? `pin ${env.pinCommit.slice(0, 12)}` : 'no pin'}`);
  const shutdown = async () => {
    await srv.close();
    signer.close();
    privateKey.fill(0);
    log('stopped');
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return undefined;
}

// Run main() only when started as a program, so tests can import parseArgs.
const self = fileURLToPath(import.meta.url);
const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]).toLowerCase() === self.toLowerCase();
if (invokedDirectly) {
  main().then(
    (code) => {
      if (code !== undefined) process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`house-signer: ${e?.message ?? String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
