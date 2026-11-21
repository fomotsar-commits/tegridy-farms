// Start-up refusals, run before the key is decrypted and before any @noble code loads.
//
// This file imports nothing from @noble on purpose: one of its jobs is to prove that
// @noble/curves and @noble/hashes resolve inside tools/house-signer/node_modules (the
// pinned, lockfile-installed copies) and not from some other node_modules up the tree,
// where a different version, or a planted one, could be waiting. cli.mjs loads every
// module that uses noble only after these checks pass.
//
// Live mode also refuses a git tree with any change in it, a HEAD that is not the commit
// the owner pinned (HOUSE_PIN_COMMIT), and a house address the site does not disclose in
// frontend/src/lib/house/houseRegistry.json at that commit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAddress, isPlainObject } from './hex.mjs';

export const SIGNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Every @noble entry point the signer imports.
export const NOBLE_SPECIFIERS = Object.freeze(['@noble/curves/secp256k1.js', '@noble/hashes/sha3.js', '@noble/hashes/scrypt.js']);
export const NOBLE_VERSIONS = Object.freeze({ '@noble/curves': '1.9.1', '@noble/hashes': '1.8.0' });
export const REGISTRY_PATH = 'frontend/src/lib/house/houseRegistry.json';

function no(field, reason) {
  return { ok: false, field, reason };
}

const realpathOr = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
};

/** OneDrive syncs, versions and can roll back files: no key, ledger or signer code may live there. */
export function checkNotOneDrive(paths) {
  for (const p of paths) {
    if (/onedrive/i.test(p) || /onedrive/i.test(realpathOr(p))) return no('B.onedrive', `${p} is inside OneDrive; run the signer and keep its keys outside OneDrive`); // PIN:B.onedrive
  }
  return { ok: true };
}

/**
 * Each noble specifier must resolve to a file under <signerRoot>/node_modules/@noble/ (after
 * following links), and the installed versions must be the pinned ones.
 */
export function checkNoble({ resolve = (spec) => import.meta.resolve(spec), signerRoot = SIGNER_ROOT, readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const root = path.join(realpathOr(signerRoot), 'node_modules', '@noble') + path.sep;
  for (const spec of NOBLE_SPECIFIERS) {
    let file;
    try {
      file = realpathOr(fileURLToPath(resolve(spec)));
    } catch {
      return no('dependencies', `${spec} does not resolve; run npm ci --ignore-scripts in tools/house-signer`);
    }
    if (!file.toLowerCase().startsWith(root.toLowerCase())) return no('B.nobleOutside', `${spec} resolves outside tools/house-signer/node_modules (${file}); refusing to load it`); // PIN:B.nobleOutside
  }
  for (const [name, want] of Object.entries(NOBLE_VERSIONS)) {
    let version = null;
    try {
      version = JSON.parse(readFile(path.join(signerRoot, 'node_modules', name, 'package.json'))).version;
    } catch { /* reported below */ }
    if (version !== want) return no('B.nobleVersion', `${name} is ${version ?? 'missing'}, the lockfile pins ${want}; run npm ci --ignore-scripts`); // PIN:B.nobleVersion
  }
  return { ok: true };
}

/** A mutation run that was cut short leaves its backups (and possibly a mutant) behind. */
export function checkNoMutant(signerRoot = SIGNER_ROOT) {
  const dir = path.join(signerRoot, 'test', '.mutate-backup');
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) return no('B.mutant', 'test/.mutate-backup exists: a mutation run was cut short and src/ may hold a mutant; run node test/mutate.mjs --restore'); // PIN:B.mutant
  return { ok: true };
}

/**
 * The read endpoints' chain ids (chain.chainIds()). One that answers with another chain is
 * refused; one that does not answer is skipped, so an outage at one provider cannot stop the
 * kill; at least one must answer. Only the endpoints that answered 1 are used afterwards.
 */
export function checkReadEndpoints(ids) {
  const wrong = ids.filter((x) => x.chainId !== null && x.chainId !== 1n);
  if (wrong.length > 0) return no('B.chainId', `these read endpoints are not on Ethereum mainnet: ${wrong.map((x) => x.host).join(', ')}`); // PIN:B.chainId
  if (!ids.some((x) => x.chainId === 1n)) return no('B.chainNone', `no read endpoint answered (${ids.map((x) => x.error).join('; ')})`); // PIN:B.chainNone
  return { ok: true, skipped: ids.filter((x) => x.chainId === null) };
}

/**
 * --dev skips the pinned-commit and registry checks, so it must never hold the real house key:
 * it refuses the default keys folder (where the real key lives) and any house the site's
 * registry lists. A dev run uses a throwaway key in a folder of its own (--keys <dir>).
 */
export function checkDevKeys({ keysDir, defaultKeysDir, house, registryTexts = [] }) {
  const where = (p) => realpathOr(path.resolve(p)).toLowerCase();
  if (where(keysDir) === where(defaultKeysDir)) return no('B.devDefault', `--dev never uses the default keys folder (${defaultKeysDir}), which holds the real house key; give a folder with a throwaway key: --keys <dir>`); // PIN:B.devDefault
  if (registryTexts.some((text) => registryEntry(text, house))) return no('B.devRegistry', `${house} is the house wallet in the site's registry; --dev only runs with a throwaway key`); // PIN:B.devRegistry
  return { ok: true };
}

/** Parse the house registry and find this house in it. */
export function registryEntry(text, house) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(doc) || !Array.isArray(doc.wallets)) return null;
  return doc.wallets.find((w) => isPlainObject(w) && isAddress(w.address) && w.address.toLowerCase() === house.toLowerCase()) ?? null;
}

/**
 * Live-mode git checks. `git(args)` runs git in the repo and returns stdout, or throws.
 * enabledSlugs: the collections the policy lets the house bid on; the registry entry must
 * disclose every one of them.
 */
export function checkLiveGit({ git, pinCommit, house, enabledSlugs }) {
  if (typeof pinCommit !== 'string' || !/^[0-9a-f]{40}$/.test(pinCommit)) return no('B.pinFormat', 'HOUSE_PIN_COMMIT must be a full 40-character lowercase commit hash'); // PIN:B.pinFormat
  let status;
  try {
    status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  } catch {
    return no('git', 'could not run git status; live mode needs the signer to run from a git checkout');
  }
  if (status.trim() !== '') return no('B.dirty', 'the git tree has changes or untracked files; live mode only runs reviewed, committed code'); // PIN:B.dirty
  let head;
  try {
    head = git(['rev-parse', 'HEAD']).trim();
  } catch {
    return no('git', 'could not read HEAD');
  }
  if (head !== pinCommit) return no('B.pin', `HEAD is ${head}, not HOUSE_PIN_COMMIT ${pinCommit}`); // PIN:B.pin
  let text = null;
  try {
    text = git(['show', `${pinCommit}:${REGISTRY_PATH}`]);
  } catch { /* a missing registry means the house is not registered */ }
  const entry = text === null ? null : registryEntry(text, house);
  if (!entry) return no('B.registry', `${house} is not in ${REGISTRY_PATH} at ${pinCommit.slice(0, 12)}; the site must disclose the house wallet before it trades`); // PIN:B.registry
  const disclosed = Array.isArray(entry.collections) ? entry.collections : [];
  const missing = enabledSlugs.filter((s) => !disclosed.includes(s));
  if (missing.length > 0) return no('B.registryCollections', `the registry entry for the house does not list ${missing.join(', ')}, which the policy enables`); // PIN:B.registryCollections
  return { ok: true };
}
