// The batcher as a process. Settings come from a JSON file (no secrets in it); endpoints and the
// key file from the environment, never logged:
//   OGMIOS_URL   https://<key>.mainnet-v6.ogmios-m1.demeter.run   (queries, evaluation, submission)
//   OGMIOS_WS    wss://<key>.mainnet-v6.ogmios-m1.demeter.run     (chain-sync)
//   KUPO_URL     https://<key>.mainnet-v2.kupo-m1.demeter.run
//   KOIOS_URL    https://api.koios.rest/api/v1   KOIOS_TOKEN  the batcher's own Koios key
//   BATCHER_KEY_FILE  the signing key (scripts/new-key.ts); without it, a dry run
// A round runs on every block, and every `idleRoundMs` anyway (chain-sync may be down). Every
// event is one JSON line, scrubbed of the secrets above. When the batcher stops itself (the float
// cap, refusals, its wallet or settings), the process exits with code 2, or 3 if it must restart.
//   node src/main.ts <settings.json> [--once]      (--once: one round, then exit)
import { readFileSync } from 'node:fs';
import { isBatcherAddress } from './build.ts';
import { MAINNET_TIME } from './chain.ts';
import { Follower } from './follow.ts';
import { stringifyExact } from './json.ts';
import { Koios } from './koios.ts';
import { Kupo, checkKupoReady } from './kupo.ts';
import { SourceUnavailable } from './ogmios.ts';
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

/** Every setting is required and checked: a missing or out-of-range one would quietly turn a safety off. */
export function readSettings(path: string): WatcherConfig & { network: number; idleRoundMs: number } {
  const s = JSON.parse(readFileSync(path, 'utf8')) as Settings;
  const d = s.deployment ?? ({} as Settings['deployment']);
  for (const [k, v] of Object.entries({ authenPolicy: d.authenPolicy, poolScriptHash: d.poolScriptHash, orderScriptHash: d.orderScriptHash, poolBatchingScriptHash: d.poolBatchingScriptHash, batcherKeyHash: s.batcherKeyHash })) {
    if (typeof v !== 'string' || !HEX56.test(v)) throw new Error(`settings: ${k} is not a 28-byte hash`);
  }
  for (const k of ['pool', 'order', 'poolBatching'] as const) if (typeof d.scriptRefs?.[k] !== 'string' || !REF.test(d.scriptRefs[k])) throw new Error(`settings: scriptRefs.${k} is not "txhash#index"`);
  if (s.network !== 1) throw new Error('settings: only mainnet (network 1) has its slot times built in');
  const int = (k: keyof Settings, min: number, max: number): number => {
    const v = s[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`settings: ${k} must be a whole number from ${min} to ${max}`);
    return v;
  };
  const lovelace = (k: 'batcherFee' | 'floatCap', min: bigint): bigint => {
    const v = s[k];
    if (typeof v !== 'string' || !/^\d+$/.test(v) || BigInt(v) < min) throw new Error(`settings: ${k} must be a whole number of lovelace, at least ${min}, as a string`);
    return BigInt(v);
  };
  // A window shorter than a few blocks expires before it lands; the contract allows 10 minutes at most.
  const slotsBefore = int('slotsBefore', 0, 300);
  const slotsAfter = int('slotsAfter', 60, 600);
  if (slotsBefore + slotsAfter > 600) throw new Error('settings: the validity window may be at most 600 slots (10 minutes)');
  // The batching redeemer numbers orders in one byte each, below 64.
  const maxOrdersPerBatch = int('maxOrdersPerBatch', 1, 64);
  const quarantineSlots = int('quarantineSlots', 600, 604_800);
  const maxRefusalsInARow = int('maxRefusalsInARow', 1, 100);
  const idleRoundMs = int('idleRoundMs', 5_000, 3_600_000);
  const batcherFee = lovelace('batcherFee', 1n);
  const floatCap = lovelace('floatCap', 10_000_000n);
  // The batcher's change and its collateral's return go to this address: it must be its own key's.
  if (typeof s.batcherAddress !== 'string' || !isBatcherAddress(s.batcherAddress, s.batcherKeyHash, s.network)) throw new Error("settings: batcherAddress is not the batcher key's own mainnet enterprise address");
  return {
    network: s.network,
    deployment: { network: s.network, dex: { authenPolicy: d.authenPolicy, poolScriptHash: d.poolScriptHash, time: MAINNET_TIME }, orderScriptHash: d.orderScriptHash, poolBatchingScriptHash: d.poolBatchingScriptHash, scriptRefs: d.scriptRefs },
    policy: { batcherFee, maxOrdersPerBatch, slotsBefore: BigInt(slotsBefore), slotsAfter: BigInt(slotsAfter) },
    batcher: { keyHash: s.batcherKeyHash, address: s.batcherAddress },
    floatCap,
    quarantineSlots: BigInt(quarantineSlots),
    maxRefusalsInARow,
    idleRoundMs,
  };
}

const SECRET_ENV = ['OGMIOS_URL', 'OGMIOS_WS', 'KUPO_URL'] as const;

/**
 * One JSON line per event, scrubbed of every secret in the environment: Demeter puts the API
 * key in the host name, so an error quoting a host must not write it out. A value that is not a
 * URL is scrubbed whole.
 */
