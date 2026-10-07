// @vitest-environment node
//
// Where Buy sends a trade, and the sentence that says so. Our pool wins a tie and nothing
// short of one; a read that did not finish is never said as "no pool"; and no line claims a
// trade went anywhere before it was sent.
import { describe, expect, it } from 'vitest';
import { OWN_EXCLUDED, type OwnCandidate, type OwnQuotes } from './ownPools';
import { chooseVenue, routeSentence, standingSentence, type JupiterSide, type OwnSend, type OwnSide } from './venueChoice';

const cand = (out: bigint): OwnCandidate => ({ view: { address: 'PooL1' }, quote: { outAmount: out } }) as unknown as OwnCandidate;
const quotes = (over: Partial<OwnQuotes> = {}): OwnSide => ({ kind: 'ok', quotes: { found: 1, gaps: [], best: cand(1_000_000n), excluded: [], ...over } });
const jup = (out: bigint, feeBps: number | null = 50): JupiterSide => ({ kind: 'route', outAmount: out, feeBps });
const YES: OwnSend = { kind: 'yes' };
const OFF: OwnSend = { kind: 'no', reason: 'trades in our pools are switched off on this page' };

describe('chooseVenue', () => {
  it('Jupiter quoting one raw unit more takes it; a tie is ours', () => {
    expect(chooseVenue(jup(1_000_001n), quotes(), YES)).toEqual({ venue: 'jupiter' });
    expect(chooseVenue(jup(1_000_000n, null), quotes(), YES)).toEqual({ venue: 'own', best: cand(1_000_000n), edge: 0, closeCall: false });
  });

  it('our pool beating the fee-bearing quote by less than the site fee is a close call; by more, it is not', () => {
    // 0.5% fee: 1,000,000 beats 996,000 by 0.4%, inside the fee; 990,000 by 1%, outside it.
    expect(chooseVenue(jup(996_000n), quotes(), YES)).toMatchObject({ venue: 'own', closeCall: true });
    expect(chooseVenue(jup(990_000n), quotes(), YES)).toMatchObject({ venue: 'own', closeCall: false });
    // A quote with no site fee in it has nothing to swing.
    expect(chooseVenue(jup(999_999n, null), quotes(), YES)).toMatchObject({ venue: 'own', closeCall: false });
  });

  it('waits while either side is still being read', () => {
    expect(chooseVenue({ kind: 'pending' }, quotes(), YES)).toEqual({ venue: 'wait' });
    expect(chooseVenue(jup(1n), { kind: 'pending' }, YES)).toEqual({ venue: 'wait' });
    expect(chooseVenue(jup(1n), quotes(), { kind: 'checking' })).toEqual({ venue: 'wait' });
  });

  it("with no pool of ours that quotes, it is Jupiter's when Jupiter has a route, else nothing", () => {
    for (const own of [{ kind: 'absent' }, { kind: 'not-a-pair' }, { kind: 'unread' }, quotes({ best: null, found: 0 })] as OwnSide[]) {
      expect(chooseVenue(jup(5n), own, YES)).toEqual({ venue: 'jupiter' });
      expect(chooseVenue({ kind: 'no-route' }, own, YES)).toEqual({ venue: 'none' });
    }
  });

  it('Jupiter with no route: our pool takes it; Jupiter unavailable: nothing, because nothing was compared', () => {
    expect(chooseVenue({ kind: 'no-route' }, quotes(), YES)).toEqual({ venue: 'own', best: cand(1_000_000n), edge: null, closeCall: false });
    expect(chooseVenue({ kind: 'unavailable' }, quotes(), YES)).toEqual({ venue: 'none' });
  });

  it('our pool winning but unable to send from here: Jupiter when it has a route, else nothing', () => {
    expect(chooseVenue(jup(900_000n), quotes(), OFF)).toEqual({ venue: 'jupiter' });
    expect(chooseVenue({ kind: 'no-route' }, quotes(), OFF)).toEqual({ venue: 'none' });
  });
});

