// The batcher as a process (on Railway: Dockerfile, docker-entrypoint.sh, railway.json). Settings
// come from a JSON file, or the BATCHER_SETTINGS variable (no secrets in them); endpoints and the
// key from the environment, never logged:
//   OGMIOS_URL   https://<key>.mainnet-v6.ogmios-m1.demeter.run   (queries, evaluation, submission)
//   OGMIOS_WS    wss://<key>.mainnet-v6.ogmios-m1.demeter.run     (chain-sync)
//   KUPO_URL     https://<key>.mainnet-v2.kupo-m1.demeter.run
//   KOIOS_URL    https://api.koios.rest/api/v1   KOIOS_TOKEN  the batcher's own Koios key
//   BATCHER_KEY_FILE  the signing key, at the top of the volume (the entrypoint refuses anywhere else)
//   BATCHER_MAKE_KEY=1  first boot only, before any settings: make the key there, say its hash and
//                       address, exit
//   BATCHER_LIVE=1  sign and send; without it, a dry run (every batch prepared and judged, none signed)
//   HC_PING_URL_CARDANO_BATCHER, HC_PING_URL_CARDANO_BATCHER_ALERTS  the alarm (src/heartbeat.ts);
//                       a live batcher needs both, and signs nothing until they have answered
// A round runs on every block, and every `idleRoundMs` anyway (chain-sync may be down). Every
// event is one JSON line, scrubbed of the secrets above. A batcher that stops itself (the float
// cap, refusals, its wallet or settings) stays up, its alerts check failing, until a person
// redeploys: Railway restarts any exit but 0, and a restarted batcher would read as recovered.
// Exit codes: 0 the key was made (or found, with no settings yet), or a stop signal; 1 the
// settings or the environment are wrong; 3 EMURGO's library broke (the process must restart: what
// it broke on is kept beside the key, and src/supervise.ts starts it again in the same container);
// with --once, 2 it stopped itself.
//   node src/main.ts [<settings.json>] [--once]      (--once: one round, then exit; no alarm)
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isBatcherAddress } from './build.ts';
import { MAINNET_TIME } from './chain.ts';
import { Follower, type SocketFactory } from './follow.ts';
import { stringifyExact } from './json.ts';
import { Koios } from './koios.ts';
import { Kupo, checkKupoReady } from './kupo.ts';
import { SourceUnavailable } from './ogmios.ts';
import { ALERTS_PING_ENV, Heartbeat, PING_ENV, resolvePingUrl, type HeartbeatConfig } from './heartbeat.ts';
import { enterpriseAddress, keyFromFile, makeKeyFile, signerOf } from './signer.ts';
import { checkTreasury } from './sweep.ts';
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
  /** Once the two-key treasury exists: above floatCap, the excess is swept there, down to `keep`. */
  sweep?: { treasury: string; treasuryScript: string; keep: string };
}

const HEX56 = /^[0-9a-f]{56}$/;
const REF = /^[0-9a-f]{64}#\d+$/;

/** The heartbeat's rhythm: a ping every 5 minutes; 10 minutes with no round reaching a source is a fail; one alert email an hour at most. */
export const HEARTBEAT = { everyMs: 300_000, quietMs: 600_000, alertGapMs: 3_600_000 };

export type ReadSettings = WatcherConfig & { network: number; idleRoundMs: number };

export function readSettings(path: string): ReadSettings {
  return parseSettings(readFileSync(path, 'utf8'));
}

