// The NFT-lending "Venue Fee" tile, and the difference between "takes no cut" and
// "nobody could ask". Since 2026-10-27 the tile reads Gondi's loan contract:
// getProtocolFee().fraction, the venue's share of a lender's interest.
//
// The tile once computed its figure as
//   `const protocolFeeBps = protocolFeeBpsData ? Number(protocolFeeBpsData) : 0`
// and then rendered `${bpsToPercent(protocolFeeBps)}%` unconditionally. So an RPC
// hiccup, a wrong chain, an ABI drift — anything that made the read come back empty —
// printed "0.00%": a flat statement that the venue keeps none of a lender's interest. It
// keeps 5% by default and the owner can move it, and this tile is on the screen where a
// lender decides what APR to offer. A zero that came from an outage is the worst possible
// lie to tell there, because it is the one that makes the deal look better than it is.
//
// Both halves are pinned here, because only the pair is a fix:
//   • UNREAD  — a failed read (stubbed failure, and the no-stub case, which in this mock
//     IS a failed read) shows the unavailable state and renders no percentage of any kind;
//   • GENUINE ZERO — a successfully read 0n still renders "0.00%" and never the
//     unavailable state. A governance-set zero fee and a fee nobody read must not look
//     alike; a fix that collapses them is just the same bug pointed the other way.

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

// The tile only reads once Gondi's loan contract is deployed: give it an address.
vi.mock('../../lib/gondi/loanOffer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/gondi/loanOffer.js')>()),
  GONDI_LOAN_ADDRESS: '0x5555555555555555555555555555555555555555',
}));
vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ offers: [], count: 0, live: true }))));

import { NFTLendingSection } from './NFTLendingSection';

const LOAN = '0x5555555555555555555555555555555555555555';
const TREASURY = '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'NFTLendingSection.tsx'), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** Any bare percentage figure, e.g. "0.00%" or "5.00%". */
const PERCENT = /^\d+\.\d{2}%$/;

/** The panel that holds the Venue Fee label and its value, and nothing else. */
function feeTile(): HTMLElement {
  // getNodeText only reads a node's OWN text children, so this matches the label <p>
  // (the "?" lives in a nested button) and not its ancestors.
  const label = screen.getByText('Venue Fee');
  const tile = label.parentElement;
  if (!tile) throw new Error('Venue Fee tile has no container');
  return tile;
}

/** Open the tile's InfoTooltip and return the bubble text. */
function feeTooltipText(): string {
  const tile = feeTile();
  fireEvent.focus(within(tile).getByRole('button', { name: 'More info' }));
  return within(tile).getByRole('tooltip').textContent ?? '';
}

function stubFee(fraction: bigint | undefined, status?: 'success' | 'failure') {
  wagmiMock.setReadResult({
    functionName: 'getProtocolFee',
    address: LOAN,
    result: fraction === undefined ? undefined : { recipient: TREASURY, fraction },
    status,
  });
}

describe('NFT lending venue-fee tile', () => {
  beforeEach(() => {
    wagmiMock.reset();
  });

  /* ── UNREAD ─────────────────────────────────────────────────────── */

  it('says the fee is unavailable when the read fails, and prints no percentage', () => {
    stubFee(undefined, 'failure');
    renderWithProviders(<NFTLendingSection />);

    const tile = feeTile();
    expect(within(tile).getByText('Unavailable')).toBeTruthy();
    // The whole point: not "0.00%", and not any other figure either.
    expect(within(tile).queryByText(PERCENT)).toBeNull();
    expect(screen.queryByText(PERCENT)).toBeNull();
    // Nor the still-loading dash — the read finished, it finished badly.
    expect(within(tile).queryByText('–')).toBeNull();
  });

  it('says the fee is unavailable when nothing answers at all', () => {
    // No stub. An unstubbed read is a FAILED read, not a zero.
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
    expect(text).not.toMatch(/the venue keeps this share/i);
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
    stubFee(0n);
    renderWithProviders(<NFTLendingSection />);

    const text = feeTooltipText();
    expect(text).toMatch(/the venue keeps this share/i);
    expect(text).not.toMatch(/not zero/i);
  });

  /* ── READ OK ────────────────────────────────────────────────────── */

  it('renders the fee the loan contract reports', () => {
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
   The render tests above only cover the branches a render reaches. This block pins the
   shape of the code itself, so the collapse cannot come back on a path no test drives. */
describe('the outage-as-zero collapse stays out of NFTLendingSection', () => {
  it('never falls back to a 0 fee on the fee binding', () => {
    expect(SRC).not.toMatch(/feeBps\s*=[^;\n]*:\s*0\b/);
  });

  it('discriminates a bigint read from an absent one, and can yield null', () => {
    expect(SRC).toMatch(/typeof protocolFee\.fraction === 'bigint'\s*\?\s*Number\(protocolFee\.fraction\)\s*:\s*null;/);
  });

  it('only prints a percentage on the non-null branch', () => {
    expect(SRC).toMatch(/feeBps !== null\s*\?\s*`\$\{bpsToPercent\(feeBps\)\}%`/);
    expect(SRC).toMatch(/'Unavailable'/);
  });

  it('guards the guard — the old shape really would trip these', () => {
    const OLD = '  const feeBps = protocolFee ? Number(protocolFee.fraction) : 0;';
    expect(OLD).toMatch(/feeBps\s*=[^;\n]*:\s*0\b/);
    expect(OLD).not.toMatch(/typeof protocolFee\.fraction === 'bigint'/);
  });
});
