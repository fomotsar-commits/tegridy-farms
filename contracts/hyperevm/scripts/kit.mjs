#!/usr/bin/env node
// HyperEVM kit helper (README.md says when to run each command). Node builtins only.
//
//   node contracts/hyperevm/scripts/kit.mjs task   --run A|B --uniswap <checkout> --chain 999|998 --rpc <url>
//                                                  [--admin-safe 0x…] [--unsupported 0x…]
//   node contracts/hyperevm/scripts/kit.mjs record --run A|B|adapter|opener --broadcast <run-*.json> --chain 999|998
//   node contracts/hyperevm/scripts/kit.mjs check  --chain 999|998 --rpc <url> [--reference-rpc <url>]
//   node contracts/hyperevm/scripts/kit.mjs sqrt-price --rpc <url> --a 0x… --b 0x… --price <B per 1 A>
//   node contracts/hyperevm/scripts/kit.mjs fee-job --chain 999 --rpc <url> [--min-block-span 1000]
//
// `task` writes Uniswap's Deploy-all task file from OUR templates (tasks/), into a Uniswap/contracts
// checkout that must sit exactly at the pinned commit. `record` turns a broadcast file into
// deployments/<chain>.json. `check` reads the deployment back: who owns what, and every contract
// held byte for byte against Uniswap's own HyperEVM deployment. `fee-job` lists the pools whose
// venue cut is not switched on yet and the cut waiting to be collected, and prints the two
// permissionless calls that fix both (anyone may send them; the money can only reach the treasury).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, '..');
const UNISWAP_CONTRACTS_PIN = 'a677c0d4b5fb6e3357cf6d0f0315bcb135a1e1ee';
const WHYPE = '0x5555555555555555555555555555555555555555';

// Uniswap's own HyperEVM (999) deployment, from Uniswap/contracts @ the pin, deployments/json/999.json.
// Our contracts must match these byte for byte, apart from the addresses each one has baked in.
const UNISWAP_999 = {
  UnsupportedProtocol: '0xeee3aa3c0d6d6f4e702748deacb42991a0094bcf',
  UniswapV3Factory: '0xf0db7b58379503491d857db50ac9ece64c653918',
  QuoterV2: '0x7dfd4f31be6814d2906bde155c3e1b146eac1468',
  TickLens: '0x9eb8600665b55d10c1eb2316ca5127a9ca6e2e76',
  NFTDescriptor: '0x2e9d45bb7b30549f5216813ada9a6b7982c5b3ed',
  NonfungibleTokenPositionDescriptorProxy: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
  NonfungiblePositionManager: '0x39654a85a4c05127f5fd6ed22caec077a0fb1377',
  UniversalRouter: '0x9afe3c497e19501db228f28cdbdd29bc98f65dba',
  // the other addresses baked into Uniswap's router and periphery (masked when comparing)
  UniswapV2Factory: '0x89e5db8b5aa49aa85ac63f691524311aeb649eba',
  PoolManager: '0x12d4fd9c5dedd00ab8a0bce2cf0167bbf94b6b1f',
  PositionManager: '0x0d7ab5b3db668128aff6f70c4ebc71d7d4da9bf9',
  PermissionsAdapterFactory: '0x2a9049f60a1a42e82ba340efe02b9ba468aff803',
  AcrossSpokePool: '0x35e63ea3eb0fb7a3bc543c71fb66412e1f6b0e04',
};

// Selectors (keccak256 of the signature, first 4 bytes).
const SEL = {
  owner: '0x8da5cb5b', feeAmountTickSpacing: '0x22afcccb', feeSetter: '0x87cf3ef4', TOKEN_JAR: '0xe0ef2b4b',
  FACTORY: '0x2dd31000', getFee: '0xb88c9148', slot0: '0x3850c7bd', protocolFees: '0x1ad8b03b', factory: '0xc45a0155',
  WETH9: '0x4aa4a4fc', FEE_SWITCH: '0x18f0bf58', TREASURY: '0x2d2c5565', POOL_OPENING_FEE: '0x24511c26',
  poolCount: '0xf525cb68',
};
const OPENING_FEE_WEI = 230_000_000_000_000_000n; // HyperEVMPoolOpener.POOL_OPENING_FEE: 0.23 HYPE (owner 2026-11-26)
const POOL_CREATED = '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118';
const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EIP1967_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

