// What a wallet that cannot fund an Add or an Open is told to do next. A SOL pool's
// words are the ones it has always had; a pool paired with USDC or BAYLA can also be
// short of the coin, which is had on the swap like the token.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import { FundingNextStep } from './FundingNextStep';

const MINT = '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump';
const WALLET = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';

function mount(coin: QuoteCoin, needs: { sol?: boolean; coin?: boolean; token?: boolean }, wallet: string | null = null) {
  render(
    <MemoryRouter>
      <FundingNextStep coin={coin} needsSol={!!needs.sol} needsCoin={needs.coin} needsToken={!!needs.token} mint={MINT} wallet={wallet} />
    </MemoryRouter>,
  );
  return screen.queryByTestId('lp-funding-next');
}
/** The whole sentence, as it reads. */
const words = (el: HTMLElement | null) => el?.textContent?.replace(/\s+/g, ' ').trim();
const links = () => screen.queryAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);

const TOKEN_ONLY = 'Try this site’s Solana swap for the token (it opens on this token, by its address), then come back to this tab.';
const SOL_ONLY = 'Send SOL to this wallet, then come back to this tab.';

describe('FundingNextStep: a SOL pool says what it has always said', () => {
  it('short of SOL and of the token', () => {
    expect(words(mount(SOL_QUOTE, { sol: true, token: true }))).toBe(
      'Send SOL to this wallet first. With SOL in it, try this site’s Solana swap for the token (it opens on this token, by its address), then come back to this tab.',
    );
    expect(links()).toEqual([['this site’s Solana swap', `/solana?out=${MINT}`]]);
  });

  it('short of SOL only', () => {
    expect(words(mount(SOL_QUOTE, { sol: true }))).toBe(SOL_ONLY);
    expect(links()).toEqual([]);
  });

  it('short of the token only', () => {
    expect(words(mount(SOL_QUOTE, { token: true }))).toBe(TOKEN_ONLY);
    expect(links()).toEqual([['this site’s Solana swap', `/solana?out=${MINT}`]]);
  });

  it('short of nothing: nothing is shown', () => {
    expect(mount(SOL_QUOTE, {})).toBeNull();
  });

  it('SOL is its own coin: "holds none of the coin" adds nothing for a SOL pool', () => {
    expect(mount(SOL_QUOTE, { coin: true })).toBeNull();
    expect(words(mount(SOL_QUOTE, { coin: true, token: true }))).toBe(TOKEN_ONLY);
  });

  it('with a wallet connected, its address is one press to copy', () => {
    expect(words(mount(SOL_QUOTE, { sol: true }, WALLET))).toBe('Send SOL to this wallet, then come back to this tab. Copy this wallet’s address');
    expect(screen.getByRole('button', { name: /Copy this wallet’s address/ })).toBeInTheDocument();
  });
});

describe('FundingNextStep: a pool paired with USDC or BAYLA', () => {
  it.each([['USDC', USDC_QUOTE], ['BAYLA', BAYLA_QUOTE]] as const)('%s: short of the coin only: the swap, opened on the coin by its address', (symbol, coin) => {
    expect(words(mount(coin, { coin: true }))).toBe(`Try this site’s Solana swap for ${symbol} (it opens on ${symbol}, by its address), then come back to this tab.`);
    expect(links()).toEqual([['this site’s Solana swap', `/solana?out=${coin.mint}`]]);
  });

  it('short of the coin and the token: one link each, each by its own address', () => {
    expect(words(mount(USDC_QUOTE, { coin: true, token: true }))).toBe(
      'Try this site’s Solana swap for both: USDC and the token (each opens the swap on that one, by its address), then come back to this tab.',
    );
    expect(links()).toEqual([
      ['USDC', `/solana?out=${USDC_QUOTE.mint}`],
      ['the token', `/solana?out=${MINT}`],
    ]);
  });

  it('short of SOL for the costs and of the coin: SOL first, then the coin', () => {
    expect(words(mount(USDC_QUOTE, { sol: true, coin: true }))).toBe(
      'Send SOL to this wallet first. With SOL in it, try this site’s Solana swap for USDC (it opens on USDC, by its address), then come back to this tab.',
    );
    expect(links()).toEqual([['this site’s Solana swap', `/solana?out=${USDC_QUOTE.mint}`]]);
  });

  it('short of all three', () => {
    expect(words(mount(USDC_QUOTE, { sol: true, coin: true, token: true }))).toBe(
      'Send SOL to this wallet first. With SOL in it, try this site’s Solana swap for both: USDC and the token (each opens the swap on that one, by its address), then come back to this tab.',
    );
    expect(links()).toHaveLength(2);
  });

  it('short of SOL for the costs only: the same words as a SOL pool', () => {
    expect(words(mount(USDC_QUOTE, { sol: true }))).toBe(SOL_ONLY);
  });

  it('short of the token only: the swap opens on the token, never on the coin', () => {
    expect(words(mount(USDC_QUOTE, { token: true }))).toBe(TOKEN_ONLY);
    expect(links()).toEqual([['this site’s Solana swap', `/solana?out=${MINT}`]]);
  });

  it('short of nothing: nothing is shown', () => {
    expect(mount(USDC_QUOTE, {})).toBeNull();
  });
});

