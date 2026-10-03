// The Solana connection the top bar shows and opens (lib/solanaSurface.ts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelSolanaOpenRequest,
  getSolanaSurfaceState,
  noteOwnSolanaFailed,
  requestSolanaOpen,
  resetSolanaSurfaceForTests,
  setSolanaSurface,
  shortSolanaAddress,
  subscribeSolanaSurface,
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
});

describe('solanaSurface: who answers', () => {
  it('is empty with no Solana section on the page', () => {
    expect(getSolanaSurfaceState()).toEqual({
      surface: null,
      openPending: false,
      page: false,
      ownWanted: false,
      ownFailed: false,
      ownAttempt: 0,
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
    setSolanaSurface(ownOwner, ownSurface, true);
    expect(getSolanaSurfaceState()).toMatchObject({ surface: ownSurface, page: false });
    setSolanaSurface(pageOwner, pageSurface);
    expect(getSolanaSurfaceState()).toMatchObject({ surface: pageSurface, page: true });
    // The own one reports again (so it is now the later entry): the page still answers.
    const ownAgain = surface({ connecting: true });
    setSolanaSurface(ownOwner, ownAgain, true);
    expect(getSolanaSurfaceState()).toMatchObject({ surface: pageSurface, page: true });
    setSolanaSurface(pageOwner, null);
    expect(getSolanaSurfaceState()).toMatchObject({ surface: ownAgain, page: false });
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

  it('says when its code did not load, and counts each new try', () => {
    wantOwnSolana();
    noteOwnSolanaFailed();
    expect(getSolanaSurfaceState()).toMatchObject({ ownWanted: true, ownFailed: true, ownAttempt: 0 });
    wantOwnSolana();
    expect(getSolanaSurfaceState()).toMatchObject({ ownWanted: true, ownFailed: false, ownAttempt: 1 });
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
