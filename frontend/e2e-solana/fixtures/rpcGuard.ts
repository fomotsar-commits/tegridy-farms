// Every /api/solrpc call the page makes, checked against the PRODUCTION proxy's own rule.
//
// Under `vite preview` the /api/solrpc proxy is a plain forward with no allowlist
// (vite.config.ts), so a page could call a method production refuses and every e2e would
// still pass. This closes that gap: each call (single or batched) is run through
// api/solrpc.js's exported isAllowedRpcCall, the function the Vercel handler uses, not a
// copy of its list. A refused call gets the proxy's own 403 and is recorded.
//
// On top of that, /curve-launch must never scan: getProgramAccounts is recorded as a
// violation here even where the proxy would allow it (its Streamflow exception), because
// nothing on these pages has a reason to enumerate a program.
//
// It also counts calls per "view" (a label the spec sets), so a spec can hold the list
// view to the plan's budget, and it can fail one method on purpose for a while (the
// "sent, not confirmed yet" test). And it can change what the PAGE reads of one account
// (rewriteAccount: a tier that is missing, switched off or lying about its fee), while
// every test run and send still goes to the real chain.
import type { BrowserContext, Route } from '@playwright/test';

interface RpcCall { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown[] }
export interface RpcRecord { at: number; view: string; method: string; batchSize: number }

export interface RpcGuard {
  readonly calls: RpcRecord[];
  readonly violations: string[];
  /** Label later calls (e.g. 'list', 'launch-page'). */
  view(label: string): void;
  count(view: string, method?: string): number;
  /** Answer `method` with HTTP `status` (no body forwarded) for the next `forMs`. */
  fail(method: string, status: number, forMs: number): void;
  /** Stop failing `method` now. */
  release(method: string): void;
  /** How many requests carrying `method` were failed on purpose. */
  failedCount(method: string): number;
  /**
   * From now on, the PAGE reads `address` as `fn` says: `fn` gets the real bytes (null when
   * the account does not exist) and returns the bytes to show, or null for "no account".
   * Applied only to `getAccountInfo` and `getMultipleAccounts` answers (base64), never to
   * `simulateTransaction` or `sendTransaction`, so a test run still sees the real chain.
   * Node fixtures read the chain directly and are unaffected. It cannot invent an account
   * that does not exist (it has no owner to give it); that is recorded in `violations`.
   */
  rewriteAccount(address: string, fn: (data: Uint8Array | null) => Uint8Array | null): void;
  /** Stop every rewrite. */
  clearRewrites(): void;
  /** How many account answers were rewritten so far. */
  rewrittenCount(address?: string): number;
}

type Rewrite = (data: Uint8Array | null) => Uint8Array | null;
interface RpcAccount { data: [string, string]; owner: string; lamports: number; executable: boolean; rentEpoch: number; space?: number }

/** Rewrite one account value in place; returns the new value (or null). */
function rewriteValue(v: RpcAccount | null, fn: Rewrite, note: (s: string) => void): RpcAccount | null {
  if (v && v.data?.[1] !== 'base64') { note(`account answer in ${v.data?.[1]} encoding cannot be rewritten`); return v; }
  const before = v ? Uint8Array.from(Buffer.from(v.data[0], 'base64')) : null;
  const after = fn(before);
  if (after === null) return null;
  if (!v) { note('rewriteAccount cannot create an account that does not exist'); return v; }
  return { ...v, data: [Buffer.from(after).toString('base64'), 'base64'], space: after.length };
}

type ProxyRule = (c: unknown) => boolean;
let rule: ProxyRule | null = null;
async function proxyRule(): Promise<ProxyRule> {
  if (rule) return rule;
  // By URL, so the type checker does not need declarations for a plain-JS handler.
  const mod = (await import(new URL('../../api/solrpc.js', import.meta.url).href)) as { isAllowedRpcCall?: ProxyRule };
  if (typeof mod.isAllowedRpcCall !== 'function') {
    throw new Error('api/solrpc.js does not export isAllowedRpcCall: the e2e will not guess the production allowlist');
  }
  rule = mod.isAllowedRpcCall;
  return rule;
}
const MAX_RPC_BATCH = 20; // api/solrpc.js

