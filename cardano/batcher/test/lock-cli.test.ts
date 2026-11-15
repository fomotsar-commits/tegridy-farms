// scripts/lock.ts and the co-signing page (scripts/cosign.ts) run as the owner runs them, against
// a stand-in Koios and Ogmios on this machine serving the real preprod outputs of PR #1148's
// rehearsal (test/fixtures/lock-preprod.json): the network both sources must answer with, and the
// page reading a lock transaction in <out> with the deploy's scripts.json. A fee-share withdrawal
// runs on the chain test/withdraw-chain.ts derives (the Execute, then a swap the batcher fills),
// its Ogmios judging with Aiken when AIKEN is set.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import type { ProtocolParams } from '../src/build.ts';
import { announceSpec, announceWindow, executeSpec, executeWindow, lockTx, poolChange, poolNow, readLockTx, type LockDeployment } from '../src/lock.ts';
import { CHANGE_AFTER, judge, LOCK_AFTER, outputs as chainOutputs, POOL_AFTER, SWAPPED } from './withdraw-chain.ts';

const LOCK_CLI = fileURLToPath(new URL('../scripts/lock.ts', import.meta.url));
const COSIGN = fileURLToPath(new URL('../scripts/cosign.ts', import.meta.url));
const FX = JSON.parse(readFileSync(new URL('./fixtures/lock-preprod.json', import.meta.url), 'utf8')) as {
  refs: Record<string, string>;
  refsState: Record<string, string>;
  outputs: Record<string, string>;
  pp: ProtocolParams;
  inputs: Record<string, unknown> & { deployer: string; ownerA: string; ownerB: string; treasury: string };
  deployment: { lock: string; policy: string; pool: string };
};
const D: LockDeployment = { network: 0, lock: FX.deployment.lock, authen: FX.deployment.policy, pool: FX.deployment.pool, ownerA: FX.inputs.ownerA, ownerB: FX.inputs.ownerB, treasury: FX.inputs.treasury };
const u = (k: string) => ({ ref: FX.refs[k]!, outputHex: FX.outputs[FX.refs[k]!]! });
const REFS = { lockScript: u('lockScript'), poolScript: u('poolScript'), settingScript: u('authenScript') };
const READY = 1_794_278_064_000n;
const slotOf = (ms: bigint) => 86_400n + (ms - 1_655_769_600_000n) / 1_000n;
const plan = (validity: { start: bigint; ttl: bigint }) => ({ pp: FX.pp, funds: [u('funds')], change: FX.inputs.deployer, validity });
/** What the chain holds unspent: the real lock, pool, setting, reference scripts and a deployer coin. */
const UNSPENT = ['lock', 'pool', 'globalSetting', 'lockScript', 'poolScript', 'authenScript', 'funds'].map((k) => FX.refs[k]!);

const OGMIOS_PP = JSON.parse(readFileSync(new URL('./fixtures/ogmios-protocol-parameters.json', import.meta.url), 'utf8')).result;
/** What the stand-in chain holds: every output it can show, and which of them are unspent. */
interface View {
  outputs: Record<string, string>;
  unspent: string[];
}
const REAL: View = { outputs: FX.outputs, unspent: UNSPENT };

/** One output as a Koios row (`_extended`), the way utxoFromKoios reads it back. */
function row(ref: string, view: View = REAL): Record<string, unknown> {
  const o = CSL.TransactionOutput.from_hex(view.outputs[ref]!);
  const [h, ix] = ref.split('#') as [string, string];
  const assets: { policy_id: string; asset_name: string; quantity: string }[] = [];
  const ma = o.amount().multiasset();
  for (let i = 0; i < (ma?.keys().len() ?? 0); i++) {
    const p = ma!.keys().get(i);
    const as = ma!.get(p)!;
    for (let j = 0; j < as.keys().len(); j++) assets.push({ policy_id: p.to_hex(), asset_name: Buffer.from(as.keys().get(j).name()).toString('hex'), quantity: as.get(as.keys().get(j))!.to_str() });
  }
  const d = o.plutus_data();
  const s = o.script_ref()?.plutus_script();
  return { tx_hash: h, tx_index: Number(ix), address: o.address().to_bech32(undefined), value: o.amount().coin().to_str(), asset_list: assets, datum_hash: d ? CSL.hash_plutus_data(d).to_hex() : null, inline_datum: d ? { bytes: d.to_hex() } : null, reference_script: s ? { type: 'plutusV2', bytes: Buffer.from(s.bytes()).toString('hex'), hash: s.hash().to_hex() } : null, block_time: 1_700_000_000, is_spent: false };
}

