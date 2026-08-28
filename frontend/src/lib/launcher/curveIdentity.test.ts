// Pins for the curve-identity binding: the write-side metadata/tags shape, and
// the read-side resolver whose owner check IS the spoof defence — the test
// feeding a wrong-owner node must go red if that check is ever dropped.

import { describe, it, expect, vi } from 'vitest';
import {
  IDENTITY_APP_NAME,
  IDENTITY_GRAPHQL_ENDPOINT,
  IDENTITY_IMAGE_MAX_BYTES,
  TAG_CHAIN_ID,
  TAG_TOKEN,
  arweaveTxIdFrom,
  buildIdentityMetadata,
  identityTags,
  parseIdentityMetadata,
  resolveCurveIdentity,
  validateIdentityImage,
} from './curveIdentity';

const TOKEN = '0xAbCd000000000000000000000000000000001234';
const CREATOR = '0x14898258122C0740106391E6e8E4F17F3b6d456E';
const CHAIN = 8453;
const TX_ID = 'A'.repeat(43);
const IMG_ID = 'B'.repeat(43);

const draft = {
  name: 'Towelie Jr',
  symbol: 'TWLJR',
  description: '  a fine coin  ',
  website: 'https://example.com/x',
  twitter: '@towelie',
  telegram: 'towelie_tg',
};

function goodBody() {
  return {
    version: 1,
    token: TOKEN.toLowerCase(),
    chainId: CHAIN,
    name: 'Towelie Jr',
    symbol: 'TWLJR',
    image: `ar://${IMG_ID}`,
    description: 'a fine coin',
    website: 'https://example.com/x',
    twitter: 'towelie',
    telegram: 'towelie_tg',
  };
}

/** fetch mock: first call = GraphQL, second = the metadata body. */
function fetchSeq(graphqlPayload: unknown, body?: unknown, opts?: { graphqlOk?: boolean; bodyOk?: boolean }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return {
        ok: opts?.graphqlOk ?? true,
        json: async () => graphqlPayload,
      } as Response;
    }
    return {
      ok: opts?.bodyOk ?? true,
      json: async () => body,
    } as Response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function edges(id: string, address: string) {
  return { data: { transactions: { edges: [{ node: { id, address } }] } } };
}

describe('image validation', () => {
  it('accepts a small png and rejects oversize / wrong mime / empty', () => {
    expect(validateIdentityImage({ size: 10_000, type: 'image/png' })).toBeNull();
    expect(validateIdentityImage({ size: IDENTITY_IMAGE_MAX_BYTES + 1, type: 'image/png' })).toMatch(/KB/);
    expect(validateIdentityImage({ size: 10_000, type: 'image/svg+xml' })).toMatch(/PNG/);
    expect(validateIdentityImage({ size: 0, type: 'image/png' })).toMatch(/empty/);
  });
});

describe('write side — tags and metadata', () => {
  it('binds tags to app + lowercased token + chain id', () => {
    const tags = identityTags(TOKEN, CHAIN);
    expect(tags).toContainEqual({ name: 'App-Name', value: IDENTITY_APP_NAME });
    expect(tags).toContainEqual({ name: TAG_TOKEN, value: TOKEN.toLowerCase() });
    expect(tags).toContainEqual({ name: TAG_CHAIN_ID, value: String(CHAIN) });
  });

  it('builds metadata with trimmed fields, ar:// image, and drops junk socials', () => {
    const meta = buildIdentityMetadata({ token: TOKEN, chainId: CHAIN, imageTxId: IMG_ID, draft });
    expect(meta.token).toBe(TOKEN.toLowerCase());
    expect(meta.image).toBe(`ar://${IMG_ID}`);
    expect(meta.description).toBe('a fine coin');
    expect(meta.twitter).toBe('towelie'); // @ stripped
    expect(meta.website).toBe('https://example.com/x');

    const junk = buildIdentityMetadata({
      token: TOKEN,
      chainId: CHAIN,
      imageTxId: IMG_ID,
      draft: { ...draft, website: 'http://insecure.example', twitter: 'has spaces!', telegram: '' },
    });
    expect(junk.website).toBeUndefined(); // http:// rejected
    expect(junk.twitter).toBeUndefined();
    expect(junk.telegram).toBeUndefined();
  });
});

describe('arweaveTxIdFrom', () => {
  it('accepts ar:// and bare 43-char ids, rejects anything else', () => {
    expect(arweaveTxIdFrom(`ar://${TX_ID}`)).toBe(TX_ID);
    expect(arweaveTxIdFrom(TX_ID)).toBe(TX_ID);
    expect(arweaveTxIdFrom(`ar://${TX_ID}/`)).toBe(TX_ID);
    expect(arweaveTxIdFrom('ar://short')).toBeNull();
    expect(arweaveTxIdFrom(`https://evil.example/${TX_ID}`)).toBeNull();
    expect(arweaveTxIdFrom(42)).toBeNull();
  });
});

