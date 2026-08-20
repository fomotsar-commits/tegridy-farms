// The degradation contract: an unread store never renders as an empty one.

import { describe, it, expect, vi } from 'vitest';
import { claimLinkCode, coerceLink, listLinks, revokeLinkById } from './botLinkClient';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const ID = '11111111-2222-4333-8444-555555555555';

describe('listLinks', () => {
  it('returns rows when the store answers', async () => {
    const fetchImpl = vi.fn(async () =>
      response(200, { links: [{ id: ID, linked_at: '2026-08-01T00:00:00.000Z' }] }),
    );
    const result = await listLinks({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.status).toBe('ready');
    expect(result.links).toEqual([{ id: ID, linkedAt: Math.floor(Date.parse('2026-08-01T00:00:00.000Z') / 1000) }]);
  });

  it('an empty READY list is an answer and stays empty', async () => {
    const fetchImpl = vi.fn(async () => response(200, { links: [] }));
    const result = await listLinks({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.status).toBe('ready');
    expect(result.detail).toBeNull();
  });

  it('a network failure is unreachable, and says it is not a statement about your chats', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const result = await listLinks({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.status).toBe('unreachable');
    expect(result.links).toEqual([]);
    expect(result.detail).toMatch(/nothing here says you have none/i);
  });

  it('separates a missing migration from a missing variable, and carries the step', async () => {
    // The two need different people to do different things. Collapsing them sends
    // whoever is on call to the wrong place.
    const schema = await listLinks({
      fetchImpl: (async () =>
        response(503, { error: 'table missing', code: 'schema-missing', operatorStep: 'apply 020' })) as unknown as typeof fetch,
    });
    expect(schema.status).toBe('schema-missing');
    expect(schema.operatorStep).toBe('apply 020');

    const config = await listLinks({
      fetchImpl: (async () => response(503, { error: 'no store', code: 'not-configured' })) as unknown as typeof fetch,
    });
    expect(config.status).toBe('not-configured');
  });

  it('401 is signed-out, not an empty list', async () => {
    const result = await listLinks({
      fetchImpl: (async () => response(401, { error: 'Not authenticated' })) as unknown as typeof fetch,
    });
    expect(result.status).toBe('signed-out');
    expect(result.links).toEqual([]);
  });

  it('a 200 with the wrong shape is unreachable rather than an empty answer', async () => {
    const result = await listLinks({
      fetchImpl: (async () => response(200, { nope: true })) as unknown as typeof fetch,
    });
    expect(result.status).toBe('unreachable');
  });

  it('sends the SIWE cookie — bindings are per-wallet and unreadable without it', async () => {
    const fetchImpl = vi.fn(async () => response(200, { links: [] }));
    await listLinks({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
  });
});

describe('coerceLink drops rather than repairs', () => {
  it('rejects a row with no usable id, so no revoke button points at nothing', () => {
    expect(coerceLink({ id: 'not-a-uuid' })).toBeNull();
    expect(coerceLink({})).toBeNull();
    expect(coerceLink(null)).toBeNull();
  });

  it('keeps a row whose timestamp is unparseable, and marks the time as unknown', () => {
    // The BINDING is the fact that matters and it is present. Dropping the row
    // because a date did not parse would hide a live binding from its owner.
    expect(coerceLink({ id: ID, linked_at: 'nonsense' })).toEqual({ id: ID, linkedAt: 0 });
  });
});

describe('claimLinkCode', () => {
  it('rejects a malformed code locally without spending a request', async () => {
    const fetchImpl = vi.fn();
    const result = await claimLinkCode('nope', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.status).toBe('code-not-open');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('normalises case before sending, because a code is read off a phone', async () => {
    const fetchImpl = vi.fn(async () => response(201, { linked: true }));
    await claimLinkCode('abcdefghjk', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toEqual({
      action: 'claim',
      code: 'ABCDEFGHJK',
    });
  });

  it('reports an expired or spent code as its own outcome', async () => {
    const result = await claimLinkCode('ABCDEFGHJK', {
      fetchImpl: (async () =>
        response(404, { error: 'That code is not open.', code: 'code-not-open' })) as unknown as typeof fetch,
    });
    expect(result.status).toBe('code-not-open');
  });

  it('says the chat was NOT linked when the store could not be reached', async () => {
    // Never optimistic. A user who believes the link landed stops trying.
    const result = await claimLinkCode('ABCDEFGHJK', {
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/NOT linked/);
  });

  it('explains the signed-out case in terms of the signature that is missing', async () => {
    const result = await claimLinkCode('ABCDEFGHJK', {
      fetchImpl: (async () => response(401, { error: 'Not authenticated' })) as unknown as typeof fetch,
    });
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/your signature/i);
  });
});

describe('revokeLinkById', () => {
  it('reports the store’s verdict, not an optimistic one', async () => {
    const result = await revokeLinkById(ID, {
      fetchImpl: (async () => response(502, { error: 'The binding was not removed. It is still in place.' })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, detail: 'The binding was not removed. It is still in place.' });
  });

  it('says the binding is still in place when it could not ask', async () => {
    const result = await revokeLinkById(ID, {
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, detail: expect.stringMatching(/still in place/i) });
  });

  it('confirms only on a real success', async () => {
    const result = await revokeLinkById(ID, {
      fetchImpl: (async () => response(200, { removed: 1 })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true });
  });
});
