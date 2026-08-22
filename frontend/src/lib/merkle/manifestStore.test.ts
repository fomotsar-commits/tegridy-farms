// The creator half of the manifest-store client: publish, and attach after funding.
//
// The read half's degradation contract is pinned by storeHonesty.test.ts, which walks it
// end-to-end into the eligibility verdict. This file covers what the CREATOR is told,
// where the failure mode is different but no less expensive:
//
//   A creator who believes their list is hosted, and funds a campaign on that belief,
//   has funded a campaign whose claimants will find nothing. So `ok: true` must mean the
//   store confirmed what it stored, and every other outcome must say plainly that
//   nothing was published — while still handing back the root, because the root is a
//   fact about their CSV and stays valid whether or not we managed to host it.

import { describe, it, expect } from 'vitest';
import { parseEther, type Address } from 'viem';
import { buildCampaign } from './campaign';
import { attachDistributor, publishManifest } from './manifestStore';

const A = '0xaaaa000000000000000000000000000000000001' as Address;
const B = '0xbbbb000000000000000000000000000000000002' as Address;
const DISTRIBUTOR = '0x5555555555555555555555555555555555555555' as Address;
const TOKEN = '0x4444444444444444444444444444444444444444' as Address;

const built = buildCampaign([
  { account: A, amount: parseEther('10') },
  { account: B, amount: parseEther('20') },
]);

const META = {
  chainId: 1,
  root: built.root,
  distributor: null,
  token: TOKEN,
  recipientCount: 2,
  total: built.total.toString(),
  criteria: 'holders at block 25,900,000',
  publishedAt: '2026-08-01T00:00:00Z',
};

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const PUBLISH_INPUT = {
  chainId: 1,
  token: TOKEN,
  criteria: 'holders at block 25,900,000',
  entries: built.rows.map((r) => ({ account: r.account, amount: r.amount.toString() })),
};

describe('publishManifest', () => {
  it('sends base-unit amounts as strings, never as JSON numbers', async () => {
    let sentBody = '';
    const spy = (async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return response(201, { manifest: META, root: built.root });
    }) as unknown as typeof fetch;

    await publishManifest(PUBLISH_INPUT, { fetchImpl: spy });

    const parsed = JSON.parse(sentBody);
    expect(parsed.action).toBe('publish');
    for (const entry of parsed.entries) {
      // A uint256 does not survive an IEEE-754 double. An amount that arrives as a
      // number is an amount that may already be wrong.
      expect(typeof entry.amount).toBe('string');
    }
    // Pin the actual value too, so a "harmless" Number() somewhere upstream is caught
    // rather than merely being the right type.
    expect(parsed.entries.map((e: { amount: string }) => e.amount)).toEqual(
      built.rows.map((r) => r.amount.toString()),
    );
  });

  it('returns the root the STORE reported, which is the number the creator commits', async () => {
    const spy = (async () => response(201, { manifest: META, root: built.root })) as unknown as typeof fetch;
    const result = await publishManifest(PUBLISH_INPUT, { fetchImpl: spy });

    expect(result.ok).toBe(true);
    expect(result.root).toBe(built.root);
    expect(result.meta?.recipientCount).toBe(2);
    expect(result.detail).toBeNull();
  });

  it('reports NOT ok when the store confirmed nothing it can read back', async () => {
    // 201 with an unreadable record. The list may or may not be stored; what is certain
    // is that we cannot confirm the stored root, so `ok` must not claim we can.
    const spy = (async () => response(201, { manifest: { root: 'nope' }, root: built.root })) as unknown as typeof fetch;
    const result = await publishManifest(PUBLISH_INPUT, { fetchImpl: spy });

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/unconfirmed/i);
  });

  it('keeps the root on a failure, because the root is a fact about the CSV', async () => {
    const spy = (async () =>
      response(503, {
        error: 'tables do not exist',
        code: 'schema-missing',
        operatorStep: 'apply 018_airdrop_manifests.sql',
        root: built.root,
      })) as unknown as typeof fetch;
    const result = await publishManifest(PUBLISH_INPUT, { fetchImpl: spy });

    expect(result.ok).toBe(false);
    // Still handed back: the creator can fund this campaign and publish the JSON
    // themselves. Losing the root here would make our outage cost them the campaign.
    expect(result.root).toBe(built.root);
    expect(result.operatorStep).toMatch(/018_airdrop_manifests\.sql/);
    expect(result.detail).toBeTruthy();
  });

  it('surfaces an already-published list as a conflict rather than as a success or a loss', async () => {
    const spy = (async () =>
      response(409, {
        error: 'already published',
        code: 'already-published',
        root: built.root,
      })) as unknown as typeof fetch;
    const result = await publishManifest(PUBLISH_INPUT, { fetchImpl: spy });

    expect(result.ok).toBe(false);
    expect(result.alreadyPublished).toBe(true);
    expect(result.root).toBe(built.root);
  });

  it('says nothing was published when the store is unreachable', async () => {
    const throwing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const result = await publishManifest(PUBLISH_INPUT, { fetchImpl: throwing });

    expect(result.ok).toBe(false);
    expect(result.root).toBeNull();
    expect(result.detail).toMatch(/nothing was published/i);
    // The instruction that keeps a funded campaign claimable.
    expect(result.detail).toMatch(/keep your manifest/i);
  });

  it('never reports ok on a non-2xx, whatever the body says', async () => {
    for (const status of [400, 401, 409, 413, 500, 502, 503]) {
      const spy = (async () => response(status, { manifest: META, root: built.root })) as unknown as typeof fetch;
      const result = await publishManifest(PUBLISH_INPUT, { fetchImpl: spy });
      expect(result.ok, `status ${status} must not read as published`).toBe(false);
    }
  });
});

describe('attachDistributor', () => {
  it('posts the attach action with the root and the campaign address', async () => {
    let sentBody = '';
    const spy = (async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return response(200, { manifest: { ...META, distributor: DISTRIBUTOR } });
    }) as unknown as typeof fetch;

    const result = await attachDistributor({ chainId: 1, root: built.root, distributor: DISTRIBUTOR }, { fetchImpl: spy });

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(sentBody);
    expect(parsed).toMatchObject({ action: 'attach', chainId: 1, root: built.root, distributor: DISTRIBUTOR });
  });

  it('reports the refusal when the store declines to overwrite an existing attachment', async () => {
    const spy = (async () =>
      response(409, { error: 'an address is already recorded', code: 'attach-refused' })) as unknown as typeof fetch;
    const result = await attachDistributor({ chainId: 1, root: built.root, distributor: DISTRIBUTOR }, { fetchImpl: spy });

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/already recorded/);
  });

  it('does not report success when the store could not be reached', async () => {
    const throwing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const result = await attachDistributor({ chainId: 1, root: built.root, distributor: DISTRIBUTOR }, { fetchImpl: throwing });

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/not recorded/i);
  });
});
