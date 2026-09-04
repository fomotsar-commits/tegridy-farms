import { describe, it, expect } from 'vitest';
import { geckoPoolsMultiUrl, geckoPoolsUrl } from '../geckoTerminal/pools';
import {
  DEFAULT_TERMINAL_PARAMS,
  parseTerminalParams,
  serializeTerminalParams,
} from './terminalParams';

// The query string is the one part of this page an attacker writes directly, and
// the network slug is interpolated into a GeckoTerminal path — where a wrong
// slug is a silent 404 rather than an error. So the union is the boundary, and
// these tests are about what CANNOT get through it.

function parse(qs: string) {
  return parseTerminalParams(new URLSearchParams(qs));
}

describe('closed unions with a fallback', () => {
  it('falls back rather than passing an unknown value through', () => {
    expect(parse('net=foo').network).toBe('eth');
    expect(parse('view=bar').view).toBe('new');
    expect(parse('').network).toBe(DEFAULT_TERMINAL_PARAMS.network);
    expect(parse('').view).toBe(DEFAULT_TERMINAL_PARAMS.view);
  });

  it('accepts exactly the three networks and the five views', () => {
    expect(parse('net=base').network).toBe('base');
    expect(parse('net=solana').network).toBe('solana');
    // 'ethereum' is this app's own word for that chain everywhere else, and it
    // is NOT GeckoTerminal's slug. Letting it through would 404 at the upstream
    // and render as an outage.
    expect(parse('net=ethereum').network).toBe('eth');
    for (const v of ['new', 'trending', 'island', 'watchlist', 'indexer']) {
      expect(parse(`view=${v}`).view).toBe(v);
    }
  });

  it('refuses a network value shaped to reshape a request path', () => {
    // The mutation: `network: rawNet ?? 'eth'`. Every one of these would then
    // reach geckoPoolsUrl and change which endpoint is called.
    for (const hostile of ['eth/../../tokens', 'eth?x=1', '../solana', 'eth%2F..']) {
      expect(parse(`net=${encodeURIComponent(hostile)}`).network).toBe('eth');
    }
  });
});

describe('?pool= is a lookup key, never a request ingredient', () => {
  it('is returned verbatim so it can be compared against fetched row keys', () => {
    expect(parse('pool=eth:0xabc').pool).toBe('eth:0xabc');
  });

  it('is dropped when absent or absurdly long', () => {
    expect(parse('').pool).toBeNull();
    expect(parse('pool=%20%20').pool).toBeNull();
    expect(parse(`pool=${'a'.repeat(200)}`).pool).toBeNull();
  });

  it('cannot reach a URL builder — the builders take a network and validated addresses only', () => {
    // This is the structural pin behind the claim. `parseTerminalParams` has no
    // path to either builder: the network argument is a closed union (a hostile
    // string cannot become one) and the address argument is re-validated inside
    // `geckoPoolsMultiUrl`, which silently omits anything that is not an address
    // for that network. A mutation that interpolated `pool` raw would have to
    // defeat both.
    const hostile = '../../search/pools?query=x';
    expect(geckoPoolsUrl(parse(`net=${encodeURIComponent(hostile)}`).network, 'new')).toBe(
      'https://api.geckoterminal.com/api/v2/networks/eth/new_pools',
    );
    expect(geckoPoolsMultiUrl('eth', [hostile])).toBe(
      'https://api.geckoterminal.com/api/v2/networks/eth/pools/multi/',
    );
    expect(geckoPoolsMultiUrl('eth', [hostile])).not.toContain('search');
  });
});

describe('share links round-trip', () => {
  it('omits defaults so the common URL stays bare', () => {
    expect(serializeTerminalParams({ network: 'eth', view: 'new', pool: null }).toString()).toBe('');
  });

  it('writes only the choices actually made, and survives a round trip', () => {
    const params = { network: 'solana' as const, view: 'trending' as const, pool: 'solana:abc' };
    const round = parseTerminalParams(serializeTerminalParams(params));
    expect(round).toEqual(params);
  });

  it('a round trip cannot smuggle a value back in', () => {
    // Only values that survived the unions are ever serialised, so the output of
    // serialize() re-parses to itself for every reachable input.
    const parsed = parse('net=nonsense&view=nonsense&pool=x');
    expect(parseTerminalParams(serializeTerminalParams(parsed))).toEqual(parsed);
  });
});
