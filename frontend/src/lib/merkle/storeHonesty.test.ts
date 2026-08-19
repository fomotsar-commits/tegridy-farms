// HONESTY GUARD — a manifest store that cannot answer must never produce a verdict.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT, stated exactly:
//
//   We now host the claim lists. That means the claim page's answer to "am I a
//   recipient?" depends on OUR infrastructure. The moment a store outage, an unapplied
//   migration, or a campaign we simply never hosted can render as "you are not
//   eligible", we have told a real recipient to walk away from real money — and they
//   have no way to tell our failure from their absence, because both look like an empty
//   allocation.
//
//   Absence of a manifest is not proof of ineligibility. It is not weak evidence of
//   ineligibility. It is not evidence at all.
//
// So this file walks every non-answer the server can give through the WHOLE path —
// `fetchStoredProof` → `CampaignManifest | null` → `evaluateEligibility` → the rendered
// status — and asserts the verdict comes out `unknown`, with `canClaim` false and
// `not-listed` unreachable. The two ends are tested together on purpose: each half is
// individually correct today, and the bug this guards against is a future change that
// makes a failure look like an empty list SOMEWHERE IN BETWEEN.
//
// The mirror assertion matters just as much: when the store genuinely says "this wallet
// is not in the list", `not-listed` MUST be reachable. A guard that turned every
// negative into `unknown` would be useless — it would just move the lie.

import { describe, it, expect } from 'vitest';
import { parseEther, type Address, type Hex } from 'viem';
import { buildCampaign } from './campaign';
import { evaluateEligibility, type OnChainCampaign } from './eligibility';
import { fetchStoredProof, type ManifestStoreStatus } from './manifestStore';

const CLAIMANT = '0xaaaa000000000000000000000000000000000001' as Address;
const OTHER = '0xbbbb000000000000000000000000000000000002' as Address;

/** A real campaign, so the served proof and root are real too. */
const built = buildCampaign([
  { account: CLAIMANT, amount: parseEther('10') },
  { account: OTHER, amount: parseEther('20') },
]);
const ROW = built.rows.find((r) => r.account.toLowerCase() === CLAIMANT.toLowerCase())!;

const onChain: OnChainCampaign = {
  merkleRoot: built.root,
  claimsOpen: true,
  expiresAt: Math.floor(Date.now() / 1000) + 86_400,
  claimFeeWei: 0n,
};

const CAMPAIGN = { chainId: 1, distributor: '0x5555555555555555555555555555555555555555' as Address };

const META = {
  chainId: 1,
  root: built.root,
  distributor: CAMPAIGN.distributor,
  token: '0x4444444444444444444444444444444444444444',
  recipientCount: 2,
  total: built.total.toString(),
  criteria: 'holders at block 25,900,000',
  publishedAt: '2026-08-01T00:00:00Z',
};

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const stub = (status: number, body: unknown) => (async () => response(status, body)) as unknown as typeof fetch;

/** Every shape of "we could not tell you", as the server actually emits it. */
const NON_ANSWERS: { name: string; status: number; body: unknown; expect: ManifestStoreStatus }[] = [
  {
    name: 'the deployment has no store configured',
    status: 503,
    body: { error: 'no manifest store configured', code: 'not-configured' },
    expect: 'not-configured',
  },
  {
    name: 'the migration has not been applied',
    status: 503,
    body: { error: 'tables do not exist', code: 'schema-missing', operatorStep: 'apply 018' },
    expect: 'schema-missing',
  },
  {
    name: 'we host no manifest for this campaign',
    status: 404,
    body: { error: 'no manifest stored', code: 'manifest-missing', pasteFallback: true },
    expect: 'no-manifest',
  },
  {
    name: 'the store could not be read',
    status: 502,
    body: { error: 'store unreachable', code: 'store-unreachable' },
    expect: 'unreachable',
  },
  {
    name: 'the generated proof would not verify',
    status: 500,
    body: { error: 'proof does not verify', code: 'proof-unverifiable' },
    expect: 'proof-unverifiable',
  },
  {
    name: 'the store answered with something unreadable',
    status: 200,
    body: { listed: true, manifest: null, entry: null },
    expect: 'unreachable',
  },
  {
    name: 'the store said listed but sent no usable row',
    status: 200,
    body: { listed: true, manifest: META, entry: { index: 0 } },
    expect: 'unreachable',
  },
];

