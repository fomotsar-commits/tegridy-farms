// Loading the house bidder's settings, and every refusal to go live.
//
// The keys folder (BUILD-SPEC 2.2) holds the env file, policy.json, insiders.json, the STOP file
// and the bot's own ledger. Everything read from it is validated against the fixed facts before
// the bot does anything: a policy that names a different Seaport, fee recipient or collection
// address is refused, not "fixed". `--live` adds the checks that make a live run the run that was
// reviewed: no OneDrive (it can roll a file back), a clean git tree at the pinned commit, a house
// that the site publicly lists, no STOP, and a signer that answers for the same house and the same
// policy file.

import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { redactRpcUrl } from '../../../../scripts/lib/redact-url.mjs';
import { COLLECTIONS, OPENSEA_FEE, PRICE_TICK_WEI, SIGNER_DAILY_DEFAULT, SIGNER_MIN_GAS_LIMIT, VENUE_FEE_BPS, VENUE_FEE_SAFE, ZERO_ADDRESS } from './constants.mjs';
import { addr } from './util.mjs';

export const DEFAULT_KEYS_DIR = 'C:\\Users\\jimbo\\evm-keys\\house-bidder';

/** The creator-fee recipients OpenSea lists (2026-11-15). A creator line, if the owner turns it on, may only pay these. */
export const CREATOR_FEES = Object.freeze({
  junglebay: Object.freeze({ recipient: '0xa3cc58eaa3800dc163726e031a2da49a9bb64eb3', maxBps: 700 }),
  gnssart: Object.freeze({ recipient: '0x209aa937ac59f60384a70b98fec5daf54ac7b967', maxBps: 500 }),
});

export class ConfigRefusal extends Error {
  constructor(refusals) {
    super(refusals.map((r) => `${r.code}: ${r.reason}`).join('\n'));
    this.name = 'ConfigRefusal';
    this.refusals = refusals;
  }
}

/** True for a path inside OneDrive, which syncs, versions and can roll a file back. */
export const isOneDrivePath = (p) => /onedrive/i.test(String(p ?? ''));

/** KEY=VALUE lines. Only HOUSE_* names are kept; values are never printed. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (m[1].startsWith('HOUSE_')) out[m[1]] = v;
  }
  return out;
}

const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const isWeiString = (v) => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
const exactKeys = (obj, allowed, where, bad) => {
  for (const k of Object.keys(obj ?? {})) if (!allowed.includes(k)) bad(`${where}`, `unknown field "${k}" (a typo would otherwise be ignored)`);
};

/**
 * policy.json (2.2) checked field by field. Returns the policy with wei as bigint and addresses
 * lowercased, and the list of problems (empty when it is sound).
 */
