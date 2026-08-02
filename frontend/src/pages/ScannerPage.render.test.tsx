import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ScanError } from '../lib/scanner';
import { statusForError } from '../hooks/useTokenScan';

// THE OTHER HALF OF THE HINGE.
//
// useTokenScan.test.ts pins ScanError code -> status. This pins status -> the words
// a user actually reads, and then joins the two so the whole chain is covered: an
// adapter that throws `ScanError('network')` must produce a screen that says nothing
// about the token.
//
// Both scanner adapters and the erc20scan route were written against this mapping and
// argue for their error codes in prose. Nothing pinned the rendering, so a one-line
// change here could have made every one of those comments false while the suite
// stayed green.

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});
vi.mock('../components/PageArtBackdrop', () => ({ PageArtBackdrop: () => null }));
vi.mock('../components/scanner/ScanReport', () => ({ ScanReport: () => <div>scan report</div> }));

const state = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../hooks/useTokenScan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useTokenScan')>();
  return { ...actual, useTokenScan: () => state.current };
});

import ScannerPage from './ScannerPage';

/** Phrases that assert something ABOUT THE SCANNED TOKEN or the deployment. */
const TOKEN_CLAIMS = [
  /no holder data for this token/i,
  /double-check the address is a token/i,
  /not enabled on this deployment/i,
  /solana token scans work today/i,
];

function renderWith(status: string, errorMessage: string | null = 'detail') {
  state.current = { status, chain: 'ethereum', outcome: null, errorMessage, reload: vi.fn() };
  render(
    <MemoryRouter>
      <ScannerPage />
    </MemoryRouter>,
  );
}

beforeEach(() => { vi.clearAllMocks(); });

describe('ScannerPage — what each state actually says', () => {
  it('renders the read-failure state as a statement about the READ, with a retry', () => {
    renderWith('error');
    expect(screen.getByText(/couldn't complete the scan/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    for (const claim of TOKEN_CLAIMS) expect(screen.queryByText(claim)).toBeNull();
  });

  it('renders the empty state as the claim about the token it is meant to be', () => {
    // The other side: this copy is CORRECT when the read worked and nobody holds the
    // token. Hardening must not empty it out.
    renderWith('empty');
    expect(screen.getByText(/no holder data for this token/i)).toBeTruthy();
    expect(screen.getByText(/double-check the address is a token/i)).toBeTruthy();
  });

  it('renders the unavailable state as a deployment gap', () => {
    renderWith('unavailable');
    expect(screen.getByText(/not enabled on this deployment/i)).toBeTruthy();
    expect(screen.queryByText(/no holder data for this token/i)).toBeNull();
  });

  it('keeps the states mutually exclusive', () => {
    // A status must render its own branch and no other, so no state can leak a
    // sentence belonging to a different one.
    renderWith('loading');
    expect(screen.getByText(/computing distribution/i)).toBeTruthy();
    for (const claim of [...TOKEN_CLAIMS, /couldn't complete the scan/i]) {
      expect(screen.queryByText(claim)).toBeNull();
    }
  });
});

describe('end to end: a ScanError an adapter throws → the words on screen', () => {
  it.each([['network'], ['rate-limited']] as const)(
    'ScanError(%s) never puts a claim about the token on screen',
    (code) => {
      // ⚠ THE INVARIANT THE WHOLE BODY OF WORK RESTS ON. Joins both layers: the code
      // an adapter chose, through statusForError, to the rendered copy. Remapping
      // either layer fails here.
      const { status } = statusForError(new ScanError(code, 'could not read it'));
      renderWith(status, 'could not read it');
      for (const claim of TOKEN_CLAIMS) expect(screen.queryByText(claim)).toBeNull();
      expect(screen.getByText(/couldn't complete the scan/i)).toBeTruthy();
    },
  );

  it.each([['empty'], ['not-found']] as const)(
    'ScanError(%s) DOES render the token-claim copy, because that is what it means',
    (code) => {
      const { status } = statusForError(new ScanError(code, 'no holders'));
      renderWith(status, 'no holders');
      expect(screen.getByText(/no holder data for this token/i)).toBeTruthy();
    },
  );
});
