// The co-signing page's server (scripts/cosign.ts), run as the owner runs it, against a stand-in
// Koios and Ogmios on this machine: who may talk to it, what it keeps, and what it sends.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';

const SCRIPT = fileURLToPath(new URL('../scripts/cosign.ts', import.meta.url));
const key = () => CSL.PrivateKey.generate_ed25519();
const K = { deployer: key(), a: key(), b: key(), stranger: key() };
const hash = (k: CSL.PrivateKey) => k.to_public().hash().to_hex();
const addr = (k: CSL.PrivateKey, net = 0) => CSL.EnterpriseAddress.new(net, CSL.Credential.from_keyhash(k.to_public().hash())).to_address();
const big = (n: bigint) => CSL.BigNum.from_str(n.toString());
const IN = 'ab'.repeat(32);

// The rehearsal's stand-in two-key treasury on preprod (both parts all-of-two scripts).
const INPUTS = {
  network: 0,
  deployer: addr(K.deployer).to_bech32(undefined),
  seedTxIn: `${'11'.repeat(32)}#0`,
  lockSeedTxIn: `${'11'.repeat(32)}#1`,
  ownerA: hash(K.a),
  ownerB: hash(K.b),
  batcherKeyHash: hash(key()),
  treasury: 'addr_test1xr0y9r8zxl9rujfrew5gnxl6430js7tta6q4cm7h6p80fqc3urxc980aqdksn0ljkuvzcus3cfsnyy0zjcq23qtsx6yq8z76re',
  treasuryScript: '8201828200581c687f4191e716452f679060c5de4befa1eec1193c1017206ab10672bf8200581c9b9f6bc73a6891efbd7e55a14fc416e9bc5aa1cb9f2a906b85b3e1f5',
  treasuryStakeScript: '8201828200581cf8b9a732621335bb5b9a7996c6045f3362f7ae7a4105cfd1a7eebafa8200581cef8033c95b2c473b4678c624d6d739b7bfe08e1cae28444dab8eb010',
  poolStake: { type: 'Script', hash: '11e0cd829dfd036d09bff2b7182c7211c2613211e29600a881703688' },
  openingFee: '73000000',
};

function payment(fee: bigint): string {
  const ins = CSL.TransactionInputs.new();
  ins.add(CSL.TransactionInput.new(CSL.TransactionHash.from_hex(IN), 0));
  const outs = CSL.TransactionOutputs.new();
  outs.add(CSL.TransactionOutput.new(addr(K.deployer), CSL.Value.new(big(10_000_000n - fee))));
  const body = CSL.TransactionBody.new_tx_body(ins, outs, big(fee));
  const rs = CSL.Ed25519KeyHashes.new();
  rs.add(K.a.to_public().hash());
  rs.add(K.b.to_public().hash());
  body.set_required_signers(rs);
  return CSL.Transaction.new(body, CSL.TransactionWitnessSet.new()).to_hex();
}
const idOf = (hex: string) => CSL.FixedTransaction.from_hex(hex).transaction_hash().to_hex();
function walletSigns(txHex: string, k: CSL.PrivateKey): string {
  const vs = CSL.Vkeywitnesses.new();
  vs.add(CSL.make_vkey_witness(CSL.FixedTransaction.from_hex(txHex).transaction_hash(), k));
  const ws = CSL.TransactionWitnessSet.new();
  ws.set_vkeys(vs);
  return ws.to_hex();
}

/** A stand-in Koios and Ogmios: one UTxO, a network magic, and every submission kept. */
function chain(magic: { koios: string; ogmios: number; answers?: string }) {
  const submitted: string[] = [];
  const s: Server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/genesis') return res.end(JSON.stringify([{ networkmagic: magic.koios }]));
      if (req.url === '/utxo_info') {
        const refs = JSON.parse(b)._utxo_refs as string[];
        return res.end(JSON.stringify(refs.filter((r) => r === `${IN}#0`).map(() => ({ tx_hash: IN, tx_index: 0, address: INPUTS.deployer, value: '10000000', asset_list: [], datum_hash: null, inline_datum: null, reference_script: null, block_time: 1_700_000_000, is_spent: false }))));
      }
      if (req.url === '/ogmios') {
        const m = JSON.parse(b);
        if (m.method === 'queryNetwork/genesisConfiguration') return res.end(JSON.stringify({ jsonrpc: '2.0', method: m.method, result: { era: 'shelley', networkMagic: magic.ogmios } }));
        if (m.method === 'submitTransaction') {
          submitted.push(m.params.transaction.cbor);
          return res.end(JSON.stringify({ jsonrpc: '2.0', method: m.method, result: { transaction: { id: magic.answers ?? idOf(m.params.transaction.cbor) } } }));
        }
      }
      res.statusCode = 404;
      res.end('[]');
    });
  });
  return new Promise<{ url: string; submitted: string[]; close: () => void }>((ok) => s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, submitted, close: () => s.close() })));
}

