// What the PRODUCTION console says, on every audited route.
//
// WHY THIS EXISTS. `/security` shipped `<polyline points="8 8 3 14h6l-1 8 5-6">`
// — path syntax in an attribute that takes coordinate pairs. The browser rejected
// the attribute, the icon lost a stroke, and every render logged `Expected
// number`. It was valid TSX, `tsc` was clean, `eslint` was clean, the component
// mounted without throwing, and a 30-check CI run passed. **The only place that
// bug was visible was the browser console on the deployed site.**
//
// So this is the check CI structurally cannot be: it runs against real production
// and reads what the browser actually reports. It is NOT part of the CI e2e run —
// `playwright.config.ts` has `testDir: './e2e'`, this lives in `./e2e-prod`, and
// it needs its own config:
//
//   npx playwright test --config=playwright.prod.config.ts
//   PROD_URL=https://memetics.finance npx playwright test --config=playwright.prod.config.ts
//
// Run it after a deploy. Give the deploy time first: prod served the previous
// bundle for ~90s after the #404 merge, and the first three probes still showed
// the old defect (see reference_dating_the_prod_build).
//
// ── WHAT IT ASSERTS, AND WHY THAT IS NARROW ──────────────────────────────────
// Production has standing console noise this sweep did NOT introduce and must not
// pretend to own. Asserting "zero console errors" would be red on day one and
// therefore ignored within a week. So it asserts two things that were MEASURED at
// zero on 2026-09-05, and lists everything else:
//
//   1. Zero uncaught page exceptions, anywhere. Measured 0/64 routes.
//   2. Zero console errors outside KNOWN_NOISE below.
//
// Each KNOWN_NOISE entry names the thread that owns it. An entry that can be
// deleted is a bug someone fixed — deleting it is how this tightens over time.
import { test, expect } from '@playwright/test';
import { AUDITABLE_ROUTES, gotoNakamigos, gotoRoute, navigablePath } from '../e2e/fixtures/routes';

/**
 * Console output that production emits today, from causes with their own open
 * threads. NOT a suppression list — a handover list. Never add a pattern here
 * without the reason and the owner, or this becomes the thing it was written to
 * prevent: noise that reads as fine.
 */
/**
 * Hosts whose failures are explained, matched on the PARSED hostname.
 *
 * Deliberately NOT regexes. `/drpc\.org/.test(url)` also matches
 * `https://evil.example/?x=drpc.org` — an unanchored host pattern tested against
 * a URL, which is `js/regex/missing-regexp-anchor` and is how a substring check
 * quietly becomes wrong. CodeQL failed this PR on exactly that, correctly.
 */
const NOISE_HOSTS: readonly { host: string; why: string }[] = [
  // 46 of 64 routes log `blocked by CORS policy` -> net::ERR_FAILED for
  // /trades, /ohlcv/* and /simple/networks/*/token_price.
  //
  // ⚠️ IT IS RATE LIMITING, NOT A CORS POLICY, and an earlier version of this
  // comment had it wrong. `connect-src` in vercel.json allows the host, AND the
  // upstream answers `200` with `access-control-allow-origin: *` for all three
  // of those exact paths when curled (measured 2026-09-05). What the browser
  // reports as CORS is a 429 whose ERROR response omits the ACAO header — the
  // header is present on success and absent on throttle, so a throttled read is
  // indistinguishable from a blocked one from inside the page.
  //
  // That inverts the obvious fix: a bare proxy would put every visitor's reads
  // on ONE Vercel egress IP and exhaust the keyless budget FASTER. Only a
  // CACHING proxy helps, because it collapses N visitors into one upstream call.
  // ZERO GeckoTerminal reads are proxied on trunk today — 8 direct call sites.
  { host: 'geckoterminal.com', why: 'GeckoTerminal keyless rate limit under burst — needs a CACHING proxy, not a bare one' },
  // The RPC ranker pings every endpoint in the roster on boot; the losers answer
  // 4xx and that is the ranker working, not a page failing.
  { host: 'drpc.org', why: 'RPC roster ranking pings — reference_viem_rank_ping_storm' },
  { host: 'publicnode.com', why: 'RPC roster ranking pings' },
  { host: 'cloudflare-eth.com', why: 'RPC roster ranking pings' },
  { host: 'mainnet.base.org', why: 'RPC roster ranking pings' },
  { host: 'chain.robinhood.com', why: 'RPC roster ranking pings' },
  { host: 'alchemy.com', why: 'RPC roster ranking pings' },
  { host: 'infura.io', why: 'RPC roster ranking pings' },
];

