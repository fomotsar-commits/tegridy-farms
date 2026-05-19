/**
 * Shared render helper for component tests that mount any subtree which
 * (transitively) uses `useTheme` or `<Link>`.
 *
 * Why this exists:
 *   Production `App` wraps everything in `<ThemeProvider>` + `<BrowserRouter>`.
 *   Component tests that mount a fragment of the tree don't get those for
 *   free, and the hooks throw at render time. Before this helper, every test
 *   either rolled its own wrapper (drift over time) or skipped — masked by
 *   `continue-on-error: true` in CI.
 *
 *   This file does NOT install a Wagmi provider — hook tests that need
 *   wagmi already use `test-utils/wagmi-mocks` which `vi.mock('wagmi', …)`
 *   the whole module. Mixing real WagmiProvider + mocked wagmi imports
 *   would fight each other.
 *
 * Usage:
 *   import { renderWithProviders } from '@/test-utils/render';
 *
 *   it('shows the title', () => {
 *     renderWithProviders(<OnboardingModal />);
 *     expect(screen.getByText('Welcome')).toBeInTheDocument();
 *   });
 *
 *   // For renderHook (when you only need theme/router, not wagmi):
 *   import { ProvidersWrapper } from '@/test-utils/render';
 *   renderHook(() => useFoo(), { wrapper: ProvidersWrapper });
 */
import type { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../contexts/ThemeContext';

export function ProvidersWrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <ThemeProvider>{children}</ThemeProvider>
    </MemoryRouter>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
): RenderResult {
  return render(ui, { wrapper: ProvidersWrapper, ...options });
}