// Each target's finger-sized press area reaches over the lines above and below, so on a
// phone the Copy button's area lies over the swap link's words and the link's area over
// the button's. Which one a press hits is decided by the layers alone. A real browser
// (2026-10-06, 320 and 390 wide) showed what each one holds: without the Copy button's
// layer a press on "Copy this wallet's address" opened the swap page, and without the
// layer on a link's words a press on the link copied the address. jsdom lays nothing
// out, so this reads the layers themselves.
describe('FundingNextStep: overlapping press areas are layered, so a press on a target’s words is that target', () => {
  const positioned = (el: Element) => el.classList.contains('relative');
  /** The stacking layer a positioned element asks for: `z-N`, or 0 with none. */
  const layer = (el: Element) => {
    const z = Array.from(el.classList).find((c) => /^z-\d+$/.test(c));
    return z ? Number(z.slice(2)) : 0;
  };

  it('link words over the Copy button, the Copy button over the bare areas, all inside the sentence', () => {
    const sentence = mount(USDC_QUOTE, { sol: true, coin: true, token: true }, WALLET)!;
    const copy = screen.getByRole('button', { name: /Copy this wallet’s address/ });
    const swaps = screen.getAllByRole('link');
    expect(swaps).toHaveLength(2);
    // The layers stay inside the sentence: none of them is weighed against the page's own.
    expect(sentence.classList.contains('isolate')).toBe(true);
    for (const target of [copy, ...swaps]) expect(positioned(target), `${target.textContent} is not positioned`).toBe(true);
    for (const swap of swaps) {
      const text = swap.querySelector('span')!;
      expect(text.textContent).toBe(swap.textContent);
      expect(positioned(text)).toBe(true);
      // The link's bare area is under the Copy button; its words are over it.
      expect(layer(swap)).toBeLessThan(layer(copy));
      expect(layer(text)).toBeGreaterThan(layer(copy));
    }
    // The Copy button comes before the links: among equals, the later one is on top.
    expect(copy.compareDocumentPosition(swaps[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Round the press area the keyboard's ring is 53px tall on a 21px line and strikes
  // through the lines above and below. `ring-on-words` (index.css) takes it off the
  // target and puts it on the `ring-words` inside, so each target needs exactly one.
  it('the keyboard’s ring goes round each target’s words, not its press area', () => {
    mount(USDC_QUOTE, { sol: true, coin: true, token: true }, WALLET);
    const targets = [screen.getByRole('button', { name: /Copy this wallet’s address/ }), ...screen.getAllByRole('link')];
    expect(targets).toHaveLength(3);
    for (const target of targets) {
      expect(target.classList.contains('ring-on-words'), `${target.textContent} keeps the ring on its area`).toBe(true);
      const ringed = target.querySelectorAll('.ring-words');
      expect(ringed).toHaveLength(1);
      expect(ringed[0]!.textContent).toBe(target.textContent);
    }
  });
});