function chain(magic: { koios: string; ogmios: number }, view: View = REAL) {
  const s = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const url = new URL(req.url ?? '/', 'http://x');
      const list = (rows: unknown[]) => {
        res.setHeader('content-range', `0-${Math.max(rows.length - 1, 0)}/${rows.length}`);
        res.end(JSON.stringify(rows));
      };
      if (url.pathname === '/genesis') return res.end(JSON.stringify([{ networkmagic: magic.koios }]));
      if (url.pathname === '/utxo_info') return res.end(JSON.stringify((JSON.parse(b)._utxo_refs as string[]).filter((r) => view.unspent.includes(r)).map((r) => row(r, view))));
      if (url.pathname === '/address_utxos') {
        const at = JSON.parse(b)._addresses as string[];
        return list(view.unspent.filter((r) => at.includes(CSL.TransactionOutput.from_hex(view.outputs[r]!).address().to_bech32(undefined))).map((r) => row(r, view)));
      }
      if (url.pathname === '/asset_utxos') {
        const [policy, name] = (JSON.parse(b)._asset_list as [string, string][])[0]!;
        const cred = /^eq\.([0-9a-f]{56})$/.exec(url.searchParams.get('payment_cred') ?? '')?.[1];
        return list(view.unspent.filter((r) => {
          const o = CSL.TransactionOutput.from_hex(view.outputs[r]!);
          const q = o.amount().multiasset()?.get_asset(CSL.ScriptHash.from_hex(policy!), CSL.AssetName.new(Buffer.from(name!, 'hex')));
          return !!q && (!cred || o.address().payment_cred()?.to_scripthash()?.to_hex() === cred);
        }).map((r) => row(r, view)));
      }
      if (url.pathname === '/ogmios') {
        const m = JSON.parse(b);
        if (m.method === 'queryNetwork/genesisConfiguration') return res.end(JSON.stringify({ jsonrpc: '2.0', method: m.method, result: { era: 'shelley', networkMagic: magic.ogmios } }));
        if (m.method === 'queryNetwork/tip') return res.end(JSON.stringify({ jsonrpc: '2.0', method: m.method, result: { slot: Number(slotOf(READY - 86_400_000n)), id: 'ab'.repeat(32) } }));
        if (m.method === 'queryLedgerState/protocolParameters') return res.end(JSON.stringify({ jsonrpc: '2.0', method: m.method, result: OGMIOS_PP }));
        if (m.method === 'evaluateTransaction') {
          // Aiken judges it when it is here (its scripts' measured budgets, or a 3010); otherwise a generous stand-in budget per spend.
          const tx = m.params.transaction.cbor as string;
          const spends = CSL.FixedTransaction.from_hex(tx).body().inputs().len();
          const j = process.env.AIKEN ? judge(process.env.AIKEN, tx, (r) => view.outputs[r]) : { ok: true as const, budgets: Array.from({ length: spends }, (_, i) => ({ tag: 'Spend', index: i, mem: 1_500_000n, steps: 600_000_000n })) };
          if (!j.ok) return res.end(JSON.stringify({ jsonrpc: '2.0', method: m.method, error: { code: 3010, message: j.error.slice(0, 400), data: [] } }));
          return res.end(JSON.stringify({ jsonrpc: '2.0', method: m.method, result: j.budgets.map((x) => ({ validator: { purpose: x.tag.toLowerCase(), index: x.index }, budget: { memory: Number(x.mem), cpu: Number(x.steps) } })) }));
        }
      }
      res.statusCode = 404;
      res.end('[]');
    });
  });
  return new Promise<{ url: string; close: () => void }>((ok) => s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => s.close() })));
}

function runDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lock-cli-'));
  // The batcher's key plays no part in a lock transaction: a fresh one stands in.
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ ...FX.inputs, batcherKeyHash: CSL.PrivateKey.generate_ed25519().to_public().hash().to_hex() }));
  mkdirSync(join(dir, 'out'));
  const h = (hash: string) => ({ hash, compiledCode: '' });
  writeFileSync(join(dir, 'out', 'scripts.json'), JSON.stringify({ scripts: { lock: h(D.lock), authen: h(D.authen), globalSetting: h(D.authen), pool: h(D.pool) } }));
  writeFileSync(join(dir, 'out', 'state.json'), JSON.stringify({ refs: FX.refsState, txs: {} }));
  return dir;
}
function run(script: string, args: string[], env: Record<string, string>): Promise<{ status: number | null; out: string }> {
  const p = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env } });
  let out = '';
  p.stderr.on('data', (c) => (out += c));
  p.stdout.on('data', (c) => (out += c));
  return new Promise((ok) => p.on('close', (status) => ok({ status, out })));
}

