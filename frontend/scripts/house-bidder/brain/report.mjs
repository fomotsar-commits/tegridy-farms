// The monthly report, from the ledger alone: what the house bid, how long its bids stood, why it
// cancelled, what it bought. These are the figures the integrity rules promise to publish
// (cancel-to-fill ratio, resting times, price changes), so they are computed from the record,
// not from anything the bot believes about itself.

import { eth, median, toSec, toWei } from './util.mjs';

const HOUR = 3_600_000;

function monthWindow(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`"${month}" is not a month such as 2026-11`);
  const start = Date.parse(`${month}-01T00:00:00Z`);
  const [y, m] = month.split('-').map(Number);
  const end = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
  return { start, end };
}

/** Total length of a set of [from, to) intervals, overlaps counted once. */
function unionMs(intervals) {
  const s = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of s) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/**
 * @param {object[]} entries  ledger lines
 * @param {{ month: string, shadow?: boolean, nowMs: number }} opts
 */
export function monthlyReport(entries, { month, shadow = false, nowMs }) {
  const { start, end } = monthWindow(month);
  const mine = entries.filter((e) => Boolean(e.shadow) === shadow);
  const orders = new Map();
  for (const e of mine) {
    if (e.kind === 'post') orders.set(e.orderHash, { ...e, postedAt: e.at, endMs: (toSec(e.endTime) ?? 0) * 1000, standingEnd: null, fills: 0, cancel: null });
  }
  for (const e of mine) {
    const o = orders.get(e.orderHash);
    if (!o) continue;
    if (e.kind === 'cancel' && !o.cancel) o.cancel = e;
    if (e.kind === 'fill') {
      o.fills += 1;
      if (o.fills >= Number(o.qty) && o.standingEnd === null) o.standingEnd = e.at;
    }
  }
  const capNow = Math.min(end, nowMs);
  for (const o of orders.values()) {
    const ends = [o.endMs, capNow];
    if (o.cancel) ends.push(o.cancel.at);
    if (o.standingEnd !== null) ends.push(o.standingEnd);
    o.standingEnd = Math.min(...ends);
  }
  const inMonth = (at) => at >= start && at < end;

  const perSlug = {};
  const slot = (slug) => (perSlug[slug] ??= { intervals: [], posted: 0, priceChanges: 0, fills: 0, wethSpent: 0n });
  const lastPrice = {};
  for (const o of [...orders.values()].sort((a, b) => a.postedAt - b.postedAt)) {
    const s = slot(o.slug);
    const price = toWei(o.unitPriceWei, 'price');
    if (inMonth(o.postedAt)) {
      s.posted += 1;
      if (lastPrice[o.slug] !== undefined && lastPrice[o.slug] !== price) s.priceChanges += 1;
    }
    lastPrice[o.slug] = price;
    s.intervals.push([Math.max(o.postedAt, start), Math.min(o.standingEnd, end)]);
  }

  const cancelled = {};
  let cancels = 0;
  let expired = 0;
  const breakers = {};
  const inventory = {};
  let fills = 0;
  let wethSpent = 0n;
  for (const e of mine) {
    if (e.kind === 'fill') {
      const inv = (inventory[e.slug] ??= { held: 0, costWei: 0n });
      if (e.at < end) {
        inv.held += 1;
        inv.costWei += toWei(e.unitPriceWei, 'fill price');
      }
      if (inMonth(e.at)) {
        fills += 1;
        wethSpent += toWei(e.unitPriceWei, 'fill price');
        slot(e.slug).fills += 1;
      }
    }
    if (!inMonth(e.at)) continue;
    if (e.kind === 'cancel') {
      cancels += 1;
      cancelled[e.reason] = (cancelled[e.reason] ?? 0) + 1;
    }
    if (e.kind === 'expiry') expired += 1;
    if (e.kind === 'breaker') breakers[`${e.breaker}:${e.reason}`] = (breakers[`${e.breaker}:${e.reason}`] ?? 0) + 1;
  }
  const resting = [...orders.values()].filter((o) => inMonth(o.postedAt)).map((o) => (o.standingEnd - o.postedAt) / 60_000);

  return {
    month,
    shadow,
    hoursWithLiveBid: unionMs(Object.values(perSlug).flatMap((s) => s.intervals)) / HOUR,
    collections: Object.fromEntries(Object.entries(perSlug).map(([slug, s]) => [slug, { hoursWithLiveBid: unionMs(s.intervals) / HOUR, posted: s.posted, priceChanges: s.priceChanges, fills: s.fills }])),
    posted: Object.values(perSlug).reduce((n, s) => n + s.posted, 0),
    expired,
    cancelledByReason: cancelled,
    priceChanges: Object.values(perSlug).reduce((n, s) => n + s.priceChanges, 0),
    fills,
    wethSpent,
    cancelToFill: fills ? cancels / fills : null,
    medianRestingMinutes: resting.length ? median(resting) : null,
    inventory,
    breakers,
  };
}

/** The report as plain text for the terminal. */
export function reportText(r) {
  const lines = [];
  lines.push(`House bidder, ${r.month}${r.shadow ? ' (SHADOW: nothing here was real)' : ''}`);
  lines.push(`  hours with a live bid   ${r.hoursWithLiveBid.toFixed(1)}`);
  for (const [slug, c] of Object.entries(r.collections)) lines.push(`    ${slug.padEnd(10)} ${c.hoursWithLiveBid.toFixed(1)} h, ${c.posted} bids, ${c.priceChanges} price changes, ${c.fills} bought`);
  lines.push(`  bids posted             ${r.posted}`);
  lines.push(`  bids expired            ${r.expired}`);
  const reasons = Object.entries(r.cancelledByReason);
  lines.push(`  cancelled early         ${reasons.length ? reasons.map(([k, v]) => `${k} ${v}`).join(', ') : 'none'}`);
  lines.push(`  price changes           ${r.priceChanges}`);
  lines.push(`  NFTs bought             ${r.fills} for ${eth(r.wethSpent)} WETH`);
  lines.push(`  cancel-to-fill ratio    ${r.cancelToFill === null ? 'n/a (nothing bought)' : r.cancelToFill.toFixed(2)}`);
  lines.push(`  median resting time     ${r.medianRestingMinutes === null ? 'n/a' : `${r.medianRestingMinutes.toFixed(1)} min`}`);
  for (const [slug, inv] of Object.entries(r.inventory)) lines.push(`  held at month end       ${slug}: ${inv.held}, cost ${eth(inv.costWei)} WETH`);
  const b = Object.entries(r.breakers);
  lines.push(`  breaker trips           ${b.length ? b.map(([k, v]) => `${k} ${v}`).join(', ') : 'none'}`);
  return lines.join('\n');
}