export function logger(env: Readonly<Record<string, string | undefined>>, write: (line: string) => void): (e: object) => void {
  const secrets = SECRET_ENV.flatMap((k) => {
    const u = env[k];
    if (!u) return [];
    // The value as given, and cleaned of stray quotes or spaces (then its host, if it has one).
    const clean = u.trim().replace(/^["']+|["']+$/g, '');
    const hosts = [u, clean].flatMap((x) => {
      try {
        return [new URL(x).host];
      } catch {
        return [];
      }
    });
    return [u, clean, ...hosts];
  })
    .concat(env.KOIOS_TOKEN ? [env.KOIOS_TOKEN] : [])
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);
  return (e) => {
    let line = stringifyExact({ at: new Date().toISOString(), ...e });
    for (const s of secrets) line = line.split(s).join('[redacted]');
    write(`${line}\n`);
  };
}

/** The endpoints, checked without ever repeating their values (they hold keys). */
export function readEnv(env: Readonly<Record<string, string | undefined>>): { ogmios?: string; ws?: string; kupo?: string; koios?: string } {
  const url = (k: string, protocols: string[]): string | undefined => {
    const v = env[k];
    if (v === undefined || v === '') return undefined;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new Error(`${k} is not a URL`);
    }
    if (!protocols.includes(u.protocol)) throw new Error(`${k} must start with ${protocols.join(' or ')}`);
    return v;
  };
  return { ogmios: url('OGMIOS_URL', ['https:', 'http:']), ws: url('OGMIOS_WS', ['wss:', 'ws:']), kupo: url('KUPO_URL', ['https:', 'http:']), koios: url('KOIOS_URL', ['https:']) };
}

/** A view that answers only once `ready` has passed, asked again at most every `recheckMs`. */
function gated(view: ChainView, ready: () => Promise<void>, recheckMs: number, log: (e: object) => void): ChainView {
  let ok = false;
  let lastAsked = 0;
  return {
    ...view,
    tip: async () => {
      if (!ok) {
        if (lastAsked && Date.now() - lastAsked < recheckMs) throw new SourceUnavailable(`${view.name} is not ready yet`);
        lastAsked = Date.now();
        await ready();
        ok = true;
        log({ kind: 'source-ready', source: view.name });
      }
      return view.tip();
    },
  };
}

async function main(): Promise<number> {
  const env = process.env;
  const log = logger(env, (line) => process.stdout.write(line));
  try {
    const path = process.argv[2];
    if (!path) throw new Error('usage: node src/main.ts <settings.json> [--once]');
    const c = readSettings(path);
    const e = readEnv(env);
    const refused = new Set<string>();
    const onRefused = (ref: string, reason: string) => {
      if (refused.has(ref)) return;
      refused.add(ref);
      log({ kind: 'unreadable-utxo', ref, reason });
    };

    const koios = e.koios ? new Koios({ url: e.koios, token: env.KOIOS_TOKEN, timeoutMs: Number(env.KOIOS_TIMEOUT_MS ?? 30_000), onRefused }) : null;
    const views: ChainView[] = [];
    if (e.ogmios && e.kupo) {
      if (!koios) throw new Error('KOIOS_URL is needed too: only Koios reads the batching account (Ogmios leaves out an account delegated nowhere)');
      const stake = koiosView(koios, c.network);
      const kupo = new Kupo({ url: e.kupo, onRefused });
      const d = c.deployment;
      const patterns = [`${d.orderScriptHash}/*`, `${d.dex.authenPolicy}.4d5350`, `${d.dex.authenPolicy}.4d534753`, `${c.batcher.keyHash}/*`, ...Object.values(d.scriptRefs).map((r) => `${r.split('#')[1]}@${r.split('#')[0]}`)];
      // Kupo must be ready before it is believed; until then (and when it is not, at start) Koios serves.
      views.push(gated(ogmiosKupoView({ url: e.ogmios }, kupo, (h) => stake.rewardBalance(h)), () => checkKupoReady(kupo, patterns), 600_000, log));
    }
    if (koios) views.push(koiosView(koios, c.network));
    if (!views.length) throw new Error('no source: set OGMIOS_URL and KUPO_URL, and/or KOIOS_URL');

    const signer = env.BATCHER_KEY_FILE ? signerOf(keyFromFile(env.BATCHER_KEY_FILE)) : null;
    const watcher = new Watcher(views, signer, c, log);
    log({ kind: 'start', sources: views.map((v) => v.name), dryRun: signer === null, batcher: c.batcher.keyHash });
    if (process.argv.includes('--once')) {
      await watcher.round();
      log({ kind: 'exit' });
      return watcher.stopped ? (watcher.stopped.fatal ? 3 : 2) : 0;
    }

    let lastBlock = Date.now();
    const follower = e.ws
      ? new Follower(e.ws, {
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
    return await new Promise<number>((resolve) => {
      const finish = async (code: number) => {
        clearInterval(timer);
        follower?.stop();
        await watcher.close();
        log({ kind: 'exit', code });
        resolve(code);
      };
      const timer = setInterval(() => {
        if (watcher.stopped) return void finish(watcher.stopped.fatal ? 3 : 2);
        if (Date.now() - lastBlock >= c.idleRoundMs) void watcher.trigger();
      }, Math.min(c.idleRoundMs, 5_000));
      void watcher.trigger();
      process.once('SIGINT', () => void finish(0));
      process.once('SIGTERM', () => void finish(0));
    });
  } catch (err) {
    log({ kind: 'fatal', error: err instanceof Error ? err.message : String(err) });
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