function call(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((ok, fail) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers, setHost: false }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => ok({ status: res.statusCode!, json: t ? JSON.parse(t) : null }));
    });
    r.on('error', fail);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function serve(dir: string, koios: string, port: number): Promise<{ p: ChildProcess; log: () => string }> {
  const p = spawn(process.execPath, [SCRIPT, 'serve', join(dir, 'inputs.json'), join(dir, 'out'), '--port', String(port)], { env: { ...process.env, KOIOS_URL: koios } });
  let log = '';
  p.stdout!.on('data', (c) => (log += c));
  p.stderr!.on('data', (c) => (log += c));
  return new Promise((ok, fail) => {
    const t = setInterval(() => {
      if (log.includes('co-signing page for')) {
        clearInterval(t);
        ok({ p, log: () => log });
      } else if (p.exitCode !== null) {
        clearInterval(t);
        fail(new Error(log));
      }
    }, 50);
  });
}

function runDir(inputs: object = INPUTS): string {
  const dir = mkdtempSync(join(tmpdir(), 'cosign-'));
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify(inputs));
  mkdirSync(join(dir, 'out'));
  writeFileSync(join(dir, 'out', 'proof.tx.json'), JSON.stringify({ type: 'Tx ConwayEra', description: 'proof', cborHex: payment(200_000n) }));
  return dir;
}
/** A CLI step, run apart: the stand-in chain answers from this process, so it must not block. */
function run(args: string[], env: Record<string, string>): Promise<{ status: number | null; stderr: string }> {
  const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } });
  let stderr = '';
  p.stderr.on('data', (c) => (stderr += c));
  p.stdout.on('data', (c) => (stderr += c));
  return new Promise((ok) => p.on('close', (status) => ok({ status, stderr })));
}
const cli = (dir: string, cmd: string, env: Record<string, string>) => run([cmd, join(dir, 'inputs.json'), join(dir, 'out'), 'proof'], env);

