// @vitest-environment jsdom
/* global document, window */
//
// The board's page script, fed a status.json: every figure written as text, a halt said plainly.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HERE = resolve(process.cwd(), 'scripts', 'house-bidder', 'exec');
const html = readFileSync(resolve(HERE, 'board.html'), 'utf8');
const app = readFileSync(resolve(HERE, 'board.js'), 'utf8');

const status = (over = {}) => ({
  at: '2026-11-16T12:00:00.000Z',
  mode: 'live',
  house: '0xbd00483ccb69c4fcc2f9f28e87fc29eeb308effa',
  gate: { canPost: true, maxQty: null, reason: null },
  halted: null,
  paused: null,
  capped: null,
  trips: [],
  chain: { block: 26500000, weth: '200000000000000000', allowance: '105000000000000000', counter: '7', eth: '50000000000000000' },
  today: { units: 1, wethSpent: '35000000000000000', txs: 2 },
  stream: { gaps: 0 },
  collections: {
    junglebay: { ticker: 'JBAC', enabled: true, F: '40000000000000000', S: '41000000000000000', L: '50000000000000000', cheapestFillable: '49980000000000000', standing: { orderHash: '0x01', unitPriceWei: '35200000000000000', qty: 2, filled: 0, endTime: 1794832200 }, plan: { unitPriceWei: '35200000000000000', qty: 2, binding: 'fair' }, held: 1, outstanding: 2, tailUnits: 0 },
  },
  lastTickAt: new Date().toISOString(),
  errors: [{ at: Date.now(), line: '<img src=x onerror=alert(1)>' }],
  ...over,
});

async function render(s) {
  document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, '');
  globalThis.fetch = async () => ({ json: async () => s });
  window.fetch = globalThis.fetch;
  new Function(app)();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('board page', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '';
  });

  it('shows the standing bid, fair value and wallet as text', async () => {
    await render(status());
    const text = document.body.textContent;
    expect(text).toContain('JBAC (junglebay)');
    expect(text).toContain('0.0352 ETH × 2 (0 filled)');
    expect(text).toContain('fair value F0.04 ETH');
    expect(document.getElementById('state').textContent).toBe('Bidding');
  });

  it('writes a problem line as text, never as HTML', async () => {
    await render(status());
    expect(document.querySelector('#errors img')).toBe(null);
    expect(document.getElementById('errors').textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('says a halt plainly, and how a person restarts it', async () => {
    await render(status({ halted: { reason: 'insider-fill', detail: 'the seller 0x55 is an insider' } }));
    expect(document.getElementById('state').textContent).toMatch(/^HALTED \(insider-fill\).*--ack-halt/);
  });
});