/** Every setting is required and checked: a missing or out-of-range one would quietly turn a safety off. */
export function parseSettings(text: string): ReadSettings {
  let s: Settings;
  try {
    s = JSON.parse(text) as Settings;
  } catch {
    throw new Error('settings: not JSON');
  }
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
  // With chain-sync down, a round still comes at least twice in the alarm's quiet time.
  const idleRoundMs = int('idleRoundMs', 5_000, HEARTBEAT.quietMs / 2);
  const batcherFee = lovelace('batcherFee', 1n);
  const floatCap = lovelace('floatCap', 10_000_000n);
  // The batcher's change and its collateral's return go to this address: it must be its own key's.
  if (typeof s.batcherAddress !== 'string' || !isBatcherAddress(s.batcherAddress, s.batcherKeyHash, s.network)) throw new Error("settings: batcherAddress is not the batcher key's own mainnet enterprise address");
  // Optional until the treasury exists; given, every part of it is checked.
  let sweep: ReadSettings['sweep'];
  if (s.sweep !== undefined) {
    const w = s.sweep as Partial<Record<'treasury' | 'treasuryScript' | 'keep', unknown>> | null;
    if (typeof w !== 'object' || w === null || Array.isArray(w)) throw new Error('settings: sweep must be {"treasury", "treasuryScript", "keep"}');
    const treasury = checkTreasury({ address: w.treasury, script: w.treasuryScript }, s.network);
    if (typeof w.keep !== 'string' || !/^\d+$/.test(w.keep)) throw new Error('settings: sweep.keep must be a whole number of lovelace, as a string');
    const keep = BigInt(w.keep);
    // The float left after a sweep is a fee UTxO; the cap leaves room above it for the collateral and a sweep worth sending.
    if (keep < 10_000_000n) throw new Error('settings: sweep.keep must be at least 10000000 (the float batches pay from)');
    if (keep > floatCap - 10_000_000n) throw new Error('settings: sweep.keep must be at least 10000000 below floatCap');
    sweep = { treasury, keep };
  }
  return {
    network: s.network,
    deployment: { network: s.network, dex: { authenPolicy: d.authenPolicy, poolScriptHash: d.poolScriptHash, time: MAINNET_TIME }, orderScriptHash: d.orderScriptHash, poolBatchingScriptHash: d.poolBatchingScriptHash, scriptRefs: d.scriptRefs },
    policy: { batcherFee, maxOrdersPerBatch, slotsBefore: BigInt(slotsBefore), slotsAfter: BigInt(slotsAfter) },
    batcher: { keyHash: s.batcherKeyHash, address: s.batcherAddress },
    floatCap,
    quarantineSlots: BigInt(quarantineSlots),
    maxRefusalsInARow,
    idleRoundMs,
    ...(sweep ? { sweep } : {}),
  };
}

const SECRET_ENV = ['OGMIOS_URL', 'OGMIOS_WS', 'KUPO_URL', PING_ENV, ALERTS_PING_ENV] as const;

/**
 * Scrubs every secret in the environment out of a text: Demeter puts the API key in the host
 * name, a ping URL's secret is its path, and a value that is not a URL is scrubbed whole. As
 * scripts/ops/lib/healthchecks.mjs's scrubSecrets, nothing shorter than 8 characters counts.
 */
