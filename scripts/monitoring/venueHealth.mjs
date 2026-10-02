#!/usr/bin/env node
// ============================================================
// venueHealth.mjs — the surfaces the synthetic monitor could not see
//
// THIS EXTENDS AN EXISTING MONITOR; IT DOES NOT REPLACE ONE
// ---------------------------------------------------------
// .github/workflows/synthetic-monitor.yml has probed production every 30
// minutes since 2026-06-10, and it WORKS: on 2026-09-04 it went red at 20:55
// and opened incident #385. Anything here that duplicated it would be a second
// alarm for one outage, so this file deliberately covers only what that
// workflow cannot reach, and its failures fold into the SAME incident rather
// than raising a rival one.
//
// The existing monitor already covers: the app shell on both apex domains, the
// www -> apex redirect, the Alchemy NFT floor-price path, the orderbook and the
// trades endpoint — each with a body-content assertion, not merely a 200.
//
// WHAT IT COULD NOT SEE, AND WHY THAT MATTERED
// --------------------------------------------
// Everything it probes is a Vercel surface. The indexer lives on Railway and
// had ZERO coverage — no /ready, no /graphql, nothing. So the second half of
// the 2026-09-04 incident went unseen: nginx caches its upstream IP at boot,
// the indexer redeployed onto a new internal address, and every proxied path
// died while the indexer itself sat there logging healthy. Solana RPC and the
// EVM RPC path (as against the NFT path) were likewise unwatched.
//
// WHY NOT A CLIENT BEACON, since that was the original proposal: a beacon
// cannot distinguish "broken" from "nobody visited" — both are silence, and
// during an outage traffic FALLS, so the signal gets quieter exactly when it
// should get louder. It also carries user data, needing a PrivacyPage §3
// amendment and §9's 14-day notice. A probe from outside has neither problem.
//
// WHAT IT CHECKS, AND WHY EACH ONE
// --------------------------------
// Every check below is a surface that was ACTUALLY DOWN on 2026-09-04, chosen
// so this probe would have caught that incident rather than a hypothetical one:
//
//   evm      /api/alchemy?endpoint=rpc — the proxy whose key was revoked. This
//            is THE check: it went on answering HTTP 200 with a JSON-RPC error
//            body, which is why nothing noticed. So a 200 is not enough here;
//            the body must carry a real block number.
//   solana   /api/solrpc — independent provider. Stayed up on 2026-09-04, and
//            that contrast is what localised the fault to Alchemy.
//   indexer  the nginx /ready gate. Down for a different reason (nginx caches
//            the upstream IP at boot), which no client beacon would have
//            attributed correctly.
//   graphql  the indexer actually serving rows, not merely answering /ready.
//
// EXIT CODES. 0 = every check passed, 1 = at least one failed. `--fails-only`
// always exits 0 and prints NOTHING when healthy: the caller decides what a
// failure means, and here the caller already owns an incident issue. A crash
// is reported as a failed check rather than a non-zero exit, so a broken probe
// pages on the venue's behalf instead of on its own.
//
// Usage:
//   node scripts/monitoring/venueHealth.mjs              # local, human output
//   node scripts/monitoring/venueHealth.mjs --fails-only # CI: one line per failure
//   node scripts/monitoring/venueHealth.mjs --self-test  # prove the checks can FAIL
// ============================================================

const FAILS_ONLY = process.argv.includes('--fails-only');
const SELF_TEST = process.argv.includes('--self-test');

const SITE = process.env.VENUE_SITE_URL || 'https://memetics.finance';
const INDEXER = process.env.VENUE_INDEXER_URL || 'https://nginx-production-7483.up.railway.app';

/** Per-request ceiling. Generous: a slow answer is still an answer. */
const TIMEOUT_MS = 20_000;

