// Alarm path: healthchecks.io-style pings. One check per job: `<url>/start` when a run
// begins, `<url>` with the report as the body on success, `<url>/fail` on failure. The
// service alerts on a fail AND when an expected ping never arrives (the dead-man switch).

export const BODY_LIMIT = 10_000;
export const PING_ATTEMPTS = 3;
export const PING_TIMEOUT_MS = 10_000;
const retryPause = (i) => 1000 * (i + 1);
/** The longest one ping can take: every attempt times out, with the pauses between them. */
export const PING_WORST_MS = PING_ATTEMPTS * PING_TIMEOUT_MS
  + Array.from({ length: PING_ATTEMPTS - 1 }, (_, i) => retryPause(i)).reduce((a, b) => a + b, 0);
const SECRETISH = /(KEY|SECRET|TOKEN|PASS|PING|RPC|URL|DSN|AUTH|CREDENTIAL|PRIVATE)/i;

export const pingEnvName = (job) => `HC_PING_URL_${job.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/** { name, url } when set and valid; { name, url: null, problem } otherwise. Never echoes the value. */
export function resolvePingUrl(env, job) {
  const name = pingEnvName(job);
  const raw = env[name];
  if (!raw) return { name, url: null, problem: 'unset' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { name, url: null, problem: 'not a URL' };
  }
  if (u.protocol !== 'https:') return { name, url: null, problem: 'not https' };
  return { name, url: u.href.replace(/\/+$/, ''), problem: null };
}

export function pingTarget(url, kind) {
  if (kind === 'start') return `${url}/start`;
  if (kind === 'fail') return `${url}/fail`;
  return url;
}

/** Replace every secret-looking env value (8+ chars) with <NAME>, longest first. */
export function scrubSecrets(text, env) {
  const pairs = Object.entries(env)
    .filter(([k, v]) => SECRETISH.test(k) && typeof v === 'string' && v.length >= 8)
    .sort((a, b) => b[1].length - a[1].length);
  let out = String(text);
  for (const [k, v] of pairs) out = out.split(v).join(`<${k}>`);
  return out;
}

/** Keep the head (the verdict lives there) and say what was cut, within `limit` bytes. */
export function clampBody(text, limit = BODY_LIMIT) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return text;
  const head = limit - 128;
  return `${buf.subarray(0, head).toString('utf8')}\n[cut: ${buf.length - head} more bytes; the full report is in the job's .last.txt]`;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST one ping with retries. Returns { ok, status?, error? }; never throws, never logs the URL. */
export async function sendPing({ url, kind, body = '', fetchImpl = fetch, attempts = PING_ATTEMPTS, timeoutMs = PING_TIMEOUT_MS, sleep = pause }) {
  let last = {};
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(pingTarget(url, kind), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return { ok: true, status: res.status };
      last = { ok: false, status: res.status, error: `HTTP ${res.status}` };
    } catch (e) {
      last = { ok: false, error: `${e?.name || 'Error'}: ${e?.message || e}` };
    }
    if (i < attempts - 1) await sleep(retryPause(i));
  }
  return last;
}