// ─── small helpers ───────────────────────────────────────────────────
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i > 0 && i + 1 < args.length ? args[i + 1] : d;
};
const need = (k) => {
  const v = opt(k);
  if (v === undefined) die(`missing --${k}`);
  return v;
};
function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a);
const pad = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const word = (hex, i) => '0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const asAddr = (w) => '0x' + w.slice(-40);
const chainDir = (chain) => {
  if (chain !== '999' && chain !== '998') die('--chain must be 999 (HyperEVM) or 998 (its testnet)');
  return chain;
};
// --file overrides where the deployment record lives (a rehearsal must never write deployments/999.json).
const deploymentsPath = (chain) => (opt('file') ? path.resolve(opt('file')) : path.join(KIT, 'deployments', `${chain}.json`));
// Read once, no separate "does it exist" check: a check-then-read can see two different files.
function readJsonOr(p, fallback) {
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  return JSON.parse(text);
}
// Write the whole file to a temporary name, then rename it over the old one, so a reader never
// sees half a file and nothing else can be swapped in between.
function writeJson(p, value) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(tmp, p);
}
const readDeployments = (chain) => readJsonOr(deploymentsPath(chain), {});

let rpcId = 1;
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
// The public HyperEVM RPC rate-limits (-32005 "rate limited"): back off up to ~1 minute before giving up.
async function rpc(url, method, params, tries = 8) {
  for (let t = 1; ; t++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result;
    } catch (e) {
      if (t >= tries || /execution reverted/.test(String(e))) throw e;
      await sleep(Math.min(500 * 2 ** (t - 1), 16_000));
    }
  }
}
const code = (url, a) => rpc(url, 'eth_getCode', [a, 'latest']);
const call = (url, to, data) => rpc(url, 'eth_call', [{ to, data }, 'latest']);
const callAddr = async (url, to, sel, argHex = '') => asAddr(await call(url, to, sel + argHex));

