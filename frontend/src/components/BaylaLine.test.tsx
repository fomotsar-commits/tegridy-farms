// Island answer twenty-four, build 4: Bayla's line under the nav, mounted. The stranger's
// line with no reading; the wallet's line once the card has read one; the farm's own pages
// keep their voice; the intel line comes from a read and is left out when there is none.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BaylaLine } from './BaylaLine';
import { __resetFire } from '../lib/fire';
import { setLastReading } from '../lib/heat/heatStore';
import { clearLanded, markLanded } from '../lib/landed';
import { clearScreenMoves, useScreenMove, type ScreenMove } from '../lib/screenMove';
import { clearReceipt, closeReceipt, raiseReceipt, useReceipt } from '../lib/receipt';
import type { HeatReading } from '../lib/heat/heatOracle';

vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }));
vi.mock('../lib/solanaSurface', () => ({ useSolanaSurface: () => ({ surface: null }) }));

const reading: HeatReading = {
  address: '0x1111111111111111111111111111111111111111',
  degrees: 12.34,
  tier: 'Observer',
  isCold: false,
  heldSinceUnix: 1_700_000_000,
  asOfUnix: 1_762_000_000,
  tokenCount: 2,
  breakdown: [],
  observedAt: 1_762_000_000,
  xHandle: null,
  daysToNextTier: null,
  daysToPlant: null,
};

function mount(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BaylaLine />
    </MemoryRouter>,
  );
}

const fireAnswer = (body: unknown, ok = true) => vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 502 }));

beforeEach(() => {
  localStorage.clear();
  setLastReading(null);
  clearLanded();
  clearScreenMoves();
  clearReceipt();
  __resetFire();
  vi.stubGlobal('fetch', fireAnswer({ error: 'sealed' }, false));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BaylaLine', () => {
  it('a stranger reads the no-wallet line with Read heat, and no intel while the fire is unread', async () => {
    mount('/pools');
    expect(screen.getByTestId('bayla-line-text')).toHaveTextContent('Your held time already has a number. Paste any wallet.');
    expect(screen.getByRole('link', { name: 'Read heat' })).toHaveAttribute('href', '/');
    await act(async () => {});
    expect(screen.queryByTestId('bayla-intel')).toBeNull();
  });

  it('speaks from the reading the card made, on another route', () => {
    setLastReading(reading);
    mount('/solana');
    expect(screen.getByTestId('bayla-line-text')).toHaveTextContent('12.34° Observer. Pick a bungalow and add to its pool.');
    expect(screen.getByRole('link', { name: 'Pick' })).toHaveAttribute('href', '/#hall');
  });

  it('after an add it says Done for a minute, with Receipt, which raises the last receipt card again', () => {
    setLastReading(reading);
    markLanded('add');
    function Open() {
      return <p data-testid="receipt-open">{String(useReceipt().open)}</p>;
    }
    render(
      <MemoryRouter initialEntries={['/pools']}>
        <BaylaLine />
        <Open />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('bayla-line-text')).toHaveTextContent('Done. Your fee went to the island. Read it.');
    const press = screen.getByRole('button', { name: 'Receipt' });
    // Island answer twenty-five, build 6: the card that was raised, closed, then asked for again.
    act(() => {
      raiseReceipt({ signature: 'S'.repeat(88), explorerUrl: 'https://solscan.io/tx/S', wallet: reading.address, action: 'added', coin: { symbol: 'BAYLA', mint: 'm' }, title: null, under: null, fee: { kind: 'reading' }, clock: null });
      closeReceipt();
    });
    expect(screen.getByTestId('receipt-open')).toHaveTextContent('false');
    fireEvent.click(press);
    expect(screen.getByTestId('receipt-open')).toHaveTextContent('true');
  });

  it('the intel line is the fire’s week, read once, and never a zero', async () => {
    vi.stubGlobal('fetch', fireAnswer({ week: { burned: 339866 } }));
    mount('/');
    await act(async () => {});
    expect(screen.getByTestId('bayla-intel')).toHaveTextContent('The fire took 339,866 $BAYLA this week.');
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/aggregator?resource=fire');
    cleanup();
    __resetFire();
    vi.stubGlobal('fetch', fireAnswer({ week: { burned: 0 } }));
    mount('/');
    await act(async () => {});
    expect(screen.queryByTestId('bayla-intel')).toBeNull();
  });

  it('a room’s door keeps its first screen: nothing on /pools with a coin in the URL, the line on /pools itself', () => {
    mount('/pools?mint=7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump&task=add');
    expect(screen.queryByTestId('bayla-line')).toBeNull();
    cleanup();
    // The wish taken, the coin stays: still the door.
    mount('/pools?mint=7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump');
    expect(screen.queryByTestId('bayla-line')).toBeNull();
    cleanup();
    mount('/pools');
    expect(screen.getByTestId('bayla-line')).toBeInTheDocument();
  });

  it('the farm keeps its own voice: nothing on /toweli', () => {
    mount('/toweli');
    expect(screen.queryByTestId('bayla-line')).toBeNull();
  });

  // Island answer twenty-five, build 3: her Add and her Start the clock open the sheet over the page.
  it('in a room, her Add opens the Add sheet over the page, and a cold wallet’s Start the clock the Buy sheet', () => {
    localStorage.setItem('tegridy-bungalow', 'bayla');
    setLastReading(reading);
    mount('/bayla');
    expect(screen.getByRole('link', { name: 'Add BAYLA' })).toHaveAttribute('href', '/bayla?sheet=add');
    cleanup();
    setLastReading({ ...reading, degrees: 0, isCold: true, tier: 'Drifter' });
    mount('/launch');
    expect(screen.getByRole('link', { name: 'Start the clock' })).toHaveAttribute('href', '/launch?sheet=buy');
  });

  // Island answer twenty-five, §2: one green button per screen.
  it('goes quiet where the screen’s own green button makes her move, and stays green where it makes another', () => {
    localStorage.setItem('tegridy-bungalow', 'bayla');
    setLastReading(reading);
    function Screen({ move }: { move: ScreenMove }) {
      useScreenMove(move);
      return null;
    }
    const at = (move: ScreenMove) =>
      render(
        <MemoryRouter initialEntries={['/bayla']}>
          <BaylaLine />
          <Screen move={move} />
        </MemoryRouter>,
      );
    at('add');
    const quiet = screen.getByRole('link', { name: 'Add BAYLA' });
    expect(quiet).toHaveAttribute('data-quiet', 'true');
    expect(quiet).not.toHaveClass('btn-primary');
    // The island's quiet press: no fill, a 0.25 white edge, 0.78 white words.
    expect(quiet.style.background).toBe('transparent');
    expect(quiet.style.border).toBe('1px solid rgba(255, 255, 255, 0.25)');
    expect(quiet.style.color).toBe('rgba(255, 255, 255, 0.78)');
    // The same press: it still opens the sheet.
    expect(quiet).toHaveAttribute('href', '/bayla?sheet=add');
    cleanup();
    at('start');
    const green = screen.getByRole('link', { name: 'Add BAYLA' });
    expect(green).not.toHaveAttribute('data-quiet');
    expect(green).toHaveClass('btn-primary');
  });
});
