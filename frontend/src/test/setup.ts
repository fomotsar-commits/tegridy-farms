import '@testing-library/jest-dom';
import { beforeEach, vi } from 'vitest';

// AUDIT FIX 2026-05-18 (frontend test mocks): install the wagmi mock
// globally so every component-render test inherits a controllable
// `useAccount` / `useReadContract` / `useWriteContract` / etc. surface
// without each test having to import the mock module explicitly. The
// `vi.mock('wagmi', ...)` factory inside `wagmi-mocks` is hoisted by
// Vitest from this setup file, applying to all spec files in the suite.
//
// Pre-fix, 79 component-render tests across 12 files failed because
// they did `render(<Component />)` on a component that calls
// `useAccount()` — the real wagmi hook raised "WagmiProvider not
// configured" because no provider tree was set up. Test files that
// DID import the mock explicitly worked; this fix levels the surface
// so the default behaviour is "wagmi is mocked" everywhere.
//
// Tests that want to drive specific stub responses still import
// `wagmiMock` from `@/test-utils/wagmi-mocks` and call
// `wagmiMock.setAccount(...)` / `setReadResult(...)` etc. inside
// beforeEach. Tests that don't reference wagmi state get the safe
// default (address: undefined, isConnected: false) — the same shape
// the production code handles cleanly on first paint.
import '@/test-utils/wagmi-mocks';
import { wagmiMock } from '@/test-utils/wagmi-mocks';

// AUDIT FIX 2026-05-18 (frontend test mocks): mock ThemeContext globally.
// `useTheme()` throws "must be used within a ThemeProvider" outside the
// provider tree; component-render tests that touch the shared `Modal`
// (which calls `useTheme()` at line 60) or any other `useTheme()`
// consumer would otherwise need to wrap every test render in
// `<ThemeProvider>` explicitly. Global mock returns a stable dark-theme
// shape so the components render in the dark palette they're designed
// for, matching production default.
vi.mock('@/contexts/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
  useTheme: () => ({ theme: 'dark' as const, toggleTheme: () => {}, isDark: true }),
}));

// AUDIT FIX 2026-05-18 (frontend test mocks): mock the GDPR consent gate
// globally to always report "granted" in tests.
//
// Pre-fix, `errorReporting.reportError` and `analytics.track` both
// early-return when `hasConsent()` is false (R046 H-1 — telemetry deny-
// by-default). The 25 errorReporting + analytics test failures all
// assert that the function MUTATED state (localStorage, console,
// sessionStorage) — but with consent=pending in the test env, the
// early return blocks every mutation and the assertions fail with
// "expected 1, got 0".
//
// The consent gate itself is not exercised by any existing test
// (no test references `setConsent` / `getConsent` / `hasConsent`), so
// hard-coding "granted" globally is the safe default. Tests that want
// to verify the gate itself would override via the standard
// `vi.mock('@/lib/consent', ...)` per-file pattern.
vi.mock('@/lib/consent', () => ({
  getConsent: () => 'granted' as const,
  setConsent: () => {},
  hasConsent: () => true,
}));

beforeEach(() => {
  // Reset between tests so leftover stubs from one spec can't bleed
  // into the next. Matches the per-test reset pattern individual
  // specs were already running locally.
  wagmiMock.reset();
});