describe('a store non-answer is never a verdict', () => {
  for (const c of NON_ANSWERS) {
    it(`${c.name} → status "${c.expect}", no manifest, and eligibility "unknown"`, async () => {
      const result = await fetchStoredProof(CAMPAIGN, CLAIMANT, { fetchImpl: stub(c.status, c.body) });

      expect(result.status).toBe(c.expect);
      // The load-bearing null. A synthesised empty manifest here is the whole bug.
      expect(result.manifest).toBeNull();
      expect(result.detail).toBeTruthy();

      const verdict = evaluateEligibility({
        manifest: result.manifest,
        account: CLAIMANT,
        onChain,
        claimed: false,
      });

      // THE ASSERTION. Not "not-listed", not "eligible", not a silent empty state.
      expect(verdict.status).toBe('unknown');
      expect(verdict.status).not.toBe('not-listed');
      expect(verdict.canClaim).toBe(false);
      expect(verdict.row).toBeNull();
    });

    it(`${c.name} → the wallet is never named as ineligible`, async () => {
      const result = await fetchStoredProof(CAMPAIGN, CLAIMANT, { fetchImpl: stub(c.status, c.body) });
      const verdict = evaluateEligibility({ manifest: result.manifest, account: CLAIMANT, onChain, claimed: false });

      // Prose may be rewritten freely; the claim it must not make is fixed. "eligible"
      // is allowed to appear (as in "cannot tell whether this wallet is eligible") —
      // what must not appear is a settled negative about the wallet.
      const said = `${verdict.title} ${verdict.detail} ${result.detail ?? ''}`.toLowerCase();
      expect(said).not.toMatch(/not eligible/);
      expect(said).not.toMatch(/ineligible/);
      expect(said).not.toMatch(/you are not (in|a recipient)/);
      expect(said).not.toMatch(/no allocation/);
    });
  }

  it('offers the paste fallback on every non-answer, so a claimant is never left with nothing to try', async () => {
    for (const c of NON_ANSWERS) {
      const result = await fetchStoredProof(CAMPAIGN, CLAIMANT, { fetchImpl: stub(c.status, c.body) });
      expect(result.pasteFallback, `${c.name} must offer the paste fallback`).toBe(true);
    }
  });

  it('treats a network failure the same as an explicit outage', async () => {
    const throwing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const result = await fetchStoredProof(CAMPAIGN, CLAIMANT, { fetchImpl: throwing });

    expect(result.status).toBe('unreachable');
    expect(result.manifest).toBeNull();
    expect(result.pasteFallback).toBe(true);
    const verdict = evaluateEligibility({ manifest: result.manifest, account: CLAIMANT, onChain, claimed: false });
    expect(verdict.status).toBe('unknown');
  });

  it('refuses a row served for a different wallet rather than rendering it as this one’s', async () => {
    const otherRow = built.rows.find((r) => r.account.toLowerCase() === OTHER.toLowerCase())!;
    const result = await fetchStoredProof(CAMPAIGN, CLAIMANT, {
      fetchImpl: stub(200, {
        listed: true,
        manifest: META,
        entry: {
          index: otherRow.index,
          account: otherRow.account,
          amount: otherRow.amount.toString(),
          leaf: otherRow.leaf,
          proof: otherRow.proof,
        },
      }),
    });

    // One wallet's allocation shown as another's is worse than no answer.
    expect(result.status).toBe('unreachable');
    expect(result.manifest).toBeNull();
  });
});

