// The batcher's alarm: a healthchecks.io check (the venue's alarm path, docs/OPS_SCHEDULER.md),
// its ping URL in HC_PING_URL_CARDANO_BATCHER. The pings are scripts/ops/lib/healthchecks.mjs's,
// copied: `<url>/start` at boot, `<url>` with a short report while healthy, `<url>/fail` with the
// reason when it is not; retries; https only; the URL is never logged.
// Every `everyMs` the batcher says one thing:
//   fail  it stopped itself (the float cap, refusals, its wallet or settings: a person is needed);
//         no source has answered for `quietMs`; or something it alerted on (at most one such fail
//         every `alertGapMs`, so a bad hour sends one email, not twenty)
//   ok    otherwise, with what it did since the last ping
// and healthchecks.io emails when a fail arrives, and when the pings stop (the process is gone).
import type { WatcherEvent } from './watcher.ts';

export const BODY_LIMIT = 10_000;
export const PING_ATTEMPTS = 3;
export const PING_TIMEOUT_MS = 10_000;
const retryPause = (i: number) => 1000 * (i + 1);

export const PING_ENV = 'HC_PING_URL_CARDANO_BATCHER';

/** The ping URL when set and valid; otherwise null and why. Never echoes the value. */
export function resolvePingUrl(env: Readonly<Record<string, string | undefined>>): { url: string | null; problem: string | null } {
  const raw = env[PING_ENV];
  if (!raw) return { url: null, problem: 'unset' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { url: null, problem: 'not a URL' };
  }
  if (u.protocol !== 'https:') return { url: null, problem: 'not https' };
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
      if (res.ok) return { ok: true, status: res.status };
      last = { ok: false, status: res.status, error: `HTTP ${res.status}` };
    } catch (e) {
      last = { ok: false, error: `${(e as Error)?.name || 'Error'}: ${(e as Error)?.message || String(e)}` };
    }
    if (i < attempts - 1) await sleep(retryPause(i));
  }
  return last;
}

export interface HeartbeatConfig {
  /** null: no alarm set up (the batcher still runs, and says so at start). */
  url: string | null;
  /** How often a ping goes out (the check's period). */
  everyMs: number;
  /** No source answering for this long is a fail. */
  quietMs: number;
  /** At most one fail for alerts this often. */
  alertGapMs: number;
  now?: () => number;
  send?: (p: { url: string; kind: PingKind; body: string }) => Promise<PingResult>;
}

/** Watches the watcher's events and pings. All pings run in the background: the loop never waits on the alarm. */
export class Heartbeat {
  readonly #c: HeartbeatConfig;
  readonly #log: (e: object) => void;
  readonly #now: () => number;
  readonly #send: (p: { url: string; kind: PingKind; body: string }) => Promise<PingResult>;
  readonly #since: number;
  #lastGood: number;
  #stopped: string | null = null;
  #alerts: string[] = [];
  #lastAlertPing = -Infinity;
  #sent = 0;
  #fees = 0n;
  #lastRound = '';
  #pending: Promise<unknown> = Promise.resolve();

  constructor(c: HeartbeatConfig, log: (e: object) => void) {
    this.#c = c;
    this.#log = log;
    this.#now = c.now ?? Date.now;
    this.#send = c.send ?? ((p) => sendPing(p));
    this.#since = this.#now();
    this.#lastGood = this.#since;
  }

  /** Every event the watcher logs passes through here. */
  observe(e: WatcherEvent | { kind: string }): void {
    const ev = e as WatcherEvent;
    switch (ev.kind) {
      case 'idle':
      case 'prepared':
      case 'refused':
      case 'inputs-gone':
        this.#lastGood = this.#now();
        this.#lastRound = `${ev.kind} via ${'source' in ev ? ev.source : '?'}`;
        break;
      case 'sent':
        this.#lastGood = this.#now();
        this.#sent++;
        this.#fees += ev.fee;
        this.#lastRound = `sent ${ev.txId}`;
        break;
      case 'set-aside':
        this.#lastGood = this.#now();
        if (ev.alert) this.#alert(`set aside ${ev.ref}: ${ev.reason}`);
        break;
      case 'alert':
        this.#alert(ev.reason);
        break;
      case 'error':
        this.#alert(`error: ${ev.error}`);
        break;
      case 'stopped':
        this.#stopped = ev.reason;
        this.#ping('fail', `STOPPED${ev.fatal ? ' (fatal: the process restarts)' : ''}: ${ev.reason}`);
        break;
    }
  }

  #alert(text: string): void {
    this.#alerts.push(text);
    if (this.#now() - this.#lastAlertPing >= this.#c.alertGapMs) this.#flushAlerts();
  }

  #flushAlerts(): void {
    if (!this.#alerts.length) return;
    this.#lastAlertPing = this.#now();
    const body = `ALERT (${this.#alerts.length}):\n${this.#alerts.join('\n')}`;
    this.#alerts = [];
    this.#ping('fail', body);
  }

  start(): void {
    if (!this.#c.url) this.#log({ kind: 'heartbeat-off', reason: `${PING_ENV} is not set: no alarm will reach anyone` });
    this.#ping('start', 'the batcher started');
  }

  /** A fail now, whatever the rhythm (the process could not start). */
  fail(text: string): void {
    this.#ping('fail', text);
  }

  /** Called every `everyMs`: one ping, ok or fail. */
  tick(): void {
    const now = this.#now();
    if (this.#stopped) return this.#ping('fail', `STOPPED: ${this.#stopped}`);
    if (now - this.#lastGood >= this.#c.quietMs) return this.#ping('fail', `no source has answered for ${Math.round((now - this.#lastGood) / 60_000)} minutes`);
    if (this.#alerts.length && now - this.#lastAlertPing >= this.#c.alertGapMs) return this.#flushAlerts();
    const report = [`ok: running ${Math.round((now - this.#since) / 60_000)} minutes`, `last round: ${this.#lastRound || 'none yet'}`, `sent since the last ping: ${this.#sent} batches, ${this.#fees} lovelace in network fees`];
    if (this.#alerts.length) report.push(`alerts held back (one fail an hour at most): ${this.#alerts.length}`);
    this.#sent = 0;
    this.#fees = 0n;
    this.#ping('ok', report.join('\n'));
  }

  #ping(kind: PingKind, body: string): void {
    const url = this.#c.url;
    if (!url) return;
    this.#pending = this.#pending.then(async () => {
      const r = await this.#send({ url, kind, body });
      if (!r.ok) this.#log({ kind: 'heartbeat-failed', ping: kind, error: r.error ?? `HTTP ${r.status}` });
    });
  }

  /** Waits for every ping sent so far (before the process exits). */
  async flush(): Promise<void> {
    await this.#pending;
  }
}
