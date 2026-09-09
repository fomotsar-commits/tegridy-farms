#!/usr/bin/env node
// ============================================================
// venueHealth.mjs — synthetic availability probe for memetics.finance
//
// WHY THIS AND NOT A CLIENT BEACON
// --------------------------------
// The obvious answer to "we found out about the outage from a user" is a
// beacon in the browser that reports whether the app booted. It does not work,
// for a reason that is structural rather than fixable:
//
//   A CLIENT BEACON CANNOT DISTINGUISH "BROKEN" FROM "NOBODY VISITED".
//
// Both produce silence, and during a real outage traffic FALLS — so the signal
// gets quieter exactly when it needs to get louder, and 04:00 on a Tuesday
// looks the same as a total failure. A beacon also cannot report the failure
// that matters most: the one where the page never executes at all.
//
// A probe run on a schedule from outside has neither problem. It also carries
// no user data whatsoever, so it needs no consent gate, no PrivacyPage §3
// amendment, and none of §9's 14-day notice — which the beacon design did.
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
//   nft      /api/alchemy NFT path — a separate Alchemy surface on the same
//            key. When only one of the two breaks, that difference is the
//            diagnosis.
//   solana   /api/solrpc — independent provider. Stayed up on 2026-09-04, and
//            that contrast is what localised the fault to Alchemy.
//   indexer  the nginx /ready gate. Down for a different reason (nginx caches
//            the upstream IP at boot), which no client beacon would have
//            attributed correctly.
//   graphql  the indexer actually serving rows, not merely answering /ready.
//
// EXIT CODES. 0 = every check passed. 1 = at least one failed. Under --probe
// it always exits 0 and writes GITHUB_OUTPUT instead: the incident issue is the
// alarm, not a red workflow badge, and a crashed probe that exits non-zero
// would page on the monitor rather than on the venue.
//
// Usage:
//   node scripts/monitoring/venueHealth.mjs             # local, human output
//   node scripts/monitoring/venueHealth.mjs --probe     # CI: writes GITHUB_OUTPUT
//   node scripts/monitoring/venueHealth.mjs --self-test # prove the checks can FAIL
// ============================================================

import { appendFileSync } from 'node:fs';

const PROBE = process.argv.includes('--probe');
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
    id: 'nft',
    what: 'NFT API proxy (/api/alchemy)',
    run: () => req(`${SITE}/api/alchemy?endpoint=getContractMetadata&contractAddress=0xd774557b647330c91bf44cfeab205095f7e6c367`),
    verdict: (r) => (r.ok
      ? { ok: true, detail: `HTTP ${r.status}` }
      : { ok: false, detail: r.error || `HTTP ${r.status}` }),
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
  for (const r of results) {
    console.log(`${r.ok ? 'UP  ' : 'DOWN'}  ${r.what.padEnd(34)} ${r.detail}`);
  }

  const summary = down.length === 0
    ? `All ${results.length} venue checks passing.`
    : `${down.length} of ${results.length} venue checks FAILING: ${down.map((d) => d.id).join(', ')}`;
  console.log(`\n${summary}`);

  if (PROBE && process.env.GITHUB_OUTPUT) {
    const body = results.map((r) => `- ${r.ok ? '✅' : '❌'} **${r.what}** — ${r.detail}`).join('\n');
    appendFileSync(process.env.GITHUB_OUTPUT, [
      `venue_status=${down.length === 0 ? 'up' : 'down'}`,
      `venue_summary=${summary}`,
      'venue_body<<VENUE_EOF',
      body,
      'VENUE_EOF',
    ].join('\n') + '\n');
  }

  // Under --probe the exit code stays 0 on purpose: the incident issue is the
  // alarm. A red workflow badge for a venue outage pages the wrong person.
  process.exitCode = PROBE ? 0 : (down.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`ERROR — probe crashed: ${e?.message || e}`);
  // A crashed probe must still say something, or `venue_status` is the empty
  // string and the workflow's `if:` silently matches nothing — the same
  // built-but-invisible shape this whole workstream exists to end.
  if (PROBE && process.env.GITHUB_OUTPUT) {
    try {
      appendFileSync(process.env.GITHUB_OUTPUT, [
        'venue_status=down',
        `venue_summary=Probe crashed before it could check anything: ${String(e?.message || e).slice(0, 120)}`,
        'venue_body<<VENUE_EOF',
        `- ❌ **Probe crashed** — ${String(e?.message || e).slice(0, 300)}`,
        'VENUE_EOF',
      ].join('\n') + '\n');
    } catch (writeErr) {
      console.error(`ERROR — could not write GITHUB_OUTPUT: ${writeErr?.message || writeErr}`);
    }
  }
  process.exitCode = PROBE ? 0 : 2;
});
