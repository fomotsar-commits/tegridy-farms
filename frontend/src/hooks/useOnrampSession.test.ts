// The handoff hook, pinned on its refusals.
//
// The rule, borrowed verbatim from heatClient: a failure resolves to an explicit
// `unavailable`, never to a URL. There is no partial success here — a user who follows a
// half-prepared link types a card number into a page that will reject it.
//
// The sharpest pin is the last block. The signing endpoint is trusted to APPEND a
// signature, not to CHOOSE a destination, so a signer that answers with any other host is
// treated as an outage rather than followed. That is the difference between a
// misconfiguration and sending someone about to enter payment details to an attacker.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { onrampStatus, type ConfiguredOnrampProvider } from '../lib/onramp/config';
import { useOnrampSession } from './useOnrampSession';

const EVM = '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d';
const SIGN_PATH = '/api/aggregator?resource=ramp-sign';

function configured(): { transak: ConfiguredOnrampProvider; moonpay: ConfiguredOnrampProvider } {
  vi.stubEnv('VITE_ONRAMP_TRANSAK_KEY', 'transak-key');
  vi.stubEnv('VITE_ONRAMP_TRANSAK_ENV', 'PRODUCTION');
  vi.stubEnv('VITE_ONRAMP_MOONPAY_KEY', 'pk_live_moonkey');
  vi.stubEnv('VITE_ONRAMP_MOONPAY_SIGN_URL', SIGN_PATH);
  const list = onrampStatus().providers;
  const transak = list.find((p) => p.id === 'transak');
  const moonpay = list.find((p) => p.id === 'moonpay');
  if (!transak || !moonpay) throw new Error('fixture did not configure both providers');
  return { transak, moonpay };
}

