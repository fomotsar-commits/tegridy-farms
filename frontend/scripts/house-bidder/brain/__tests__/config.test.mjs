// @vitest-environment node
//
// Settings and the refusals to go live (BUILD-SPEC 3.5 step 1): OneDrive, a dirty tree, HEAD
// not at the pin, a house the site does not list, STOP, and a signer that answers for another
// house or another policy file. Each refusal is checked on its own, with everything else right.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig, validatePolicy, validateInsiders, parseEnvFile, ConfigRefusal, isOneDrivePath } from '../config.mjs';
import { memFs } from '../../exec/__tests__/fakes.mjs';

const KEYS = 'C:\\Users\\jimbo\\evm-keys\\house-bidder';
const FRONTEND = 'C:\\checkout\\frontend';
const SCRIPT = 'C:\\checkout\\frontend\\scripts\\house-bidder.mjs';
const HOUSE = '0xBd00483CcB69C4FCc2f9F28E87FC29eeb308efFA';
const PIN = 'a'.repeat(40);
const k = (f) => path.join(KEYS, f);

const policyJson = (over = {}) => ({
  version: 1,
  chainId: 1,
  house: HOUSE,
  fundingWallet: '0x1111111111111111111111111111111111111111',
  collections: {
    junglebay: { address: '0xd37264c71e9af940e49795F0d3a8336afAaFDdA9', enabled: true, maxUnitPriceWei: '45000000000000000', maxQty: 2, inventoryCap: 3, creatorFee: null },
    gnssart: { address: '0xa1De9f93c56C290C48849B1393b09eB616D55dbb', enabled: false, maxUnitPriceWei: '16000000000000000', maxQty: 1, inventoryCap: 2, creatorFee: null },
  },
  openseaFee: { recipient: '0x0000a26b00c1F0DF003000390027140000fAa719', bps: 100 },
  venueFee: null,
  maxLifetimeSec: 1800,
  maxAllowanceWei: '150000000000000000',
  maxWrapWei: '200000000000000000',
  gas: { maxFeeGwei: 20, priorityGwei: 0.05, killPriorityGwei: 2, maxGasLimit: 300000 },
  listing: { enabled: false, maxLifetimeSec: 259200, minUnitPriceWei: { junglebay: '40000000000000000', gnssart: '15000000000000000' } },
  ...over,
});

const REGISTERED = [{ address: HOUSE, label: 'House bidder', collections: ['junglebay', 'gnssart'], since: '2026-11-20' }];
const INSIDERS = { version: 1, wallets: [{ address: '0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e', who: 'greencifer.eth' }], contracts: [] };
const ENV = `HOUSE_OPENSEA_API_KEY=secret-key\nHOUSE_RPC_HTTP=https://eth.drpc.org\nHOUSE_PIN_COMMIT=${PIN}\n`;

/** The keys folder and the checkout as files, plus the hash of the policy file as written. */
function world({ policy = policyJson(), registry = REGISTERED, insiders = INSIDERS, env = ENV, stop = false } = {}) {
  const policyText = JSON.stringify(policy, null, 2);
  const files = {
    [k('house-bidder.env')]: env,
    [k('policy.json')]: policyText,
    [k('insiders.json')]: JSON.stringify(insiders),
    [path.join(FRONTEND, 'src', 'lib', 'house', 'houseRegistry.json')]: JSON.stringify({ version: 1, note: '', wallets: registry }),
  };
  if (stop) files[k('STOP')] = '';
  return { fs: memFs(files), sha: createHash('sha256').update(Buffer.from(policyText)).digest('hex') };
}
const git = (porcelain = '', head = PIN) => ({ porcelain: () => porcelain, head: () => head });
const helloFor = (sha, over = {}) => ({ ok: true, house: HOUSE.toLowerCase(), policySha256: sha, version: 1, stopped: false, pinCommit: PIN, ...over });
const signer = (hello) => ({ hello: async () => hello });

async function refusalsOf(args) {
  try {
    await loadConfig(args);
    return [];
  } catch (e) {
    if (!(e instanceof ConfigRefusal)) throw e;
    return e.refusals.map((r) => r.code);
  }
}

/** A live start with everything right, then `over` changes one thing. */
function liveArgs(over = {}) {
  const w = over.world ?? world();
  return { mode: 'live', keysDir: KEYS, frontendDir: FRONTEND, scriptPath: SCRIPT, fs: w.fs, git: git(), signer: signer(helloFor(w.sha)), ...over.args };
}