export function validatePolicy(raw, { mode = 'shadow' } = {}) {
  const problems = [];
  const bad = (field, reason) => problems.push({ code: 'policy', field, reason: `policy.json ${field}: ${reason}` });
  if (!raw || typeof raw !== 'object') return { policy: null, problems: [{ code: 'policy', field: 'file', reason: 'policy.json is not a JSON object' }] };
  exactKeys(raw, ['version', 'chainId', 'house', 'fundingWallet', 'collections', 'openseaFee', 'venueFee', 'maxLifetimeSec', 'maxAllowanceWei', 'maxWrapWei', 'gas', 'listing', 'daily'], 'top level', bad);
  if (raw.version !== 1) bad('version', 'must be 1');
  if (raw.chainId !== 1) bad('chainId', 'must be 1 (Ethereum)');

  let house = addr(raw.house);
  if (house === ZERO_ADDRESS) house = null;
  if (!house && mode === 'live') bad('house', 'the house address is required to go live');
  if (raw.house !== undefined && raw.house !== null && raw.house !== '' && !addr(raw.house)) bad('house', 'is not an address');
  const fundingWallet = addr(raw.fundingWallet);
  if (!fundingWallet && mode === 'live') bad('fundingWallet', 'the funding wallet is required to go live');
  if (raw.fundingWallet && !fundingWallet) bad('fundingWallet', 'is not an address');
  if (house && fundingWallet && house === fundingWallet) bad('fundingWallet', 'must not be the house itself');

  const collections = {};
  if (!raw.collections || typeof raw.collections !== 'object') bad('collections', 'missing');
  for (const [slug, c] of Object.entries(raw.collections ?? {})) {
    const where = `collections.${slug}`;
    if (!COLLECTIONS[slug]) {
      bad(where, `"${slug}" is not a collection v1 knows (junglebay, gnssart)`);
      continue;
    }
    exactKeys(c, ['address', 'enabled', 'maxUnitPriceWei', 'maxQty', 'inventoryCap', 'creatorFee'], where, bad);
    if (addr(c.address) !== COLLECTIONS[slug].address) bad(`${where}.address`, `must be ${COLLECTIONS[slug].address}`);
    if (typeof c.enabled !== 'boolean') bad(`${where}.enabled`, 'must be true or false');
    if (!isWeiString(c.maxUnitPriceWei) || BigInt(c.maxUnitPriceWei) <= 0n) bad(`${where}.maxUnitPriceWei`, 'must be a positive whole number of wei as a string');
    else if (BigInt(c.maxUnitPriceWei) % PRICE_TICK_WEI !== 0n) bad(`${where}.maxUnitPriceWei`, 'must be a multiple of 10^13 wei (0.00001 ETH)');
    if (!Number.isInteger(c.maxQty) || c.maxQty < 1 || c.maxQty > 10) bad(`${where}.maxQty`, 'must be a whole number from 1 to 10');
    if (!Number.isInteger(c.inventoryCap) || c.inventoryCap < 1 || c.inventoryCap > 50) bad(`${where}.inventoryCap`, 'must be a whole number from 1 to 50');
    let creatorFee = null;
    if (c.creatorFee !== null && c.creatorFee !== undefined) {
      const pin = CREATOR_FEES[slug];
      if (addr(c.creatorFee.recipient) !== pin.recipient) bad(`${where}.creatorFee.recipient`, `must be the collection's creator-fee address ${pin.recipient}`);
      if (!Number.isInteger(c.creatorFee.bps) || c.creatorFee.bps < 1 || c.creatorFee.bps > pin.maxBps) bad(`${where}.creatorFee.bps`, `must be 1 to ${pin.maxBps}`);
      creatorFee = { recipient: addr(c.creatorFee.recipient), bps: c.creatorFee.bps };
    }
    collections[slug] = {
      address: COLLECTIONS[slug].address,
      enabled: c.enabled === true,
      maxUnitPriceWei: isWeiString(c.maxUnitPriceWei) ? BigInt(c.maxUnitPriceWei) : 0n,
      maxQty: c.maxQty,
      inventoryCap: c.inventoryCap,
      creatorFee,
    };
  }

  if (addr(raw.openseaFee?.recipient) !== OPENSEA_FEE.recipient || raw.openseaFee?.bps !== OPENSEA_FEE.bps) {
    bad('openseaFee', `must be { recipient: ${OPENSEA_FEE.recipient}, bps: ${OPENSEA_FEE.bps} }`);
  }
  let venueFee = null;
  if (raw.venueFee !== null && raw.venueFee !== undefined) {
    if (addr(raw.venueFee.recipient) !== VENUE_FEE_SAFE || raw.venueFee.bps !== VENUE_FEE_BPS) bad('venueFee', `must be null or { recipient: ${VENUE_FEE_SAFE}, bps: ${VENUE_FEE_BPS} }`);
    else venueFee = { recipient: VENUE_FEE_SAFE, bps: VENUE_FEE_BPS };
  }
  if (!Number.isInteger(raw.maxLifetimeSec) || raw.maxLifetimeSec < 60 || raw.maxLifetimeSec > 86_400) bad('maxLifetimeSec', 'must be whole seconds from 60 to 86400');
  for (const f of ['maxAllowanceWei', 'maxWrapWei']) if (!isWeiString(raw[f])) bad(f, 'must be a whole number of wei as a string');
  const g = raw.gas ?? {};
  exactKeys(g, ['maxFeeGwei', 'priorityGwei', 'killPriorityGwei', 'maxGasLimit'], 'gas', bad);
  if (!(typeof g.maxFeeGwei === 'number' && g.maxFeeGwei > 0)) bad('gas.maxFeeGwei', 'must be a positive number');
  if (!(typeof g.priorityGwei === 'number' && g.priorityGwei >= 0)) bad('gas.priorityGwei', 'must be a number, 0 or more');
  if (!(typeof g.killPriorityGwei === 'number' && g.killPriorityGwei > 0)) bad('gas.killPriorityGwei', 'must be a positive number');
  if (!(Number.isInteger(g.maxGasLimit) && g.maxGasLimit >= SIGNER_MIN_GAS_LIMIT)) bad('gas.maxGasLimit', `must be a whole number of at least ${SIGNER_MIN_GAS_LIMIT}, what an on-chain cancel of 6 orders needs (the signer refuses less, as it would stop the kill's counter bump and NFT revokes)`);
  if (raw.listing?.enabled !== false) bad('listing.enabled', 'must be false: the house does not list in v1');
  // Optional, and read by the signer too: its daily budget, checked as the signer checks it.
  let daily = SIGNER_DAILY_DEFAULT;
  if (raw.daily !== undefined) {
    const d = raw.daily ?? {};
    exactKeys(d, ['maxTxs', 'maxGasWei'], 'daily', bad);
    const txsOk = Number.isInteger(d.maxTxs) && d.maxTxs >= 1 && d.maxTxs <= 1000;
    const gasOk = isWeiString(d.maxGasWei) && BigInt(d.maxGasWei) >= 1n && BigInt(d.maxGasWei) <= 10n ** 18n;
    if (!txsOk) bad('daily.maxTxs', 'must be a whole number from 1 to 1000');
    if (!gasOk) bad('daily.maxGasWei', 'must be a decimal string of wei, more than 0 and at most 1 ETH');
    if (txsOk && gasOk) daily = { maxTxs: d.maxTxs, maxGasWei: BigInt(d.maxGasWei) };
  }

  const policy = {
    version: 1,
    chainId: 1,
    house,
    fundingWallet,
    collections,
    openseaFee: { ...OPENSEA_FEE },
    venueFee,
    maxLifetimeSec: raw.maxLifetimeSec,
    maxAllowanceWei: isWeiString(raw.maxAllowanceWei) ? BigInt(raw.maxAllowanceWei) : 0n,
    maxWrapWei: isWeiString(raw.maxWrapWei) ? BigInt(raw.maxWrapWei) : 0n,
    gas: { ...g },
    listing: { ...(raw.listing ?? {}), enabled: false },
    daily: { ...daily },
  };
  return { policy, problems };
}

