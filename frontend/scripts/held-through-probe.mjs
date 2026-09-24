#!/usr/bin/env node
/**
 * Reproduces the reads held-through.json publishes, on the live chains, from nothing but
 * the file: per contract it enumerates the positions, runs the published per-wallet read
 * for up to three wallets and checks the reconcile rule. Read-only JSON-RPC (an allowlist
 * of read methods); no keys, nothing signed or sent. Not part of the build; run by hand.
 */
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';

const args = process.argv.slice(2);
const opt = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const [file] = opt('--file');
const [url] = opt('--url');
const only = new Set(opt('--only'));
const extraWallets = opt('--wallet');
if (!file && !url) {
  console.error(
    [
      'usage: node scripts/held-through-probe.mjs --file dist/held-through.json',
      '       node scripts/held-through-probe.mjs --url https://memetics.finance/held-through.json',
      '',
      '  --wallet 0x...  (repeatable) EVM wallets for the pair and the farm; the default is the',
      '                  TegridyStaking owners this run finds',
      '  --only <id>     (repeatable) probe only these contract ids',
      '  RPC endpoints:  HELD_THROUGH_SOLANA_RPC, HELD_THROUGH_ETHEREUM_RPC, HELD_THROUGH_BASE_RPC',
    ].join('\n'),
  );
  process.exit(2);
}

