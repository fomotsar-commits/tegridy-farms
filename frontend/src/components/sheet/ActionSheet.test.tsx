// Island answer twenty-five, screen 1, build 3: the sheet's frame over the page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ActionSheet, DeepLinkSheet } from './ActionSheet';
import { BAYLA_MINT } from '../../lib/bungalows';
import { clearScreenMoves, useCurrentScreenMove } from '../../lib/screenMove';
import { holdSheetOutlet, resetSheetStore, useSheetOpen } from '../../lib/sheetStore';

// The sheet's own Solana connection is its own chunk: a stand-in here says whether it mounted.
vi.mock('./SheetSolana', () => ({ default: () => <p data-testid="own-connection">own connection</p> }));

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  const move = useCurrentScreenMove();
  const open = useSheetOpen();
  return (
    <>
      <p data-testid="where">{`${location.pathname}${location.search}`}</p>
      <p data-testid="move">{move ?? 'none'}</p>
      <p data-testid="open">{open ? `${open.kind}:${open.room?.id ?? 'no coin'}:${open.slot.dataset.testid}` : 'closed'}</p>
      <button type="button" onClick={() => navigate(-1)}>browser back</button>
    </>
  );
}

type Entry = string | { pathname: string; search: string; state: unknown };
function mount(entries: Entry[], index = entries.length - 1) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <Probe />
      <ActionSheet />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  clearScreenMoves();
  resetSheetStore();
});
afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