/** insiders.json (2.2): who must never trade with the house. */
export function validateInsiders(raw, { mode = 'shadow' } = {}) {
  const problems = [];
  const bad = (field, reason) => problems.push({ code: 'insiders', field, reason: `insiders.json ${field}: ${reason}` });
  if (!raw || typeof raw !== 'object') return { insiders: { wallets: [], contracts: [] }, problems: [{ code: 'insiders', field: 'file', reason: 'insiders.json is not a JSON object' }] };
  exactKeys(raw, ['version', 'wallets', 'contracts'], 'top level', bad);
  if (raw.version !== 1) bad('version', 'must be 1');
  const wallets = [];
  (Array.isArray(raw.wallets) ? raw.wallets : []).forEach((w, i) => {
    const a = addr(w?.address);
    if (!a) bad(`wallets[${i}].address`, 'is not an address');
    else wallets.push({ address: a, who: String(w.who ?? ''), note: String(w.note ?? '') });
  });
  if (!Array.isArray(raw.wallets)) bad('wallets', 'must be a list');
  const contracts = [];
  (Array.isArray(raw.contracts) ? raw.contracts : []).forEach((c, i) => {
    const a = addr(c);
    if (!a) bad(`contracts[${i}]`, 'is not an address');
    else contracts.push(a);
  });
  if (!Array.isArray(raw.contracts)) bad('contracts', 'must be a list');
  // An empty list in a live run means the file was never filled in, not that there are no insiders.
  if (mode === 'live' && wallets.length === 0) bad('wallets', 'lists nobody: name the owner, the team and the Safe signers before going live');
  return { insiders: { wallets, contracts }, problems };
}

/** The site's public list of house wallets (frontend/src/lib/house/houseRegistry.json). A missing file lists nobody. */
export function readRegistry(fs, registryPath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch {
    return { wallets: [], present: false };
  }
  const wallets = (Array.isArray(raw?.wallets) ? raw.wallets : [])
    .map((w) => ({ address: addr(w?.address), label: w?.label ?? null, collections: Array.isArray(w?.collections) ? w.collections.map(String) : [], since: w?.since ?? null }))
    .filter((w) => w.address);
  return { wallets, present: true };
}

