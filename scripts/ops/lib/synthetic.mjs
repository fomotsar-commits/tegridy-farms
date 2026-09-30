// Prod health: the probes and pass/fail rules of synthetic-monitor.yml (lines 30-186), in
// Node, plus the Railway indexer's /ready (it had no probe). Redirects are never followed:
// like the workflow's curl without -L, a probe sees the first answer only.

export const CANONICAL = 'memetics.finance';
export const ALIASES = ['www.memetics.finance', 'tegridyfarms.vercel.app'];
export const FOREIGN = 'memetic.fun';
export const DEFAULT_INDEXER = 'https://nginx-production-7483.up.railway.app';
const TIMEOUT_MS = 20_000;
const NFT = '0xd774557b647330C91Bf44cfEAB205095f7E6c367';

async function get(fetchImpl, url) {
  const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  return res;
}

/** Run every probe. Returns { ok, fails, notes, report }. */
export async function runSynthetic({ fetchImpl = fetch, env = process.env, now = new Date() } = {}) {
  const BASE = `https://${CANONICAL}`;
  const indexer = (env.VENUE_INDEXER_URL || DEFAULT_INDEXER).replace(/\/+$/, '');
  const fails = [];
  const notes = [];
  let probes = 0;

  const probe = async (name, url, pattern) => {
    probes++;
    let res;
    let body;
    try {
      res = await get(fetchImpl, url);
      body = await res.text();
    } catch (e) {
      fails.push(`- ${name}: request failed (${e?.name || 'Error'}: ${e?.message || e})`);
      return null;
    }
    if (res.status !== 200) { fails.push(`- ${name}: HTTP ${res.status}`); return null; }
    if (pattern && !body.includes(pattern)) {
      fails.push(`- ${name}: 200 but expected content missing (${pattern})`);
      return null;
    }
    return body;
  };

  await probe('app shell', `${BASE}/`, '/assets/');
  await probe('alchemy proxy', `${BASE}/api/alchemy?endpoint=getFloorPrice&contractAddress=${NFT}`, 'floorPrice');
  const orders = await probe('orderbook', `${BASE}/api/orderbook?action=query&contract=${NFT}&limit=1`, 'orders');
  // Same pass rule as the workflow (a degraded read still proves the function runs), but said
  // out loud: docs/OPEX.md gap 1. It is not a failure because a 2.5s read deadline trips it.
  if (orders && /"degraded"\s*:\s*true/.test(orders)) notes.push('warn: orderbook answered degraded:true (the Supabase read failed or took over 2.5s)');
  await probe('trades', `${BASE}/api/orderbook?action=trade-query&wallet=0x0000000000000000000000000000000000000001`, 'trades');
  await probe(`${CANONICAL} app shell`, `https://${CANONICAL}/`, '/assets/');
  // New: the venue's Ponder indexer behind the Railway nginx proxy. 200 = ready; 503 = syncing.
  await probe('indexer /ready', `${indexer}/ready`, '');

  // Each alias must answer a PERMANENT redirect (301 or 308) onto the canonical host.
  for (const host of ALIASES) {
    probes++;
    let res;
    try {
      res = await get(fetchImpl, `https://${host}/`);
      await res.body?.cancel?.();
    } catch (e) {
      fails.push(`- ${host}: request failed (${e?.name || 'Error'}: ${e?.message || e})`);
      continue;
    }
    if (res.status !== 301 && res.status !== 308) {
      fails.push(`- ${host}: expected a permanent redirect (301 or 308) to https://${CANONICAL}/, got ${res.status}`);
      continue;
    }
    let location = res.headers.get('location') || '';
    try { location = new URL(location, `https://${host}/`).href; } catch { /* keep raw */ }
    if (!(location === `https://${CANONICAL}` || location.startsWith(`https://${CANONICAL}/`))) {
      fails.push(`- ${host}: ${res.status}s to '${location}', not the canonical host https://${CANONICAL}/`);
    }
  }

  // A host that is no longer ours must not serve our app shell. A non-200 is inconclusive.
  probes++;
  try {
    const res = await get(fetchImpl, `https://${FOREIGN}/`);
    const body = await res.text();
    if (res.status === 200) {
      if (body.includes('/assets/')) {
        fails.push(`- ${FOREIGN}: THIS VENUE is answering on it (served our app shell). The domain is back on this Vercel project; the canonical-host law forbids a second front door.`);
      }
    } else {
      notes.push(`note: ${FOREIGN} answered ${res.status}, so the "not us" check is inconclusive. Not ours to page on.`);
    }
  } catch (e) {
    notes.push(`note: ${FOREIGN} did not answer (${e?.name || 'Error'}), so the "not us" check is inconclusive. Not ours to page on.`);
  }

  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  const head = fails.length
    ? `Synthetic monitor failures at ${stamp} UTC:\n${fails.join('\n')}`
    : `Synthetic monitor at ${stamp} UTC: all ${probes} probes passed.`;
  const tail = fails.length
    ? '\n\nRunbook: check Vercel deployments (npx vercel ls from the repo root), the Upstash rate limiter, Supabase status, and the Railway indexer.'
    : '';
  return { ok: fails.length === 0, fails, notes, report: [head, ...notes].join('\n') + tail };
}