describe('routeSentence', () => {
  it.each<[string, JupiterSide, OwnSide, OwnSend, string]>([
    ['our pool wins', jup(900_000n, null), quotes(), YES, 'Our pool quotes 11.111% more than Jupiter, so Buy sends it to our pool.'],
    ['a tie', jup(1_000_000n, null), quotes(), YES, 'Our pool and Jupiter quote the same for this trade, so Buy sends it to our pool.'],
    ['a tie with a quote that carries the site fee', jup(1_000_000n), quotes(), YES, "Our pool quotes the same as Jupiter's quote, which includes this site's fee. Buy asks Jupiter again first: if Jupiter would pay more, nothing is sent and its quote is shown."],
    ['a close call', jup(996_000n), quotes(), YES, "Our pool quotes 0.402% more than Jupiter's quote, which includes this site's fee. Buy asks Jupiter again first: if Jupiter would pay more, nothing is sent and its quote is shown."],
    ['Jupiter wins', jup(1_010_000n), quotes(), YES, 'Jupiter quotes 1% more than our pool, so Buy sends this trade to Jupiter.'],
    ['an edge too small to print', jup(999_999_999n, null), quotes({ best: cand(1_000_000_000n) }), YES, 'Our pool quotes a little more than Jupiter, so Buy sends it to our pool.'],
    ['ours wins but cannot send', jup(900_000n), quotes(), OFF, 'Our pool quotes 11.111% more than Jupiter, but trades in our pools are switched off on this page, so Buy sends this trade to Jupiter.'],
    ['ours wins, wallet being checked', jup(900_000n), quotes(), { kind: 'checking' }, 'Our pool quotes 11.111% more than Jupiter. Checking this wallet can trade in our pool…'],
    ['Jupiter has no route', { kind: 'no-route' }, quotes(), YES, 'Jupiter has no route for this trade, and our pool quotes it, so Buy sends it to our pool.'],
    ['Jupiter has no route, ours cannot send', { kind: 'no-route' }, quotes(), OFF, 'Jupiter has no route for this trade, and our pool quotes it, but trades in our pools are switched off on this page, so it cannot be made here right now.'],
    ['Jupiter unavailable', { kind: 'unavailable' }, quotes(), YES, "Jupiter could not be asked for a quote just now, so our pool's quote cannot be checked against it. Nothing is sent until it can."],
    ['Jupiter pending', { kind: 'pending' }, quotes(), YES, 'Our pool quotes this trade. Checking Jupiter…'],
    ['both pending', { kind: 'pending' }, { kind: 'pending' }, YES, 'Checking our pools and Jupiter for this trade…'],
    ['ours pending', jup(1n), { kind: 'pending' }, YES, 'Checking our pools for this trade…'],
  ])('%s', (_name, j, o, s, text) => {
    expect(routeSentence(j, o, s)).toBe(text);
  });

  it.each<[string, OwnSide, string]>([
    ['a complete search that found none', quotes({ best: null, found: 0 }), 'We have no pool for this pair, so Buy sends this trade to Jupiter.'],
    [
      'a search that did not finish',
      quotes({ best: null, found: 0, gaps: ['our pool index could not be read (HTTP 502)'] }),
      'No pool of ours was found for this pair, but the search did not finish (our pool index could not be read (HTTP 502)), so Buy sends this trade to Jupiter.',
    ],
    ['our pools could not be read', { kind: 'unread' }, 'Our pools could not be read just now, so Buy sends this trade to Jupiter.'],
    ['one pool that cannot fill', quotes({ best: null, excluded: [{ address: 'P', reason: 'one of its vaults is frozen' }] }), 'Our pool for this pair cannot take this trade: one of its vaults is frozen, so Buy sends this trade to Jupiter.'],
    [
      'two that cannot',
      quotes({ best: null, found: 2, excluded: [{ address: 'P', reason: 'one of its vaults is frozen' }, { address: 'Q', reason: 'it pays nothing for this amount' }] }),
      'None of our 2 pools for this pair can take this trade: one of its vaults is frozen; it pays nothing for this amount, so Buy sends this trade to Jupiter.',
    ],
    [
      'pools that cannot fill, after a search that did not finish',
      quotes({ best: null, gaps: ['one of our pools could not be read'], excluded: [{ address: 'P', reason: 'it pays nothing for this amount' }] }),
      'Our pool for this pair cannot take this trade: it pays nothing for this amount, and the search did not finish (one of our pools could not be read), so Buy sends this trade to Jupiter.',
    ],
    [
      'a token this site trades only through Jupiter',
      quotes({ best: null, excluded: [{ address: 'P', reason: OWN_EXCLUDED.tokenBlocked }] }),
      'Our pool for this pair cannot take this trade: this site does not trade this token in our pools, so Buy sends this trade to Jupiter.',
    ],
    ['a pair we cannot hold', { kind: 'not-a-pair' }, 'Our pools pair a token with SOL, USDC or BAYLA, and this pair has none of them, so Buy sends this trade to Jupiter.'],
    ['no pools on this network', { kind: 'absent' }, 'This site has no pools of its own on this network yet, so Buy sends this trade to Jupiter.'],
  ])('%s', (_name, own, text) => {
    expect(routeSentence(jup(1_000n), own, YES)).toBe(text);
  });

  it('with no pool of ours, Jupiter having no route, unavailable or pending is said after it', () => {
    const none = quotes({ best: null, found: 0 });
    expect(routeSentence({ kind: 'no-route' }, none, YES)).toBe('We have no pool for this pair, and Jupiter has no route for this pair and amount.');
    expect(routeSentence({ kind: 'unavailable' }, none, YES)).toBe('We have no pool for this pair, and Jupiter could not be asked for a quote just now.');
    expect(routeSentence({ kind: 'pending' }, none, YES)).toBe('We have no pool for this pair. Checking Jupiter for this trade…');
  });

  it('never says a trade was routed, and never uses an em dash', () => {
    const sides: JupiterSide[] = [jup(900_000n), jup(1_010_000n), jup(996_000n), { kind: 'no-route' }, { kind: 'unavailable' }, { kind: 'pending' }];
    const owns: OwnSide[] = [quotes(), quotes({ best: null, found: 0 }), { kind: 'unread' }, { kind: 'absent' }, { kind: 'not-a-pair' }, { kind: 'pending' }];
    for (const j of sides) for (const o of owns) for (const s of [YES, OFF, { kind: 'checking' } as OwnSend]) {
      const t = routeSentence(j, o, s);
      expect(t).not.toMatch(/routed/i);
      expect(t).not.toContain('—');
    }
    expect(standingSentence(quotes())).toBe('Buy goes to one of our pools when it pays you at least as much as Jupiter, and to Jupiter otherwise.');
    expect(standingSentence({ kind: 'absent' })).toBe('Quotes come from Jupiter. This site has no pools of its own on this network yet.');
  });
});