describe('the honest negative is still reachable', () => {
  it('reports not-listed when the store read the list and this wallet is absent', async () => {
    const result = await fetchStoredProof(CAMPAIGN, CLAIMANT, {
      fetchImpl: stub(200, {
        listed: false,
        manifest: META,
        detail: 'not among the 2 addresses',
      }),
    });

    expect(result.status).toBe('not-listed');
    // A manifest IS produced here — a list was genuinely read — but it is partial and
    // says so, so nothing downstream mistakes one row for the campaign.
    expect(result.manifest).not.toBeNull();
    expect(result.manifest!.partial).toBe(true);
    expect(result.manifest!.rows).toHaveLength(0);
    expect(result.manifest!.recipientCount).toBe(2);
    expect(result.pasteFallback).toBe(false);

    const verdict = evaluateEligibility({ manifest: result.manifest, account: CLAIMANT, onChain, claimed: false });
    expect(verdict.status).toBe('not-listed');
    expect(verdict.canClaim).toBe(false);
  });

  it('quotes the campaign size, not the number of rows it was handed', async () => {
    const result = await fetchStoredProof(CAMPAIGN, CLAIMANT, {
      fetchImpl: stub(200, { listed: false, manifest: { ...META, recipientCount: 4137 } }),
    });
    const verdict = evaluateEligibility({ manifest: result.manifest, account: CLAIMANT, onChain, claimed: false });

    // The store serves at most one row, so `rows.length` is 0 or 1 and would read as a
    // list of one address. A wallet turned away is owed the real size.
    expect(verdict.detail).toContain('4137');
    expect(verdict.detail).not.toMatch(/list of (0|1) address/);
  });

  it('carries the selection criteria into the negative verdict', async () => {
    const result = await fetchStoredProof(CAMPAIGN, CLAIMANT, {
      fetchImpl: stub(200, { listed: false, manifest: META }),
    });
    const verdict = evaluateEligibility({ manifest: result.manifest, account: CLAIMANT, onChain, claimed: false });
    expect(verdict.detail).toContain('holders at block 25,900,000');
  });
});

describe('the served proof is re-checked locally, not trusted', () => {
  it('accepts a store row whose proof verifies against the root the chain reports', async () => {
    const result = await fetchStoredProof(CAMPAIGN, CLAIMANT, {
      fetchImpl: stub(200, {
        listed: true,
        manifest: META,
        entry: {
          index: ROW.index,
          account: ROW.account,
          amount: ROW.amount.toString(),
          leaf: ROW.leaf,
          proof: ROW.proof,
        },
      }),
    });

    expect(result.status).toBe('listed');
    const verdict = evaluateEligibility({ manifest: result.manifest, account: CLAIMANT, onChain, claimed: false });
    expect(verdict.status).toBe('eligible');
    expect(verdict.canClaim).toBe(true);
    expect(verdict.row?.amount).toBe(ROW.amount);
  });

  it('rejects a store row whose proof does not verify, without calling the wallet ineligible', async () => {
    const result = await fetchStoredProof(CAMPAIGN, CLAIMANT, {
      fetchImpl: stub(200, {
        listed: true,
        manifest: META,
        // A proof element flipped in transit. The server verifies before serving, so
        // this is the tampered-response case rather than a store fault.
        entry: {
          index: ROW.index,
          account: ROW.account,
          amount: ROW.amount.toString(),
          leaf: ROW.leaf,
          proof: [`0x${'cd'.repeat(32)}` as Hex],
        },
      }),
    });

    expect(result.status).toBe('listed');
    const verdict = evaluateEligibility({ manifest: result.manifest, account: CLAIMANT, onChain, claimed: false });
    // `proof-invalid`, which names the manifest as damaged — never `not-listed`, and
    // never a claim button that could only revert.
    expect(verdict.status).toBe('proof-invalid');
    expect(verdict.canClaim).toBe(false);
  });

  it('rejects a store manifest whose root is not the root this distributor pays against', async () => {
    const result = await fetchStoredProof(CAMPAIGN, CLAIMANT, {
      fetchImpl: stub(200, {
        listed: true,
        manifest: { ...META, root: `0x${'11'.repeat(32)}` },
        entry: {
          index: ROW.index,
          account: ROW.account,
          amount: ROW.amount.toString(),
          leaf: ROW.leaf,
          proof: ROW.proof,
        },
      }),
    });

    const verdict = evaluateEligibility({ manifest: result.manifest, account: CLAIMANT, onChain, claimed: false });
    expect(verdict.status).toBe('root-mismatch');
    expect(verdict.canClaim).toBe(false);
  });
});

describe('the store is never asked for a list', () => {
  it('always names exactly one account in the request URL', async () => {
    let seen = '';
    const spy = (async (url: string) => {
      seen = String(url);
      return response(200, { listed: false, manifest: META });
    }) as unknown as typeof fetch;

    await fetchStoredProof(CAMPAIGN, CLAIMANT, { fetchImpl: spy });

    // There is no client-side way to ask for the list, because there is no parameter
    // that would mean it. A future "all" / "limit" / "offset" parameter fails here.
    expect(seen).toContain(`account=${encodeURIComponent(CLAIMANT)}`.replace('%2F', '/'));
    expect(seen.toLowerCase()).not.toMatch(/[?&](all|list|limit|offset|page)=/);
  });
});