export async function installRpcGuard(context: BrowserContext): Promise<RpcGuard> {
  const isAllowed = await proxyRule();
  const calls: RpcRecord[] = [];
  const violations: string[] = [];
  const failures = new Map<string, { status: number; until: number; hits: number }>();
  const rewrites = new Map<string, Rewrite>();
  const rewritten: string[] = [];
  let current = 'start';

  await context.route('**/api/solrpc', async (route: Route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    let body: RpcCall | RpcCall[];
    try {
      body = JSON.parse(req.postData() ?? '');
    } catch {
      violations.push(`[${current}] a non-JSON body was posted to /api/solrpc`);
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid JSON-RPC body' }) });
    }
    const list = Array.isArray(body) ? body : [body];
    if (list.length === 0 || list.length > MAX_RPC_BATCH) {
      violations.push(`[${current}] batch of ${list.length} (the proxy allows 1-${MAX_RPC_BATCH})`);
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid or oversized JSON-RPC batch' }) });
    }
    const now = Date.now();
    for (const c of list) {
      const method = typeof c?.method === 'string' ? c.method : String(c?.method);
      calls.push({ at: now, view: current, method, batchSize: list.length });
      if (method === 'getProgramAccounts') {
        violations.push(`[${current}] getProgramAccounts ${JSON.stringify(c.params?.[0])}: /curve-launch must never scan a program`);
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: `RPC method not allowed: ${method}` }) });
      }
      if (!isAllowed(c)) {
        violations.push(`[${current}] ${method}: refused by the production proxy's isAllowedRpcCall`);
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: `RPC method not allowed: ${method}` }) });
      }
    }
    for (const c of list) {
      const f = failures.get(String(c.method));
      if (f && now < f.until) {
        f.hits++;
        return route.fulfill({ status: f.status, contentType: 'application/json', body: JSON.stringify({ error: 'Upstream RPC error' }) });
      }
    }
    // Rewrites: only account reads that name a rewritten address are fetched and edited.
    const addressesOf = (c: RpcCall): string[] => {
      if (c.method === 'getAccountInfo') return typeof c.params?.[0] === 'string' ? [c.params[0]] : [];
      if (c.method === 'getMultipleAccounts') return Array.isArray(c.params?.[0]) ? (c.params[0] as unknown[]).map(String) : [];
      return [];
    };
    if (rewrites.size === 0 || !list.some((c) => addressesOf(c).some((a) => rewrites.has(a)))) return route.continue();
    const res = await route.fetch();
    let answer: unknown;
    try {
      answer = await res.json();
    } catch {
      return route.fulfill({ status: res.status(), contentType: res.headers()['content-type'] ?? 'application/json', body: await res.body() });
    }
    const answers = (Array.isArray(answer) ? answer : [answer]) as { id?: unknown; result?: { value?: unknown } }[];
    const note = (s: string) => violations.push(`[${current}] ${s}`);
    for (const c of list) {
      const addrs = addressesOf(c);
      if (!addrs.some((a) => rewrites.has(a))) continue;
      const a = answers.find((x) => x?.id === c.id);
      if (!a?.result || !('value' in a.result)) continue;
      if (c.method === 'getAccountInfo') {
        a.result.value = rewriteValue(a.result.value as RpcAccount | null, rewrites.get(addrs[0])!, note);
        rewritten.push(addrs[0]);
      } else if (Array.isArray(a.result.value)) {
        const vals = a.result.value as (RpcAccount | null)[];
        addrs.forEach((addr, i) => {
          const fn = rewrites.get(addr);
          if (!fn) return;
          vals[i] = rewriteValue(vals[i] ?? null, fn, note);
          rewritten.push(addr);
        });
      }
    }
    // Status and type only: the fetched body is already decoded, so the upstream's
    // content-encoding / content-length headers must not be replayed.
    return route.fulfill({ status: res.status(), contentType: 'application/json', body: JSON.stringify(Array.isArray(answer) ? answers : answers[0]) });
  });

  return {
    calls,
    violations,
    view(label) { current = label; },
    count(view, method) { return calls.filter((c) => c.view === view && (!method || c.method === method)).length; },
    fail(method, status, forMs) { failures.set(method, { status, until: Date.now() + forMs, hits: 0 }); },
    release(method) { const f = failures.get(method); if (f) f.until = 0; },
    failedCount(method) { return failures.get(method)?.hits ?? 0; },
    rewriteAccount(address, fn) { rewrites.set(address, fn); },
    clearRewrites() { rewrites.clear(); },
    rewrittenCount(address) { return address ? rewritten.filter((a) => a === address).length : rewritten.length; },
  };
}
