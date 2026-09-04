// THE PILL'S INPUTS, GUARDED AS SHAPE.
//
// /tax no longer carries a SOON pill, and the justification is a repo fact
// rather than a probe: /api/etherscan ships with every deployment of this repo
// and allowlists exactly the three account actions the ledger read needs. A
// fact that lives only in a comment stops being true quietly, so this file
// parses the artefact and fails the build the moment one of the three
// disappears.
//
// WHAT THIS IS NOT: a liveness claim. It cannot tell whether the deployment's
// ETHERSCAN_API_KEY is set, and it does not try — that state is not readable in
// the browser at nav-render time either, which is exactly why the disclosure
// lives on the page instead of in the nav. So the third assertion here is about
// the DISCLOSURE: the keyless copy that names the operator's variable must
// exist and must be reachable from the page. Same idea as a11yRouteCoverage —
// a shape guard on a claim the code is making elsewhere.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TAX_PILL_SOON } from './rails';

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

describe('the rail the /tax pill is keyed to is in the repo, not in a comment', () => {
  const proxy = read('api', 'etherscan.js');

  it('allowlists all three account actions the wallet ledger reads', () => {
    const block = proxy.slice(proxy.indexOf('ALLOWED_ACTIONS'), proxy.indexOf('ETH_ADDRESS_RE'));
    for (const action of ['txlist', 'txlistinternal', 'tokentx']) {
      expect(block, `api/etherscan.js must allowlist ${action}`).toContain(`"${action}"`);
    }
  });

  it('pins the proxy to Ethereum mainnet, which is the scope every export claims', () => {
    expect(proxy).toContain('params.set("chainid", "1")');
  });

  it('forwards the pagination that keeps a read bounded', () => {
    expect(proxy).toContain('params.set("offset"');
    expect(proxy).toContain('params.set("page"');
    expect(proxy).toContain('if (endblock) params.set("endblock", String(endblock));');
  });

  // Not read in this lane, and asserted anyway: the Solana leg is designed
  // against these two methods, and a future lane finding them gone should find
  // out here rather than at runtime.
  it('leaves the Solana signature methods allowlisted for the address leg that follows', () => {
    const solrpc = read('api', 'solrpc.js');
    expect(solrpc).toContain('"getSignaturesForAddress"');
    expect(solrpc).toContain('"getTransaction"');
  });
});

describe('the pill and the page disagree deliberately, and both halves are pinned', () => {
  it('states the pill as a value, because nothing in the browser can check the key', () => {
    expect(TAX_PILL_SOON).toBe(false);
  });

  it('keeps the operator disclosure on the surface the pill is about', () => {
    const card = read('src', 'components', 'tax', 'LedgerStatusCard.tsx');
    expect(card).toContain('ETHERSCAN_API_KEY');
    expect(card).toMatch(/whole period is a declared gap on every export/);
    // …and the page must actually render it, or the disclosure is a file nobody sees.
    expect(read('src', 'pages', 'TaxPage.tsx')).toContain('<LedgerStatusCard');
  });
});