function stubFetch(impl: () => Promise<Response> | Response) {
  // Typed as `typeof fetch`, not inferred from the zero-argument `impl`:
  // inferred, `spy.mock.calls[0]` is a zero-length tuple and the request body
  // this file asserts on below is not reachable from the type system at all.
  const spy = vi.fn<typeof fetch>(async () => impl());
  vi.stubGlobal('fetch', spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('nothing is ready without somewhere to send the funds', () => {
  it('waits for an address rather than guessing one', () => {
    const { transak } = configured();
    const { result } = renderHook(() =>
      useOnrampSession({ provider: transak, chain: 'ethereum', walletAddress: undefined }),
    );
    expect(result.current.state).toEqual({ kind: 'needs-address' });
  });

  it('never claims readiness with no provider configured', () => {
    const { result } = renderHook(() =>
      useOnrampSession({ provider: null, chain: 'ethereum', walletAddress: EVM }),
    );
    expect(result.current.state.kind).toBe('needs-address');
  });

  it('says the address is unusable rather than building a URL without a destination', () => {
    const { transak } = configured();
    const { result } = renderHook(() =>
      useOnrampSession({ provider: transak, chain: 'solana', walletAddress: EVM }),
    );
    expect(result.current.state).toEqual({ kind: 'invalid-address' });
  });
});

describe('an unsigned partner needs no round-trip', () => {
  it('is ready from pure construction, with no network call', () => {
    const fetchSpy = stubFetch(() => jsonResponse({}));
    const { transak } = configured();
    const { result } = renderHook(() =>
      useOnrampSession({ provider: transak, chain: 'ethereum', walletAddress: EVM }),
    );
    expect(result.current.state.kind).toBe('ready');
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.url.startsWith('https://global.transak.com')).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('a signing partner is not ready until it has been signed', () => {
  it('does not hand out the unsigned URL', () => {
    const { moonpay } = configured();
    const { result } = renderHook(() =>
      useOnrampSession({ provider: moonpay, chain: 'ethereum', walletAddress: EVM }),
    );
    expect(result.current.state).toEqual({ kind: 'needs-preparation' });
  });

  it('fires no request until the user asks for one', () => {
    const fetchSpy = stubFetch(() => jsonResponse({}));
    const { moonpay } = configured();
    renderHook(() => useOnrampSession({ provider: moonpay, chain: 'ethereum', walletAddress: EVM }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('becomes ready on a signed URL from the partner origin', async () => {
    const signed = 'https://buy.moonpay.com/?apiKey=pk_live_moonkey&signature=abc';
    const fetchSpy = stubFetch(() => jsonResponse({ url: signed }));
    const { moonpay } = configured();
    const { result } = renderHook(() =>
      useOnrampSession({ provider: moonpay, chain: 'ethereum', walletAddress: EVM }),
    );
    act(() => result.current.prepare());
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'ready', url: signed }));
    expect(fetchSpy).toHaveBeenCalledWith(SIGN_PATH, expect.objectContaining({ method: 'POST' }));
  });

  it('sends the partner only the unsigned URL — the body may carry nothing else', async () => {
    const fetchSpy = stubFetch(() => jsonResponse({ url: 'https://buy.moonpay.com/?signature=abc' }));
    const { moonpay } = configured();
    const { result } = renderHook(() =>
      useOnrampSession({ provider: moonpay, chain: 'ethereum', walletAddress: EVM }),
    );
    act(() => result.current.prepare());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    const init = fetchSpy.mock.calls[0][1];
    expect(init?.body, 'the sign request carried no body').toBeTypeOf('string');
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body)).toEqual(['url']);
  });
});

describe('an outage is an outage, never a handoff', () => {
  async function expectUnavailable(impl: () => Promise<Response> | Response) {
    stubFetch(impl);
    const { moonpay } = configured();
    const { result } = renderHook(() =>
      useOnrampSession({ provider: moonpay, chain: 'ethereum', walletAddress: EVM }),
    );
    act(() => result.current.prepare());
    await waitFor(() => expect(result.current.state.kind).toBe('unavailable'));
    return result.current.state;
  }

  it('reports unavailable on a non-OK response', async () => {
    const state = await expectUnavailable(() => jsonResponse({ error: 'nope' }, 502));
    expect(state.kind === 'unavailable' && state.reason).toMatch(/nothing was charged/i);
  });

  it('reports unavailable on a thrown request', async () => {
    const state = await expectUnavailable(() => Promise.reject(new Error('network down')));
    expect(state.kind === 'unavailable' && state.reason).toMatch(/could not be reached/i);
  });

  it('reports unavailable on a non-JSON body', async () => {
    await expectUnavailable(() => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error('not json'); },
    } as unknown as Response));
  });

  it('reports unavailable when the answer carries no url', async () => {
    await expectUnavailable(() => jsonResponse({ signature: 'abc' }));
  });
});

describe('the signer may not choose where the user goes', () => {
  const hostile = [
    'https://attacker.example/?apiKey=x',
    'https://buy.moonpay.com.attacker.example/?apiKey=x',
    'http://buy.moonpay.com/?apiKey=x',
    'https://global.transak.com/?apiKey=x',
    'javascript:alert(1)',
  ];

  for (const url of hostile) {
    it(`refuses to open ${url}`, async () => {
      stubFetch(() => jsonResponse({ url }));
      const { moonpay } = configured();
      const { result } = renderHook(() =>
        useOnrampSession({ provider: moonpay, chain: 'ethereum', walletAddress: EVM }),
      );
      act(() => result.current.prepare());
      await waitFor(() => expect(result.current.state.kind).toBe('unavailable'));
      const state = result.current.state;
      expect(state.kind === 'unavailable' && state.reason).toMatch(/unexpected destination/i);
    });
  }
});

describe('an answer belongs to the inputs it was prepared for', () => {
  it('drops a signed URL when the partner changes underneath it', async () => {
    stubFetch(() => jsonResponse({ url: 'https://buy.moonpay.com/?signature=abc' }));
    const { transak, moonpay } = configured();
    const { result, rerender } = renderHook(
      (props: { provider: ConfiguredOnrampProvider }) =>
        useOnrampSession({ provider: props.provider, chain: 'ethereum', walletAddress: EVM }),
      { initialProps: { provider: moonpay } },
    );
    act(() => result.current.prepare());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    rerender({ provider: transak });
    const state = result.current.state;
    expect(state.kind).toBe('ready');
    expect(state.kind === 'ready' && state.url.startsWith('https://global.transak.com')).toBe(true);
  });

  it('drops a signed URL when the destination address changes underneath it', async () => {
    stubFetch(() => jsonResponse({ url: 'https://buy.moonpay.com/?signature=abc' }));
    const { moonpay } = configured();
    const other = '0x6d5791A660e79175F74C6D639584C98422d5956E';
    const { result, rerender } = renderHook(
      (props: { walletAddress: string }) =>
        useOnrampSession({ provider: moonpay, chain: 'ethereum', walletAddress: props.walletAddress }),
      { initialProps: { walletAddress: EVM } },
    );
    act(() => result.current.prepare());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    rerender({ walletAddress: other });
    expect(result.current.state).toEqual({ kind: 'needs-preparation' });
  });
});

describe('the hook opens no windows of its own', () => {
  it('never navigates — the handoff is a link the user clicks', async () => {
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    stubFetch(() => jsonResponse({ url: 'https://buy.moonpay.com/?signature=abc' }));
    const { moonpay } = configured();
    const { result } = renderHook(() =>
      useOnrampSession({ provider: moonpay, chain: 'ethereum', walletAddress: EVM }),
    );
    act(() => result.current.prepare());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    expect(openSpy).not.toHaveBeenCalled();
  });
});
