// @vitest-environment jsdom
/* global document */
//
// The robot's dashboard page with the scanner merged in: the page's own HTML and script, fed
// what the dashboard streams. A scanner that is off is said plainly while the robot's half keeps
// working; every coin shows its claimed ticker beside its whole address, written as text; the
// headline, the funnel and the profit/ROI order follow the figures.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { scannerView } from '../src/lib/solana/keeper/scannerView.ts';

const HERE = resolve(process.cwd(), 'scripts');
const html = readFileSync(resolve(HERE, 'price-keeper-dashboard.html'), 'utf8');
const app = readFileSync(resolve(HERE, 'price-keeper-dashboard.js'), 'utf8');

const SOL = 'So11111111111111111111111111111111111111112';
const addr = () => Keypair.generate().publicKey.toBase58();
const NOW = Date.now();

const trip = (symbol, over = {}) => {
  const mint = addr();
  return {
    mint, symbol, ours: true, coin: SOL,
    legs: [
      { pool: addr(), dex: 'pumpswap', venue: 'PumpSwap', from: SOL, to: mint, fee: 0.003 },
      { pool: addr(), dex: 'ours', venue: 'Tegriddy Farms (ours)', from: mint, to: SOL, fee: 0.01 },
    ],
    gapPct: 19.58, costPct: 1.3, inUsd: 10.39, netUsd: 0.5, roiPct: 2, gapInUsd: 10.39, gapNetUsd: 0.5, capUsd: 25, floatUsd: 60.86,
    sizedBy: 'gap', robotTakes: true, why: null, proof: null, ...over,
  };
};
const scannerPage = (over = {}) => ({
  at: NOW, slot: 466_006_442, note: null, solUsd: 89.5,
  holds: { SOL: 0.68, USDC: 11.9 }, holdsUsd: { SOL: 60.85, USDC: 11.9 },
  rule: { capUsd: 25, settingUsd: 25, safeCapUsd: 25, minProfitUsd: 0.01, feeLamports: 19_000, floorUsd: { SOL: 0.0117, USDC: 0.0117 }, lighthouse: { proven: true, why: null } },
  coins: 70, pools: 120, looked: 70, cycleAt: NOW, refused: [],
  stats: { scans: 21_429, paying: 392, tried: 6, passed: 1, routesPassed: 1, hours: 6.6 },
  take: [], watch: [], closest: [], ...over,
});
const live = (page) => ({ page: '127.0.0.1:8795', view: scannerView(page), readAt: NOW, problem: null });
const robot = { at: new Date(NOW).toISOString(), hold: null, pass: { at: new Date(NOW).toISOString(), pools: 22, gaps: 2, sent: 0 }, spentTodaySol: 0.006, maxDailySol: 0.05, checkSec: 10, intervalSec: 60 };

let stream;
function load() {
  document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, '');
  globalThis.EventSource = class {
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      stream = this;
    }
  };
  globalThis.requestAnimationFrame ??= (f) => setTimeout(f, 0);
  globalThis.cancelAnimationFrame ??= (t) => clearTimeout(t);
  new Function(app)();
}
const send = (s) => stream.onmessage({ data: JSON.stringify(s) });
const $ = (id) => document.getElementById(id);

beforeEach(load);

