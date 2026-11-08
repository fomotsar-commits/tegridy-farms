// scripts/lock.ts and the co-signing page (scripts/cosign.ts) run as the owner runs them, against
// a stand-in Koios and Ogmios on this machine serving the real preprod outputs of PR #1148's
// rehearsal (test/fixtures/lock-preprod.json): the network both sources must answer with, and the
// page reading a lock transaction in <out> with the deploy's scripts.json.
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
import { announceSpec, announceWindow, executeSpec, executeWindow, lockTx, poolChange, poolNow, type LockDeployment } from '../src/lock.ts';

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

/** One output as a Koios row (`_extended`), the way utxoFromKoios reads it back. */
function row(ref: string): Record<string, unknown> {
  const o = CSL.TransactionOutput.from_hex(FX.outputs[ref]!);
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

function chain(magic: { koios: string; ogmios: number }) {
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
      if (url.pathname === '/utxo_info') return res.end(JSON.stringify((JSON.parse(b)._utxo_refs as string[]).filter((r) => UNSPENT.includes(r)).map(row)));
      if (url.pathname === '/asset_utxos') {
        const [policy, name] = (JSON.parse(b)._asset_list as [string, string][])[0]!;
        const cred = /^eq\.([0-9a-f]{56})$/.exec(url.searchParams.get('payment_cred') ?? '')?.[1];
        return list(UNSPENT.filter((r) => {
          const o = CSL.TransactionOutput.from_hex(FX.outputs[r]!);
          const q = o.amount().multiasset()?.get_asset(CSL.ScriptHash.from_hex(policy!), CSL.AssetName.new(Buffer.from(name!, 'hex')));
          return !!q && (!cred || o.address().payment_cred()?.to_scripthash()?.to_hex() === cred);
        }).map(row));
      }
      if (url.pathname === '/ogmios') {
        const m = JSON.parse(b);
        if (m.method === 'queryNetwork/genesisConfiguration') return res.end(JSON.stringify({ jsonrpc: '2.0', method: m.method, result: { era: 'shelley', networkMagic: magic.ogmios } }));
        if (m.method === 'queryNetwork/tip') return res.end(JSON.stringify({ jsonrpc: '2.0', method: m.method, result: { slot: Number(slotOf(READY - 86_400_000n)), id: 'ab'.repeat(32) } }));
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
