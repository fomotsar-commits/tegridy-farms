import { describe, it, expect, vi } from 'vitest';
import { validateMetadataUri, toFetchableUrl, toFetchableUrls, checkMetadataDocument } from './metadataUri';
import { IPFS_GATEWAYS } from '../../ipfsGateways';

const GW = (cid: string) => IPFS_GATEWAYS.map((g) => `${g}${cid}`);

// These checks exist because the launched token is created with
// AUTHORITY_IMMUTABLE — no update authority — so the metadata URI is PERMANENT.
// Everything here is about catching a mistake while it is still free.

describe('validateMetadataUri', () => {
  it('accepts the three schemes wallets actually resolve', () => {
    for (const uri of ['ipfs://bafy123', 'https://example.com/meta.json', 'ar://abc123']) {
      expect(validateMetadataUri(uri), uri).toEqual({ ok: true });
    }
  });

  it('rejects plain http:// with a reason that says why it matters', () => {
    const r = validateMetadataUri('http://example.com/meta.json');
    expect(r.ok).toBe(false);
    // Not a style preference: wallets mixed-content-block it, and it cannot be fixed later.
    expect((r as { reason: string }).reason).toMatch(/never be changed/i);
  });

  it('rejects a scheme with no path — the classic half-paste', () => {
    for (const uri of ['ipfs://', 'https://', 'ar://']) {
      expect(validateMetadataUri(uri).ok, uri).toBe(false);
    }
  });

  it('rejects empty, whitespace-only, and embedded spaces', () => {
    expect(validateMetadataUri('').ok).toBe(false);
    expect(validateMetadataUri('   ').ok).toBe(false);
    expect(validateMetadataUri('ipfs://bafy 123').ok).toBe(false);
  });

  it('rejects schemes a wallet will not resolve', () => {
    for (const uri of ['ftp://x/y', 'data:application/json,{}', 'bafy123', '/meta.json']) {
      expect(validateMetadataUri(uri).ok, uri).toBe(false);
    }
  });

  it('trims before judging, so a pasted trailing newline is not an error', () => {
    expect(validateMetadataUri('  ipfs://bafy123\n ')).toEqual({ ok: true });
  });
});