const RPC = {
  solana: process.env.HELD_THROUGH_SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
  ethereum: process.env.HELD_THROUGH_ETHEREUM_RPC || 'https://ethereum-rpc.publicnode.com',
  base: process.env.HELD_THROUGH_BASE_RPC || 'https://base-rpc.publicnode.com',
};
const READ_METHODS = new Set(['getSlot', 'getAccountInfo', 'getMultipleAccounts', 'getProgramAccounts', 'eth_blockNumber', 'eth_call']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(chain, method, params) {
  if (!READ_METHODS.has(method)) throw new Error(`not a read method: ${method}`);
  let wait = 1000;
  for (let i = 0; i < 8; i++) {
    const res = await fetch(RPC[chain], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429 || res.status >= 500) { await sleep(wait); wait *= 2; continue; }
    const j = await res.json();
    if (j.error) {
      if (/429|rate|too many/i.test(JSON.stringify(j.error))) { await sleep(wait); wait *= 2; continue; }
      const e = new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
      e.rpcError = j.error;
      throw e;
    }
    return j.result;
  }
  throw new Error(`${method}: still rate limited after retries`);
}

const doc = file ? JSON.parse(readFileSync(file, 'utf8')) : await (await fetch(url)).json();
const conv = doc.conventions;
const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const summary = [];
const stakingOwners = new Set();

/* ----- Solana, from the published seeds, layouts and filters ----- */

const b64 = (s) => Buffer.from(s, 'base64');
function seedBytes(tokens, ctx) {
  return tokens.map((t) => {
    if (t.startsWith('utf8:')) return Buffer.from(t.slice(5), 'utf8');
    if (t.startsWith('u32le:')) { const b = Buffer.alloc(4); b.writeUInt32LE(Number(ctx[t.slice(6)])); return b; }
    if (typeof ctx[t] !== 'string') throw new Error(`no value for seed ${t}`);
    return new PublicKey(ctx[t]).toBuffer();
  });
}
const pda = (tokens, ctx, program) =>
  PublicKey.findProgramAddressSync(seedBytes(tokens, ctx), new PublicKey(program))[0].toBase58();
function field(data, layout, name) {
  const f = layout.find((x) => x.name === name);
  if (!f) throw new Error(`the file's layout has no ${name}`);
  switch (f.type) {
    case 'u8': case 'bool': return data[f.offset];
    case 'u32': return data.readUInt32LE(f.offset);
    case 'u64': return data.readBigUInt64LE(f.offset);
    case 'i64': return data.readBigInt64LE(f.offset);
    case 'u128': return data.readBigUInt64LE(f.offset) + (data.readBigUInt64LE(f.offset + 8) << 64n);
    case 'pubkey': return new PublicKey(data.subarray(f.offset, f.offset + 32)).toBase58();
    default: throw new Error(`no reader for ${f.type}`);
  }
}
const discOk = (data, d) => d.every((x, i) => data[i] === x);
const fmt = (raw, dec) => {
  const neg = raw < 0n; const s = (neg ? -raw : raw).toString().padStart(dec + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -dec) || '0'}.${s.slice(-dec)}`;
};
async function account(address) {
  const r = await rpc('solana', 'getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized' }]);
  return r.value ? { owner: r.value.owner, data: b64(r.value.data[0]) } : null;
}
// SPL Token and Token-2022 share the base mint layout, so decimals is one byte at 44.
const MINT_DECIMALS_OFFSET = 44;
async function solanaTokenChecks(c, vaultOwner) {
  const t = c.tokens[0];
  const mint = await account(t.address);
  if (!mint) return [[`${t.symbol} mint ${t.address} exists`, false]];
  const decimals = mint.data[MINT_DECIMALS_OFFSET];
  out(`  ${t.symbol} mint ${t.address}: token program ${mint.owner}, decimals ${decimals}`);
  return [
    [`${t.symbol} mint decimals == ${t.decimals}`, decimals === t.decimals],
    ['the vault is a token account of the mint\'s own program', mint.owner === vaultOwner],
  ];
}
async function accounts(addresses) {
  const r = await rpc('solana', 'getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'finalized' }]);
  return r.value.map((v) => (v ? { owner: v.owner, data: b64(v.data[0]) } : null));
}
const filterValues = (filters, ctx) =>
  filters.map((f) => ('memcmp' in f ? { memcmp: { offset: f.memcmp.offset, bytes: ctx[f.memcmp.bytes] } } : f))
    .filter((f) => !('memcmp' in f) || typeof f.memcmp.bytes === 'string');
async function gpa(program, filters) {
  const r = await rpc('solana', 'getProgramAccounts', [program, { encoding: 'base64', commitment: 'finalized', filters }]);
  return r.map((a) => ({ address: a.pubkey, data: b64(a.account.data[0]) }));
}
const top = (byWallet, n = 3) => [...byWallet.entries()].sort((a, b) => (b[1].sum > a[1].sum ? 1 : b[1].sum < a[1].sum ? -1 : 0)).slice(0, n);

async function probeLadder(c) {
  const r = c.read; const t = c.tokens[0]; const dec = t.decimals;
  const slot = await rpc('solana', 'getSlot', [{ commitment: 'finalized' }]);
  const pool = await account(c.address);
  const checks = [];
  checks.push(['pool account owned by the program', pool?.owner === c.program]);
  checks.push(['pool discriminator and size', pool && discOk(pool.data, r.pool.discriminator) && pool.data.length === r.pool.size]);
  const principal = field(pool.data, r.pool.layout, 'total_principal');
  const orphaned = field(pool.data, r.pool.layout, 'orphaned_penalty');
  checks.push(['pool.stake_vault == vault', field(pool.data, r.pool.layout, 'stake_vault') === c.vault]);
  checks.push(['pool.mint == token', field(pool.data, r.pool.layout, 'mint') === t.address]);
  checks.push(['pool.decimals == token decimals', field(pool.data, r.pool.layout, 'decimals') === dec]);
  const vaultAcc = await account(c.vault);
  const vault = vaultAcc.data.readBigUInt64LE(conv.tokenAccountAmountOffset);
  checks.push(...(await solanaTokenChecks(c, vaultAcc.owner)));

  const scanFilters = filterValues(r.position.filters, { pool: c.address });
  const scanned = await gpa(c.program, scanFilters);
  const byWallet = new Map(); let sum = 0n; let pdaOk = 0; let discGood = 0;
  for (const a of scanned) {
    if (discOk(a.data, r.position.discriminator)) discGood++;
    const owner = field(a.data, r.position.layout, 'owner');
    const nonce = field(a.data, r.position.layout, 'nonce');
    const amount = field(a.data, r.position.layout, 'amount');
    if (pda(r.position.seeds, { pool: c.address, owner, nonce }, c.program) === a.address) pdaOk++;
    sum += amount;
    const w = byWallet.get(owner) ?? { sum: 0n, n: 0 }; w.sum += amount; w.n++; byWallet.set(owner, w);
  }
  out(`  slot ${slot}; positions ${scanned.length} (discriminator ok ${discGood}, PDA re-derived ${pdaOk}/${scanned.length}) across ${byWallet.size} wallets; sum ${fmt(sum, dec)} ${t.symbol}`);
  out(`  pool.total_principal ${fmt(principal, dec)}; orphaned_penalty ${fmt(orphaned, dec)}; vault ${fmt(vault, dec)}`);
  const reconcile = sum === principal && vault >= principal + orphaned;
  checks.push(['reconcile: sum == total_principal and vault >= total_principal + orphaned_penalty', reconcile]);

  let reproduced = 0; const picked = top(byWallet);
  for (const [wallet, scan] of picked) {
    const usAddr = pda(r.userStats.seeds, { pool: c.address, owner: wallet }, c.program);
    const us = await account(usAddr);
    const next = field(us.data, r.userStats.layout, 'next_nonce');
    const p = field(us.data, r.userStats.layout, 'principal');
    const addrs = Array.from({ length: next }, (_, n) => pda(r.position.seeds, { pool: c.address, owner: wallet, nonce: n }, c.program));
    let derived = 0n; let open = 0;
    for (let i = 0; i < addrs.length; i += 100) {
      for (const acc of await accounts(addrs.slice(i, i + 100))) {
        if (acc) { derived += field(acc.data, r.position.layout, 'amount'); open++; }
      }
    }
    const ok = p === derived && derived === scan.sum && discOk(us.data, r.userStats.discriminator);
    if (ok) reproduced++;
    out(`  wallet ${wallet}: userStats ${usAddr} principal ${fmt(p, dec)}; next_nonce ${next}, open ${open}, derived sum ${fmt(derived, dec)}; scan ${fmt(scan.sum, dec)} -> ${ok ? 'REPRODUCED' : 'MISMATCH'}`);
  }
  return { positions: scanned.length, wallets: `${reproduced}/${picked.length}`, reconcile, checks };
}

async function probeStreamflow(c) {
  const r = c.read; const t = c.tokens[0]; const dec = t.decimals;
  const slot = await rpc('solana', 'getSlot', [{ commitment: 'finalized' }]);
  const pool = await account(c.address);
  const checks = [];
  checks.push(['pool account owned by the program', pool?.owner === c.program]);
  checks.push(['pool discriminator', pool && discOk(pool.data, r.stakePool.discriminator)]);
  checks.push(['pool.vault == vault', field(pool.data, r.stakePool.layout, 'vault') === c.vault]);
  checks.push(['pool.mint == token', field(pool.data, r.stakePool.layout, 'mint') === t.address]);
  const total = field(pool.data, r.stakePool.layout, 'total_stake');
  const vaultAcc = await account(c.vault);
  const vault = vaultAcc.data.readBigUInt64LE(conv.tokenAccountAmountOffset);
  checks.push(...(await solanaTokenChecks(c, vaultAcc.owner)));
  const scanned = await gpa(c.program, filterValues(r.stakeEntry.filters, { stakePool: c.address }));
  const byWallet = new Map(); let open = 0n; let nOpen = 0; let pdaOk = 0; let sizeOk = 0;
  for (const a of scanned) {
    if (a.data.length === r.stakeEntry.accountSize && discOk(a.data, r.stakeEntry.discriminator)) sizeOk++;
    const authority = field(a.data, r.stakeEntry.layout, 'authority');
    const nonce = field(a.data, r.stakeEntry.layout, 'nonce');
    if (pda(r.stakeEntry.seeds, { stakePool: c.address, authority, nonce }, c.program) === a.address) pdaOk++;
    if (field(a.data, r.stakeEntry.layout, 'closed_ts') !== 0n) continue;
    const amount = field(a.data, r.stakeEntry.layout, 'amount');
    open += amount; nOpen++;
    const w = byWallet.get(authority) ?? { sum: 0n, n: 0 }; w.sum += amount; w.n++; byWallet.set(authority, w);
  }
  out(`  slot ${slot}; stake entries ${scanned.length} (size+discriminator ok ${sizeOk}, PDA re-derived ${pdaOk}/${scanned.length}), open ${nOpen} across ${byWallet.size} authorities; open sum ${fmt(open, dec)} ${t.symbol}`);
  out(`  stakePool.total_stake ${fmt(total, dec)}; vault ${fmt(vault, dec)}`);
  const reconcile = open === total && vault >= total;
  checks.push(['reconcile: sum(open amount) == total_stake and vault >= total_stake', reconcile]);
  if (scanned.length === 0) {
    out('  no positions: 0 stake entries');
    return { positions: 0, wallets: 'none exist', reconcile, checks };
  }
  let reproduced = 0; const picked = top(byWallet);
  for (const [wallet, scan] of picked) {
    const mine = await gpa(c.program, filterValues(r.stakeEntry.filters, { stakePool: c.address, authority: wallet }));
    let sum = 0n; let n = 0;
    for (const a of mine) {
      if (field(a.data, r.stakeEntry.layout, 'closed_ts') === 0n) { sum += field(a.data, r.stakeEntry.layout, 'amount'); n++; }
    }
    // The published fallback for an RPC without getProgramAccounts: derive every nonce.
    const range = Number(/0 to (\d+)/.exec(r.stakeEntry.nonces)?.[1] ?? -1) + 1;
    const derivedAddrs = Array.from({ length: range }, (_, i) =>
      pda(r.stakeEntry.seeds, { stakePool: c.address, authority: wallet, nonce: i }, c.program));
    let derived = 0n; let nDerived = 0;
    for (let i = 0; i < derivedAddrs.length; i += 100) {
      for (const acc of await accounts(derivedAddrs.slice(i, i + 100))) {
        if (!acc || field(acc.data, r.stakeEntry.layout, 'closed_ts') !== 0n) continue;
        derived += field(acc.data, r.stakeEntry.layout, 'amount'); nDerived++;
      }
    }
    const ok = sum === scan.sum && derived === sum && nDerived === n;
    if (ok) reproduced++;
    out(`  wallet ${wallet}: the published filter read finds ${mine.length} entries, ${n} open, ${fmt(sum, dec)}; pool scan ${fmt(scan.sum, dec)}; deriving nonces 0..${range - 1} without a scan finds ${nDerived} open, ${fmt(derived, dec)} -> ${ok ? 'REPRODUCED' : 'MISMATCH'}`);
  }
  return { positions: nOpen, wallets: `${reproduced}/${picked.length}`, reconcile, checks };
}

/* ----- EVM, from the published selectors and return layouts ----- */

const ERC20_DECIMALS = '0x313ce567'; // decimals(), the ERC-20 standard: used only to check the file's decimals
const pad = (v) => (typeof v === 'string' ? v.toLowerCase().replace(/^0x/, '') : BigInt(v).toString(16)).padStart(64, '0');
const word = (hex, i) => BigInt(`0x${hex.slice(2 + 64 * i, 2 + 64 * (i + 1)) || '0'}`);
const addrWord = (hex, i) => `0x${hex.slice(2 + 64 * i, 2 + 64 * (i + 1)).slice(-40)}`;
const wordIndex = (returns, name) =>
  returns.replace(/^\(|\)$/g, '').split(',').map((p) => p.trim().split(/\s+/).pop()).indexOf(name);
const callOf = (c, sig) => {
  const x = c.read.calls.find((k) => k.signature === sig);
  if (!x) throw new Error(`${c.id} publishes no ${sig}`);
  return x;
};
async function eth(chain, to, selector, argsList = [], block = 'latest') {
  try {
    return await rpc(chain, 'eth_call', [{ to, data: selector + argsList.map(pad).join('') }, block]);
  } catch (e) {
    if (e.rpcError) return null; // a revert
    throw e;
  }
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

async function tokenDecimalChecks(chain, c) {
  const checks = [];
  for (const t of c.tokens) {
    const d = await eth(chain, t.address, ERC20_DECIMALS);
    checks.push([`${t.symbol}.decimals() == ${t.decimals}`, d !== null && word(d, 0) === BigInt(t.decimals)]);
  }
  return checks;
}

async function probeEvmLadder(chain, c) {
  const t = c.tokens[0]; const dec = t.decimals;
  const block = await rpc(chain, 'eth_blockNumber', []);
  const checks = await tokenDecimalChecks(chain, c);
  const next = word(await eth(chain, c.address, callOf(c, 'nextPositionId()').selector, [], block), 0);
  const total = word(await eth(chain, c.address, callOf(c, 'totalSupply()').selector, [], block), 0);
  const token = addrWord(await eth(chain, c.address, callOf(c, 'stakingToken()').selector, [], block), 0);
  checks.push(['stakingToken() == token', same(token, t.address)]);
  const held = word(await eth(chain, t.address, callOf(c, 'balanceOf(address)').selector, [c.address], block), 0);
  const posCall = callOf(c, 'positions(uint256)');
  const byWallet = new Map(); let sum = 0n; let open = 0;
  for (let id = 1n; id < next; id++) {
    const p = await eth(chain, c.address, posCall.selector, [id], block);
    const owner = addrWord(p, wordIndex(posCall.returns, 'owner'));
    const amount = word(p, wordIndex(posCall.returns, 'amount'));
    if (/^0x0{40}$/.test(owner)) continue;
    open++; sum += amount;
    const w = byWallet.get(owner) ?? { sum: 0n, n: 0 }; w.sum += amount; w.n++; byWallet.set(owner, w);
  }
  const reconcile = sum === total && held >= total;
  checks.push(['reconcile: sum(positions.amount) == totalSupply() and token balance >= totalSupply()', reconcile]);
  out(`  block ${BigInt(block)}; nextPositionId() ${next}; totalSupply() ${fmt(total, dec)}; ${t.symbol} held by the contract ${fmt(held, dec)}`);
  if (next <= 1n) {
    out('  no positions: nextPositionId()==1');
    return { positions: 0, wallets: 'none exist', reconcile, checks };
  }
  let reproduced = 0; const picked = top(byWallet);
  for (const [wallet, scan] of picked) {
    const bal = word(await eth(chain, c.address, callOf(c, 'balanceOf(address)').selector, [wallet], block), 0);
    const ids = await eth(chain, c.address, callOf(c, 'positionsOf(address)').selector, [wallet], block);
    const n = Number(word(ids, 1));
    let s = 0n;
    for (let i = 0; i < n; i++) s += word(await eth(chain, c.address, posCall.selector, [word(ids, 2 + i)], block), wordIndex(posCall.returns, 'amount'));
    const ok = bal === s && s === scan.sum;
    if (ok) reproduced++;
    out(`  wallet ${wallet}: balanceOf ${fmt(bal, dec)}; positionsOf ${n} ids summing ${fmt(s, dec)}; scan ${fmt(scan.sum, dec)} -> ${ok ? 'REPRODUCED' : 'MISMATCH'}`);
  }
  return { positions: open, wallets: `${reproduced}/${picked.length}`, reconcile, checks };
}

async function probeStaking(chain, c) {
  const t = c.tokens[0]; const dec = t.decimals;
  const block = await rpc(chain, 'eth_blockNumber', []);
  const checks = await tokenDecimalChecks(chain, c);
  const posCall = callOf(c, 'positions(uint256)');
  const ownerCall = callOf(c, 'ownerOf(uint256)');
  const amountAt = wordIndex(posCall.returns, 'amount');
  const total = word(await eth(chain, c.address, callOf(c, 'totalStaked()').selector, [], block), 0);
  const byWallet = new Map(); let sum = 0n; let live = 0; let misses = 0; let lastId = 0n;
  for (let id = 1n; misses < 30 && id < 5000n; id++) {
    const p = await eth(chain, c.address, posCall.selector, [id], block);
    const o = await eth(chain, c.address, ownerCall.selector, [id], block);
    const amount = p ? word(p, amountAt) : 0n;
    if (!o || amount === 0n) { misses++; continue; }
    misses = 0; live++; sum += amount; lastId = id;
    const owner = addrWord(o, 0);
    const w = byWallet.get(owner) ?? { sum: 0n, n: 0 }; w.sum += amount; w.n++; byWallet.set(owner, w);
  }
  for (const w of byWallet.keys()) stakingOwners.add(w);
  const reconcile = sum === total;
  checks.push(['reconcile: sum(positions.amount) over live ids == totalStaked()', reconcile]);
  out(`  block ${BigInt(block)}; live ids ${live} (highest ${lastId}) across ${byWallet.size} owners; sum ${fmt(sum, dec)} ${t.symbol}; totalStaked() ${fmt(total, dec)}`);
  let reproduced = 0; const picked = top(byWallet);
  for (const [wallet, scan] of picked) {
    const count = word(await eth(chain, c.address, callOf(c, 'balanceOf(address)').selector, [wallet], block), 0);
    const ok = count === BigInt(scan.n);
    if (ok) reproduced++;
    out(`  wallet ${wallet}: positions ${scan.n} summing ${fmt(scan.sum, dec)}; balanceOf ${count} -> ${ok ? 'REPRODUCED' : 'MISMATCH'}`);
  }
  return { positions: live, wallets: `${reproduced}/${picked.length}`, reconcile, checks };
}

async function probePair(chain, c) {
  const block = await rpc(chain, 'eth_blockNumber', []);
  const checks = await tokenDecimalChecks(chain, c);
  const lpDec = word(await eth(chain, c.address, ERC20_DECIMALS, [], block), 0);
  checks.push([`LP decimals() == ${c.read.lp.decimals}`, lpDec === BigInt(c.read.lp.decimals)]);
  const [t0, t1] = c.tokens;
  checks.push(['token0() and token1() are the listed tokens in order',
    same(addrWord(await eth(chain, c.address, callOf(c, 'token0()').selector, [], block), 0), t0.address) &&
    same(addrWord(await eth(chain, c.address, callOf(c, 'token1()').selector, [], block), 0), t1.address)]);
  const resCall = callOf(c, 'getReserves()');
  const res = await eth(chain, c.address, resCall.selector, [], block);
  const r0 = word(res, wordIndex(resCall.returns, 'reserve0'));
  const r1 = word(res, wordIndex(resCall.returns, 'reserve1'));
  const supply = word(await eth(chain, c.address, callOf(c, 'totalSupply()').selector, [], block), 0);
  const bal = callOf(c, 'balanceOf(address)').selector;
  const h0 = word(await eth(chain, t0.address, bal, [c.address], block), 0);
  const h1 = word(await eth(chain, t1.address, bal, [c.address], block), 0);
  const reconcile = h0 >= r0 && h1 >= r1;
  checks.push(['reconcile: token balances >= reserves', reconcile]);
  out(`  block ${BigInt(block)}; reserve0 ${fmt(r0, t0.decimals)} ${t0.symbol}, reserve1 ${fmt(r1, t1.decimals)} ${t1.symbol}; LP supply ${fmt(supply, 18)}`);
  const wallets = [...new Set([...extraWallets, ...stakingOwners].map((w) => w.toLowerCase()))];
  let holders = 0;
  for (const w of wallets) {
    const lp = word(await eth(chain, c.address, bal, [w], block), 0);
    if (lp === 0n) continue;
    holders++;
    out(`  wallet ${w}: LP ${fmt(lp, 18)} -> ${fmt((lp * r0) / supply, t0.decimals)} ${t0.symbol} + ${fmt((lp * r1) / supply, t1.decimals)} ${t1.symbol}`);
  }
  out(`  ${holders} of ${wallets.length} candidate wallets hold LP in the wallet`);
  return { positions: holders, wallets: `${holders} read`, reconcile, checks, pair: { r0, r1, supply, t0, t1 } };
}

async function probeFarm(chain, c, pairResult, pairContract) {
  const block = await rpc(chain, 'eth_blockNumber', []);
  const checks = await tokenDecimalChecks(chain, c);
  const lpToken = addrWord(await eth(chain, c.address, callOf(c, 'stakingToken()').selector, [], block), 0);
  checks.push(['stakingToken() == the pair', same(lpToken, c.read.lp.address)]);
  const totalRaw = word(await eth(chain, c.address, callOf(c, 'totalRawSupply()').selector, [], block), 0);
  const held = word(await eth(chain, c.read.lp.address, callOf(pairContract, 'balanceOf(address)').selector, [c.address], block), 0);
  const wallets = [...new Set([...extraWallets, ...stakingOwners].map((w) => w.toLowerCase()))];
  let found = 0n; let stakers = 0;
  const { r0, r1, supply, t0, t1 } = pairResult;
  for (const w of wallets) {
    const lp = word(await eth(chain, c.address, callOf(c, 'rawBalanceOf(address)').selector, [w], block), 0);
    if (lp === 0n) continue;
    stakers++; found += lp;
    out(`  wallet ${w}: rawBalanceOf ${fmt(lp, 18)} LP -> ${fmt((lp * r0) / supply, t0.decimals)} ${t0.symbol} + ${fmt((lp * r1) / supply, t1.decimals)} ${t1.symbol}`);
  }
  const reconcile = held >= totalRaw;
  checks.push(['reconcile: pair.balanceOf(farm) >= totalRawSupply()', reconcile]);
  checks.push(['the wallets found account for all of totalRawSupply()', found === totalRaw]);
  out(`  block ${BigInt(block)}; totalRawSupply() ${fmt(totalRaw, 18)} LP; LP held by the farm ${fmt(held, 18)}; found ${fmt(found, 18)} across ${stakers} wallets`);
  return { positions: stakers, wallets: found === totalRaw ? `${stakers}/${stakers}, all of totalRawSupply` : `${stakers} read`, reconcile, checks };
}

/* ----- run ----- */

out(`held-through probe: ${file ?? url}`);
out(`schema ${doc.schema}; generated ${doc.generated}; commit ${doc.commit ?? '(none)'}; run at ${new Date().toISOString()}`);
out(`RPC: solana ${RPC.solana}; ethereum ${RPC.ethereum}; base ${RPC.base} (read methods only)`);
let pairResult = null;
for (const chain of ['solana', 'ethereum', 'base']) {
  for (const c of doc.chains[chain] ?? []) {
    if (only.size && !only.has(c.id)) continue;
    out('');
    out(`[${chain}] ${c.id}: ${c.label} (${c.kind}, ${c.offered}, readByIsland ${c.readByIsland}) ${c.address}`);
    let r;
    try {
      if (c.kind === 'bayla-ladder') r = await probeLadder(c);
      else if (c.kind === 'streamflow-stake-pool') r = await probeStreamflow(c);
      else if (c.kind === 'lighthouse-ladder') r = await probeEvmLadder(chain, c);
      else if (c.kind === 'tegridy-staking' || c.kind === 'tegridy-staking-legacy') r = await probeStaking(chain, c);
      else if (c.kind === 'tegridy-pair') { r = await probePair(chain, c); pairResult = { ...r.pair, contract: c }; }
      else if (c.kind === 'tegridy-lp-farming') {
        if (!pairResult) throw new Error('the pair must be probed first');
        r = await probeFarm(chain, c, pairResult, pairResult.contract);
      } else throw new Error(`no probe for kind ${c.kind}`);
    } catch (e) {
      out(`  ERROR ${e.message}`);
      summary.push([c.id, '-', '-', 'ERROR']);
      continue;
    }
    for (const [what, ok] of r.checks) out(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    const allOk = r.checks.every(([, ok]) => ok);
    summary.push([c.id, String(r.positions), r.wallets, allOk ? 'ok' : 'FAIL']);
  }
}
out('');
out('SUMMARY  id | open positions | wallets reproduced | checks');
for (const row of summary) out(`  ${row.join(' | ')}`);
const failed = summary.filter((r) => r[3] !== 'ok').length;
out(`${summary.length} contracts probed, ${failed} with a failed check or an error.`);
process.exitCode = failed ? 1 : 0;