async function req(url, { method = 'GET', body, headers } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { origin: SITE, ...(headers || {}) },
      body,
      signal: ac.signal,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

const json = (t) => { try { return JSON.parse(t); } catch { return null; } };

/**
 * The checks. Each returns { ok, detail } — `detail` is what a human reads at
 * 3am, so it names the observed value rather than repeating the check's name.
 *
 * Exported for --self-test, which drives each `verdict` against a synthetic
 * response to prove it can actually FAIL. A probe that cannot fail is
 * indistinguishable from one that is passing, which is the whole lesson of
 * this codebase's outage-as-zero work.
 */
export const CHECKS = [
  {
    id: 'evm',
    what: 'EVM RPC proxy (/api/alchemy)',
    run: () => req(`${SITE}/api/alchemy?endpoint=rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    }),
    // THE CHECK THAT WOULD HAVE CAUGHT 2026-09-04. A revoked key produced
    // HTTP 200 carrying {"error":{"code":-32600,"message":"Must be
    // authenticated!"}} — so status alone says "fine". Require a real block.
    verdict: (r) => {
      if (!r.ok) return { ok: false, detail: r.error || `HTTP ${r.status}` };
      const b = json(r.text);
      if (b?.error) return { ok: false, detail: `HTTP 200 carrying a JSON-RPC error: ${String(b.error.message).slice(0, 80)}` };
      const hex = b?.result;
      if (typeof hex !== 'string' || !/^0x[0-9a-f]+$/i.test(hex)) {
        return { ok: false, detail: `no block number in a 200 response` };
      }
      return { ok: true, detail: `block ${parseInt(hex, 16).toLocaleString('en-US')}` };
    },
  },
  {
    id: 'solana',
    what: 'Solana RPC proxy (/api/solrpc)',
    run: () => req(`${SITE}/api/solrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }),
    }),
    verdict: (r) => {
      if (!r.ok) return { ok: false, detail: r.error || `HTTP ${r.status}` };
      const slot = json(r.text)?.result;
      return Number.isFinite(slot)
        ? { ok: true, detail: `slot ${slot.toLocaleString('en-US')}` }
        : { ok: false, detail: 'no slot in a 200 response' };
    },
  },
  {
    id: 'indexer',
    what: 'Indexer readiness (/ready)',
    run: () => req(`${INDEXER}/ready`),
    // /ready 503s until the historical sync completes, which is correct and is
    // still "not serving". A timeout here has meant nginx holding a stale
    // upstream IP after an indexer redeploy — see the runbook.
    verdict: (r) => (r.ok
      ? { ok: true, detail: `HTTP ${r.status}` }
      : { ok: false, detail: r.error || `HTTP ${r.status}` }),
  },
  {
    id: 'graphql',
    what: 'Indexer serving rows (/graphql)',
    run: () => req(`${INDEXER}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ swaps(limit: 1) { items { id } } }' }),
    }),
    // /ready can pass while the schema is empty or the resolver is broken, so
    // this asks for an actual row shape rather than a 200.
    verdict: (r) => {
      if (!r.ok) return { ok: false, detail: r.error || `HTTP ${r.status}` };
      const b = json(r.text);
      if (b?.errors?.length) return { ok: false, detail: `GraphQL error: ${String(b.errors[0]?.message).slice(0, 80)}` };
      return Array.isArray(b?.data?.swaps?.items)
        ? { ok: true, detail: `${b.data.swaps.items.length} row(s)` }
        : { ok: false, detail: 'no data.swaps.items in a 200 response' };
    },
  },
];

// ── self-test ───────────────────────────────────────────────────────────────
// Each case drives one verdict against a synthetic response. Both directions
// are asserted: the failure it must catch, AND the healthy shape it must not
// flag. A monitor is worth exactly what its ability to go red is worth.
function selfTest() {
  const v = (id) => CHECKS.find((c) => c.id === id).verdict;
  const cases = [
    ['evm catches the 2026-09-04 shape: 200 + JSON-RPC error', false,
      v('evm')({ ok: true, status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Must be authenticated!' } }) })],
    ['evm catches a 200 with no result at all', false,
      v('evm')({ ok: true, status: 200, text: '{}' })],
    ['evm passes a real block number', true,
      v('evm')({ ok: true, status: 200, text: JSON.stringify({ result: '0x18b6d0e' }) })],
    ['evm catches a transport failure', false,
      v('evm')({ ok: false, status: 0, text: '', error: 'timeout after 20000ms' })],
    ['solana catches a 200 with no slot', false,
      v('solana')({ ok: true, status: 200, text: '{}' })],
    ['solana passes a real slot', true,
      v('solana')({ ok: true, status: 200, text: JSON.stringify({ result: 444653371 }) })],
    ['graphql catches an errors[] body behind a 200', false,
      v('graphql')({ ok: true, status: 200, text: JSON.stringify({ errors: [{ message: 'Cannot query field' }] }) })],
    ['graphql passes real rows', true,
      v('graphql')({ ok: true, status: 200, text: JSON.stringify({ data: { swaps: { items: [{ id: '0xabc' }] } } }) })],
    ['graphql treats an empty-but-present list as up', true,
      v('graphql')({ ok: true, status: 200, text: JSON.stringify({ data: { swaps: { items: [] } } }) })],
    ['indexer catches a 503', false,
      v('indexer')({ ok: false, status: 503, text: '' })],
    ['indexer passes a 200', true,
      v('indexer')({ ok: true, status: 200, text: '' })],
  ];

  let failed = 0;
  for (const [name, want, got] of cases) {
    const pass = got.ok === want;
    if (!pass) failed += 1;
    console.log(`${pass ? '  ok  ' : '  FAIL'} ${name}${pass ? '' : ` (wanted ok=${want}, got ok=${got.ok}: ${got.detail})`}`);
  }
  if (failed) {
    console.error(`\nvenueHealth self-test: ${failed} case(s) failed`);
    process.exit(1);
  }
  console.log(`\nvenueHealth self-test: ${cases.length} cases pass`);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (SELF_TEST) return selfTest();

  const results = [];
  for (const c of CHECKS) {
    let verdict;
    try {
      verdict = c.verdict(await c.run());
    } catch (e) {
      // A check that throws is a failed check, not a crashed probe.
      verdict = { ok: false, detail: `check threw: ${String(e?.message || e)}` };
    }
    results.push({ id: c.id, what: c.what, ...verdict });
  }

  const down = results.filter((r) => !r.ok);

  if (FAILS_ONLY) {
    // One line per failure, in the shape the calling workflow already uses for
    // its own probes, so both sets read as a single list in a single incident.
    // Silence means healthy — the caller tests for empty output.
    for (const r of down) console.log(`- ${r.what}: ${r.detail}`);
    process.exitCode = 0;
    return;
  }

  for (const r of results) {
    console.log(`${r.ok ? 'UP  ' : 'DOWN'}  ${r.what.padEnd(34)} ${r.detail}`);
  }
  console.log(
    down.length === 0
      ? `\nAll ${results.length} venue checks passing.`
      : `\n${down.length} of ${results.length} venue checks FAILING: ${down.map((d) => d.id).join(', ')}`,
  );
  process.exitCode = down.length === 0 ? 0 : 1;
}

main().catch((e) => {
  // A CRASH MUST SPEAK AS A FAILED CHECK, not as a silent non-zero exit. Under
  // --fails-only the caller reads stdout and treats empty as healthy, so a
  // probe that died without printing would be indistinguishable from a probe
  // that found nothing wrong — the built-but-invisible shape this whole
  // workstream exists to end, rebuilt inside the thing doing the watching.
  const msg = String(e?.message || e).slice(0, 200);
  if (FAILS_ONLY) {
    console.log(`- Venue probe: crashed before it could check anything — ${msg}`);
    process.exitCode = 0;
    return;
  }
  console.error(`ERROR — probe crashed: ${msg}`);
  process.exitCode = 2;
});