// ─── task ────────────────────────────────────────────────────────────
async function task() {
  const run = need('run');
  const uni = path.resolve(need('uniswap'));
  const chain = chainDir(need('chain'));
  const url = need('rpc');
  const head = execFileSync('git', ['-C', uni, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== UNISWAP_CONTRACTS_PIN) die(`Uniswap/contracts checkout is at ${head}, not the pin ${UNISWAP_CONTRACTS_PIN}`);
  const dirty = execFileSync('git', ['-C', uni, 'status', '--porcelain', '--', 'src', 'script/deploy/Deploy-all.s.sol'], {
    encoding: 'utf8',
  }).trim();
  if (dirty) die(`Uniswap/contracts checkout has local changes in its code:\n${dirty}`);
  if ((await rpc(url, 'eth_chainId', [])) !== '0x' + Number(chain).toString(16)) die(`--rpc is not chain ${chain}`);
  if ((await code(url, WHYPE)).length < 4) die(`no wrapped HYPE at ${WHYPE} on this chain`);

  if (run !== 'A' && run !== 'B') die('--run must be A or B');
  const template = run === 'A' ? 'task-A-unsupported-protocol.json' : 'task-B-v3-and-router.json';
  let text = fs.readFileSync(path.join(KIT, 'tasks', template), 'utf8');
  if (run === 'B') {
    const admin = need('admin-safe');
    const unsupported = need('unsupported');
    if (!isAddr(admin) || !isAddr(unsupported)) die('--admin-safe and --unsupported must be full addresses');
    if ((await code(url, admin)).length < 4) die(`--admin-safe ${admin} has no code on chain ${chain}: create the Safe first`);
    const uc = await code(url, unsupported);
    const ref = readDeployments(chain).UnsupportedProtocol;
    if (uc.length < 4) die(`--unsupported ${unsupported} has no code on chain ${chain}`);
    if (ref && ref.toLowerCase() !== unsupported.toLowerCase()) die(`--unsupported differs from run A's record ${ref}`);
    text = text.replaceAll('__ADMIN_SAFE__', admin).replaceAll('__UNSUPPORTED_PROTOCOL__', unsupported);
  }
  if (/__[A-Z_]+__/.test(text)) die('a placeholder is still unfilled');
  const out = path.join(uni, 'script', 'deploy', 'tasks', chain, 'task-pending.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  const t = JSON.parse(text);
  const on = [];
  for (const [pn, p] of Object.entries(t.protocols)) for (const [cn, c] of Object.entries(p.contracts || {})) if (p.deploy && c.deploy) on.push(`${pn}.${cn}`);
  console.log(`✅ wrote ${out}\n   run ${run} deploys: ${on.join(', ')}`);
}

// ─── record ──────────────────────────────────────────────────────────
// Deploy-all deploys from Uniswap's frozen initcode, so forge cannot name the contracts. They are
// labelled by their order in the broadcast (fixed by Deploy-all.s.sol and our task file), and
// `check` then proves every label by reading the contract back.
const RUN_B_CREATES = [
  'UniswapV3Factory',
  'QuoterV2',
  'TickLens',
  'NonfungibleTokenPositionDescriptorImpl',
  'NonfungibleTokenPositionDescriptorProxy',
  'NonfungiblePositionManager',
  'UniversalRouter',
];
function record() {
  const run = need('run');
  const chain = chainDir(need('chain'));
  const b = JSON.parse(fs.readFileSync(need('broadcast'), 'utf8'));
  if (String(b.chain) !== chain) die(`broadcast is for chain ${b.chain}, not ${chain}`);
  const creates = b.transactions.filter((t) => t.transactionType === 'CREATE' || t.transactionType === 'CREATE2');
  const d = readDeployments(chain);
  const deployer = b.transactions[0]?.transaction?.from;
  if (run === 'A') {
    if (creates.length !== 1) die(`run A should create exactly 1 contract, found ${creates.length}`);
    if (creates[0].contractName) die(`run A's contract is named ${creates[0].contractName}: this is not a Deploy-all broadcast`);
    d.UnsupportedProtocol = creates[0].contractAddress;
  } else if (run === 'B') {
    if (creates.length !== RUN_B_CREATES.length) die(`run B should create ${RUN_B_CREATES.length} contracts, found ${creates.length}`);
    RUN_B_CREATES.forEach((name, i) => (d[name] = creates[i].contractAddress));
    const pa = creates[4].additionalContracts?.find((c) => c.contractName === 'ProxyAdmin');
    if (pa) d.NonfungibleTokenPositionDescriptorProxyAdmin = pa.address;
  } else if (run === 'adapter') {
    const dep = creates.find((t) => t.contractName === 'HyperEVMFeeAdapterDeployer');
    if (!dep) die('no HyperEVMFeeAdapterDeployer in this broadcast');
    d.HyperEVMFeeAdapterDeployer = dep.contractAddress;
    const ad = (dep.additionalContracts || []).find((c) => c.contractName === 'V3OpenFeeAdapter') || dep.additionalContracts?.[0];
    if (!ad) die('the broadcast does not show the adapter the deployer created');
    d.V3OpenFeeAdapter = ad.address;
  } else if (run === 'opener') {
    const op = creates.filter((t) => t.contractName === 'HyperEVMPoolOpener');
    if (op.length !== 1) die(`the broadcast should create exactly 1 HyperEVMPoolOpener, found ${op.length}`);
    d.HyperEVMPoolOpener = op[0].contractAddress;
  } else die('--run must be A, B, adapter or opener');
  d.deployers = Array.from(new Set([...(d.deployers || []), deployer].filter(Boolean)));
  d.chainId = Number(chain);
  fs.mkdirSync(path.dirname(deploymentsPath(chain)), { recursive: true });
  writeJson(deploymentsPath(chain), d);
  console.log(`✅ ${deploymentsPath(chain)}`);
  for (const [k, v] of Object.entries(d)) console.log(`   ${k.padEnd(44)} ${Array.isArray(v) ? v.join(', ') : v}`);
}

// ─── check ───────────────────────────────────────────────────────────
function stripMetadata(buf) {
  // solc appends CBOR metadata + its 2-byte length; Uniswap's briefcase builds have none.
  if (buf.length < 4) return buf;
  const len = buf.readUInt16BE(buf.length - 2);
  const start = buf.length - 2 - len;
  if (len > 0 && len < 120 && start > 0 && (buf[start] & 0xf0) === 0xa0) return buf.subarray(0, start);
  return buf;
}
function maskAddresses(buf, addrs) {
  const out = Buffer.from(buf);
  for (const a of addrs) {
    const needle = Buffer.from(a.toLowerCase().replace(/^0x/, ''), 'hex');
    for (let i = out.indexOf(needle); i !== -1; i = out.indexOf(needle, i + 1)) out.fill(0, i, i + 20);
  }
  return out;
}
async function check() {
  const chain = chainDir(need('chain'));
  const url = need('rpc');
  const refUrl = opt('reference-rpc', url);
  const d = readDeployments(chain);
  let ok = true;
  const pass = (m) => console.log(`✅ ${m}`);
  const fail = (m) => {
    ok = false;
    console.log(`❌ ${m}`);
  };
  const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  for (const k of [...RUN_B_CREATES, 'UnsupportedProtocol']) if (!isAddr(d[k] || '')) die(`deployments/${chain}.json lacks ${k}: run record first`);

  // 1. Every contract, byte for byte against Uniswap's HyperEVM deployment.
  const proxyImpl = async (u, p) => asAddr(await rpc(u, 'eth_getStorageAt', [p, EIP1967_IMPL, 'latest']));
  const ours = {
    UnsupportedProtocol: d.UnsupportedProtocol,
    UniswapV3Factory: d.UniswapV3Factory,
    QuoterV2: d.QuoterV2,
    TickLens: d.TickLens,
    NonfungibleTokenPositionDescriptorImpl: await proxyImpl(url, d.NonfungibleTokenPositionDescriptorProxy),
    NonfungiblePositionManager: d.NonfungiblePositionManager,
    UniversalRouter: d.UniversalRouter,
  };
  const theirs = {
    ...UNISWAP_999,
    NonfungibleTokenPositionDescriptorImpl: await proxyImpl(refUrl, UNISWAP_999.NonfungibleTokenPositionDescriptorProxy),
  };
  if (!eq(ours.NonfungibleTokenPositionDescriptorImpl, d.NonfungibleTokenPositionDescriptorImpl))
    fail(`descriptor proxy points at ${ours.NonfungibleTokenPositionDescriptorImpl}, not the recorded impl`);
  const mask = [
    ...Object.values(ours),
    ...Object.values(theirs),
    d.NonfungibleTokenPositionDescriptorProxy,
    UNISWAP_999.NonfungibleTokenPositionDescriptorProxy,
  ].filter(isAddr);
  for (const k of Object.keys(ours)) {
    if (k === 'UnsupportedProtocol') {
      // Uniswap's HyperEVM copy (0xeee3…) was compiled separately (solc 0.8.26) from the briefcase one
      // Deploy-all deploys (0.8.30), so the bytes differ. Hold ours to what it must do instead: be tiny
      // and revert every call with UnsupportedProtocolError() (selector 0xea3559ef).
      const c = await code(url, ours[k]);
      let reverted = '';
      try {
        await call(url, ours[k], '0x12345678');
      } catch (e) {
        reverted = String(e);
      }
      if (c.length > 2 && c.length < 200 && /ea3559ef/.test(reverted)) pass(`${k} ${ours[k]}: ${(c.length - 2) / 2} B, reverts every call with UnsupportedProtocolError()`);
      else fail(`${k} ${ours[k]}: not a revert-only stub (code ${(c.length - 2) / 2} B, call: ${reverted || 'did NOT revert'})`);
      continue;
    }
    let a = stripMetadata(maskAddresses(Buffer.from((await code(url, ours[k])).slice(2), 'hex'), mask));
    let b = stripMetadata(maskAddresses(Buffer.from((await code(refUrl, theirs[k])).slice(2), 'hex'), mask));
    let note = '';
    if (k === 'UniversalRouter' && a.length === b.length && !a.equals(b)) {
      // UniversalRouter 2.2 is OpenZeppelin EIP712('UniversalRouter', '2'): it caches its domain separator,
      // a hash of the chain id and its OWN address, as a 32-byte immutable. That one word differs between
      // any two deployments (proved 2026-11-20: Uniswap's own build with Uniswap's own arguments, deployed
      // at another address, differs from 0x9afe… in exactly that word and its own address). Allow that word
      // only: one PUSH32 operand, nothing else.
      const diff = [];
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
      const s = diff[0], e = diff[diff.length - 1];
      const start = Array.from({ length: 32 }, (_, j) => s - j).find((p) => a[p - 1] === 0x7f && b[p - 1] === 0x7f && p + 31 >= e);
      if (start !== undefined) {
        a = Buffer.concat([a.subarray(0, start), Buffer.alloc(32), a.subarray(start + 32)]);
        b = Buffer.concat([b.subarray(0, start), Buffer.alloc(32), b.subarray(start + 32)]);
        note = ', EIP-712 domain separator masked';
      }
    }
    if (a.length === 0) fail(`${k}: no code at ${ours[k]}`);
    else if (a.equals(b)) pass(`${k} ${ours[k]}: byte-identical to Uniswap's ${theirs[k]} (addresses masked${note})`);
    else {
      let i = 0;
      while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
      fail(`${k} ${ours[k]}: DIFFERS from Uniswap's ${theirs[k]} at byte ${i} (${a.length} vs ${b.length} B)`);
    }
  }

  // 2. Wiring: every periphery contract points at OUR factory and wrapped HYPE.
  const f = d.UniswapV3Factory;
  for (const k of ['QuoterV2', 'NonfungiblePositionManager']) {
    eq(await callAddr(url, d[k], SEL.factory), f) ? pass(`${k}.factory() = our factory`) : fail(`${k}.factory() is not our factory`);
    eq(await callAddr(url, d[k], SEL.WETH9), WHYPE) ? pass(`${k}.WETH9() = wrapped HYPE`) : fail(`${k}.WETH9() is not wrapped HYPE`);
  }
  // NonfungiblePositionManager keeps its descriptor in a private immutable (no getter): find it in the code.
  (await code(url, d.NonfungiblePositionManager)).toLowerCase().includes(d.NonfungibleTokenPositionDescriptorProxy.toLowerCase().slice(2))
    ? pass('NonfungiblePositionManager has our descriptor proxy baked in')
    : fail('NonfungiblePositionManager does not carry our descriptor proxy');
  for (const [what, a] of [['our factory', f], ['our position manager', d.NonfungiblePositionManager], ['wrapped HYPE', WHYPE], ['Permit2', '0x000000000022D473030F116dDEE9F6B43aC78BA3']])
    (await code(url, d.UniversalRouter)).toLowerCase().includes(a.toLowerCase().slice(2))
      ? pass(`UniversalRouter has ${what} baked in`)
      : fail(`UniversalRouter does not carry ${what}`);
  for (const a of [UNISWAP_999.UniswapV3Factory, UNISWAP_999.NonfungiblePositionManager, UNISWAP_999.UniswapV2Factory, UNISWAP_999.PoolManager])
    if ((await code(url, d.UniversalRouter)).toLowerCase().includes(a.slice(2))) fail(`UniversalRouter carries Uniswap's own ${a}: it would route to THEIR pools`);
  const tiers = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
  for (const [fee, ts] of Object.entries(tiers)) {
    const got = Number(BigInt.asIntN(24, BigInt(await call(url, f, SEL.feeAmountTickSpacing + pad('0x' + Number(fee).toString(16))))));
    got === ts ? pass(`fee tier ${fee / 10000}% enabled (tick spacing ${ts})`) : fail(`fee tier ${fee} has tick spacing ${got}, want ${ts}`);
  }

  // 3. Who holds what. The deployer must hold nothing.
  const deployers = (d.deployers || []).map((x) => x.toLowerCase());
  const adminOfDescriptor = await callAddr(url, asAddr(await rpc(url, 'eth_getStorageAt', [d.NonfungibleTokenPositionDescriptorProxy, EIP1967_ADMIN, 'latest'])), SEL.owner);
  const factoryOwner = await callAddr(url, f, SEL.owner);
  console.log(`   factory owner: ${factoryOwner}\n   NFT descriptor ProxyAdmin owner: ${adminOfDescriptor}`);
  if (deployers.includes(factoryOwner.toLowerCase())) fail('the deployer still owns the factory');
  if (deployers.includes(adminOfDescriptor.toLowerCase())) fail('the deployer still owns the NFT descriptor upgrade key');
  if ((await code(url, adminOfDescriptor)).length < 4) fail('the NFT descriptor upgrade key is not a contract (Safe)');
  if (isAddr(d.V3OpenFeeAdapter || '')) {
    const a = d.V3OpenFeeAdapter;
    const owner = await callAddr(url, a, SEL.owner);
    const setter = await callAddr(url, a, SEL.feeSetter);
    const jar = await callAddr(url, a, SEL.TOKEN_JAR);
    console.log(`   adapter owner: ${owner}\n   adapter fee setter: ${setter}\n   adapter TOKEN_JAR (where the cut goes): ${jar}`);
    eq(await callAddr(url, a, SEL.FACTORY), f) ? pass('adapter.FACTORY() = our factory') : fail('adapter points at another factory');
    if (!eq(owner, setter)) fail('adapter owner and fee setter differ (both should be the admin Safe)');
    if (!eq(owner, adminOfDescriptor)) fail('adapter owner is not the same Safe as the descriptor upgrade key');
    if (eq(jar, owner)) fail('the treasury and the admin Safe are the same address');
    if (deployers.includes(owner.toLowerCase()) || deployers.includes(setter.toLowerCase())) fail('the deployer holds an adapter role');
    if ((await code(url, jar)).length < 4) fail('TOKEN_JAR (treasury) is not a contract (Safe)');
    if (d.treasury && !eq(jar, d.treasury)) fail(`TOKEN_JAR ${jar} is not the recorded treasury ${d.treasury}`);
    if (eq(factoryOwner, a)) pass('factory is handed to the adapter: the venue cut can be switched on');
    else if (eq(factoryOwner, owner)) console.log('⏳ factory still owned by the admin Safe: its setOwner(adapter) step is still to do');
    else fail('factory owner is neither the adapter nor the admin Safe');
  } else console.log('⏳ no V3OpenFeeAdapter recorded yet');
  // 4. The pool opener: no owner, so all that matters is where it points and what it charges.
  if (isAddr(d.HyperEVMPoolOpener || '')) {
    const o = d.HyperEVMPoolOpener;
    const onChain = await code(url, o);
    if (onChain.length < 4) fail('the recorded HyperEVMPoolOpener has no code');
    else {
      // Its code must be exactly this kit's build: the three immutables (factory, fee switch,
      // treasury) are blanked on both sides, and checked one by one below.
      const art = path.join(KIT, 'out', 'HyperEVMPoolOpener.sol', 'HyperEVMPoolOpener.json');
      const built = readJsonOr(art, null);
      if (!built) fail(`no build of HyperEVMPoolOpener at ${art}: run forge build in contracts/hyperevm first`);
      else {
        const blank = (hex) => {
          const b = Buffer.from(hex.replace(/^0x/, ''), 'hex');
          for (const refs of Object.values(built.deployedBytecode.immutableReferences || {})) for (const r of refs) b.fill(0, r.start, r.start + r.length);
          return b;
        };
        blank(onChain).equals(blank(built.deployedBytecode.object))
          ? pass("opener code = this kit's compiled HyperEVMPoolOpener (immutables blanked)")
          : fail("the opener's code differs from this kit's HyperEVMPoolOpener");
      }
      const jar = isAddr(d.V3OpenFeeAdapter || '') ? await callAddr(url, d.V3OpenFeeAdapter, SEL.TOKEN_JAR) : null;
      const paidTo = await callAddr(url, o, SEL.TREASURY);
      const fee = BigInt(await rpc(url, 'eth_call', [{ to: o, data: SEL.POOL_OPENING_FEE }, 'latest']));
      console.log(`   opener ${o}: fee ${fee} wei, paid to ${paidTo}`);
      eq(await callAddr(url, o, SEL.FACTORY), f) ? pass('opener.FACTORY() = our factory') : fail('the opener points at another factory');
      eq(await callAddr(url, o, SEL.FEE_SWITCH), d.V3OpenFeeAdapter || '') ? pass('opener.FEE_SWITCH() = our fee switch') : fail('the opener points at another fee switch');
      jar && eq(paidTo, jar) ? pass('the opening fee goes to the same treasury Safe as the venue cut') : fail('the opening fee goes somewhere other than the treasury Safe');
      fee === OPENING_FEE_WEI ? pass('opening fee = 0.23 HYPE') : fail(`opening fee is ${fee} wei, not 0.23 HYPE`);
    }
  } else console.log('⏳ no HyperEVMPoolOpener recorded yet');
  if (!ok) {
    process.exitCode = 1; // not process.exit: Windows Node can crash exiting with sockets still open
    return console.log('\nSOME CHECKS FAILED');
  }
  console.log('\nall checks passed');
}

// ─── sqrt-price ──────────────────────────────────────────────────────
function isqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) [x, y] = [y, (y + n / y) / 2n];
  return x;
}
async function sqrtPrice() {
  const url = need('rpc');
  const a = need('a'), b = need('b');
  const price = need('price'); // human: how many B for 1 A
  if (!isAddr(a) || !isAddr(b) || eq2(a, b)) die('--a and --b must be two different full addresses');
  const decimals = async (t) => Number(BigInt(await call(url, t, '0x313ce567')));
  const [da, db] = [await decimals(a), await decimals(b)];
  const [ip, fp = ''] = price.split('.');
  const scale = 10n ** BigInt(fp.length);
  const p = BigInt(ip + fp); // price * scale, B per A in whole coins
  // raw B per raw A = p/scale * 10^db / 10^da ; sort so the ratio is token1 per token0
  const aIs0 = a.toLowerCase() < b.toLowerCase();
  let num = p * 10n ** BigInt(db), den = scale * 10n ** BigInt(da);
  if (!aIs0) [num, den] = [den, num];
  const sqrtX96 = isqrt((num << 192n) / den);
  console.log(`token0 ${aIs0 ? a : b}\ntoken1 ${aIs0 ? b : a}\nSQRT_PRICE_X96=${sqrtX96}`);
}
const eq2 = (x, y) => x.toLowerCase() === y.toLowerCase();

