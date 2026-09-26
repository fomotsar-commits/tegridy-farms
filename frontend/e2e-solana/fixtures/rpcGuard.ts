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
// "sent, not confirmed yet" test).
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
    return route.continue();
  });

  return {
    calls,
    violations,
    view(label) { current = label; },
    count(view, method) { return calls.filter((c) => c.view === view && (!method || c.method === method)).length; },
    fail(method, status, forMs) { failures.set(method, { status, until: Date.now() + forMs, hits: 0 }); },
    release(method) { const f = failures.get(method); if (f) f.until = 0; },
    failedCount(method) { return failures.get(method)?.hits ?? 0; },
  };
}
