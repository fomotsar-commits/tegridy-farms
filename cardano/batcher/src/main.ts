// The batcher as a process. Settings come from a JSON file (no secrets in it); endpoints and the
// key file from the environment, never logged:
//   OGMIOS_URL   https://<key>.mainnet-v6.ogmios-m1.demeter.run   (queries, evaluation, submission)
//   OGMIOS_WS    wss://<key>.mainnet-v6.ogmios-m1.demeter.run     (chain-sync)
//   KUPO_URL     https://<key>.mainnet-v2.kupo-m1.demeter.run
//   KOIOS_URL    https://api.koios.rest/api/v1   KOIOS_TOKEN  the batcher's own Koios key
//   BATCHER_KEY_FILE  the signing key (scripts/new-key.ts); without it, a dry run
// A round runs on every block, and every `idleRoundMs` anyway (chain-sync may be down).
// Events are written as one JSON line each.
//   node src/main.ts <settings.json> [--once]      (--once: one round, then exit)
import { readFileSync } from 'node:fs';
import { MAINNET_TIME } from './chain.ts';
import { Follower } from './follow.ts';
import { stringifyExact } from './json.ts';
import { Koios } from './koios.ts';
import { Kupo, checkKupoReady } from './kupo.ts';
import { keyFromFile, signerOf } from './signer.ts';
import { koiosView, ogmiosKupoView, type ChainView } from './view.ts';
import { Watcher, type WatcherConfig } from './watcher.ts';

export interface Settings {
  network: number;
  deployment: {
    authenPolicy: string;
    poolScriptHash: string;
    orderScriptHash: string;
    poolBatchingScriptHash: string;
    scriptRefs: { pool: string; order: string; poolBatching: string };
  };
  batcherKeyHash: string;
  batcherAddress: string;
  /** Lovelace, as a string. */
  batcherFee: string;
  floatCap: string;
  maxOrdersPerBatch: number;
  slotsBefore: number;
  slotsAfter: number;
  quarantineSlots: number;
  maxRefusalsInARow: number;
  idleRoundMs: number;
}

const HEX56 = /^[0-9a-f]{56}$/;
const REF = /^[0-9a-f]{64}#\d+$/;

export function readSettings(path: string): WatcherConfig & { network: number; idleRoundMs: number } {
  const s = JSON.parse(readFileSync(path, 'utf8')) as Settings;
  const d = s.deployment;
  for (const [k, v] of Object.entries({ authenPolicy: d.authenPolicy, poolScriptHash: d.poolScriptHash, orderScriptHash: d.orderScriptHash, poolBatchingScriptHash: d.poolBatchingScriptHash, batcherKeyHash: s.batcherKeyHash })) {
    if (!HEX56.test(v)) throw new Error(`settings: ${k} is not a 28-byte hash`);
  }
  for (const [k, v] of Object.entries(d.scriptRefs)) if (!REF.test(v)) throw new Error(`settings: scriptRefs.${k} is not "txhash#index"`);
  if (s.slotsBefore + s.slotsAfter > 600) throw new Error('settings: the validity window may be at most 600 slots (10 minutes)');
  if (s.network !== 1) throw new Error('settings: only mainnet (network 1) has its slot times built in');
  return {
    network: s.network,
    deployment: { network: s.network, dex: { authenPolicy: d.authenPolicy, poolScriptHash: d.poolScriptHash, time: MAINNET_TIME }, orderScriptHash: d.orderScriptHash, poolBatchingScriptHash: d.poolBatchingScriptHash, scriptRefs: d.scriptRefs },
    policy: { batcherFee: BigInt(s.batcherFee), maxOrdersPerBatch: s.maxOrdersPerBatch, slotsBefore: BigInt(s.slotsBefore), slotsAfter: BigInt(s.slotsAfter) },
    batcher: { keyHash: s.batcherKeyHash, address: s.batcherAddress },
    floatCap: BigInt(s.floatCap),
    quarantineSlots: BigInt(s.quarantineSlots),
    maxRefusalsInARow: s.maxRefusalsInARow,
    idleRoundMs: s.idleRoundMs,
  };
}

/**
 * One JSON line per event, scrubbed of every secret in the environment: Demeter puts the API
 * key in the host name, so an error quoting a host must not write it out.
 */
export function logger(env: Readonly<Record<string, string | undefined>>, write: (line: string) => void): (e: object) => void {
  const secrets = [env.OGMIOS_URL, env.OGMIOS_WS, env.KUPO_URL].flatMap((u) => (u ? [new URL(u).host] : [])).concat(env.KOIOS_TOKEN ? [env.KOIOS_TOKEN] : []);
  return (e) => {
    let line = stringifyExact({ at: new Date().toISOString(), ...e });
    for (const s of secrets) line = line.split(s).join('[redacted]');
    write(`${line}\n`);
  };
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('usage: node src/main.ts <settings.json> [--once]');
  const c = readSettings(path);
  const env = process.env;
  const log = logger(env, (line) => process.stdout.write(line));

  const koios = env.KOIOS_URL ? new Koios({ url: env.KOIOS_URL, token: env.KOIOS_TOKEN, timeoutMs: Number(env.KOIOS_TIMEOUT_MS ?? 30_000) }) : null;
  const views: ChainView[] = [];
  if (env.OGMIOS_URL && env.KUPO_URL) {
    if (!koios) throw new Error('KOIOS_URL is needed too: only Koios reads the batching account (Ogmios leaves out an account delegated nowhere)');
    const stake = koiosView(koios, c.network);
    const kupo = new Kupo({ url: env.KUPO_URL });
    const d = c.deployment;
    await checkKupoReady(kupo, [`${d.orderScriptHash}/*`, `${d.dex.authenPolicy}.4d5350`, `${d.dex.authenPolicy}.4d534753`, `${c.batcher.keyHash}/*`]);
    views.push(ogmiosKupoView({ url: env.OGMIOS_URL }, kupo, (h) => stake.rewardBalance(h)));
  }
  if (koios) views.push(koiosView(koios, c.network));
  if (!views.length) throw new Error('no source: set OGMIOS_URL and KUPO_URL, and/or KOIOS_URL');

  const signer = env.BATCHER_KEY_FILE ? signerOf(keyFromFile(env.BATCHER_KEY_FILE)) : null;
  const watcher = new Watcher(views, signer, c, log);
  log({ kind: 'start', sources: views.map((v) => v.name), dryRun: signer === null, batcher: c.batcher.keyHash });
  if (process.argv.includes('--once')) {
    await watcher.round();
    return log({ kind: 'exit' });
  }

  let lastBlock = Date.now();
  const follower = env.OGMIOS_WS
    ? new Follower(env.OGMIOS_WS, {
        forward: (b) => {
          lastBlock = Date.now();
          void watcher.trigger();
          log({ kind: 'block', slot: b.slot, height: b.height, ours: b.txIds.filter((t) => watcher.inflight.has(t)) });
        },
        backward: (p) => {
          void watcher.trigger();
          log({ kind: 'rollback', to: p === 'origin' ? 'origin' : p.slot });
        },
        down: (error) => log({ kind: 'chain-sync-down', error }),
      })
    : null;
  follower?.start();
  const timer = setInterval(() => {
    if (watcher.stopped) {
      log({ kind: 'stopped', reason: watcher.stopped });
      return;
    }
    if (Date.now() - lastBlock >= c.idleRoundMs) void watcher.trigger();
  }, c.idleRoundMs);
  void watcher.trigger();

  const stop = () => {
    follower?.stop();
    clearInterval(timer);
    log({ kind: 'exit' });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (import.meta.main) await main();
