// Picking a bungalow walks through its door inside the app: the router moves to
// /<id> and the door there changes the skin in place. A document navigation
// would load the app again for a switch the door already makes.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { BungalowPicker } from './BungalowPicker';
import { ThemeProvider } from '../contexts/ThemeContext';
import { BUNGALOW_STORAGE_KEY, BUNGALOWS } from '../lib/bungalows';

let realLocation: Location;

afterEach(() => {
  if (realLocation) Object.defineProperty(window, 'location', { configurable: true, writable: true, value: realLocation });
  localStorage.clear();
  vi.restoreAllMocks();
});

function mockDocumentNavigation() {
  realLocation = window.location;
  const assign = vi.fn();
  const reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: 'http://localhost/farm', search: '', pathname: '/farm', assign, reload },
  });
  return { assign, reload };
}

function renderPicker(onClose = vi.fn()) {
  let path = '';
  function WhereAmI() {
    path = useLocation().pathname;
    return null;
  }
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/farm']}>
        <BungalowPicker open onClose={onClose} />
        <WhereAmI />
      </MemoryRouter>
    </ThemeProvider>,
  );
  return { onClose, path: () => path };
}

function card(name: string) {
  return screen.getAllByRole('button').find((b) => b.textContent?.startsWith(name))!;
}

describe('BungalowPicker', () => {
  const target = BUNGALOWS.find((b) => b.live && b.id !== 'bayla' && b.id !== 'toweli')!;

  it('enters a live bungalow through its door inside the app', () => {
    const { assign, reload } = mockDocumentNavigation();
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    const picker = renderPicker();
    fireEvent.click(card(target.name));
    expect(assign, 'no document navigation').not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(picker.path()).toBe(`/${target.id}`);
    expect(picker.onClose).toHaveBeenCalled();
  });

  it('the current bungalow just closes the hall', () => {
    const { assign } = mockDocumentNavigation();
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    const picker = renderPicker();
    fireEvent.click(card('Bayla'));
    expect(assign).not.toHaveBeenCalled();
    expect(picker.path()).toBe('/farm');
    expect(picker.onClose).toHaveBeenCalled();
  });

  it('"Stay here" keeps the current skin and marks the hall as seen', () => {
    mockDocumentNavigation();
    const picker = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Stay here' }));
    expect(localStorage.getItem(BUNGALOW_STORAGE_KEY)).toBe('venue');
    expect(picker.path()).toBe('/farm');
    expect(picker.onClose).toHaveBeenCalled();
  });
});