/** Exact host, or a true subdomain of it — never a substring. */
function isNoiseHost(hostname: string): { known: true; why: string } | { known: false } {
  for (const entry of NOISE_HOSTS) {
    if (hostname === entry.host || hostname.endsWith(`.${entry.host}`)) return { known: true, why: entry.why };
  }
  return { known: false };
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Console text that is not attributable to a host, because it names none.
 * These stay message patterns — none of them is host-shaped.
 */
const KNOWN_NOISE: readonly { pattern: RegExp; why: string }[] = [
  {
    // The tail of a blocked cross-origin fetch, logged separately from the URL.
    pattern: /net::ERR_FAILED/i,
    why: 'trailing log line of a refused cross-origin read (see NOISE_HOSTS)',
  },
  // ── DELETED 2026-09-05: the indexer-CSP entry. ────────────────────────────
  // It excused `violates ... Content Security Policy` on /chart, /competitions
  // and /copy-trading. #426 added the host to connect-src, and production now
  // reports cspErrors=0 with the GraphQL endpoint answering 200 on all three.
  //
  // Deleting it is the POINT of this list, not housekeeping: while the entry
  // stood, those three routes passed whether or not the panel worked, so the
  // sweep could not have told you the fix landed — and cannot now regress
  // silently. Do the same for any other entry whose cause gets fixed.
];

/**
 * Chrome logs `Failed to load resource: the server responded with a status of N`
 * with NO URL, so the message alone cannot say who failed. Allowlisting the
 * status code would be allowlisting a number nobody attributed — exactly the
 * "unreadable must not read as fine" move this whole file exists to prevent.
 * Instead: attribute it. The line is explained only when every failing response
 * actually observed on the page came from a known host.
 */
function statusOnlyIsAttributable(message: string, failed: readonly { status: number; url: string }[]): boolean {
  const m = /Failed to load resource: the server responded with a status of (\d+)/i.exec(message);
  if (!m) return false;
  const status = Number(m[1]);
  const sameStatus = failed.filter((f) => f.status === status);
  // Nothing observed with that status → cannot attribute it, so do NOT excuse it.
  if (sameStatus.length === 0) return false;
  return sameStatus.every((f) => {
    const h = hostnameOf(f.url);
    return h !== null && isNoiseHost(h).known;
  });
}

/** Any absolute URL quoted inside a console message, e.g. "Access to fetch at '…'". */
function urlsIn(message: string): string[] {
  return message.match(/https?:\/\/[^\s'"()]+/g) ?? [];
}

function classify(
  message: string,
  failed: readonly { status: number; url: string }[],
): { known: true; why: string } | { known: false } {
  // Prefer attribution by the host the message itself names.
  for (const url of urlsIn(message)) {
    const h = hostnameOf(url);
    if (h === null) continue;
    const verdict = isNoiseHost(h);
    if (verdict.known) return verdict;
  }
  for (const n of KNOWN_NOISE) if (n.pattern.test(message)) return { known: true, why: n.why };
  if (statusOnlyIsAttributable(message, failed)) {
    return { known: true, why: 'status-only console line attributed to a known host by response URL' };
  }
  return { known: false };
}

/** Our own origin, so a failing response can be told from a third party's. */
const baseOrigin = new URL(process.env.PROD_URL || 'https://memetic.fun').origin;

for (const route of AUDITABLE_ROUTES) {
  const path = navigablePath(route);

  test(`prod console — ${path}`, async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failed: { status: number; url: string }[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    // Recorded so a URL-less console line can be attributed to a host instead of
    // excused by its status code.
    page.on('response', (r) => {
      if (r.status() >= 400) failed.push({ status: r.status(), url: r.url() });
    });

    // Reuse the fixtures' own readiness probe rather than a second copy of it:
    // it also waits out Suspense skeletons (`aria-busy`), which a hand-rolled
    // "main has text" check does not, and it is the probe CI already trusts.
    //
    // /nakamigos needs its own helper — it opens on a full-viewport splash with
    // NO `main` behind it until dismissed, so the generic probe cannot pass
    // there. Hand-rolling this was a false "production is broken" for one run.
    if (path === '/nakamigos') {
      await gotoNakamigos(page);
    } else {
      await gotoRoute(page, path);
    }
    // Let deferred/lazy panels mount and make their calls — most of this class of
    // bug appears on the second render, not the first.
    await page.waitForTimeout(2_500);

    // ── SELF-INFLICTED 502s ───────────────────────────────────────────────
    // Visiting 64 routes fires ~300 keyless GeckoTerminal reads from ONE IP in
    // ~4 minutes, which trips the upstream rate limit; api/_lib/pool-market.js
    // maps any non-404 upstream status to 502 (:153). So the sweep can make our
    // own API 502 at a rate no real user would.
    //
    // Blanket-allowlisting `/api/aggregator` 502s would hide a genuine API
    // outage, which is the one thing this file must never do. So DISAMBIGUATE
    // instead: re-request the exact failing same-origin URL once. If it answers
    // now, the failure was ours to cause and is not a defect. If it still
    // fails, it is real and stays reported.
    const selfInflicted = new Set<number>();
    for (const f of failed) {
      if (!f.url.startsWith(baseOrigin) || f.status < 500) continue;
      // Wait before re-probing: the re-request leaves the SAME IP that just
      // tripped the upstream window, so an immediate retry inherits the throttle
      // and proves nothing. Two attempts with a pause is enough to separate
      // "we burst" from "the API is down" without becoming a retry loop.
      for (const backoffMs of [3_000, 8_000]) {
        await new Promise((r) => setTimeout(r, backoffMs));
        try {
          const again = await page.request.get(f.url, { timeout: 20_000 });
          if (again.ok()) {
            selfInflicted.add(f.status);
            break;
          }
        } catch {
          /* keep trying until the attempts run out, then leave it reported */
        }
      }
    }

    // A 5xx from OUR OWN origin that the re-probes could not clear.
    //
    // This is the one class this sweep cannot fairly assert on, and saying so is
    // better than pretending either way. Visiting all 64 routes fires ~300
    // keyless GeckoTerminal reads from one IP; the upstream throttles, and
    // api/_lib/pool-market.js maps any non-404 upstream status to 502 (:153). The
    // rate limit outlives an 11s backoff, so one route per run typically reports
    // a 502 that NO USER would see — measured: the failing route passes on its
    // own every time, and the failing pool URL hand-probes 12/12 at 200.
    //
    // Failing on it would make this flaky, and flaky gets ignored. Allowlisting
    // it would hide a real API outage. So: it is EXCLUDED from the assertion and
    // PRINTED loudly with the command to check it properly. If a route reports
    // this every run, or several do, that is not the sweep — go look.
    const sweptOurOwn5xx = new Set(
      failed.filter((f) => f.url.startsWith(baseOrigin) && f.status >= 500 && !selfInflicted.has(f.status)).map((f) => f.status),
    );

    const unexpected: string[] = [];
    for (const message of [...new Set(consoleErrors)]) {
      const verdict = classify(message, failed);
      if (verdict.known) continue;
      const m = /responded with a status of (\d+)/i.exec(message);
      if (m && selfInflicted.has(Number(m[1]))) continue;
      if (m && sweptOurOwn5xx.has(Number(m[1]))) {
        // Printed, never silently dropped. See the note above `sweptOurOwn5xx`.
        console.log(
          `SWEEP-INDUCED ${path}: our own ${m[1]} did not clear after two backed-off ` +
            `re-probes. Confirm with: npx playwright test --config=playwright.prod.config.ts -g "${path}"`,
        );
        continue;
      }
      unexpected.push(message.slice(0, 300));
    }
    // Printed with the failure so a status-only line can be traced to a host
    // without re-running the sweep by hand.
    const failedSummary = [...new Set(failed.map((f) => `${f.status} ${f.url}`))].slice(0, 12);

    // An uncaught exception is never acceptable and was measured at zero, so it
    // gets its own assertion rather than being folded into the message list.
    expect(
      [...new Set(pageErrors)],
      `${path} threw an uncaught exception. This was 0 across all routes on 2026-09-05.`,
    ).toEqual([]);

    expect(
      unexpected,
      `${path} logged console errors that no KNOWN_NOISE entry explains.\n` +
        unexpected.map((u) => `  ${u}`).join('\n') +
        (failedSummary.length ? `\nFailing responses seen on this page:\n${failedSummary.map((f) => `  ${f}`).join('\n')}` : '') +
        '\nEither it is a real defect, or it belongs in KNOWN_NOISE **with its reason and owner**.',
    ).toEqual([]);
  });
}
