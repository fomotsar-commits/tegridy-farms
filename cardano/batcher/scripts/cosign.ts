// The co-signing page: every owner signature on a deploy transaction comes from the owner's own
// wallets (CIP-30 signTx(tx, true)), never from a key file. Served from 127.0.0.1 only, never
// deployed (it is not under frontend/). The checks are cosign/review.ts's.
//   KOIOS_URL=... node scripts/cosign.ts serve <inputs.json> <out> [--port 8737]
//   KOIOS_URL=... node scripts/cosign.ts assemble <inputs.json> <out> <step>
//   KOIOS_URL=... OGMIOS_URL=... node scripts/cosign.ts submit <inputs.json> <out> <step>
// <out> is deploy.ts's: <step>.tx.json is the unsigned transaction it wrote, the page keeps each
// wallet's checked signatures in <step>.witnesses.json, and assemble writes <step>.signed.tx.json.
// The network is the inputs' (0 preprod, 1 mainnet): an address, a wallet or a chain endpoint on
// any other is refused. A change through the 48-hour lock (scripts/lock.ts writes it here too) is
// read with the deploy's <out>/scripts.json, and shown in plain words with when it can run.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { MAINNET_TIME, PREPROD_TIME } from '../src/chain.ts';
import { Koios } from '../src/koios.ts';
import { rpc, submit, type Endpoint } from '../src/ogmios.ts';
import { checkInputs, checkNothingPending, NAMES, type DeployInputs, type Scripts } from '../src/deploy.ts';
import type { LockDeployment } from '../src/lock.ts';
import { addWitnesses, assemble, checkMagic, checkWalletNetwork, checkWitnessSet, missing, networkName, outputOf, Refused, review, walletKeys, type LockView, type Resolver, type Review, type WitnessFile } from '../cosign/review.ts';

const [cmd, inputsPath, outArg, stepArg] = process.argv.slice(2);
if (!cmd || !inputsPath || !outArg) throw new Error('usage: node scripts/cosign.ts <serve|assemble|submit> <inputs.json> <out> [<step>] [--port 8737]');
const out: string = outArg;
const raw = JSON.parse(readFileSync(inputsPath, 'utf8'));
checkNothingPending(raw);
const inputs: DeployInputs = { ...raw, openingFee: BigInt(raw.openingFee) };
checkInputs(inputs);
const network = inputs.network as 0 | 1;
const deployerKey = CSL.Address.from_bech32(inputs.deployer).payment_cred()!.to_keyhash()!.to_hex();
const labels: Record<string, string> = { [inputs.ownerA]: 'owner A', [inputs.ownerB]: 'owner B', [inputs.batcherKeyHash]: 'the batcher' };
labels[deployerKey] = labels[deployerKey] ? `${labels[deployerKey]} and the deployer` : 'the deployer';

const koiosUrl = process.env.KOIOS_URL ?? '';
if (!koiosUrl) throw new Error('set KOIOS_URL (it reads the inputs each transaction spends)');
const koios = new Koios({ url: koiosUrl, time: network === 1 ? MAINNET_TIME : PREPROD_TIME });

