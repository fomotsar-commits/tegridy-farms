// The Solana connection the top bar shows and opens (lib/solanaSurface.ts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SOLANA_HANDOFF_PARAM,
  cancelSolanaOpenRequest,
  getSolanaSurfaceState,
  markSolanaHandoff,
  noteOwnSolanaFailed,
  noteSolanaHandoffArrival,
  requestSolanaOpen,
  resetSolanaSurfaceForTests,
  setSolanaSurface,
  solanaHandoffPending,
  solanaWasConnectedHere,
  shortSolanaAddress,
  subscribeSolanaSurface,
  takeSolanaHandoff,
  takeSolanaOpenRequest,
  wantOwnSolana,
  type SolanaSurface,
} from './solanaSurface';

const surface = (over: Partial<SolanaSurface> = {}): SolanaSurface => ({
  open: vi.fn(),
  address: null,
  connecting: false,
  ...over,
});

const owners: object[] = [];
const owner = () => {
  const o = {};
  owners.push(o);
  return o;
};

afterEach(() => {
  for (const o of owners.splice(0)) setSolanaSurface(o, null);
  resetSolanaSurfaceForTests();
  localStorage.clear();
});

describe('solanaSurface: who answers', () => {
  it('is empty with no Solana section on the page', () => {
    expect(getSolanaSurfaceState()).toEqual({
      surface: null,
      openPending: false,
      page: false,
      ownWanted: false,
      ownFailed: false,
    });
  });

  it('answers with the provider mounted last, and falls back as each one leaves', () => {
    const a = owner();
    const b = owner();
    const sa = surface();
    const sb = surface();
    setSolanaSurface(a, sa);
    setSolanaSurface(b, sb);
    expect(getSolanaSurfaceState().surface).toBe(sb);
    // A re-report keeps its mount order: A stays first.
    const sa2 = surface({ address: 'A' });
    setSolanaSurface(a, sa2);
    expect(getSolanaSurfaceState().surface).toBe(sb);
    setSolanaSurface(b, null);
    expect(getSolanaSurfaceState().surface).toBe(sa2);
    setSolanaSurface(a, null);
    expect(getSolanaSurfaceState().surface).toBeNull();
  });

  it('tells subscribers about every change, and only until they unsubscribe', () => {
    const listener = vi.fn();
    const off = subscribeSolanaSurface(listener);
    const a = owner();
    setSolanaSurface(a, surface());
    setSolanaSurface(a, surface({ address: 'X' }));
    setSolanaSurface(a, null);
    expect(listener).toHaveBeenCalledTimes(3);
    off();
    setSolanaSurface(a, surface());
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('withdrawing a provider that never reported changes nothing and tells no one', () => {
    const listener = vi.fn();
    const off = subscribeSolanaSurface(listener);
    const before = getSolanaSurfaceState();
    setSolanaSurface(owner(), null);
    expect(listener).not.toHaveBeenCalled();
    expect(getSolanaSurfaceState()).toBe(before);
    off();
  });

  it('hands out the same snapshot object until something changes (useSyncExternalStore)', () => {
    setSolanaSurface(owner(), surface());
    expect(getSolanaSurfaceState()).toBe(getSolanaSurfaceState());
  });
});

describe('solanaSurface: a top-bar tap', () => {
  it('opens the page list at once when the page has one, and remembers nothing', () => {
    const s = surface();
    setSolanaSurface(owner(), s);
    requestSolanaOpen();
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(getSolanaSurfaceState().openPending).toBe(false);
    expect(takeSolanaOpenRequest()).toBe(false);
  });

  it('is remembered while the page has no Solana section yet, and used exactly once', () => {
    requestSolanaOpen();
    requestSolanaOpen();
    expect(getSolanaSurfaceState().openPending).toBe(true);
    expect(takeSolanaOpenRequest()).toBe(true);
    expect(getSolanaSurfaceState().openPending).toBe(false);
    expect(takeSolanaOpenRequest()).toBe(false);
  });

  // While the page's wallet is being waited on, the page holds an early tap
  // (SolanaSurfaceBridge) and the top bar still takes taps. A later tap that
  // reaches the page is the answer to both: the early one must not be replayed
  // after it, nor reported as "did not load" ten seconds on (TopNav).
  it('a tap that reaches the page answers a tap still waiting for it', () => {
    requestSolanaOpen();
    const s = surface({ connecting: true });
    setSolanaSurface(owner(), s);
    expect(getSolanaSurfaceState().openPending).toBe(true);
    requestSolanaOpen();
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(getSolanaSurfaceState().openPending).toBe(false);
    expect(takeSolanaOpenRequest()).toBe(false);
  });

  it('is dropped by a cancel (the visitor left the page)', () => {
    requestSolanaOpen();
    cancelSolanaOpenRequest();
    expect(getSolanaSurfaceState().openPending).toBe(false);
    expect(takeSolanaOpenRequest()).toBe(false);
  });
});

// ONE LIVE CONNECTION PER PAGE: where the page has a Solana section the top bar
// borrows it; its own is for pages with none (components/layout/TopBarSolana.tsx).
describe("solanaSurface: the top bar's own connection", () => {
  it("lets a page's connection answer over the top bar's own, whichever mounted last", () => {
    const pageOwner = owner();
    const ownOwner = owner();
    const pageSurface = surface();
    const ownSurface = surface();
    // The page's mounts FIRST and the top bar's own LAST: "last mounted" would pick the own one.
    setSolanaSurface(pageOwner, pageSurface);
    setSolanaSurface(ownOwner, ownSurface, true);
    expect(getSolanaSurfaceState()).toMatchObject({ surface: pageSurface, page: true });
    setSolanaSurface(pageOwner, null);
    expect(getSolanaSurfaceState()).toMatchObject({ surface: ownSurface, page: false });
    // And the other way round: the own one first, then a page's.
    const laterPage = owner();
    const laterSurface = surface();
    setSolanaSurface(laterPage, laterSurface);
    expect(getSolanaSurfaceState()).toMatchObject({ surface: laterSurface, page: true });
  });

  it('is not wanted on a first visit, and is once the visitor asks for Solana', () => {
    expect(getSolanaSurfaceState().ownWanted).toBe(false);
    wantOwnSolana();
    expect(getSolanaSurfaceState().ownWanted).toBe(true);
  });

  it('is wanted for the rest of the tab once any Solana wallet has connected', () => {
    const pageOwner = owner();
    setSolanaSurface(pageOwner, surface());
    expect(getSolanaSurfaceState().ownWanted).toBe(false);
    setSolanaSurface(pageOwner, surface({ address: 'X' }));
    expect(getSolanaSurfaceState().ownWanted).toBe(true);
    // The visitor leaves the Solana page: the address should follow them.
    setSolanaSurface(pageOwner, null);
    expect(getSolanaSurfaceState().ownWanted).toBe(true);
  });

  // In the same tab only a reload can fetch a failed chunk again, so asking
  // again changes nothing; a Solana page that mounts its section proves the
  // code loads after all.
  it('says when its code did not load, until a Solana connection does mount', () => {
    wantOwnSolana();
    noteOwnSolanaFailed();
    expect(getSolanaSurfaceState()).toMatchObject({ ownWanted: true, ownFailed: true });
    wantOwnSolana();
    expect(getSolanaSurfaceState().ownFailed).toBe(true);
    setSolanaSurface(owner(), surface());
    expect(getSolanaSurfaceState()).toMatchObject({ ownWanted: true, ownFailed: false });
  });

  // What a later visit restores on. The wallet adapter saves a wallet's NAME
  // the moment its row is tapped, connected or not, so the name alone would
  // download the Solana code on every page for a phone visitor who only ever
  // tapped "Open app".
  it('remembers that a Solana wallet really connected here, until that connection disconnects', () => {
    const pageOwner = owner();
    expect(solanaWasConnectedHere()).toBe(false);
    setSolanaSurface(pageOwner, surface());
    setSolanaSurface(pageOwner, surface({ connecting: true }));
    expect(solanaWasConnectedHere()).toBe(false);
    setSolanaSurface(pageOwner, surface({ address: 'X' }));
    expect(solanaWasConnectedHere()).toBe(true);
    // Leaving the page is not a disconnect.
    setSolanaSurface(pageOwner, null);
    expect(solanaWasConnectedHere()).toBe(true);
    // Another connection that never had an address says nothing either.
    setSolanaSurface(owner(), surface());
    expect(solanaWasConnectedHere()).toBe(true);
    // A connection that had an address and now has none was disconnected.
    const again = owner();
    setSolanaSurface(again, surface({ address: 'X' }));
    setSolanaSurface(again, surface());
    expect(solanaWasConnectedHere()).toBe(false);
  });

  it('tells no one when it is asked for twice', () => {
    wantOwnSolana();
    const listener = vi.fn();
    const off = subscribeSolanaSurface(listener);
    wantOwnSolana();
    expect(listener).not.toHaveBeenCalled();
    off();
  });
});

describe('solanaSurface', () => {
  it('shortens a Solana address the house way', () => {
    expect(shortSolanaAddress('Bq6jovnQfVTFjmxL4dPt9xNNNnDBgvdhaXy3D4YqXTXV')).toBe('Bq6j…XTXV');
  });

  // TopNav is in the entry chunk; check-dist-graph.mjs B fails the BUILD if any
  // of these pulls the Solana stack in. This says so in the unit run, sooner.
  const SOLANA_CODE = /@solana\/|solanaPolyfill|solanaWallet|components\/solana\/|\.\.\/solana\//;
  const EAGER = [
    'lib/solanaSurface.ts',
    'lib/routeVoice.ts',
    'components/layout/TopNav.tsx',
    'components/layout/WalletSheet.tsx',
    'components/layout/TopBarSolana.tsx',
  ];
  it.each(EAGER)('%s, which the top bar loads up front, imports no Solana code', (file) => {
    const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
    const imports = source.match(/^\s*import[\s\S]*?from\s+['"][^'"]+['"]|^\s*import\s+['"][^'"]+['"]/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const statement of imports) {
      expect(statement, `${file}: ${statement}`).not.toMatch(SOLANA_CODE);
    }
  });

  // The one way in: TopBarSolana's import() of the provider, which the bundler
  // splits into its own chunk. Nothing else up front may reach Solana code,
  // not even lazily, without being added here on purpose.
  it('reaches Solana code through exactly one import(), in TopBarSolana.tsx', () => {
    const dynamic = EAGER.flatMap((file) => {
      const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
      return [...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => `${file} -> ${match[1]}`);
    });
    expect(dynamic).toEqual(['components/layout/TopBarSolana.tsx -> ../solana/SolanaProviders']);
  });
});

// In a phone browser a wallet's row reopens the page inside that wallet's app.
// The page that opened there looked like the start again, and Connect, Solana
// and the wallet had to be pressed a second time (four testers, 2026-10-03).
// The press now leaves a marker in the address the wallet is handed.
//
// MUTATION CHECKS
//  - markSolanaHandoff: drop the `searchParams.set`. The first test must fail.
//  - noteSolanaHandoffArrival: drop the `isPhoneOrTablet()` guard. "on a
//    computer" must fail. Drop the replaceState: both arrival tests must fail.
//  - solanaHandoffPending: drop the freshness bound. "lapses" must fail.
describe('solanaSurface: a hand-off into a wallet app carries on there', () => {
  const ANDROID =
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
  const onAPhone = () => vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ANDROID);
  const address = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

  afterEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('puts the marker in the address the wallet is handed, keeps the rest of it, and takes it out again', () => {
    vi.useFakeTimers();
    window.history.replaceState({ idx: 3 }, '', '/earn/bayla?ref=abc#ladder');
    markSolanaHandoff();
    // The query, because MetaMask's link drops a fragment. The router's own
    // history state is left as it was.
    expect(address()).toBe(`/earn/bayla?ref=abc&${SOLANA_HANDOFF_PARAM}=1#ladder`);
    expect(window.history.state).toEqual({ idx: 3 });
    // A second press while it is there adds nothing.
    markSolanaHandoff();
    expect(address()).toBe(`/earn/bayla?ref=abc&${SOLANA_HANDOFF_PARAM}=1#ladder`);
    // The page left behind does not keep it: a copied or reloaded address is clean.
    vi.advanceTimersByTime(3_000);
    expect(address()).toBe('/earn/bayla?ref=abc#ladder');
  });

  it('on a phone, the page that opens reads the marker once, cleans its address, and remembers for the tab', () => {
    onAPhone();
    window.history.replaceState(null, '', `/?${SOLANA_HANDOFF_PARAM}=1&ref=abc`);
    noteSolanaHandoffArrival();
    expect(address()).toBe('/?ref=abc');
    expect(solanaHandoffPending()).toBe(true);
    // The home page reloads once on a first visit: the reloaded page has no
    // marker and still knows.
    noteSolanaHandoffArrival();
    expect(solanaHandoffPending()).toBe(true);
    expect(takeSolanaHandoff()).toBe(true);
    expect(solanaHandoffPending()).toBe(false);
    expect(takeSolanaHandoff()).toBe(false);
  });

  // The hand-off exists on phones and tablets only. A link carrying the marker,
  // opened on a computer, must not make a wallet extension prompt by itself.
  it('on a computer the marker is removed and nothing follows', () => {
    window.history.replaceState(null, '', `/pools?${SOLANA_HANDOFF_PARAM}=1`);
    noteSolanaHandoffArrival();
    expect(address()).toBe('/pools');
    expect(solanaHandoffPending()).toBe(false);
  });

  it('is a flag: whatever value a link gives it, nothing is read out of it', () => {
    onAPhone();
    window.history.replaceState(null, '', `/?${SOLANA_HANDOFF_PARAM}=https%3A%2F%2Fevil.example%2F`);
    noteSolanaHandoffArrival();
    expect(address()).toBe('/');
    expect(sessionStorage.length).toBe(1);
    expect(Number(sessionStorage.getItem('tegridy-solana-handoff'))).toBeGreaterThan(0);
  });

  it('a hand-off that nothing answered lapses', () => {
    vi.useFakeTimers();
    onAPhone();
    window.history.replaceState(null, '', `/?${SOLANA_HANDOFF_PARAM}=1`);
    noteSolanaHandoffArrival();
    vi.advanceTimersByTime(119_000);
    expect(solanaHandoffPending()).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(solanaHandoffPending()).toBe(false);
    expect(takeSolanaHandoff()).toBe(false);
  });

  it('an ordinary visit remembers nothing', () => {
    onAPhone();
    window.history.replaceState(null, '', '/earn?ref=abc');
    noteSolanaHandoffArrival();
    expect(address()).toBe('/earn?ref=abc');
    expect(solanaHandoffPending()).toBe(false);
    expect(sessionStorage.length).toBe(0);
  });
});