const readJson = (fs, file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The real git, run from the bot's own checkout. */
export function realGit(cwd) {
  const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { porcelain: () => run(['status', '--porcelain']), head: () => run(['rev-parse', 'HEAD']) };
}

/**
 * STOP is any file in the keys folder whose name starts with "stop", in any letter case: STOP,
 * STOP.txt, the STOP.txt.txt Windows Explorer makes when it hides extensions, stop-now. The same
 * rule as the signer's (tools/house-signer, stopFilePresent), so both stop on the same file. The
 * bot never names a file of its own like that.
 */
export const isStopFileName = (name) => String(name ?? '').toLowerCase().startsWith('stop');

/** Is there a STOP file? A folder that cannot be read is no proof the owner did not ask to stop. */
export function stopPresent(fs, keysDir) {
  try {
    return fs.readdirSync(keysDir).some(isStopFileName);
  } catch {
    return true;
  }
}

/**
 * @param {object} a
 * @param {'shadow'|'live'|'status'} a.mode
 * @param {string} [a.keysDir]
 * @param {string} a.frontendDir           the checkout's frontend/ folder (for the registry)
 * @param {string} [a.scriptPath]          the bot's own file (a live run from OneDrive is refused)
 * @param {object} [a.fs]
 * @param {{ porcelain(): string, head(): string }} [a.git]
 * @param {{ hello(): Promise<object> }} [a.signer]  live only
 * @returns {Promise<object>} the config; throws ConfigRefusal listing every reason it will not run
 */
export async function loadConfig({ mode = 'shadow', keysDir = DEFAULT_KEYS_DIR, frontendDir, scriptPath = '', fs = nodeFs, git = null, signer = null }) {
  const refusals = [];
  const refuse = (code, reason) => refusals.push({ code, reason });
  const live = mode === 'live';

  if (isOneDrivePath(keysDir)) refuse('keys-onedrive', `the keys folder ${keysDir} is inside OneDrive, which can roll a file back: use a folder outside it (default ${DEFAULT_KEYS_DIR})`);
  if (live && isOneDrivePath(scriptPath)) refuse('code-onedrive', 'the bot is running from a OneDrive folder: run it from a checkout outside OneDrive');
  if (refusals.length) throw new ConfigRefusal(refusals);

  const paths = {
    env: path.join(keysDir, 'house-bidder.env'),
    policy: path.join(keysDir, 'policy.json'),
    insiders: path.join(keysDir, 'insiders.json'),
    ledger: path.join(keysDir, 'ledger.jsonl'),
    trades: path.join(keysDir, 'trades.csv'),
    status: path.join(keysDir, 'status.json'),
    signerOrders: path.join(keysDir, 'signer-orders.jsonl'),
    registry: path.join(frontendDir, 'src', 'lib', 'house', 'houseRegistry.json'),
  };

  let env = {};
  try {
    env = parseEnvFile(fs.readFileSync(paths.env, 'utf8'));
  } catch {
    refuse('env', `${paths.env} could not be read`);
  }
  if (!env.HOUSE_OPENSEA_API_KEY) refuse('env', 'HOUSE_OPENSEA_API_KEY is not set in house-bidder.env');
  const rpcHttp = list(env.HOUSE_RPC_HTTP);
  if (!rpcHttp.length) refuse('env', 'HOUSE_RPC_HTTP is not set in house-bidder.env');
  for (const u of rpcHttp) if (!/^https:\/\//.test(u)) refuse('env', `HOUSE_RPC_HTTP has an endpoint that is not https: ${redactRpcUrl(u)}`);
  const pinCommit = String(env.HOUSE_PIN_COMMIT ?? '').toLowerCase();
  if (live && !/^[0-9a-f]{40}$/.test(pinCommit)) refuse('env', 'HOUSE_PIN_COMMIT must be the full 40-character commit the live run is pinned to');

  let policyBytes = null;
  let policy = null;
  try {
    policyBytes = fs.readFileSync(paths.policy);
    const v = validatePolicy(JSON.parse(policyBytes.toString('utf8')), { mode });
    policy = v.policy;
    for (const p of v.problems) refuse(p.code, p.reason);
  } catch {
    refuse('policy', `${paths.policy} could not be read as JSON`);
  }
  const policySha256 = policyBytes ? createHash('sha256').update(policyBytes).digest('hex') : null;

  let insiders = { wallets: [], contracts: [] };
  if (fs.existsSync(paths.insiders)) {
    try {
      const v = validateInsiders(readJson(fs, paths.insiders), { mode });
      insiders = v.insiders;
      for (const p of v.problems) refuse(p.code, p.reason);
    } catch {
      refuse('insiders', `${paths.insiders} could not be read as JSON`);
    }
  } else if (live) {
    refuse('insiders', `${paths.insiders} is missing: name everyone who must never trade with the house`);
  }

  const registry = readRegistry(fs, paths.registry);
  const house = policy?.house ?? null;

  if (live) {
    if (stopPresent(fs, keysDir)) refuse('stop', 'the STOP file is in the keys folder: delete it to go live');
    if (house) {
      const entry = registry.wallets.find((w) => w.address === house);
      if (!entry) refuse('registry', `the house ${house} is not in the site's house registry (src/lib/house/houseRegistry.json at this commit): the site must label it before it bids`);
      else {
        for (const [slug, c] of Object.entries(policy.collections)) {
          if (c.enabled && !entry.collections.includes(slug)) refuse('registry', `the house registry does not list ${slug} for the house: the site must say which collections it bids on`);
        }
      }
    }
    if (!git) refuse('git', 'no git checkout to check');
    else {
      try {
        if (git.porcelain() !== '') refuse('git', 'the git tree has changes or new files: a live run must be the committed code');
        const head = git.head().toLowerCase();
        if (pinCommit && head !== pinCommit) refuse('git', `HEAD is ${head.slice(0, 12)}, not the pinned ${pinCommit.slice(0, 12)} (HOUSE_PIN_COMMIT)`);
      } catch {
        refuse('git', 'git could not be read');
      }
    }
    if (!signer) refuse('signer', 'no signer to ask');
    else if (house && policySha256) {
      let hello = null;
      try {
        hello = await signer.hello();
      } catch (e) {
        refuse('signer', `the signer did not answer: ${e?.message ?? e} (start it with house-signer serve)`);
      }
      if (hello) {
        if (hello.ok !== true) refuse('signer', `the signer refused hello: ${hello.reason ?? 'no reason given'}`);
        else {
          if (addr(hello.house) !== house) refuse('signer', `the signer holds ${addr(hello.house) ?? 'no'} house key, the policy names ${house}`);
          if (String(hello.policySha256 ?? '').toLowerCase() !== policySha256) refuse('signer', 'the signer was started with a different policy.json: restart it so both read the same file');
          if (hello.stopped === true) refuse('signer', 'the signer reports STOP');
          if (pinCommit && String(hello.pinCommit ?? '').toLowerCase() !== pinCommit) refuse('signer', 'the signer is pinned to a different commit');
        }
      }
    }
  }

  if (refusals.length) throw new ConfigRefusal(refusals);

  const apiKey = env.HOUSE_OPENSEA_API_KEY;
  return Object.freeze({
    mode,
    keysDir,
    paths,
    policy,
    policySha256,
    insiders,
    registry,
    house,
    houseWallets: registry.wallets.map((w) => w.address),
    pinCommit: pinCommit || null,
    rpcHttp,
    rpcWs: env.HOUSE_RPC_WS || null,
    // The key is reachable only through this function, so printing the config never prints it.
    openseaApiKey: () => apiKey,
    describe: () => ({
      mode,
      keysDir,
      house,
      fundingWallet: policy?.fundingWallet ?? null,
      policySha256,
      rpc: rpcHttp.map(redactRpcUrl),
      stream: env.HOUSE_RPC_WS ? redactRpcUrl(env.HOUSE_RPC_WS) : null,
      registry: registry.present ? `${registry.wallets.length} house wallet(s) listed` : 'no registry file at this commit',
      insiders: `${insiders.wallets.length} wallet(s), ${insiders.contracts.length} contract(s) (plus the built-in list)`,
      collections: Object.fromEntries(Object.entries(policy?.collections ?? {}).map(([s, c]) => [s, { enabled: c.enabled, maxUnitPriceWei: String(c.maxUnitPriceWei), maxQty: c.maxQty, inventoryCap: c.inventoryCap }])),
    }),
  });
}