describe('toFetchableUrl', () => {
  it('maps ipfs:// and ar:// to gateways and leaves https:// alone', () => {
    expect(toFetchableUrl('ipfs://bafy123')).toBe('https://ipfs.filebase.io/ipfs/bafy123');
    expect(toFetchableUrl('ar://abc')).toBe('https://arweave.net/abc');
    expect(toFetchableUrl('https://x.com/m.json')).toBe('https://x.com/m.json');
    expect(toFetchableUrl('ftp://x')).toBeNull();
  });

  it('tries the site-wide gateway list, never a retired gateway', () => {
    expect(toFetchableUrls('ipfs://bafy123')).toEqual(GW('bafy123'));
    for (const u of toFetchableUrls('ipfs://bafy123')) {
      expect(u).not.toMatch(/\/\/(ipfs\.io|dweb\.link|cloudflare-ipfs\.com)\//);
    }
  });
});

describe('checkMetadataDocument', () => {
  const res = (body: string, init: { ok?: boolean; status?: number } = {}) =>
    ({ ok: init.ok ?? true, status: init.status ?? 200, text: async () => body }) as Response;

  it('reports ok and echoes the fields it found', async () => {
    const f = vi.fn(async () => res(JSON.stringify({ name: 'Coin', symbol: 'C', image: 'ipfs://img' })));
    await expect(checkMetadataDocument('ipfs://bafy', f as unknown as typeof fetch)).resolves.toEqual({
      status: 'ok', name: 'Coin', symbol: 'C', image: 'ipfs://img',
    });
  });

  it('calls the GATEWAY url, never the raw ipfs:// scheme', async () => {
    const f = vi.fn(async () => res('{"name":"x"}'));
    await checkMetadataDocument('ipfs://bafy', f as unknown as typeof fetch);
    expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe(GW('bafy')[0]);
  });

  it('treats an https 404 as INVALID — the host is authoritative for its own path', async () => {
    const f = vi.fn(async () => res('', { ok: false, status: 404 }));
    const v = await checkMetadataDocument('https://x/m.json', f as unknown as typeof fetch);
    expect(v.status).toBe('invalid');
  });

  it('treats an ar:// 404 as INVALID too — arweave is permanent, so absence is an answer', async () => {
    const f = vi.fn(async () => res('', { ok: false, status: 404 }));
    const v = await checkMetadataDocument('ar://abc', f as unknown as typeof fetch);
    expect(v.status).toBe('invalid');
    expect(f).toHaveBeenCalledTimes(1);
  });

  // ── the IPFS 404, which is not an answer about the content ────────────────
  //
  // A public gateway 404s for a freshly pinned CID for minutes while the
  // announcement propagates, and gateways prune and rate-limit besides. Calling
  // that "nothing is published there" blocks a launcher whose upload is fine.

  it('retries a second gateway when the first 404s, and uses what it finds', async () => {
    const f = vi.fn(async (url: string) =>
      url === GW('bafy')[0] ? res('', { ok: false, status: 404 }) : res('{"name":"real"}'),
    );
    const v = await checkMetadataDocument('ipfs://bafy', f as unknown as typeof fetch);
    expect(v).toMatchObject({ status: 'ok', name: 'real' });
    expect(f.mock.calls.map((c) => c[0])).toEqual(GW('bafy').slice(0, 2));
  });

  // 2026-09-21: ipfs.io and dweb.link were retired and answered 403 (a bot
  // challenge) and 429 instead of 404. A walk that only moved on after a 404
  // stopped at the first dead gateway and never tried a live one.
  it('moves on after a refusal, a network error or a HANG, and finds the document on the last gateway', async () => {
    const f = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      const i = GW('bafy').indexOf(url);
      if (i === 0) return Promise.resolve(res('', { ok: false, status: 403 }));
      if (i === 1) return Promise.reject(new TypeError('Failed to fetch'));
      if (i === 2) {
        return new Promise<Response>((_r, rej) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
          });
        });
      }
      return Promise.resolve(res('{"name":"real"}'));
    });
    const v = await checkMetadataDocument('ipfs://bafy', f as unknown as typeof fetch, 5000, 20);
    expect(v).toMatchObject({ status: 'ok', name: 'real' });
    expect(f.mock.calls.map((c) => c[0])).toEqual(GW('bafy'));
  });

  it('a mix of 404s and refusals is UNKNOWN, never invalid and never the propagation warning', async () => {
    const f = vi.fn(async (url: string) =>
      res('', { ok: false, status: url === GW('bafy')[0] ? 429 : 404 }),
    );
    const v = await checkMetadataDocument('ipfs://bafy', f as unknown as typeof fetch);
    expect(v.status).toBe('unknown');
    expect(v.status === 'unknown' && v.severity).toBeUndefined();
    expect(f).toHaveBeenCalledTimes(IPFS_GATEWAYS.length);
  });

  it('does NOT call an ipfs 404 invalid even when every gateway 404s', async () => {
    // The whole point: this must stay a warning the launcher reads, never a
    // block. Gateways agreeing is not proof of absence, and IPFS has no
    // authoritative "this CID does not exist" answer to give.
    const f = vi.fn(async () => res('', { ok: false, status: 404 }));
    const v = await checkMetadataDocument('ipfs://bafy', f as unknown as typeof fetch);
    expect(v.status).toBe('unknown');
    expect(v.status === 'unknown' && v.severity).toBe('warning');
    expect(v.status === 'unknown' && v.reason).toMatch(/propagated/);
    expect(f).toHaveBeenCalledTimes(IPFS_GATEWAYS.length);
  });

  it('retries a non-404 gateway failure too, and a 500 everywhere stays `unknown`', async () => {
    const f = vi.fn(async () => res('', { ok: false, status: 500 }));
    const v = await checkMetadataDocument('ipfs://bafy', f as unknown as typeof fetch);
    expect(v.status).toBe('unknown');
    expect(v.status === 'unknown' && v.severity).toBeUndefined();
    expect(f).toHaveBeenCalledTimes(IPFS_GATEWAYS.length);
  });

  it('does not retry an https:// failure: that host is authoritative', async () => {
    const f = vi.fn(async () => res('', { ok: false, status: 500 }));
    await checkMetadataDocument('https://x/m', f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('treats non-JSON and non-object JSON as invalid', async () => {
    const html = vi.fn(async () => res('<!doctype html><html>'));
    expect((await checkMetadataDocument('https://x/m', html as unknown as typeof fetch)).status).toBe('invalid');
    const arr = vi.fn(async () => res('[1,2,3]'));
    expect((await checkMetadataDocument('https://x/m', arr as unknown as typeof fetch)).status).toBe('invalid');
  });

  it('is invalid when the JSON has neither name nor image', async () => {
    const f = vi.fn(async () => res('{"description":"nope"}'));
    expect((await checkMetadataDocument('https://x/m', f as unknown as typeof fetch)).status).toBe('invalid');
  });

  // The important negative: we must never block a launch because WE could not look.
  it('degrades to UNKNOWN — not invalid — when the read fails', async () => {
    const cors = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect((await checkMetadataDocument('https://x/m', cors as unknown as typeof fetch)).status).toBe('unknown');

    const five = vi.fn(async () => res('', { ok: false, status: 503 }));
    expect((await checkMetadataDocument('https://x/m', five as unknown as typeof fetch)).status).toBe('unknown');
  });

  it('times out into UNKNOWN rather than hanging the launch button', async () => {
    const hang = vi.fn((_u: string, init?: { signal?: AbortSignal }) => new Promise<Response>((_r, rej) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
      });
    }));
    const v = await checkMetadataDocument('https://x/m', hang as unknown as typeof fetch, 10);
    expect(v).toEqual({ status: 'unknown', reason: 'The check timed out.' });
  });

  it('the overall deadline still wins over the per-gateway walk', async () => {
    const hang = vi.fn((_u: string, init?: { signal?: AbortSignal }) => new Promise<Response>((_r, rej) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
      });
    }));
    const v = await checkMetadataDocument('ipfs://bafy', hang as unknown as typeof fetch, 10, 60_000);
    expect(v).toEqual({ status: 'unknown', reason: 'The check timed out.' });
    expect(hang).toHaveBeenCalledTimes(1);
  });
});
