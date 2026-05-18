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

beforeEach(() => {
  // Reset between tests so leftover stubs from one spec can't bleed
  // into the next. Matches the per-test reset pattern individual
  // specs were already running locally.
  wagmiMock.reset();
});