// ─── fee-job ─────────────────────────────────────────────────────────
async function feeJob() {
  const chain = chainDir(need('chain'));
  const url = need('rpc');
  const span = Number(opt('min-block-span', '1000')); // the public HyperEVM RPC caps eth_getLogs at 1,000 blocks
  const d = readDeployments(chain);
  const f = d.UniswapV3Factory, a = d.V3OpenFeeAdapter;
  if (!isAddr(f || '') || !isAddr(a || '')) die(`deployments/${chain}.json lacks the factory or the adapter`);
  const statePath = deploymentsPath(chain).replace(/\.json$/, '.fee-job-state.json');
  const saved = readJsonOr(statePath, null);
  const st = saved ?? { lastBlock: Number(need('from-block')) - 1, pools: [] };
  if (!Number.isSafeInteger(st.lastBlock) || !Array.isArray(st.pools) || !st.pools.every(isAddr)) die(`${statePath} is not a fee-job state file`);
  // The saved state is only the factory's own pool list and the last block scanned, each checked.
  const save = (s) => writeJson(statePath, { lastBlock: s.lastBlock, pools: Array.from(new Set(s.pools.map((p) => p.toLowerCase()))) });
  const head = Number(BigInt(await rpc(url, 'eth_blockNumber', [])));
  let chunks = 0;
  for (let from = st.lastBlock + 1; from <= head; from += span) {
    const to = Math.min(head, from + span - 1);
    const logs = await rpc(url, 'eth_getLogs', [{ address: f, topics: [POOL_CREATED], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
    for (const l of logs) {
      const pool = asAddr(word(l.data, 1));
      if (!isAddr(pool)) die(`a PoolCreated log carries no pool address: ${l.data}`);
      st.pools.push(pool);
    }
    st.lastBlock = to;
    if (++chunks % 50 === 0) save(st); // a long first scan that dies keeps what it read
    await sleep(150); // pace the scan under the public RPC's limit
  }
  st.pools = Array.from(new Set(st.pools.map((p) => p.toLowerCase())));
  save(st);
  if (!eq2(await callAddr(url, f, SEL.owner), a)) die('the factory is not owned by the adapter yet: nothing can be switched on');

  const toTrigger = [], toCollect = [];
  for (const p of st.pools) {
    const s0 = await call(url, p, SEL.slot0);
    const initialized = BigInt(word(s0, 0)) !== 0n;
    const have = Number(BigInt(word(s0, 5)));
    const want = Number(BigInt(await call(url, a, SEL.getFee + pad(p))));
    const pf = await call(url, p, SEL.protocolFees);
    const [c0, c1] = [BigInt(word(pf, 0)), BigInt(word(pf, 1))];
    console.log(`${p}  cut ${have === want ? 'ON ' : initialized ? 'OFF' : 'no price yet'} (${have}/${want})  waiting: ${c0} / ${c1} (raw token0 / token1)`);
    if (initialized && have !== want) toTrigger.push(p);
    if (c0 > 1n || c1 > 1n) toCollect.push(p);
  }
  const max = '340282366920938463463374607431768211455';
  console.log(`\n${st.pools.length} pool(s) up to block ${st.lastBlock}`);
  if (toTrigger.length) console.log(`\nswitch the venue cut on (anyone may send this):\ncast send ${a} "batchTriggerFeeUpdateByPool(address[])" "[${toTrigger.join(',')}]" --rpc-url ${url} --account <name>`);
  if (toCollect.length) console.log(`\ncollect the venue cut into the treasury (anyone may send this):\ncast send ${a} "collect((address,uint128,uint128)[])" "[${toCollect.map((p) => `(${p},${max},${max})`).join(',')}]" --rpc-url ${url} --account <name>`);
  if (!toTrigger.length && !toCollect.length) console.log('nothing to do');
}

const COMMANDS = { task, record, check, 'sqrt-price': sqrtPrice, 'fee-job': feeJob };
if (!COMMANDS[cmd]) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n'));
  process.exit(cmd ? 1 : 0);
}
await COMMANDS[cmd]();