export function scrubber(env: Readonly<Record<string, string | undefined>>): (text: string) => string {
  const secrets = SECRET_ENV.flatMap((k) => {
    const u = env[k];
    if (!u) return [];
    // The value as given, and cleaned of stray quotes or spaces (then its URL's parts, if it is one).
    const clean = u.trim().replace(/^["']+|["']+$/g, '');
    const parts = [u, clean].flatMap((x) => {
      try {
        const url = new URL(x);
        return [url.href.replace(/\/+$/, ''), url.host, url.pathname];
      } catch {
        return [];
      }
    });
    return [u, clean, ...parts];
  })
    .concat(env.KOIOS_TOKEN ? [env.KOIOS_TOKEN] : [])
    .filter((s) => s.length >= 8)
    .sort((a, b) => b.length - a.length);
  return (text) => {
    for (const s of secrets) text = text.split(s).join('[redacted]');
    return text;
  };
}

/** One JSON line per event, scrubbed of every secret in the environment. */
export function logger(env: Readonly<Record<string, string | undefined>>, write: (line: string) => void): (e: object) => void {
  const scrub = scrubber(env);
  return (e) => write(`${scrub(stringifyExact({ at: new Date().toISOString(), ...e }))}\n`);
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

/**
 * The one-time key: with BATCHER_MAKE_KEY=1 and no key at BATCHER_KEY_FILE, makes it there and
 * returns what to show (its hash and the address to fund); with a key there already, returns
 * null and the key is used as it is. Before any settings are read: the settings can only name
 * the key once it exists.
 */
export function makeKeyIfAsked(env: Readonly<Record<string, string | undefined>>): { keyHash: string; address: string } | null {
  if (env.BATCHER_MAKE_KEY !== '1') return null;
  const path = env.BATCHER_KEY_FILE;
  if (!path) throw new Error('BATCHER_MAKE_KEY=1 needs BATCHER_KEY_FILE: where to keep the key');
  if (existsSync(path)) return null;
  return makeKeyFile(path, 1);
}

/**
 * UTxOs EMURGO's library broke on, kept beside the key for the next process: named after the key
 * file, so it can never be the key file (whose name may not end in either suffix).
 */
export const setAsideFileOf = (keyFile: string) => `${keyFile}.set-aside.json`;
const STATE_SUFFIXES = /\.(new|set-aside\.json)$/;

/** One alone: never read again ("trap"). The orders of a batch: each tried alone first ("suspect"). */
export interface SetAside {
  trapped: Set<string>;
  suspects: Set<string>;
}

/** {"<txhash>#<index>": "trap" | "suspect"}; a file that cannot be read is said, and nothing is set aside. */
export function readSetAside(path: string, log: (e: object) => void): SetAside {
  const s: SetAside = { trapped: new Set(), suspects: new Set() };
  if (!existsSync(path)) return s;
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error('not an object');
    for (const [ref, kind] of Object.entries(j)) {
      if (!REF.test(ref) || (kind !== 'trap' && kind !== 'suspect')) throw new Error(`${ref}: not a UTxO and "trap" or "suspect"`);
      (kind === 'trap' ? s.trapped : s.suspects).add(ref);
    }
    return s;
  } catch (e) {
    log({ kind: 'set-aside-unreadable', file: path, error: e instanceof Error ? e.message : String(e) });
    return { trapped: new Set(), suspects: new Set() };
  }
}

/** A break named (one UTxO alone: a trap; a batch's orders: suspects), or a suspect cleared. */
export function writeSetAside(path: string, change: { trapped?: string[]; cleared?: string }): void {
  const s = readSetAside(path, () => {});
  const t = change.trapped ?? [];
  if (t.length === 1) {
    s.suspects.delete(t[0]!);
    s.trapped.add(t[0]!);
  } else for (const r of t) if (!s.trapped.has(r)) s.suspects.add(r);
  if (change.cleared) s.suspects.delete(change.cleared);
  const out: Record<string, string> = {};
  for (const r of s.trapped) out[r] = 'trap';
  for (const r of s.suspects) out[r] = 'suspect';
  writeFileSync(`${path}.new`, `${JSON.stringify(out)}\n`, { mode: 0o600 });
  renameSync(`${path}.new`, path);
}

/** On Linux, what the process may still do (the entrypoint drops every capability, for good). */
function privileges(): { capEff: string; capBnd: string; noNewPrivs: string } | null {
  try {
    const s = readFileSync('/proc/self/status', 'utf8');
    const field = (k: string) => new RegExp(`^${k}:\\s*(\\S+)`, 'm').exec(s)?.[1] ?? '?';
    return { capEff: field('CapEff'), capBnd: field('CapBnd'), noNewPrivs: field('NoNewPrivs') };
  } catch {
    return null;
  }
}

/** What the process is given. Tests stand in for the alarm's pings, the sources and the rhythm. */
export interface Proc {
  env: Readonly<Record<string, string | undefined>>;
  /** The arguments after the script. */
  argv: readonly string[];
  write: (line: string) => void;
  /** Hands over the function that stops the batcher cleanly (SIGINT, SIGTERM). */
  onStop: (stop: () => void) => void;
  rhythm?: typeof HEARTBEAT;
  send?: HeartbeatConfig['send'];
  /** Stand-in sources, given the UTxOs a real source must never decode. */
  views?: (skip: (ref: string) => boolean) => ChainView[];
  socket?: SocketFactory;
  /** How often the loop looks for a stop and an idle round (5 s). */
  pollMs?: number;
  /** How long a live batcher waits before asking its alarm again (60 s). */
  alarmRetryMs?: number;
}

export async function main(p: Proc): Promise<number> {
  const env = p.env;
  const log = logger(env, p.write);
  log({ kind: 'boot', uid: process.getuid?.() ?? null, node: process.version, privileges: privileges() });
  const once = p.argv.includes('--once');
  const live = env.BATCHER_LIVE === '1';
  const alive = resolvePingUrl(env, PING_ENV);
  const alerts = resolvePingUrl(env, ALERTS_PING_ENV);
  const rhythm = p.rhythm ?? HEARTBEAT;
  const heartbeat = new Heartbeat({ alive: once ? null : alive.url, alerts: once ? null : alerts.url, ...rhythm, dryRun: !live, scrub: scrubber(env), send: p.send }, log);
  let stopAsked = false;
  const stopSignal = new Promise<void>((resolve) =>
    p.onStop(() => {
      stopAsked = true;
      resolve();
    }),
  );
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      void stopSignal.then(() => {
        clearTimeout(t);
        resolve();
      });
    });
  try {
    const path = p.argv.find((a) => !a.startsWith('--'));
    const text = path ? readFileSync(path, 'utf8') : env.BATCHER_SETTINGS;
    if (env.BATCHER_KEY_FILE && STATE_SUFFIXES.test(env.BATCHER_KEY_FILE)) throw new Error("BATCHER_KEY_FILE may not end in .new or .set-aside.json: those names are the batcher's own files beside the key");
    // Left on, it would make a fresh key whenever the old one is missing, and say "fund it".
    if (env.BATCHER_MAKE_KEY === '1' && text !== undefined) throw new Error('BATCHER_MAKE_KEY=1 is for the first boot only, before there are settings: remove it');
    const made = makeKeyIfAsked(env);
    if (made) {
      log({ kind: 'key-made', ...made, next: 'remove BATCHER_MAKE_KEY and redeploy: that boot must show this same hash (key-found), so the key is on the volume. Only then register the hash as a batcher (the 48-hour lock), fund the address with two plain ADA UTxOs (5 ADA for collateral, and its float), and put the hash and address in the settings' });
      return 0;
    }
    // The key first: a key the settings do not name is refused before any source is asked.
    const key = env.BATCHER_KEY_FILE ? signerOf(keyFromFile(env.BATCHER_KEY_FILE)) : null;
    if (key) log({ kind: 'key-found', keyHash: key.keyHash, address: enterpriseAddress(key.keyHash, 1) });
    if (text === undefined) {
      if (key) {
        log({ kind: 'waiting', reason: 'no settings yet: put this key hash and address in BATCHER_SETTINGS' });
        return 0;
      }
      throw new Error('no settings: give a settings file, or BATCHER_SETTINGS');
    }
    const c = parseSettings(text);
    if (key && key.keyHash !== c.batcher.keyHash) throw new Error(`the key at BATCHER_KEY_FILE is ${key.keyHash}; the settings name ${c.batcher.keyHash}`);
    if (live && !key) throw new Error('BATCHER_LIVE=1 needs BATCHER_KEY_FILE: there is nothing to sign with');
    if (live && !once) {
      for (const [name, r] of [[PING_ENV, alive], [ALERTS_PING_ENV, alerts]] as const) if (r.problem) throw new Error(`a live batcher needs its alarm: ${name} is ${r.problem}`);
      if (alive.url === alerts.url) throw new Error(`a live batcher needs its alarm: ${PING_ENV} and ${ALERTS_PING_ENV} are the same check`);
    }
    // A dry run goes on without its alarm; a ping URL given but refused is said, by name.
    for (const [variable, r] of [[PING_ENV, alive], [ALERTS_PING_ENV, alerts]] as const) if (!once && r.problem && r.problem !== 'unset') log({ kind: 'alarm-url-refused', variable, problem: r.problem });
    const e = readEnv(env);

    const stateFile = env.BATCHER_KEY_FILE ? setAsideFileOf(env.BATCHER_KEY_FILE) : null;
    const state = stateFile ? readSetAside(stateFile, log) : { trapped: new Set<string>(), suspects: new Set<string>() };
    if (state.trapped.size || state.suspects.size) log({ kind: 'set-aside-restored', trapped: [...state.trapped], suspects: [...state.suspects] });
    // A UTxO the library broke on alone is never decoded again.
    const skip = (ref: string) => state.trapped.has(ref);
    const refused = new Set<string>();
    const onRefused = (ref: string, reason: string) => {
      if (refused.has(ref)) return;
      refused.add(ref);
      log({ kind: 'unreadable-utxo', ref, reason });
    };
    const koios = e.koios ? new Koios({ url: e.koios, token: env.KOIOS_TOKEN, timeoutMs: Number(env.KOIOS_TIMEOUT_MS ?? 30_000), onRefused, skip }) : null;
    const views: ChainView[] = p.views ? p.views(skip) : [];
    if (!p.views && e.ogmios && e.kupo) {
      if (!koios) throw new Error('KOIOS_URL is needed too: only Koios reads the batching account (Ogmios leaves out an account delegated nowhere)');
      const stake = koiosView(koios, c.network);
      const kupo = new Kupo({ url: e.kupo, onRefused, skip });
      const d = c.deployment;
      const patterns = [`${d.orderScriptHash}/*`, `${d.dex.authenPolicy}.4d5350`, `${d.dex.authenPolicy}.4d534753`, `${c.batcher.keyHash}/*`, ...Object.values(d.scriptRefs).map((r) => `${r.split('#')[1]}@${r.split('#')[0]}`)];
      // Kupo must be ready before it is believed; until then (and when it is not, at start) Koios serves.
      views.push(gated(ogmiosKupoView({ url: e.ogmios }, kupo, (h) => stake.rewardBalance(h)), () => checkKupoReady(kupo, patterns), 600_000, log));
    }
    if (!p.views && koios) views.push(koiosView(koios, c.network));
    if (!views.length) throw new Error('no source: set OGMIOS_URL and KUPO_URL, and/or KOIOS_URL');

    const signer = live ? key : null;
    const save = (change: { trapped?: string[]; cleared?: string }) => {
      if (!stateFile) return;
      try {
        writeSetAside(stateFile, change);
      } catch (err) {
        log({ kind: 'set-aside-unsaved', error: err instanceof Error ? err.message : String(err) });
      }
    };
    const watcher = new Watcher(views, signer, { ...c, suspects: state.suspects, checkLanding: e.ws !== undefined }, (ev) => {
      log(ev);
      heartbeat.observe(ev);
      if (ev.kind === 'stopped' && ev.trapped) save({ trapped: ev.trapped });
      if (ev.kind === 'suspect-cleared') save({ cleared: ev.ref });
    });
    log({ kind: 'start', sources: views.map((v) => v.name), dryRun: signer === null, batcher: c.batcher.keyHash, alarm: { alive: alive.url !== null && !once, alerts: alerts.url !== null && !once } });
    if (once) {
      await watcher.round();
      log({ kind: 'exit' });
      return watcher.stopped ? (watcher.stopped.fatal ? 3 : 2) : 0;
    }
    // A live batcher signs nothing until its alarm has answered: else a stop alerts no one.
    if (live) {
      while (!(await heartbeat.start())) {
        log({ kind: 'alarm-unreachable', reason: 'a ping did not get through (heartbeat-failed says why); nothing is signed until both checks answer' });
        await wait(p.alarmRetryMs ?? 60_000);
        if (stopAsked) {
          log({ kind: 'exit', code: 0 });
          return 0;
        }
      }
    } else void heartbeat.start();

    let lastBlock = Date.now();
    let lastIdle = 0;
    const follower = e.ws
      ? new Follower(e.ws, {
          forward: (b) => {
            lastBlock = Date.now();
            watcher.blockSeen(b.slot, b.txIds);
            void watcher.trigger();
            log({ kind: 'block', slot: b.slot, height: b.height, ours: b.txIds.filter((t) => watcher.inflight.has(t)) });
          },
          backward: (pt) => {
            watcher.rolledBack(pt === 'origin' ? 0n : pt.slot);
            void watcher.trigger();
            log({ kind: 'rollback', to: pt === 'origin' ? 'origin' : pt.slot });
          },
          down: (error) => {
            watcher.syncLost();
            log({ kind: 'chain-sync-down', error });
          },
        }, { socket: p.socket })
      : null;
    follower?.start();
    return await new Promise<number>((resolve) => {
      let done = false;
      let following = follower !== null;
      const unfollow = () => {
        if (following) follower!.stop();
        following = false;
      };
      const finish = async (code: number) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        clearInterval(beat);
        unfollow();
        await watcher.close();
        await heartbeat.close();
        log({ kind: 'exit', code });
        resolve(code);
      };
      const timer = setInterval(() => {
        const s = watcher.stopped;
        if (s?.fatal) return void finish(3);
        // Stopped for a person: up, idle, its alerts check failing, until redeployed.
        if (s) return unfollow();
        // With no block, a round every idleRoundMs: counted from the last block or idle round.
        if (Date.now() - Math.max(lastBlock, lastIdle) >= c.idleRoundMs) {
          lastIdle = Date.now();
          void watcher.trigger();
        }
      }, Math.min(c.idleRoundMs, p.pollMs ?? 5_000));
      const beat = setInterval(() => heartbeat.tick(), rhythm.everyMs);
      // The first report right after the first round: the checks turn green within a minute of the start.
      void watcher.trigger().then(() => {
        if (!done) heartbeat.tick();
      });
      void stopSignal.then(() => finish(0));
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log({ kind: 'fatal', error });
    heartbeat.fail(`could not start: ${error}`);
    await heartbeat.close();
    return 1;
  }
}

if (import.meta.main) {
  const code = await main({
    env: process.env,
    argv: process.argv.slice(2),
    write: (line) => process.stdout.write(line),
    onStop: (stop) => {
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    },
  });
  process.exitCode = code;
  // Whatever handle a library left open, the process ends: Railway waits for it to.
  setTimeout(() => process.exit(code), 1_000).unref();
}