describe('the dashboard page with the scanner merged in', () => {
  it('reads its stream from its own address only', () => {
    expect(stream.url).toBe('/events');
  });

  it('says plainly when the scanner is off, and the robot’s half keeps working', () => {
    send({ robot, stopped: false, scanner: { page: null, view: null, readAt: null, problem: 'nothing answers at 127.0.0.1:8795: the scanner is not running' } });
    expect($('hlText').textContent).toMatch(/^The scanner is off\. The robot is running\.$/);
    expect($('scanOff').hidden).toBe(false);
    expect($('scanOff').textContent).toContain('nothing answers at 127.0.0.1:8795: the scanner is not running');
    expect($('scanOff').textContent).toContain('The robot\'s figures are not affected');
    expect($('market').classList.contains('off')).toBe(true);
    expect($('scanLamp').textContent).toContain('off');
    expect($('tRobot').textContent).toBe('Running');
  });

  it('shows a coin’s claimed ticker beside its whole address, as text', () => {
    const t = trip('<img src=x onerror=alert(1)>');
    send({ robot, stopped: false, scanner: live(scannerPage({ watch: [t] })) });
    expect(document.querySelector('img')).toBeNull();
    const card = $('watch').querySelector('.card');
    const claims = card.querySelector('.claims');
    expect(claims.textContent).toBe('<img src=x onerror=alert(1)>'.slice(0, 24));
    expect(claims.nextElementSibling.textContent).toBe('in our pools');
    expect(card.querySelector('.cardTop .addr').textContent).toBe(t.mint);
    // Every pool's whole address, each leg with its venue and fee.
    expect([...card.querySelectorAll('.venue')].map((v) => [v.querySelector('b').textContent, v.querySelector('.addr').textContent])).toEqual([
      ['PumpSwap · 0.300%', t.legs[0].pool],
      ['Tegriddy Farms (ours) · 1.00%', t.legs[1].pool],
    ]);
    expect(card.querySelector('.venue.ours .addr').getAttribute('href')).toBe(`https://solscan.io/account/${t.legs[1].pool}`);
  });

  it('says what held each trip back, and who gets paid', () => {
    send({ robot, stopped: false, scanner: live(scannerPage({ watch: [trip('SOY', { sizedBy: 'float', floatUsd: 8, inUsd: 8 })] })) });
    const card = $('watch').querySelector('.card');
    expect(card.querySelector('.fence.held').textContent).toBe('Float$8.00');
    expect(card.querySelectorAll('.fence.held')).toHaveLength(1);
    expect(card.querySelector('.mk + .fence, .meters').textContent).toContain('held by all the robot holds');
    expect(card.querySelector('.paid').textContent).toBe('Who gets paid: the robot +$0.500 est., the gap, paid by the liquidity providers of the pools it trades against; our venue its share of our pool’s 1.00% fee; PumpSwap its 0.300%.');
  });

  it('ranks by profit, or by ROI at the switch', () => {
    const a = trip('AAA', { netUsd: 0.5, roiPct: 2 });
    const b = trip('BBB', { netUsd: 0.2, roiPct: 9 });
    send({ robot, stopped: false, scanner: live(scannerPage({ watch: [b, a] })) });
    const order = () => [...$('watch').querySelectorAll('.claims')].map((c) => c.textContent);
    expect(order()).toEqual(['AAA', 'BBB']);
    $('byRoi').click();
    expect(order()).toEqual(['BBB', 'AAA']);
    expect($('byRoi').getAttribute('aria-pressed')).toBe('true');
    expect($('watch').querySelector('.big').textContent).toBe('9.00%');
    $('byProfit').click();
    expect(order()).toEqual(['AAA', 'BBB']);
  });

  it('heads the page with what is on the table', () => {
    send({ robot, stopped: false, scanner: live(scannerPage({ watch: [trip('SOY', { proof: { ok: false, quiet: true, why: 'quiet', at: NOW } })] })) });
    expect($('hlText').textContent).toBe('+$0.500 est. shows on SOY, not proven: a pool in it has been quiet for an hour. The robot is running.');
    send({ robot, stopped: false, scanner: live(scannerPage({ take: [trip('SOY', { proof: { ok: true, at: NOW, gainedUsd: 0.48, units: 120_000 } })] })) });
    expect($('hlText').textContent).toBe('1 trip passes the test run · best est. +$0.500 on SOY. The robot is running.');
    expect($('take').querySelector('.stamp').textContent).toBe('✓ test run passed');
    expect($('take').querySelector('.big').textContent).toBe('+$0.480');
    send({ robot, stopped: false, scanner: live(scannerPage()) });
    expect($('hlText').textContent).toBe('Nothing on the table. The robot is running and waiting.');
  });

  it('draws the funnel from the scanner’s counts an hour to the robot’s trades', () => {
    send({ robot, stopped: false, scanner: live(scannerPage()) });
    const cells = [...$('spine').children].filter((li) => !li.classList.contains('seam'));
    expect(cells.map((c) => c.querySelector('.v').textContent)).toEqual(['21,429', '392', '6', '1', '…', '…']);
    expect(cells[1].querySelector('.s').textContent).toBe('59.4 an hour · 1.8% of those scanned');
    expect(cells[3].querySelector('.s').textContent).toBe('0.2 an hour · 1 different route · 16.7% of those tried');
    expect(cells[4].querySelector('.s').textContent).toBe('last pass: 22 pools → 2 gaps → 0 sent');
  });

  it('keeps nearest-to-paying in the scanner’s own order, with how far short', () => {
    const near = [trip('NEAR', { gapPct: 0.578, costPct: 1.25, netUsd: 0 }), trip('FAR', { gapPct: 0.1, costPct: 1.25, netUsd: 0.1 })];
    send({ robot, stopped: false, scanner: live(scannerPage({ closest: near })) });
    expect([...$('closest').querySelectorAll('.claims')].map((c) => c.textContent)).toEqual(['NEAR', 'FAR']);
    expect($('closest').querySelector('.ml').textContent).toBe('0.672% short: gap 0.578% against fees 1.25%');
  });
});
