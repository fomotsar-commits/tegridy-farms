// The batcher's alarm: two healthchecks.io checks (the venue's alarm path, docs/OPS_SCHEDULER.md
// section 2). The pings are scripts/ops/lib/healthchecks.mjs's, copied: `<url>/start` at boot,
// `<url>` while healthy, `<url>/fail` when not; retries; https only; the URL is never logged, and
// every body is scrubbed of secrets (run-job.mjs does the same) before it leaves. A ping counts as
// answered only when healthchecks.io says exactly "OK": a check that does not exist answers 200
// "OK (not found)", and a rate-limited ping 200 "OK (rate limited)" (its API docs).
//   cardano-batcher (HC_PING_URL_CARDANO_BATCHER): the dead-man. An ok every `everyMs` whatever
//     the batcher's state, its report in the body. It never says fail: a fail would hold it DOWN,
//     and a process dying meanwhile would send no new email (the venue's rule). DOWN: the process
//     is gone.
//   cardano-batcher-alerts (HC_PING_URL_CARDANO_BATCHER_ALERTS): whether it works. Fail when it
//     stopped itself (the float cap, refusals, its wallet or settings: a person is needed), when no
//     round has reached a source for `quietMs`, while the last three batches it sent never reached a
//     block, or for what it alerted on (one such fail every `alertGapMs` at most, so a bad hour sends
//     one email, not twenty); ok otherwise. healthchecks.io emails only when a check changes, so a
//     new reason while it is already DOWN (a stop after an alert, say) first sends an ok, and then
//     the fail: an email for every new reason, none for the same one again.
import type { WatcherEvent } from './watcher.ts';

export const BODY_LIMIT = 10_000;
export const PING_ATTEMPTS = 3;
export const PING_TIMEOUT_MS = 10_000;
const retryPause = (i: number) => 1000 * (i + 1);

export const PING_ENV = 'HC_PING_URL_CARDANO_BATCHER';
export const ALERTS_PING_ENV = 'HC_PING_URL_CARDANO_BATCHER_ALERTS';
/** Alerts kept while held back; past this many, only counted. */
const MAX_HELD = 100;
/** Batches in a row that never reached a block, that fail the alerts check until one does. */
export const UNLANDED_FAIL = 3;

/** The ping URL when set and valid; otherwise null and why. Never echoes the value. */
export function resolvePingUrl(env: Readonly<Record<string, string | undefined>>, name: string = PING_ENV): { url: string | null; problem: string | null } {
  const raw = env[name];
  if (!raw) return { url: null, problem: 'unset' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { url: null, problem: 'not a URL' };
  }
  if (u.protocol !== 'https:') return { url: null, problem: 'not https' };
  // fetch refuses such a URL, and its error quotes the URL whole.
  if (u.username || u.password) return { url: null, problem: 'carrying a user name or password' };
  return { url: u.href.replace(/\/+$/, ''), problem: null };
}

export type PingKind = 'start' | 'ok' | 'fail';

export function pingTarget(url: string, kind: PingKind): string {
  if (kind === 'start') return `${url}/start`;
  if (kind === 'fail') return `${url}/fail`;
  return url;
}

/** Keep the head (the verdict lives there) and say what was cut, within `limit` bytes. */
export function clampBody(text: string, limit = BODY_LIMIT): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return text;
  const head = limit - 128;
  return `${buf.subarray(0, head).toString('utf8')}\n[cut: ${buf.length - head} more bytes]`;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PingResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** POST one ping with retries. Never throws, never logs the URL. */
export async function sendPing({ url, kind, body = '', fetchImpl = fetch, attempts = PING_ATTEMPTS, timeoutMs = PING_TIMEOUT_MS, sleep = pause }: { url: string; kind: PingKind; body?: string; fetchImpl?: typeof fetch; attempts?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<unknown> }): Promise<PingResult> {
  let last: PingResult = { ok: false };
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(pingTarget(url, kind), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: clampBody(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const said = (await res.text()).trim().slice(0, 100);
      if (res.ok && said === 'OK') return { ok: true, status: res.status };
      last = { ok: false, status: res.status, error: res.ok ? `answered "${said}"` : `HTTP ${res.status}` };
    } catch (e) {
      last = { ok: false, error: `${(e as Error)?.name || 'Error'}: ${(e as Error)?.message || String(e)}` };
    }
    if (i < attempts - 1) await sleep(retryPause(i));
  }
  return last;
}

export interface HeartbeatConfig {
  /** The dead-man check's ping URL; null: not set up. */
  alive: string | null;
  /** The alerts check's ping URL; null: not set up. */
  alerts: string | null;
  /** How often both are pinged (the checks' period). */
  everyMs: number;
  /** No round reaching a source for this long is a fail. */
  quietMs: number;
  /** At most one fail for alerts this often. */
  alertGapMs: number;
  /** It signs nothing: every report says so. */
  dryRun: boolean;
  /** Every body, and every ping error logged, passes through this (the logger's scrubber). */
  scrub?: (text: string) => string;
  now?: () => number;
  send?: (p: { url: string; kind: PingKind; body: string }) => Promise<PingResult>;
}