describe('a live start', () => {
  it('passes when everything is right, and the API key never appears in what it prints', async () => {
    const c = await loadConfig(liveArgs());
    expect(c.house).toBe(HOUSE.toLowerCase());
    expect(c.policy.collections.junglebay.maxUnitPriceWei).toBe(45_000_000_000_000_000n);
    expect(JSON.stringify(c.describe())).not.toContain('secret-key');
    expect(c.openseaApiKey()).toBe('secret-key');
  });

  const cases = {
    'a keys folder in OneDrive': [{ args: { keysDir: 'C:\\Users\\jimbo\\OneDrive\\Desktop\\keys' } }, 'keys-onedrive'],
    'running from OneDrive': [{ args: { scriptPath: 'C:\\Users\\jimbo\\OneDrive\\Desktop\\tegriddy farms\\frontend\\scripts\\house-bidder.mjs' } }, 'code-onedrive'],
    'a dirty tree': [{ args: { git: git(' M frontend/scripts/house-bidder.mjs') } }, 'git'],
    'HEAD not at the pin': [{ args: { git: git('', 'b'.repeat(40)) } }, 'git'],
    'STOP present': [{ world: world({ stop: true }) }, 'stop'],
    'a house the registry does not list': [{ world: world({ registry: [] }) }, 'registry'],
    'a registry entry without the enabled collection': [{ world: world({ registry: [{ ...REGISTERED[0], collections: ['gnssart'] }] }) }, 'registry'],
    'the signer holding another house': [{ args: { signer: signer(helloFor(world().sha, { house: '0x9999999999999999999999999999999999999999' })) } }, 'signer'],
    'the signer started with another policy': [{ args: { signer: signer(helloFor('f'.repeat(64))) } }, 'signer'],
    'the signer reporting STOP': [{ args: { signer: signer(helloFor(world().sha, { stopped: true })) } }, 'signer'],
    'the signer pinned to another commit': [{ args: { signer: signer(helloFor(world().sha, { pinCommit: 'c'.repeat(40) })) } }, 'signer'],
    'the signer refusing hello': [{ args: { signer: signer({ ok: false, field: 'x', reason: 'no' }) } }, 'signer'],
    'the signer not answering': [{ args: { signer: { hello: () => Promise.reject(new Error('ENOENT')) } } }, 'signer'],
    'an empty insiders list': [{ world: world({ insiders: { version: 1, wallets: [], contracts: [] } }) }, 'insiders'],
    'no pin commit': [{ world: world({ env: 'HOUSE_OPENSEA_API_KEY=k\nHOUSE_RPC_HTTP=https://eth.drpc.org\n' }) }, 'env'],
  };
  for (const [name, [over, code]] of Object.entries(cases)) {
    it(`refuses ${name}`, async () => {
      const args = liveArgs(over);
      // a case that changes the policy world also changes its hash: the signer agrees with it
      if (over.world && !over.args?.signer) args.signer = signer(helloFor(over.world.sha));
      expect(await refusalsOf(args)).toEqual([code]);
    });
  }

  it('a shadow start needs neither git, nor a signer, nor a registry entry', async () => {
    const c = await loadConfig({ mode: 'shadow', keysDir: KEYS, frontendDir: FRONTEND, fs: world({ registry: [] }).fs });
    expect(c.mode).toBe('shadow');
  });

  it('even a shadow start refuses a OneDrive keys folder', async () => {
    expect(await refusalsOf({ mode: 'shadow', keysDir: 'D:\\OneDrive\\keys', frontendDir: FRONTEND, fs: memFs() })).toEqual(['keys-onedrive']);
    expect(isOneDrivePath('C:\\Users\\x\\OneDrive - Work\\k')).toBe(true);
  });
});

describe('policy.json', () => {
  const problems = (over, mode = 'live') => validatePolicy(policyJson(over), { mode }).problems.map((p) => p.reason);
  const c = policyJson().collections;
  it('accepts the spec’s policy', () => {
    expect(problems({})).toEqual([]);
  });
  it('refuses a price off the 0.00001 ETH tick, an unknown collection or address, a wrong fee, listings on, a typo', () => {
    expect(problems({ collections: { ...c, junglebay: { ...c.junglebay, maxUnitPriceWei: '45000000000000001' } } }).join()).toMatch(/multiple of 10\^13/);
    expect(problems({ collections: { ...c, bayc: { ...c.junglebay } } }).join()).toMatch(/not a collection v1 knows/);
    expect(problems({ collections: { ...c, junglebay: { ...c.junglebay, address: '0x0000000000000000000000000000000000000001' } } }).join()).toMatch(/must be 0xd372/);
    expect(problems({ openseaFee: { recipient: '0x0000a26b00c1F0DF003000390027140000fAa719', bps: 50 } }).join()).toMatch(/openseaFee/);
    expect(problems({ venueFee: { recipient: '0x0000000000000000000000000000000000000001', bps: 50 } }).join()).toMatch(/venueFee/);
    expect(problems({ listing: { enabled: true } }).join()).toMatch(/does not list/);
    expect(problems({ maxAlowanceWei: '1' }).join()).toMatch(/unknown field/);
  });
  it('pins a creator line to the collection’s own creator-fee address and rate', () => {
    const bad = { ...c, junglebay: { ...c.junglebay, creatorFee: { recipient: '0x0000000000000000000000000000000000000001', bps: 700 } } };
    expect(problems({ collections: bad }).join()).toMatch(/creator-fee address/);
    const tooMuch = { ...c, junglebay: { ...c.junglebay, creatorFee: { recipient: '0xa3cc58eaa3800dc163726e031a2da49a9bb64eb3', bps: 701 } } };
    expect(problems({ collections: tooMuch }).join()).toMatch(/1 to 700/);
    const ok = { ...c, junglebay: { ...c.junglebay, creatorFee: { recipient: '0xa3cc58eaa3800dc163726e031a2da49a9bb64eb3', bps: 700 } } };
    expect(problems({ collections: ok })).toEqual([]);
  });
  it('lets shadow run before the house key exists, and not live', () => {
    expect(problems({ house: null, fundingWallet: null }, 'shadow')).toEqual([]);
    expect(problems({ house: null }, 'live').join()).toMatch(/house address is required/);
  });
});

describe('the other files', () => {
  it('reads only HOUSE_ names from the env file, quotes stripped', () => {
    expect(parseEnvFile('# c\nHOUSE_A="1"\nexport HOUSE_B=2\nOTHER=3\n')).toEqual({ HOUSE_A: '1', HOUSE_B: '2' });
  });
  it('checks insiders.json addresses', () => {
    expect(validateInsiders({ version: 1, wallets: [{ address: 'nope' }], contracts: ['0x1'] }).problems).toHaveLength(2);
  });
});