describe('parseIdentityMetadata', () => {
  it('accepts a well-formed body and builds the https image URL', () => {
    const id = parseIdentityMetadata(goodBody(), { token: TOKEN, chainId: CHAIN });
    expect(id).not.toBeNull();
    expect(id!.imageUrl).toBe(`https://arweave.net/${IMG_ID}`);
    expect(id!.name).toBe('Towelie Jr');
  });

  it('rejects a body claiming a different token or chain', () => {
    expect(parseIdentityMetadata({ ...goodBody(), token: '0x' + '9'.repeat(40) }, { token: TOKEN, chainId: CHAIN })).toBeNull();
    expect(parseIdentityMetadata({ ...goodBody(), chainId: 1 }, { token: TOKEN, chainId: CHAIN })).toBeNull();
  });

  it('rejects a non-arweave image and out-of-bounds name/symbol', () => {
    expect(parseIdentityMetadata({ ...goodBody(), image: 'https://evil.example/x.png' }, { token: TOKEN, chainId: CHAIN })).toBeNull();
    expect(parseIdentityMetadata({ ...goodBody(), name: 'x'.repeat(65) }, { token: TOKEN, chainId: CHAIN })).toBeNull();
    expect(parseIdentityMetadata({ ...goodBody(), symbol: '' }, { token: TOKEN, chainId: CHAIN })).toBeNull();
  });

  it('drops invalid socials without rejecting the identity', () => {
    const id = parseIdentityMetadata(
      { ...goodBody(), website: 'javascript:alert(1)', twitter: 'bad handle' },
      { token: TOKEN, chainId: CHAIN },
    );
    expect(id).not.toBeNull();
    expect(id!.website).toBeUndefined();
    expect(id!.twitter).toBeUndefined();
    expect(id!.telegram).toBe('towelie_tg');
  });
});

describe('resolveCurveIdentity', () => {
  it('queries the Irys gateway with owners + binding tags and resolves', async () => {
    const { fn, calls } = fetchSeq(edges(TX_ID, CREATOR), goodBody());
    const res = await resolveCurveIdentity({ token: TOKEN, chainId: CHAIN, creator: CREATOR }, fn);
    expect(res.status).toBe('ok');
    expect(calls[0]!.url).toBe(IDENTITY_GRAPHQL_ENDPOINT);
    const sent = JSON.parse(String(calls[0]!.init?.body));
    expect(sent.variables.owners).toContain(CREATOR);
    expect(JSON.stringify(sent.variables.tags)).toContain(TOKEN.toLowerCase());
    expect(calls[1]!.url).toBe(`https://arweave.net/${TX_ID}`);
  });

  it('SPOOF DEFENCE: a node signed by anyone but the creator never resolves', async () => {
    const stranger = '0x' + '1'.repeat(40);
    const { fn } = fetchSeq(edges(TX_ID, stranger), goodBody());
    const res = await resolveCurveIdentity({ token: TOKEN, chainId: CHAIN, creator: CREATOR }, fn);
    expect(res.status).toBe('invalid');
  });

  it('owner match is case-insensitive (gateway may lowercase addresses)', async () => {
    const { fn } = fetchSeq(edges(TX_ID, CREATOR.toLowerCase()), goodBody());
    const res = await resolveCurveIdentity({ token: TOKEN, chainId: CHAIN, creator: CREATOR }, fn);
    expect(res.status).toBe('ok');
  });

  it('no edges → none; malformed body → invalid; network failure → error', async () => {
    const none = await resolveCurveIdentity(
      { token: TOKEN, chainId: CHAIN, creator: CREATOR },
      fetchSeq({ data: { transactions: { edges: [] } } }).fn,
    );
    expect(none.status).toBe('none');

    const invalid = await resolveCurveIdentity(
      { token: TOKEN, chainId: CHAIN, creator: CREATOR },
      fetchSeq(edges(TX_ID, CREATOR), { nonsense: true }).fn,
    );
    expect(invalid.status).toBe('invalid');

    const err = await resolveCurveIdentity(
      { token: TOKEN, chainId: CHAIN, creator: CREATOR },
      (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    );
    expect(err.status).toBe('error');

    const http500 = await resolveCurveIdentity(
      { token: TOKEN, chainId: CHAIN, creator: CREATOR },
      fetchSeq(edges(TX_ID, CREATOR), goodBody(), { graphqlOk: false }).fn,
    );
    expect(http500.status).toBe('error');
  });
});