/** Watches the watcher's events and pings. All pings run in the background: the loop never waits on the alarm. */
export class Heartbeat {
  readonly #c: HeartbeatConfig;
  readonly #log: (e: object) => void;
  readonly #now: () => number;
  readonly #send: (p: { url: string; kind: PingKind; body: string }) => Promise<PingResult>;
  readonly #scrub: (text: string) => string;
  readonly #since: number;
  #lastGood: number;
  #lastProblem: string | null = null;
  #stopped: string | null = null;
  #alerts: string[] = [];
  #moreAlerts = 0;
  #lastAlertPing = -Infinity;
  #sent = 0;
  #fees = 0n;
  #lastRound = '';
  #wallet: { held: bigint; plain: bigint; cap: bigint } | null = null;
  #swept = 0n;
  #prepared = 0;
  #unlanded = 0;
  /** What the alerts check was last failed for ('stopped', 'quiet', 'unlanded', 'alert', 'start'), or null: it was last ok. */
  #downFor: string | null = null;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(c: HeartbeatConfig, log: (e: object) => void) {
    this.#c = c;
    this.#log = log;
    this.#now = c.now ?? Date.now;
    this.#send = c.send ?? ((p) => sendPing(p));
    this.#scrub = c.scrub ?? ((t) => t);
    this.#since = this.#now();
    this.#lastGood = this.#since;
  }

  /** Every event the watcher logs passes through here. */
  observe(e: WatcherEvent | { kind: string }): void {
    const ev = e as WatcherEvent;
    switch (ev.kind) {
      // A round that reached a source, whatever it then found.
      case 'idle':
        return this.#good(`idle via ${ev.source}${ev.reason ? `: ${ev.reason}` : ''}`);
      case 'prepared':
        this.#prepared++;
        return this.#good(`prepared ${ev.orders.length} orders via ${ev.source}${ev.dryRun ? ' (dry run)' : ''}`);
      case 'inputs-gone':
        return this.#good(`an input was spent meanwhile, via ${ev.source}`);
      case 'refused':
        return this.#good(`a batch refused at submission (pool ${ev.pool})`);
      case 'sent':
        this.#sent++;
        this.#fees += ev.fee;
        return this.#good(`sent ${ev.txId}`);
      case 'set-aside':
        this.#good(`set aside ${ev.ref}`);
        if (ev.alert) this.#alert(`set aside ${ev.ref}: ${ev.reason}`);
        return;
      case 'wallet':
        this.#wallet = { held: ev.held, plain: ev.plain, cap: ev.cap };
        return;
      case 'sweep-prepared':
        return this.#good(`prepared a sweep of ${ev.amount} lovelace to the treasury${ev.dryRun ? ' (dry run)' : ''}`);
      case 'swept':
        this.#swept += ev.amount;
        return this.#good(`swept ${ev.amount} lovelace to the treasury (${ev.txId})`);
      case 'unlanded':
        this.#unlanded = ev.inARow;
        return;
      case 'landed':
        this.#unlanded = 0;
        return;
      case 'source-down':
        this.#lastProblem = `${ev.source}: ${ev.error}`;
        return;
      case 'alert':
        return this.#alert(ev.reason);
      case 'error':
        this.#lastProblem = ev.error;
        return this.#alert(`error: ${ev.error}`);
      case 'stopped':
        this.#stopped = ev.reason;
        return this.#failAlerts(`STOPPED${ev.fatal ? ' (fatal: the process restarts)' : ''}: ${ev.reason}`, 'stopped');
    }
  }

  #good(round: string): void {
    this.#lastGood = this.#now();
    this.#lastRound = round;
  }

  #alert(text: string): void {
    if (this.#alerts.length < MAX_HELD) this.#alerts.push(text);
    else this.#moreAlerts++;
    if (this.#now() - this.#lastAlertPing >= this.#c.alertGapMs) this.#failAlerts(null, 'alert');
  }

  /**
   * One fail on the alerts check: `head` (a stop, the quiet), then the alerts held back, once an
   * hour has passed since the last (or at exit: `all`). Already DOWN for another reason, or with
   * alerts, it first sends an ok: healthchecks.io emails only when a check changes. Alerts that do
   * not get through are held again.
   */
  #failAlerts(head: string | null, why: string, all = false): void {
    const due = all || this.#now() - this.#lastAlertPing >= this.#c.alertGapMs;
    const held = due ? this.#alerts : [];
    const more = due ? this.#moreAlerts : 0;
    if (head === null && !held.length) return;
    if (due) {
      this.#alerts = [];
      this.#moreAlerts = 0;
    }
    const before = this.#lastAlertPing;
    if (held.length) this.#lastAlertPing = this.#now();
    const flip = this.#downFor !== null && (this.#downFor !== why || held.length > 0);
    if (flip) void this.#ping(this.#c.alerts, 'ok', 'not recovered: a new problem follows');
    const wasDownFor = this.#downFor;
    this.#downFor = why;
    const alerts = held.length ? `ALERT (${held.length + more}):\n${held.join('\n')}${more ? `\n(and ${more} more)` : ''}` : null;
    const body = [head, alerts].filter((x) => x !== null).join('\n');
    void this.#ping(this.#c.alerts, 'fail', `${this.#c.dryRun ? 'DRY RUN, signing nothing. ' : ''}${body}`, () => {
      // It did not get through: the check is as the last ping that did left it.
      this.#downFor = flip ? null : wasDownFor;
      if (!held.length) return;
      this.#alerts = [...held, ...this.#alerts].slice(0, MAX_HELD);
      this.#moreAlerts += more;
      this.#lastAlertPing = before;
    });
  }

  /** The start pings. Resolves true once every check set up has answered. */
  start(): Promise<boolean> {
    const off = [!this.#c.alive && PING_ENV, !this.#c.alerts && ALERTS_PING_ENV].filter((x) => x);
    if (off.length) this.#log({ kind: 'heartbeat-off', reason: `${off.join(' and ')}: not set up, so ${this.#c.alive ? 'no alert' : 'no alarm'} will reach anyone` });
    const body = this.#c.dryRun ? 'the batcher started: a dry run, it signs nothing' : 'the batcher started, signing';
    return Promise.all([this.#ping(this.#c.alive, 'start', body), this.#ping(this.#c.alerts, 'start', body)]).then((rs) => rs.every((r) => r === null || r.ok));
  }

  /** A fail on the alerts check now, whatever the rhythm (the process could not start). */
  fail(text: string): void {
    this.#failAlerts(text, 'start');
  }

  /** Called every `everyMs`: the dead-man's ok, and the alerts check's ok or fail. */
  tick(): void {
    const now = this.#now();
    const quiet = now - this.#lastGood >= this.#c.quietMs ? `no round has reached a source for ${Math.round((now - this.#lastGood) / 60_000)} minutes${this.#lastProblem ? ` (the last problem: ${this.#lastProblem})` : ''}` : null;
    const report = [
      `${this.#c.dryRun ? 'DRY RUN, signing nothing. ' : ''}${this.#stopped ? `STOPPED: ${this.#stopped}` : (quiet ?? 'working')}`,
      `running ${Math.round((now - this.#since) / 60_000)} minutes; last round: ${this.#lastRound || 'none yet'}`,
      `since the last report: ${this.#prepared} batches prepared, ${this.#sent} sent, ${this.#fees} lovelace in network fees`,
    ];
    if (this.#swept) report.push(`swept to the treasury since the last report: ${this.#swept} lovelace`);
    if (this.#wallet) report.push(`wallet: ${this.#wallet.held} lovelace (${this.#wallet.plain} of it plain ADA), its cap ${this.#wallet.cap}`);
    if (this.#alerts.length) report.push(`alerts held back (one alert email an hour at most): ${this.#alerts.length + this.#moreAlerts}`);
    this.#prepared = 0;
    this.#swept = 0n;
    this.#sent = 0;
    this.#fees = 0n;
    void this.#ping(this.#c.alive, 'ok', report.join('\n'));
    if (this.#stopped) return this.#failAlerts(`STOPPED: ${this.#stopped}`, 'stopped');
    if (quiet) return this.#failAlerts(quiet, 'quiet');
    if (this.#unlanded >= UNLANDED_FAIL) return this.#failAlerts(`the last ${this.#unlanded} batches sent never reached a block before their window closed: is the submitting node passing them on?`, 'unlanded');
    if (this.#alerts.length && now - this.#lastAlertPing >= this.#c.alertGapMs) return this.#failAlerts(null, 'alert');
    this.#downFor = null;
    void this.#ping(this.#c.alerts, 'ok', report.join('\n'));
  }

  #ping(url: string | null, kind: PingKind, body: string, onFail?: () => void): Promise<PingResult | null> {
    if (!url) return Promise.resolve(null);
    const done = this.#pending.then(async () => {
      const r = await this.#send({ url, kind, body: this.#scrub(body) });
      if (!r.ok) {
        this.#log({ kind: 'heartbeat-failed', check: url === this.#c.alive ? 'alive' : 'alerts', ping: kind, error: this.#scrub(r.error ?? `HTTP ${r.status}`) });
        onFail?.();
      }
      return r;
    });
    this.#pending = done;
    return done;
  }

  /** Waits for every ping sent so far. */
  async flush(): Promise<void> {
    await this.#pending;
  }

  /** Before the process exits: alerts still held back go out now, then every ping is waited for. */
  async close(): Promise<void> {
    this.#failAlerts(null, 'alert', true);
    await this.#pending;
  }
}
