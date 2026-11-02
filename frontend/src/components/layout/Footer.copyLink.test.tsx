// Island answer twenty-four: this page's link is one press away on every screen. The footer
// is on every route, so the press lives there: 44px, "Copied" for one second, and the link of
// the page the visitor is on now, not the one the footer first drew on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { Footer } from './Footer';

const press = () => screen.getByRole('button', { name: /^Copy this page's link/ });

describe('the footer’s copy-this-page’s-link press', () => {
  const writeText = vi.fn(async () => {});
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    window.history.replaceState(null, '', '/swap?in=So11111111111111111111111111111111111111112#pay');
  });
  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, '', '/');
  });

  it('is one 44px press, outside the eight links, that copies the whole address of this page', async () => {
    render(
      <BrowserRouter>
        <Footer />
      </BrowserRouter>,
    );
    expect(press().className).toContain('min-h-[44px]');
    expect(press().closest('nav')).toBeNull();
    await act(async () => {
      fireEvent.click(press());
    });
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/swap\?in=So1{40}2#pay$/));
  });

  it('says Copied for one second', async () => {
    vi.useFakeTimers();
    render(
      <BrowserRouter>
        <Footer />
      </BrowserRouter>,
    );
    await act(async () => {
      fireEvent.click(press());
    });
    expect(within(press()).getByText('Copied')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(within(press()).getByText('Copied')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(within(press()).queryByText('Copied')).toBeNull();
  });

  it('copies the page the visitor moved to, not the one the footer first drew on', async () => {
    render(
      <BrowserRouter>
        <Footer />
      </BrowserRouter>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'FAQ' }));
    expect(window.location.pathname).toBe('/faq');
    await act(async () => {
      fireEvent.click(press());
    });
    expect(writeText).toHaveBeenLastCalledWith(window.location.href);
    expect(writeText).toHaveBeenLastCalledWith(expect.stringMatching(/\/faq$/));
  });
});