test('the page: this machine only, needed keys only, one body only, then assemble and submit on the run\'s network', async () => {
  const c = await chain({ koios: '1', ogmios: 1 });
  const dir = runDir();
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const origin = `http://127.0.0.1:${port}`;
  const ok = { host: `127.0.0.1:${port}`, origin, 'content-type': 'application/json' };
  // Everything started here is stopped whatever fails: a test left running would hang the run.
  let s: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    s = await serve(dir, c.url, port);
    // Another name for this machine (DNS rebinding), or another site's page, is refused.
    assert.equal((await call(port, 'GET', '/api/run', { host: `localhost:${port}` })).status, 421);
    assert.equal((await call(port, 'POST', '/api/witness', { ...ok, origin: 'https://evil.example' }, {})).status, 403);
    const tx = (await call(port, 'GET', '/api/tx?step=proof', { host: ok.host })).json;
    assert.deepEqual(tx.review.needs.map((n: { key: string }) => n.key), [hash(K.deployer), hash(K.a), hash(K.b)]);
    assert.deepEqual(tx.review.needs.map((n: { label: string }) => n.label), ['the deployer', 'owner A', 'owner B']);
    const hex = tx.txHex as string;
    // A wallet on mainnet, in a preprod run.
    const main = await call(port, 'POST', '/api/wallet', ok, { step: 'proof', networkId: 1, addresses: [addr(K.a, 1).to_hex()] });
    assert.equal(main.status, 422);
    assert.match(main.json.error, /the wallet is on mainnet/);
    const w = await call(port, 'POST', '/api/witness', ok, { step: 'proof', txId: tx.review.txId, witnessSet: walletSigns(hex, K.a), networkId: 1 });
    assert.match(w.json.error, /the wallet is on mainnet/);
    assert.equal(existsSync(join(dir, 'out', 'proof.witnesses.json')), false);
    const held = await call(port, 'POST', '/api/wallet', ok, { step: 'proof', networkId: 0, addresses: [addr(K.a).to_hex()] });
    assert.deepEqual(held.json.holds.map((n: { key: string }) => n.key), [hash(K.a)]);
    // A key the transaction does not need.
    const rogue = await call(port, 'POST', '/api/witness', ok, { step: 'proof', txId: tx.review.txId, witnessSet: walletSigns(hex, K.stranger), networkId: 0 });
    assert.equal(rogue.status, 422);
    assert.match(rogue.json.error, /does not need/);
    // Owner A signs: kept.
    const a = await call(port, 'POST', '/api/witness', ok, { step: 'proof', txId: tx.review.txId, witnessSet: walletSigns(hex, K.a), networkId: 0 });
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.deepEqual(a.json.kept, [hash(K.a)]);
    assert.deepEqual(a.json.missing, [hash(K.deployer), hash(K.b)]);
    // The envelope is rebuilt (another body) while owner B's wallet signs the old one.
    const changed = payment(210_000n);
    writeFileSync(join(dir, 'out', 'proof.tx.json'), JSON.stringify({ type: 'Tx ConwayEra', cborHex: changed }));
    const late = await call(port, 'POST', '/api/witness', ok, { step: 'proof', txId: tx.review.txId, witnessSet: walletSigns(hex, K.b), networkId: 0 });
    assert.match(late.json.error, /changed while the wallet signed/);
    // Owner B reloads and signs the new body: refused, A's signature is for the old one.
    const fresh = (await call(port, 'GET', '/api/tx?step=proof', { host: ok.host })).json;
    assert.equal(fresh.stale, true);
    const b2 = await call(port, 'POST', '/api/witness', ok, { step: 'proof', txId: idOf(changed), witnessSet: walletSigns(changed, K.b), networkId: 0 });
    assert.match(b2.json.error, /changed between signatures/);
    // Back to the first body: B and the deployer sign, and every signature is in.
    writeFileSync(join(dir, 'out', 'proof.tx.json'), JSON.stringify({ type: 'Tx ConwayEra', cborHex: hex }));
    for (const k of [K.b, K.deployer]) assert.equal((await call(port, 'POST', '/api/witness', ok, { step: 'proof', txId: tx.review.txId, witnessSet: walletSigns(hex, k), networkId: 0 })).status, 200);
    assert.deepEqual((await call(port, 'GET', '/api/tx?step=proof', { host: ok.host })).json.missing, []);
    s.p.kill();
    s = undefined;
    // Ogmios on mainnet, in a preprod run: nothing is sent.
    const m = await chain({ koios: '1', ogmios: 764_824_073 });
    const r = await cli(dir, 'submit', { KOIOS_URL: c.url, OGMIOS_URL: `${m.url}/ogmios` });
    m.close();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Ogmios .* is not on preprod/);
    assert.equal(m.submitted.length, 0);
    // Koios on mainnet: refused before anything is read.
    const mk = await chain({ koios: '764824073', ogmios: 1 });
    const r2 = await cli(dir, 'assemble', { KOIOS_URL: mk.url });
    mk.close();
    assert.match(r2.stderr, /Koios .* is not on preprod/);
    // A node that answers with another transaction id: not recorded as sent.
    const liar = await chain({ koios: '1', ogmios: 1, answers: 'ee'.repeat(32) });
    const r5 = await cli(dir, 'submit', { KOIOS_URL: c.url, OGMIOS_URL: `${liar.url}/ogmios` });
    liar.close();
    assert.match(r5.stderr, /the node took e+, not/);
    assert.equal(existsSync(join(dir, 'out', 'state.json')), false);
    // The right network: assembled, sent once, recorded.
    const r3 = await cli(dir, 'submit', { KOIOS_URL: c.url, OGMIOS_URL: `${c.url}/ogmios` });
    assert.equal(r3.status, 0, r3.stderr);
    assert.equal(c.submitted.length, 1);
    const sent = CSL.FixedTransaction.from_hex(c.submitted[0]!);
    assert.equal(sent.transaction_hash().to_hex(), idOf(payment(200_000n)));
    assert.equal(sent.witness_set().vkeys()!.len(), 3);
    assert.equal(JSON.parse(readFileSync(join(dir, 'out', 'state.json'), 'utf8')).txs.proof, idOf(payment(200_000n)));
    // Inputs still pending the owner's OK: the page does not start.
    const pend = runDir({ ...INPUTS, _pending: ['ownerA'] });
    const r4 = await run(['serve', join(pend, 'inputs.json'), join(pend, 'out')], { KOIOS_URL: c.url });
    assert.match(r4.stderr, /pending the owner's OK/);
    rmSync(pend, { recursive: true, force: true });
  } finally {
    s?.p.kill();
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