test('lock.ts refuses a Koios or an Ogmios on another network than the inputs, before reading anything else', async () => {
  const dir = runDir();
  const go = async (magic: { koios: string; ogmios: number }) => {
    const c = await chain(magic);
    try {
      return await run(LOCK_CLI, ['show', join(dir, 'inputs.json'), join(dir, 'out')], { KOIOS_URL: c.url, OGMIOS_URL: `${c.url}/ogmios` });
    } finally {
      c.close();
    }
  };
  try {
    const k = await go({ koios: '764824073', ogmios: 1 });
    assert.notEqual(k.status, 0);
    assert.match(k.out, /Koios \(http:\/\/127\.0\.0\.1:\d+\) is not on preprod \(network magic 764824073\)/);
    const o = await go({ koios: '1', ogmios: 764_824_073 });
    assert.notEqual(o.status, 0);
    assert.match(o.out, /Ogmios \(http:\/\/127\.0\.0\.1:\d+\/ogmios\) is not on preprod/);
    const ok = await go({ koios: '1', ogmios: 1 });
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /1 announced[\s\S]*#0: pool ADA \/ MEMETEST .*venue share 1333\/10000 of the trade fee.*waiting, ready 2026-11-10 02:34:24 UTC/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function call(port: number, path: string): Promise<{ status: number; json: any }> {
  return new Promise((ok, fail) => {
    const r = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` }, setHost: false }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => ok({ status: res.statusCode!, json: t ? JSON.parse(t) : null }));
    });
    r.on('error', fail);
    r.end();
  });
}

test("the page reads lock transactions with the deploy's scripts.json: the change in plain words against the pool now, and an early Execute refused", async () => {
  const dir = runDir();
  const env = (s: string) => ({ type: 'Tx ConwayEra', description: s, cborHex: '' });
  const execute = lockTx(executeSpec(D, REFS, u('lock'), 0, u('pool'), u('globalSetting'), FX.pp), plan(executeWindow(slotOf(READY + 600_000n), 0, READY, 600n)));
  const early = lockTx(executeSpec(D, REFS, u('lock'), 0, u('pool'), u('globalSetting'), FX.pp), plan({ start: slotOf(READY) - 1n, ttl: slotOf(READY) + 300n }));
  const w = announceWindow(slotOf(READY - 86_400_000n), 0, 600n);
  const announce = lockTx(announceSpec(D, REFS, u('lock'), poolChange(poolNow(u('pool').outputHex), { baseFee: [25n, 25n] }), w.readyAt, FX.pp), plan(w));
  for (const [step, hex] of [['lock-execute-1', execute.txHex], ['lock-execute-2', early.txHex], ['lock-announce-3', announce.txHex]] as const) writeFileSync(join(dir, 'out', `${step}.tx.json`), JSON.stringify({ ...env(step), cborHex: hex }));
  const c = await chain({ koios: '1', ogmios: 1 });
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  let p: ChildProcess | undefined;
  try {
    p = spawn(process.execPath, [COSIGN, 'serve', join(dir, 'inputs.json'), join(dir, 'out'), '--port', String(port)], { env: { ...process.env, KOIOS_URL: c.url } });
    let log = '';
    p.stdout!.on('data', (x) => (log += x));
    p.stderr!.on('data', (x) => (log += x));
    await new Promise<void>((ok, fail) => {
      const t = setInterval(() => {
        if (log.includes('co-signing page for')) ok(clearInterval(t));
        else if (p!.exitCode !== null) fail(new Error((clearInterval(t), log)));
      }, 50);
    });
    const x = await call(port, '/api/tx?step=lock-execute-1');
    assert.equal(x.status, 200, JSON.stringify(x.json));
    assert.equal(x.json.review.lock.action, 'Execute');
    assert.match(x.json.review.lock.words.join('\n'), /venue share: off → 1333\/10000 of the trade fee/);
    assert.match(x.json.review.lock.when, /the window closes 2026-11-24 02:34:24 UTC/);
    const e = await call(port, '/api/tx?step=lock-execute-2');
    assert.equal(e.status, 422);
    assert.match(e.json.error, /the lock transaction is refused: the Execute could run before ready_at/);
    // An Announce touches no pool: the page reads the pool as the chain holds it now, to say what changes.
    const a = await call(port, '/api/tx?step=lock-announce-3');
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.match(a.json.review.lock.words.join('\n'), /base fee: 30\/30 \(0\.30% each way\) → 25\/25 \(0\.25% each way\)/);
  } finally {
    p?.kill();
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock.ts withdraw: the pool's whole share to the treasury, judged and written unsigned; the page reads it; nothing accrued is refused", async () => {
  const dir = runDir();
  const known: Record<string, string> = {};
  for (const r of [...UNSPENT, LOCK_AFTER.ref, SWAPPED.pool.ref, POOL_AFTER.ref, CHANGE_AFTER.ref]) known[r] = chainOutputs()(r)!;
  // After the Execute and one swap: the lock, the pool and the deployer's change as that chain leaves them.
  const after = (pool: string): View => ({ outputs: known, unspent: [LOCK_AFTER.ref, pool, FX.refs.globalSetting!, FX.refs.lockScript!, FX.refs.poolScript!, FX.refs.authenScript!, CHANGE_AFTER.ref] });
  const args = (...more: string[]) => ['withdraw', join(dir, 'inputs.json'), join(dir, 'out'), '--pool', 'ada,1ac2931c06a56bbab07c21ab7fde8eb6cac7cf427a49b03f00aa234b.4d454d4554455354', ...more];
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  let p: ChildProcess | undefined;
  const c = await chain({ koios: '1', ogmios: 1 }, after(SWAPPED.pool.ref));
  try {
    const env = { KOIOS_URL: c.url, OGMIOS_URL: `${c.url}/ogmios` };
    const w = await run(LOCK_CLI, args(), env);
    assert.equal(w.status, 0, w.out);
    assert.match(w.out, /the venue's share in [0-9a-f]{64}#1: 3999 of lovelace, 0 of 1ac2931c/);
    assert.match(w.out, /lock-withdraw-1: [0-9a-f]{64}, fee \d+ lovelace, judged by the node/);
    assert.match(w.out, /leaves the pool: 3999 lovelace \(0\.003999 ADA\)/);
    assert.ok(w.out.includes(`to the treasury ${FX.inputs.treasury}, and nowhere else`));
    const hex = (JSON.parse(readFileSync(join(dir, 'out', 'lock-withdraw-1.tx.json'), 'utf8')) as { cborHex: string }).cborHex;
    assert.equal(readLockTx(hex, (r) => known[r], D)!.action, 'WithdrawFeeSharing');
    if (process.env.AIKEN) {
      const j = judge(process.env.AIKEN, hex, (r) => known[r]);
      assert.ok(j.ok, j.ok ? '' : j.error);
    }
    // The page: each coin that leaves the pool, and the treasury's whole address.
    p = spawn(process.execPath, [COSIGN, 'serve', join(dir, 'inputs.json'), join(dir, 'out'), '--port', String(port)], { env: { ...process.env, KOIOS_URL: c.url } });
    let log = '';
    p.stdout!.on('data', (x) => (log += x));
    p.stderr!.on('data', (x) => (log += x));
    await new Promise<void>((ok, fail) => {
      const t = setInterval(() => {
        if (log.includes('co-signing page for')) ok(clearInterval(t));
        else if (p!.exitCode !== null) fail(new Error((clearInterval(t), log)));
      }, 50);
    });
    const x = await call(port, '/api/tx?step=lock-withdraw-1');
    assert.equal(x.status, 200, JSON.stringify(x.json));
    assert.equal(x.json.review.lock.action, 'WithdrawFeeSharing');
    assert.deepEqual(x.json.review.lock.withdrawal.leaves, [{ ticker: 'ADA', policy: '', name: '', quantity: '3999' }]);
    assert.equal(x.json.review.lock.withdrawal.treasury, FX.inputs.treasury);
  } finally {
    p?.kill();
    c.close();
  }
  // The pool as the Execute leaves it, before any trade: nothing to take.
  const empty = await chain({ koios: '1', ogmios: 1 }, after(POOL_AFTER.ref));
  try {
    rmSync(join(dir, 'out', 'lock-withdraw-1.tx.json'));
    const env = { KOIOS_URL: empty.url, OGMIOS_URL: `${empty.url}/ogmios` };
    // A change flag, or --simulate: a withdrawal takes neither.
    assert.match((await run(LOCK_CLI, args('--fee-share', '1500'), env)).out, /a withdrawal changes nothing/);
    assert.match((await run(LOCK_CLI, args('--simulate'), env)).out, /a withdrawal changes nothing/);
    const e = await run(LOCK_CLI, args(), env);
    assert.notEqual(e.status, 0);
    assert.match(e.out, /nothing has accrued in [0-9a-f]{64}#1/);
  } finally {
    empty.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
