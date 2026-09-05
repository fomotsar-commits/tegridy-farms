// The NFT-lending "Protocol Fee" tile, and the difference between "takes no
// cut" and "nobody could ask".
//
// The tile computed its figure as
//   `const protocolFeeBps = protocolFeeBpsData ? Number(protocolFeeBpsData) : 0`
// and then rendered `${bpsToPercent(protocolFeeBps)}%` unconditionally. So an
// RPC hiccup, a wrong chain, an ABI drift — anything that made the read come
// back empty — printed "0.00%": a flat statement that the protocol keeps none
// of a lender's interest. It keeps 5% by default and the owner can move it, and
// this tile is on the screen where a lender decides what APR to offer. A zero
// that came from an outage is the worst possible lie to tell there, because it
// is the one that makes the deal look better than it is.
//
// Both halves are pinned here, because only the pair is a fix:
//   • UNREAD  — a failed read (stubbed failure, and the no-stub case, which in
//     this mock IS a failed read) shows the unavailable state and renders no
//     percentage of any kind;
//   • GENUINE ZERO — a successfully read 0n still renders "0.00%" and never the
//     unavailable state. A governance-set zero fee and a fee nobody read must
//     not look alike; a fix that collapses them is just the same bug pointed the
//     other way.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

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

import { NFTLendingSection } from './NFTLendingSection';
import { TEGRIDY_NFT_LENDING_ADDRESS } from '../../lib/constants';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'NFTLendingSection.tsx'),
  'utf-8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** Any bare percentage figure, e.g. "0.00%" or "5.00%". */
const PERCENT = /^\d+\.\d{2}%$/;

/** The panel that holds the Protocol Fee label and its value, and nothing else. */
function feeTile(): HTMLElement {
  // getNodeText only reads a node's OWN text children, so this matches the
  // label <p> (the "?" lives in a nested button) and not its ancestors.
  const label = screen.getByText('Protocol Fee');
  const tile = label.parentElement;
  if (!tile) throw new Error('Protocol Fee tile has no container');
  return tile;
}

/** Open the tile's InfoTooltip and return the bubble text. */
function feeTooltipText(): string {
  const tile = feeTile();
  fireEvent.focus(within(tile).getByRole('button', { name: 'More info' }));
  return within(tile).getByRole('tooltip').textContent ?? '';
}

function stubFee(result: unknown, status?: 'success' | 'failure') {
  wagmiMock.setReadResult({
    functionName: 'protocolFeeBps',
    address: TEGRIDY_NFT_LENDING_ADDRESS,
    result,
    status,
  });
}

describe('NFT lending protocol-fee tile', () => {
  beforeEach(() => {
    wagmiMock.reset();
  });

  /* ── UNREAD ─────────────────────────────────────────────────────── */

  it('says the fee is unavailable when the read fails, and prints no percentage', () => {
    stubFee(undefined, 'failure');
    renderWithProviders(<NFTLendingSection />);

    const tile = feeTile();
    expect(within(tile).getByText('Unavailable')).toBeTruthy();
    // The whole point: not "0.00%", and not any other figure either. Old code
    // put "0.00%" in this tile on exactly this input.
    expect(within(tile).queryByText(PERCENT)).toBeNull();
    expect(screen.queryByText(PERCENT)).toBeNull();
    // Nor the still-loading dash — the read finished, it finished badly.
    expect(within(tile).queryByText('–')).toBeNull();
  });

  it('says the fee is unavailable when nothing answers at all', () => {
    // No stub. An unstubbed read is a FAILED read, not a zero — the conflation
    // that made this defect survive its own test suite last time.
    renderWithProviders(<NFTLendingSection />);

    const tile = feeTile();
    expect(within(tile).getByText('Unavailable')).toBeTruthy();
    expect(within(tile).queryByText(PERCENT)).toBeNull();
    expect(screen.queryByText(PERCENT)).toBeNull();
  });

  it('tells the reader the unread fee is unknown, not zero', () => {
    stubFee(undefined, 'failure');
    renderWithProviders(<NFTLendingSection />);

    const text = feeTooltipText();
    expect(text).toMatch(/not zero/i);
    expect(text).toMatch(/could not be read/i);
    // Old code handed this tile the standard "fee taken from interest" copy
    // whatever happened to the read, which corroborated the fabricated 0.00%.
    expect(text).not.toMatch(/paid to the protocol treasury/i);
  });

  /* ── GENUINE ZERO ───────────────────────────────────────────────── */

  it('renders a real on-chain zero fee as 0.00%, not as unavailable', () => {
    stubFee(0n);
    renderWithProviders(<NFTLendingSection />);

    const tile = feeTile();
    expect(within(tile).getByText('0.00%')).toBeTruthy();
    expect(within(tile).queryByText('Unavailable')).toBeNull();
    expect(screen.queryByText('Unavailable')).toBeNull();
  });

  it('keeps the ordinary fee explanation on a real zero', () => {
    // A read that succeeded is a read that succeeded. 0n must not pick up the
    // "unknown right now" copy — that would be the fix over-firing.
    stubFee(0n);
    renderWithProviders(<NFTLendingSection />);

    const text = feeTooltipText();
    expect(text).toMatch(/paid to the protocol treasury/i);
    expect(text).not.toMatch(/not zero/i);
  });

  /* ── READ OK ────────────────────────────────────────────────────── */

  it('renders the fee the lending contract reports', () => {
    stubFee(500n);
    renderWithProviders(<NFTLendingSection />);

    const tile = feeTile();
    expect(within(tile).getByText('5.00%')).toBeTruthy();
    expect(within(tile).queryByText('Unavailable')).toBeNull();
  });

  it('follows the contract when the owner moves the fee', () => {
    stubFee(125n);
    renderWithProviders(<NFTLendingSection />);

    expect(within(feeTile()).getByText('1.25%')).toBeTruthy();
  });
});

/* ── SOURCE GUARD ─────────────────────────────────────────────────────
   The render tests above only cover the branches a render reaches. This block
   pins the shape of the code itself, so the collapse cannot be reintroduced on
   a path no test drives — and so a "tidy-up" that restores the one-line ternary
   fails here even if it happens to look right on screen. */
describe('the outage-as-zero collapse stays out of NFTLendingSection', () => {
  it('never truthiness-collapses the raw protocolFeeBps read', () => {
    // `protocolFeeBpsData ? … : 0` — the exact defect. Comments are stripped
    // from SRC, so the one describing the old line does not trip this.
    expect(SRC).not.toMatch(/protocolFeeBpsData\s*\?/);
  });

  it('never falls back to a 0 fee anywhere on that binding', () => {
    expect(SRC).not.toMatch(/protocolFeeBps\s*=[^;\n]*:\s*0\b/);
  });

  it('discriminates a bigint read from an absent one, and can yield null', () => {
    expect(SRC).toMatch(/typeof protocolFeeBpsData === 'bigint'\s*\?/);
    expect(SRC).toMatch(/:\s*null;/);
  });

  it('only prints a percentage on the non-null branch', () => {
    expect(SRC).toMatch(/protocolFeeBps !== null\s*\?\s*`\$\{bpsToPercent\(protocolFeeBps\)\}%`/);
    expect(SRC).toMatch(/'Unavailable'/);
  });

  it('guards the guard — the old line really would trip these', () => {
    const OLD = "  const protocolFeeBps = protocolFeeBpsData ? Number(protocolFeeBpsData) : 0;";
    expect(OLD).toMatch(/protocolFeeBpsData\s*\?/);
    expect(OLD).toMatch(/protocolFeeBps\s*=[^;\n]*:\s*0\b/);
  });
});