/** Koios must answer with the run's network magic before anything it says is shown. */
async function checkKoios(): Promise<void> {
  const r = await fetch(`${koiosUrl}/genesis`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Koios answered ${r.status} for its genesis`);
  const g = (await r.json()) as { networkmagic?: unknown }[];
  checkMagic(g[0]?.networkmagic, network, `Koios (${koiosUrl})`);
}

const STEP = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** The unsigned transactions deploy.ts wrote: <step>.tx.json, never a signed or draft one. */
function steps(): string[] {
  return readdirSync(out)
    .filter((f) => f.endsWith('.tx.json') && !f.endsWith('.signed.tx.json') && !f.endsWith('.draft.tx.json'))
    .map((f) => f.slice(0, -'.tx.json'.length))
    .filter((s) => STEP.test(s))
    .sort();
}
function envelope(step: string): string {
  if (!STEP.test(step) || !steps().includes(step)) throw new Refused(`no unsigned transaction ${step}.tx.json in ${out}`);
  const e = JSON.parse(readFileSync(join(out, `${step}.tx.json`), 'utf8')) as { type?: unknown; cborHex?: unknown };
  if (typeof e.type !== 'string' || !e.type.startsWith('Tx ') || typeof e.cborHex !== 'string') throw new Refused(`${step}.tx.json is not a transaction envelope`);
  return e.cborHex;
}
const txIdOf = (hex: string) => CSL.FixedTransaction.from_hex(hex).transaction_hash().to_hex();
const witnessPath = (step: string) => join(out, `${step}.witnesses.json`);
const witnesses = (step: string): WitnessFile | null => (existsSync(witnessPath(step)) ? (JSON.parse(readFileSync(witnessPath(step), 'utf8')) as WitnessFile) : null);
function writeAtomic(path: string, text: string): void {
  writeFileSync(`${path}.new`, text);
  renameSync(`${path}.new`, path);
}
/** The deploy's scripts (<out>/scripts.json), when there: lock transactions are read with them. */
function deployment(): LockDeployment | undefined {
  const p = join(out, 'scripts.json');
  if (!existsSync(p)) return undefined;
  const s = (JSON.parse(readFileSync(p, 'utf8')) as { scripts: Scripts }).scripts;
  return { network, lock: s.lock.hash, authen: s.authen.hash, pool: s.pool.hash, ownerA: inputs.ownerA, ownerB: inputs.ownerB, treasury: inputs.treasury };
}
/** For an Announce or a Cancel (which touch neither), the pool and the GlobalSetting as the chain holds them now. */
async function current(d: LockDeployment, lp: string | undefined): Promise<NonNullable<LockView['current']>> {
  const c: NonNullable<LockView['current']> = {};
  const gs = await koios.utxosWithAsset(d.authen, NAMES.globalSetting, d.authen);
  if (gs.length === 1) c.setting = gs[0]!.outputHex;
  if (lp) {
    const pools = (await koios.utxosWithAsset(d.authen, lp, d.pool)).filter((u) => (CSL.TransactionOutput.from_hex(u.outputHex).amount().multiasset()?.get_asset(CSL.ScriptHash.from_hex(d.authen), CSL.AssetName.new(Buffer.from(NAMES.pool, 'hex')))?.to_str() ?? '0') === '1');
    if (pools.length === 1) c.pool = pools[0]!.outputHex;
  }
  return c;
}
const sent = (): Record<string, string> => (existsSync(join(out, 'state.json')) ? ((JSON.parse(readFileSync(join(out, 'state.json'), 'utf8')) as { txs?: Record<string, string> }).txs ?? {}) : {});

/** What the transaction does: its inputs read from the run's own transactions (a chain of unsent ones) or from the chain. */
async function reviewOf(step: string): Promise<{ hex: string; r: Review }> {
  const hex = envelope(step);
  const run = new Map<string, string>();
  for (const s of steps()) {
    try {
      run.set(txIdOf(envelope(s)), s);
    } catch {
      // an envelope CSL cannot read makes no outputs anyone can spend
    }
  }
  const body = CSL.FixedTransaction.from_hex(hex).body();
  const refs: string[] = [];
  for (const l of [body.inputs(), body.collateral(), body.reference_inputs()]) for (let i = 0; i < (l?.len() ?? 0); i++) refs.push(`${l!.get(i).transaction_id().to_hex()}#${l!.get(i).index()}`);
  const fromChain = new Map((await koios.utxos(refs.filter((r) => !run.has(r.split('#')[0]!)))).map((u) => [u.ref, u.outputHex]));
  const resolve: Resolver = (ref) => {
    const [id, ix] = ref.split('#') as [string, string];
    const s = run.get(id);
    if (s) {
      const o = outputOf(envelope(s), Number(ix));
      return o ? { outputHex: o, from: `this run's ${s}` } : undefined;
    }
    const o = fromChain.get(ref);
    return o ? { outputHex: o, from: 'the chain' } : undefined;
  };
  const d = deployment();
  const r = review(hex, network, resolve, labels, d && { deployment: d });
  if (!d || !r.lock || r.lock.action === 'Execute') return { hex, r };
  return { hex, r: review(hex, network, resolve, labels, { deployment: d, current: await current(d, r.lock.lp) }) };
}

async function signedTx(step: string): Promise<{ hex: string; txId: string }> {
  const { hex, r } = await reviewOf(step);
  const signed = assemble(hex, witnesses(step), r.needs.map((n) => n.key));
  writeAtomic(join(out, `${step}.signed.tx.json`), `${JSON.stringify({ type: 'Tx ConwayEra', description: `memetics.finance pools deploy: ${step}, co-signed`, cborHex: signed }, null, 1)}\n`);
  return { hex: signed, txId: r.txId };
}

if (cmd === 'assemble') {
  if (!stepArg) throw new Error('assemble needs a step');
  await checkKoios();
  const s = await signedTx(stepArg);
  console.log(`${stepArg}: ${s.txId}, every signature in, written to ${join(out, `${stepArg}.signed.tx.json`)}`);
} else if (cmd === 'submit') {
  if (!stepArg) throw new Error('submit needs a step');
  const ogmios: Endpoint = { url: process.env.OGMIOS_URL ?? '', timeoutMs: 60_000 };
  if (!ogmios.url) throw new Error('set OGMIOS_URL');
  await checkKoios();
  const g = (await rpc(ogmios, 'queryNetwork/genesisConfiguration', { era: 'shelley' })) as { networkMagic?: unknown };
  checkMagic(g?.networkMagic, network, `Ogmios (${ogmios.url})`);
  const s = await signedTx(stepArg);
  const id = await submit(ogmios, s.hex);
  if (id !== s.txId) throw new Error(`the node took ${id}, not ${s.txId}`);
  const statePath = join(out, 'state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { refs: {}, txs: {}, locked: {}, fees: {}, refSizes: {} };
  state.txs = { ...(state.txs ?? {}), [stepArg]: id };
  writeAtomic(statePath, `${JSON.stringify(state, null, 1)}\n`);
  console.log(`${stepArg}: submitted ${id} on ${networkName(network)}`);
} else if (cmd === 'serve') {
  await checkKoios();
  const at = process.argv.indexOf('--port');
  const port = at < 0 ? 8737 : Number(process.argv[at + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be 1024 to 65535');
  const origin = `http://127.0.0.1:${port}`;
  const here = join(dirname(fileURLToPath(import.meta.url)), '..', 'cosign');
  const files: Record<string, [string, string]> = { '/': ['page.html', 'text/html; charset=utf-8'], '/page.js': ['page.js', 'text/javascript; charset=utf-8'], '/page.css': ['page.css', 'text/css; charset=utf-8'] };
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { ...headers, 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((ok, fail) => {
      let n = 0;
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        n += c.length;
        if (n > 200_000) {
          fail(new Refused('too much sent'));
          req.destroy();
        } else parts.push(c);
      });
      req.on('end', () => {
        try {
          ok(JSON.parse(Buffer.concat(parts).toString('utf8')));
        } catch {
          fail(new Refused('not JSON'));
        }
      });
    });

  const state = async (step: string) => {
    const { hex, r } = await reviewOf(step);
    const file = witnesses(step);
    const stale = !!file && file.txId !== r.txId;
    return { step, txHex: hex, review: r, signed: stale ? [] : Object.keys(file?.witnesses ?? {}), missing: stale ? r.needs.map((n) => n.key) : missing(r, file), stale };
  };

  createServer((req, res) => {
    void (async () => {
      try {
        // Only this machine, by this exact name: another site's page (or a name pointed at 127.0.0.1) is refused.
        if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 421, { error: `open ${origin}` });
        const url = new URL(req.url ?? '/', origin);
        if (req.method === 'GET' && files[url.pathname]) {
          const [f, type] = files[url.pathname]!;
          res.writeHead(200, { ...headers, 'content-type': type });
          return res.end(readFileSync(join(here, f)));
        }
        if (req.method === 'GET' && url.pathname === '/api/run') {
          const done = sent();
          return send(res, 200, {
            network,
            networkName: networkName(network),
            submit: `KOIOS_URL=... OGMIOS_URL=... node scripts/cosign.ts submit "${inputsPath}" "${out}" <step>`,
            steps: steps().map((s) => {
              let txId: string | null = null;
              try {
                txId = txIdOf(envelope(s));
              } catch {
                // listed, unreadable: the review says why
              }
              const file = witnesses(s);
              return { step: s, txId, sent: !!txId && done[s] === txId, signatures: file && file.txId === txId ? Object.keys(file.witnesses).length : 0 };
            }),
          });
        }
        if (req.method === 'GET' && url.pathname === '/api/tx') return send(res, 200, await state(url.searchParams.get('step') ?? ''));
        if (req.method === 'POST' && (url.pathname === '/api/wallet' || url.pathname === '/api/witness')) {
          if (req.headers.origin !== origin || !String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 403, { error: 'only this page may send signatures' });
          const b = await readBody(req);
          checkWalletNetwork(b.networkId, network);
          // The step as this server's own list spells it, so nothing the page sends reaches a file name or the log.
          const step = steps().find((s) => s === b.step);
          if (!step) throw new Refused(`no unsigned transaction ${String(b.step)}.tx.json in ${out}`);
          if (url.pathname === '/api/wallet') {
            const { r } = await reviewOf(step);
            const keys = walletKeys(b.addresses, network);
            const held = r.needs.filter((n) => keys.includes(n.key));
            return send(res, 200, { holds: held });
          }
          const { hex, r } = await reviewOf(step);
          if (b.txId !== r.txId) throw new Refused(`the transaction changed while the wallet signed: the page showed ${String(b.txId)}, ${step}.tx.json is now ${r.txId}. Nothing was kept: reload and read it again`);
          const rows = checkWitnessSet(hex, String(b.witnessSet ?? ''), r.needs.map((n) => n.key));
          const file = addWitnesses(witnesses(step), r.txId, rows);
          writeAtomic(witnessPath(step), `${JSON.stringify(file, null, 1)}\n`);
          console.log(`${step}: kept ${rows.map((x) => `${labels[x.key] ?? 'key'} ${x.key}`).join(', ')}; ${missing(r, file).length} still to sign`);
          return send(res, 200, { kept: rows.map((x) => x.key), ...(await state(step)) });
        }
        return send(res, 404, { error: 'not found' });
      } catch (e) {
        // A refusal is written for the page. Anything else stays in this terminal.
        if (e instanceof Refused) return send(res, 422, { error: e.message });
        console.error(e);
        send(res, 500, { error: 'the co-sign server failed: its terminal says why' });
      }
    })();
  })
    .on('error', (e: NodeJS.ErrnoException) => {
      console.error(e.code === 'EADDRINUSE' ? `port ${port} is taken by another program: pass --port <another>` : e.message);
      process.exit(1);
    })
    .listen(port, '127.0.0.1', () => {
      if (network === 1) console.log('MAINNET: these transactions spend real ADA once sent. Read every line before you sign.');
      console.log(`co-signing page for ${networkName(network)}: ${origin}  (steps: ${steps().join(', ') || 'none yet'})`);
    });
} else throw new Error(`unknown command ${cmd}`);