describe('the sheet', () => {
  it('rises over the room with the handle, Back, the coin and the form’s place, and nothing else', async () => {
    localStorage.setItem('tegridy-bungalow', 'bayla');
    mount(['/bayla?sheet=add']);
    const sheet = screen.getByRole('dialog', { name: 'Add SOL + BAYLA' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('sheet-veil')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Back to the room' })).toBeInTheDocument();
    const coin = within(sheet).getByTestId('sheet-coin');
    expect(within(coin).getByTestId('coin-name')).toHaveTextContent('BAYLA');
    expect(within(coin).getByTestId('coin-name')).toHaveAccessibleName(`BAYLA: copy its address ${BAYLA_MINT}`);
    expect(coin).toHaveTextContent('SOL + BAYLA pool · Solana');
    expect(within(sheet).getByTestId('sheet-body')).toBeEmptyDOMElement();
    // The form is drawn into the sheet's place: the store names it, with the room.
    expect(screen.getByTestId('open')).toHaveTextContent('add:bayla:sheet-body');
    // The page under the veil does not scroll while it is up.
    expect(document.body.style.overflow).toBe('hidden');
    await act(async () => {});
  });

  it('says it is up, so her header button goes quiet whatever her line says: the sheet’s button is her move', () => {
    localStorage.setItem('tegridy-bungalow', 'bayla');
    mount(['/bayla?sheet=add']);
    expect(screen.getByTestId('move')).toHaveTextContent('sheet');
    cleanup();
    mount(['/bayla?sheet=buy']);
    expect(screen.getByTestId('move')).toHaveTextContent('sheet');
    cleanup();
    mount(['/bayla']);
    expect(screen.getByTestId('move')).toHaveTextContent('none');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('takes focus itself, not its first control, so nothing is lit before a tap', async () => {
    localStorage.setItem('tegridy-bungalow', 'bayla');
    mount(['/bayla?sheet=add']);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Add SOL + BAYLA' }));
  });

  it('Back after a press on the page pops back to it: the room is still there', () => {
    localStorage.setItem('tegridy-bungalow', 'bayla');
    mount(['/earn', '/bayla', { pathname: '/bayla', search: '?sheet=add', state: { sheet: true } }]);
    fireEvent.click(screen.getByRole('button', { name: 'Back to the room' }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/bayla$/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('open')).toHaveTextContent('closed');
    expect(document.body.style.overflow).toBe('');
    // Popped, not replaced: the browser's Back from the room goes where the visitor was before it.
    fireEvent.click(screen.getByRole('button', { name: 'browser back' }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/earn$/);
  });

  it('Back after a link puts the room in the sheet’s place, so Back never leaves the site', () => {
    localStorage.setItem('tegridy-bungalow', 'bayla');
    mount(['/bayla?sheet=buy']);
    fireEvent.click(screen.getByRole('button', { name: 'Back to the room' }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/bayla$/);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape and a press on the veil close it too', () => {
    localStorage.setItem('tegridy-bungalow', 'bayla');
    mount(['/bayla?sheet=add']);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    mount(['/bayla?sheet=add']);
    fireEvent.click(screen.getByTestId('sheet-veil'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('with no room, Add’s bungalow row stands in the coin’s place; a pick names the coin and the sheet reads as drawn', () => {
    mount(['/launch?sheet=add']);
    const row = screen.getByRole('group', { name: 'Pick a coin' });
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['BAYLA', 'BOBO', 'SOY', 'BRAINLET', 'RIZZ']);
    expect(screen.getByTestId('open')).toHaveTextContent('closed');
    fireEvent.click(within(row).getByRole('button', { name: 'SOY' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/launch?sheet=add&coin=soy');
    expect(screen.getByRole('dialog', { name: 'Add SOL + SOY' })).toBeInTheDocument();
    expect(screen.getByTestId('sheet-coin')).toHaveTextContent('SOL + SOY pool · Solana');
    expect(screen.getByTestId('open')).toHaveTextContent('add:soy:sheet-body');
  });

  // Island answer twenty-seven: Buy's bungalow row is the form's own, above the amount, so its
  // "Any coin" can open the swap's own picker. The frame asks the form to draw with or without a coin.
  it('Buy asks the form to draw in every case: on the room’s coin, on the coin named, or with none on the row', async () => {
    localStorage.setItem('tegridy-bungalow', 'bayla');
    mount(['/bayla?sheet=buy']);
    expect(screen.getByRole('dialog', { name: 'Buy BAYLA' })).toBeInTheDocument();
    expect(screen.getByTestId('open')).toHaveTextContent('buy:bayla:sheet-body');
    // The coin is named by the form's row, which follows a pick from Any coin: the frame names none.
    expect(screen.queryByTestId('sheet-coin')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Pick a coin' })).toBeNull();
    cleanup();
    mount(['/bayla?sheet=buy&coin=bobo']);
    expect(screen.getByRole('dialog', { name: 'Buy BOBO' })).toBeInTheDocument();
    expect(screen.getByTestId('open')).toHaveTextContent('buy:bobo:sheet-body');
    cleanup();
    localStorage.clear();
    mount(['/?sheet=buy']);
    expect(screen.getByRole('dialog', { name: 'Buy' })).toBeInTheDocument();
    expect(screen.getByTestId('open')).toHaveTextContent('buy:no coin:sheet-body');
    // With no room the page has no Solana section of its own: the sheet brings its connection.
    expect(await screen.findByTestId('own-connection')).toBeInTheDocument();
  });

  it('a room the sheet cannot act on opens on no coin, never its own', () => {
    localStorage.setItem('tegridy-bungalow', 'pepe');
    mount(['/pepe?sheet=buy']);
    expect(screen.getByTestId('open')).toHaveTextContent('buy:no coin:sheet-body');
    expect(screen.queryByTestId('sheet-coin')).toBeNull();
    cleanup();
    mount(['/pepe?sheet=add']);
    expect(screen.getByRole('group', { name: 'Pick a coin' })).toBeInTheDocument();
    expect(screen.queryByTestId('sheet-coin')).toBeNull();
  });

  it('Escape inside a dialog over the form (the swap’s picker) closes that one, not the sheet', () => {
    localStorage.setItem('tegridy-bungalow', 'bayla');
    mount(['/bayla?sheet=buy']);
    const inner = document.createElement('div');
    inner.setAttribute('role', 'dialog');
    const field = document.createElement('input');
    inner.appendChild(field);
    screen.getByTestId('sheet-body').appendChild(inner);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Buy BAYLA' })).toBeInTheDocument();
    inner.remove();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Buy BAYLA' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Buy BAYLA' })).toBeNull();
  });

  it('brings its own Solana connection only where the page has none: one live connection per page', async () => {
    localStorage.setItem('tegridy-bungalow', 'bayla');
    mount(['/bayla?sheet=add']);
    expect(await screen.findByTestId('own-connection')).toBeInTheDocument();
    cleanup();
    resetSheetStore();
    const release = holdSheetOutlet(Symbol('page'));
    mount(['/bayla?sheet=add']);
    await act(async () => {});
    expect(screen.queryByTestId('own-connection')).toBeNull();
    release();
  });
});

describe('the island’s deep links', () => {
  function routes(entry: string) {
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="pools" element={<DeepLinkSheet><p>the pools page</p></DeepLinkSheet>} />
          <Route path="solana" element={<DeepLinkSheet><p>the swap page</p></DeepLinkSheet>} />
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
  }
  it('open the sheet over the coin’s room instead of a page', () => {
    routes(`/pools?mint=${BAYLA_MINT}&task=add`);
    expect(screen.getByTestId('where')).toHaveTextContent('/bayla?sheet=add');
    cleanup();
    routes(`/solana?out=${BAYLA_MINT}`);
    expect(screen.getByTestId('where')).toHaveTextContent('/bayla?sheet=buy');
  });
  it('leave every other address on those routes as the page it was', () => {
    routes(`/pools?mint=${BAYLA_MINT}`);
    expect(screen.getByText('the pools page')).toBeInTheDocument();
    cleanup();
    routes('/solana');
    expect(screen.getByText('the swap page')).toBeInTheDocument();
  });
});
