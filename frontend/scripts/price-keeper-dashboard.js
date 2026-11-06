// The price keeper's dashboard page script (scripts/price-keeper-dashboard.html), served as
// /app.js by `node scripts/price-keeper.mjs dashboard`: the only script the page's content
// security policy lets run. It reads /state.json and writes every figure as text: coin names
// are the coins' own claims, so nothing is ever written as HTML. It runs in the browser.
/* global document, window, Node, EventSource, requestAnimationFrame, cancelAnimationFrame */
(() => {
  const $ = (id) => document.getElementById(id);
  const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const k of kids) if (k !== null && k !== undefined) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  }
  // The same, for the curve's SVG.
  function svg(tag, attrs, ...kids) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
    for (const k of kids) if (k !== null && k !== undefined) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  }
  const fill = (id, ...kids) => $(id).replaceChildren(...kids);
  const solscan = (kind, id) => B58.test(id) ? el('a', { href: `https://solscan.io/${kind}/${id}`, target: '_blank', rel: 'noopener noreferrer', text: 'Solscan ↗' }) : null;
  const usd = (v) => {
    if (v === null || v === undefined) return 'not priced';
    const a = Math.abs(v);
    const d = a >= 100 ? 0 : a >= 1 ? 2 : 3;
    return (v < 0 ? '−$' : '$') + a.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  const signedUsd = (v) => (v === null ? 'not priced' : (v > 0 ? '+' : '') + usd(v));
  const amount = (v, signed) => {
    const a = Math.abs(v);
    const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.000001 ? 6 : 9;
    const s = a.toLocaleString(undefined, { maximumFractionDigits: d });
    return (v < 0 ? '−' : signed && v > 0 ? '+' : '') + s;
  };
  const sol = (v, signed) => amount(v, signed) + ' SOL';
  const ago = (ms) => {
    const s = Math.round(ms / 1000);
    return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  };
  const swatch = (color) => (color ? el('span', { class: 'swatch', style: `background:${color}` }) : null);
  const coinCell = (c, color) => el('div', { class: 'coin' }, swatch(color), el('b', { text: c.symbol || '?' }), c.onVenue ? null : el('span', { class: 'muted', text: ' · on no pool of ours' }), el('div', { class: 'addr', text: c.mint }));
  const coinList = (list, signed) => list.length
    ? el('div', {}, ...list.map((c) => el('div', {}, `${amount(c.amount, signed)} `, el('b', { text: c.symbol || '?' }), c.usd === null ? el('span', { class: 'muted', text: ' (not priced)' }) : el('span', { class: 'muted', text: ` (${usd(c.usd)})` }), el('div', { class: 'addr', text: c.mint }))))
    : el('span', { class: 'empty', text: 'none' });
  const pair = (dt, dd) => [el('dt', { text: dt }), el('dd', {}, dd)];
  const status = (cls, text) => el('span', {}, el('span', { class: `dot ${cls}` }), text);
  const signClass = (v) => (v > 0 ? 'gain' : v < 0 ? 'loss' : '');
  const poolName = (p) => `${p.symbol || '?'} / ${p.quote || '?'}`;
  const day = (secs) => new Date(secs * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  function robotState(s) {
    const r = s.robot;
    if (s.stopped) return { cls: 'warn', text: 'Paused', sub: 'the stop file exists' };
    if (!r) return { cls: 'crit', text: 'No report', sub: s.robotNote === 'no status yet' ? 'it reports once restarted with this version' : s.robotNote };
    const age = Date.now() - Date.parse(r.at);
    if (!(age < 5 * 60_000)) return { cls: 'crit', text: 'Not seen', sub: `last report ${ago(age)}` };
    if (r.hold) return { cls: 'warn', text: 'Paused', sub: r.hold };
    return { cls: 'good', text: 'Running', sub: `last report ${ago(age)}` };
  }

  // The trades and leftover sales the chain took, oldest first, from the list below; and whether
  // that list holds every one of them (it holds the latest 50 activities).
  function tripsOf(s) {
    const trips = s.recent.filter((a) => (a.kind === 'trade' || a.kind === 'sale') && a.ok && a.at).sort((x, y) => x.at - y.at);
    return { trips, all: trips.length === s.results.trades + s.results.sales };
  }
  const span = (t) => (t.all ? `every trade since ${day(t.trips[0].at)}` : `its last ${t.trips.length} trades, in the list below`);

  // What a trip's gap paid, in the coin its pool is priced in: SOL, or USDC for a USDC pool (a
  // USDC trip's gain is among its coins, its SOL change only the fee), and that at today's prices.
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  function paid(a, solUsd) {
    if (a.pools.length && a.pools[0].quote === 'USDC') {
      const c = a.coins.find((x) => x.mint === USDC);
      return { coin: 'USDC', amount: c ? c.amount : 0, usd: c ? c.usd : 0 };
    }
    return { coin: 'SOL', amount: a.sol, usd: solUsd === null ? null : a.sol * solUsd };
  }

  // What the trades made, trade by trade: the gaps closed, in dollars at today's prices, before fees.
  function drawCurve(s) {
    const box = $('curve');
    const t = tripsOf(s);
    if (!t.trips.length || s.solUsd === null) {
      box.replaceChildren();
      $('curveNote').textContent = t.trips.length ? 'No SOL price in this read, so no curve until the next one.' : 'The curve starts with its first trade.';
      $('curveEnd').textContent = '';
      return;
    }
    const W = Math.max(280, Math.round(box.getBoundingClientRect().width || 640));
    const H = 170;
    const pad = { l: 2, r: 10, t: 16, b: 22 };
    let run = 0;
    const pts = t.trips.map((a) => {
      const got = paid(a, s.solUsd);
      return { a, got, t: a.at, v: (run += got.usd ?? 0) };
    });
    const t0 = pts[0].t;
    const t1 = Math.max(pts[pts.length - 1].t, Math.floor(Date.now() / 1000));
    const vs = pts.map((p) => p.v);
    const hi = Math.max(0, ...vs);
    const lo = Math.min(0, ...vs);
    const x = (v) => pad.l + (t1 === t0 ? 0 : (v - t0) / (t1 - t0)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (hi === lo ? 1 : (hi - v) / (hi - lo)) * (H - pad.t - pad.b);
    let line = `M${x(t0)},${y(0)}`;
    for (const p of pts) line += ` H${x(p.t)} V${y(p.v)}`;
    line += ` H${x(t1)}`;
    box.setAttribute('viewBox', `0 0 ${W} ${H}`);
    box.replaceChildren(
      svg('defs', {}, svg('linearGradient', { id: 'curveFill', x1: 0, y1: 0, x2: 0, y2: 1 },
        svg('stop', { offset: '0%', 'stop-color': 'oklch(91% 0.21 128)', 'stop-opacity': 0.32 }),
        svg('stop', { offset: '100%', 'stop-color': 'oklch(91% 0.21 128)', 'stop-opacity': 0 }))),
      svg('line', { class: 'axis', x1: 0, x2: W, y1: y(0), y2: y(0) }),
      svg('line', { class: 'axis', x1: 0, x2: W, y1: y(hi), y2: y(hi), 'stroke-dasharray': '2 6' }),
      svg('path', { class: 'area', d: `${line} V${y(0)} H${x(t0)} Z` }),
      svg('path', { class: 'line', d: line }),
      ...pts.map((p) => svg('circle', { class: 'dot', cx: x(p.t), cy: y(p.v), r: 3 },
        svg('title', {}, `${new Date(p.t * 1000).toLocaleString()} · ${amount(p.got.amount, true)} ${p.got.coin} (${signedUsd(p.got.usd)}) · ${p.a.pools.length ? p.a.pools.map(poolName).join(' ⇄ ') : 'leftover sale'}`))),
      svg('circle', { class: 'now', cx: x(t1), cy: y(run), r: 3.5 }),
      svg('text', { class: 'tick', x: W - pad.r, y: y(hi) - 5, 'text-anchor': 'end' }, signedUsd(hi)),
      svg('text', { class: 'tick', x: pad.l, y: H - 4 }, day(t0)),
      svg('text', { class: 'tick', x: W - pad.r, y: H - 4, 'text-anchor': 'end' }, 'now'));
    $('curveNote').textContent = `What the gaps it closed paid, in dollars at today's prices, before fees: ${span(t)}`;
    $('curveEnd').textContent = signedUsd(run);
  }

  // What the wallet holds, as one bar by worth: wrapped SOL is what it trades with.
  function drawMix(s) {
    const h = s.holdings;
    const parts = [];
    if (s.solUsd !== null) {
      parts.push({ name: 'SOL for fees', usd: h.solPlain * s.solUsd, color: 'oklch(91% 0.21 128 / 0.45)' });
      parts.push({ name: 'SOL wrapped, for trading', usd: h.solWrapped * s.solUsd, color: 'oklch(91% 0.21 128)' });
    }
    const coins = h.coins.filter((c) => c.onVenue && c.usd !== null && c.usd > 0).sort((a, b) => b.usd - a.usd);
    coins.forEach((c, i) => parts.push({ name: c.symbol || '?', mint: c.mint, usd: c.usd, color: `oklch(${Math.max(38, 78 - i * 7)}% 0.025 265)` }));
    const total = parts.reduce((a, p) => a + p.usd, 0);
    fill('mix', ...(total > 0 ? parts.filter((p) => p.usd > 0).map((p) => el('i', {
      style: `flex:${p.usd} 1 0;background:${p.color}`,
      title: `${p.name} · ${usd(p.usd)} (${((p.usd / total) * 100).toFixed(1)}%)`,
    })) : []));
    return new Map(parts.map((p) => [p.mint || p.name, p.color]));
  }

  // Which pools' gaps paid: what the gaps closed in each paid, in its own coin, before fees.
  function drawPools(s) {
    const t = tripsOf(s);
    const by = new Map();
    for (const a of t.trips) {
      const key = a.pools.length ? a.pools.map((p) => p.pool).join(' ') : 'sale';
      const got = paid(a, s.solUsd);
      const was = by.get(key) || { pools: a.pools, coin: got.coin, amount: 0, usd: 0, n: 0 };
      by.set(key, { ...was, amount: was.amount + got.amount, usd: was.usd + (got.usd ?? 0), n: was.n + 1 });
    }
    const rows = [...by.values()].sort((a, b) => b.usd - a.usd);
    const top = Math.max(...rows.map((r) => Math.abs(r.usd)), 0);
    fill('pools', ...(rows.length ? rows.map((r) => el('div', { class: 'row' },
      el('div', { class: 'coin' }, el('b', { text: r.pools.length ? r.pools.map(poolName).join(' ⇄ ') : 'Leftover sales' }), el('span', { class: 'muted', text: ` · ${r.n} trade${r.n === 1 ? '' : 's'}` }),
        ...r.pools.map((p) => el('div', { class: 'addr', text: p.pool }))),
      el('span', { class: `amt ${signClass(r.amount)}`, text: `${amount(r.amount, true)} ${r.coin}` }),
      el('div', { class: 'bar' }, el('i', { style: `width:${top > 0 ? (Math.abs(r.usd) / top) * 100 : 0}%` })))) : [el('span', { class: 'empty', text: 'No trades yet' })]));
    $('poolsNote').textContent = rows.length ? `Over ${span(t)}, each in its pool's own coin, ranked by worth at today's prices. Before network fees; leftover coins are not counted here.` : '';
  }

  // ─── The scanner's half (s.scanner, read by the dashboard from the scanner's page on this
  // computer and checked there: keeper/scannerView.ts). Its dollars are estimates until the robot
  // trades; only panels 01 to 08 are money the robot really made. ───
  const pct = (v) => `${v.toFixed(Math.abs(v) < 1 ? 3 : 2)}%`;
  const rate = (v) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1));
  const count = (v) => Math.round(v).toLocaleString();
  const addrLink = (id) => (B58.test(id) ? el('a', { class: 'addr', href: `https://solscan.io/account/${id}`, target: '_blank', rel: 'noopener noreferrer', text: id }) : el('span', { class: 'addr', text: id }));
  const HELD = { gap: 'the whole gap', float: 'all the robot holds', cap: 'the robot’s cap' };
  let rankBy = 'profit';

  /** What the scanner's feed is: live, old (kept a short while after it stopped answering), or off. */
  function feedOf(s) {
    const f = s.scanner;
    if (!f) return { kind: 'off', view: null, text: 'this dashboard does not read the scanner' };
    if (!f.view) return { kind: 'off', view: null, text: f.problem || 'not read yet' };
    const age = Date.now() - f.readAt;
    if (f.problem) return { kind: 'old', view: f.view, text: `${f.problem} · showing its read of ${new Date(f.readAt).toLocaleTimeString()}, ${ago(age)}` };
    return { kind: 'live', view: f.view, text: `read ${ago(age)}` };
  }

  /** The order the trips are listed in: what each would make, or that over what it puts in. */
  const ranked = (rows) => [...rows].sort((a, b) => (rankBy === 'roi' ? b.roiPct - a.roiPct : b.netUsd - a.netUsd));

  // The one sentence at the top: is there money on the table, and is the robot taking it?
  function headline(s, feed, rs) {
    const robot = rs.cls === 'good' ? 'The robot is running' : `The robot is ${rs.text.toLowerCase()}`;
    const v = feed.view;
    if (feed.kind === 'off') return { parts: [['c', 'The scanner is off.'], ['', ` ${robot}.`]], sub: `The scanner: ${feed.text}. The robot's own figures below do not depend on it.` };
    const take = ranked(v.take);
    if (take.length) {
      const best = take[0];
      return { parts: [['em', `${take.length} trip${take.length === 1 ? '' : 's'} pass${take.length === 1 ? 'es' : ''} the test run`], ['', ` · best est. ${signedUsd(best.netUsd)} on ${best.symbol}. ${robot}.`]], sub: `Passed from the robot's own wallet in the last 3 minutes. The robot quotes, test-runs and checks each one again before it sends.` };
    }
    const top = ranked(v.watch)[0];
    if (top) {
      const why = !top.proof ? 'waiting for its test run' : top.proof.quiet ? 'a pool in it has been quiet for an hour' : top.proof.ok ? 'its pass is over 3 minutes old' : 'its test run said no';
      return { parts: [['em', `${signedUsd(top.netUsd)} est.`], ['w', ` shows on ${top.symbol}, not proven:`], ['', ` ${why}. ${robot}.`]], sub: `${v.watch.length} trip${v.watch.length === 1 ? ' clears' : 's clear'} the floor on the latest chain read; none has passed a test run in the last 3 minutes.` };
    }
    return { parts: [['', 'Nothing on the table. '], ['', `${robot} and waiting.`]], sub: 'No trip clears the robot’s floor on the latest chain read: the busy pools sit inside their fees.' };
  }

  // The funnel: what the scanner looked at, down to what passed, then what the robot did.
  function drawSpine(s, feed) {
    const st = feed.view && feed.view.stats;
    const res = s.results;
    const max = st ? Math.log10(st.scans + 1) : 1;
    const taper = (n) => el('div', { class: 'taper' }, el('i', { style: `width:${st && max > 0 ? Math.max(1.5, (Math.log10(n + 1) / max) * 100) : 0}%` }));
    const conv = (n, of, those) => (of > 0 ? ` · ${((n / of) * 100).toFixed(n / of < 0.01 ? 2 : 1)}% of those ${those}` : '');
    const cell = (k, v, sub, extra, cls) => el('li', { class: cls || 'scanCell' }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), extra, el('div', { class: 's', text: sub }));
    const pass = s.robot && s.robot.pass;
    fill('spine',
      cell('01 Scanned', st ? count(st.scans) : '—', st ? `${rate(st.perHour.scans)} an hour · ${feed.view.coins ?? '?'} coins, ${feed.view.pools ?? '?'} pools` : 'no scanner figures', st ? taper(st.scans) : null),
      cell('02 Pays on the read', st ? count(st.paying) : '—', st ? `${rate(st.perHour.paying)} an hour${conv(st.paying, st.scans, 'scanned')}` : '', st ? taper(st.paying) : null),
      cell('03 Test-run', st ? count(st.tried) : '—', st ? `${rate(st.perHour.tried)} an hour, from the robot’s wallet${conv(st.tried, st.paying, 'that paid')}` : '', st ? taper(st.tried) : null),
      cell('04 Passed', st ? count(st.passed) : '—', st ? `${rate(st.perHour.passed)} an hour · ${st.routesPassed} different route${st.routesPassed === 1 ? '' : 's'}${conv(st.passed, st.tried, 'tried')}` : '', st ? taper(st.passed) : null),
      el('li', { class: 'seam', 'aria-hidden': 'true' }),
      cell('05 The robot traded', res ? String(res.trades) : '…', pass ? `last pass: ${pass.pools} pools → ${pass.gaps} gaps → ${pass.sent} sent` : 'all time', null, 'robotCell'),
      cell('06 Made, after fees', res ? signedUsd(res.netUsd) : '…', 'all time, at today’s prices (panel 01)', null, 'robotCell'));
    $('spineWrap').classList.toggle('off', !st);
    $('spineNote').textContent = st
      ? `The scanner's counts since it started ${st.hours >= 1 ? `${st.hours.toFixed(1)} h` : `${Math.round(st.hours * 60)} min`} ago; the robot's since its first trade. The scanner looks; the robot quotes, test-runs and checks every trip again itself before it sends.`
      : `The scanner's half is empty: ${feed.text}.`;
  }

  function drawLamps(feed) {
    const v = feed.view;
    if (!v) return fill('lamps', el('span', { class: 'empty', text: 'not read: the scanner is off' }));
    const r = v.rule;
    const lamp = (k, val, cls, sub) => el('div', {}, el('div', { class: 'k', text: k }), el('div', { class: `lv ${cls || ''}`, text: val }), el('div', { class: 'ls', text: sub }));
    const lh = r.lighthouse;
    const floor = (x) => (x === null ? '…' : usd(x));
    const holds = v.holds.map((h) => `${amount(h.amount)} ${h.ticker}${h.usd === null ? '' : ` (${usd(h.usd)})`}`).join(' + ');
    fill('lamps',
      lamp('Cap', r.capUsd === null ? '…' : `${usd(r.capUsd)} a trip`, '', lh.proven || r.settingUsd === null ? `setting ${usd(r.settingUsd)}` : `setting ${usd(r.settingUsd)}; held to ${usd(r.safeCapUsd)} until the Lighthouse check is proven`),
      lamp('Lighthouse', lh.proven ? 'Proven' : 'Not proven', lh.proven ? 'good' : 'warn', lh.proven ? 'on mainnet at start: a trip that ends under its floor is undone' : (lh.why || 'not run yet')),
      lamp('Floor', `${floor(r.floorUsd.SOL)} SOL · ${floor(r.floorUsd.USDC)} USDC`, '', `${usd(r.minProfitUsd)} profit + the network fee (${r.feeLamports ?? '?'} lamports at most)`),
      lamp('Float', holds || '…', '', 'what the robot holds to trade, as the scanner read it'));
  }

  const coinHead = (t) => el('div', {}, el('span', { class: 'claims', title: 'the ticker this coin claims for itself', text: t.symbol }), t.ours ? el('span', { class: 'tag ours', text: 'in our pools' }) : null, el('div', { class: 'addr', text: t.mint }));

  function route(t) {
    const out = el('div', { class: 'route' }, el('span', { class: 'stop', text: t.legs[0].fromTicker }));
    for (const l of t.legs) {
      out.append(el('div', { class: 'hop' }, el('span', { class: 'arrow', text: '─' }),
        el('div', { class: `venue${l.ours ? ' ours' : ''}` }, el('b', { text: `${l.venue} · ${pct(l.fee * 100)}${l.rough ? ' · depth rough' : ''}` }), addrLink(l.pool)),
        el('span', { class: 'arrow', text: '→' }), el('span', { class: 'stop', text: l.toTicker })));
    }
    return out;
  }

  // The gap against the pools' fees: the fill is the gap, the line the fees, hatching what is short.
  function gapMeter(t) {
    const top = Math.max(t.gapPct, t.costPct, 1e-9);
    const w = (x) => `${(Math.max(0, x) / top) * 100}%`;
    return el('div', {}, el('div', { class: 'mk', text: 'Gap against the pools’ fees' }),
      el('div', { class: 'gapbar' }, el('i', { style: `width:${w(t.gapPct)}` }), t.shortPct > 0 ? el('s', { style: `left:${w(t.gapPct)};width:${w(t.shortPct)}` }) : null, el('u', { style: `left:calc(${w(t.costPct)} - 1px)` })),
      el('div', { class: 'ml', text: t.shortPct > 0 ? `${pct(t.shortPct)} short: gap ${pct(t.gapPct)} against fees ${pct(t.costPct)}` : `gap ${pct(t.gapPct)} · fees ${pct(t.costPct)}` }));
  }

  // What sized it: the trip is the least of the gap, the cap and all the robot holds.
  function fences(t) {
    const lim = [['gap', 'Gap', t.gapInUsd], ['cap', 'Cap', t.capUsd], ['float', 'Float', t.floatUsd]].filter((x) => x[2] !== null);
    const top = Math.max(...lim.map((x) => x[2]), t.inUsd, 1e-9);
    return el('div', {}, el('div', { class: 'mk', text: `In ${usd(t.inUsd)} ${t.coinTicker} · held by ${HELD[t.sizedBy] || 'its limits'}` }),
      ...lim.map(([key, name, v]) => el('div', { class: `fence${key === t.sizedBy ? ' held' : ''}` }, el('span', { text: name }), el('div', { class: 'bar' }, el('i', { style: `width:${(v / top) * 100}%` })), el('span', { text: usd(v) }))));
  }

  function stampOf(t) {
    const p = t.proof;
    if (!p) return el('span', { class: 'stamp wait', text: '… waiting for its test run' });
    if (p.ok) return el('span', { class: 'stamp good', text: '✓ test run passed' });
    if (p.quiet) return el('span', { class: 'stamp warn', text: '◌ quiet pool: not tried' });
    return el('span', { class: 'stamp crit', text: '✕ test run said no' });
  }

  // Who gets paid on this trip, leg by leg.
  function whoPaid(t) {
    const ours = t.legs.filter((l) => l.ours);
    const outside = t.legs.filter((l) => !l.ours);
    return el('div', { class: 'paid' }, el('b', { text: 'Who gets paid: ' }),
      `the robot ${signedUsd(t.netUsd)} est., the gap, paid by the liquidity providers of the pools it trades against`,
      ours.length ? `; our venue its share of our pool’s ${ours.map((l) => pct(l.fee * 100)).join(' and ')} fee` : '; our venue nothing (no pool of ours in this trip)',
      outside.length ? `; ${outside.map((l) => `${l.venue} its ${pct(l.fee * 100)}`).join(', ')}` : '', '.');
  }

  function tripCard(t, kind) {
    const big = rankBy === 'roi' ? pct(t.roiPct) : `${signedUsd(kind === 'take' && t.proof && t.proof.gainedUsd !== null ? t.proof.gainedUsd : t.netUsd)}`;
    const small = rankBy === 'roi' ? `${signedUsd(t.netUsd)} est.` : `ROI ${pct(t.roiPct)}`;
    const p = t.proof;
    return el('article', { class: `card ${kind}` },
      el('div', { class: 'cardTop' }, coinHead(t), el('div', { class: 'fig' }, el('div', { class: `big${t.netUsd > 0 ? ' gain' : ''}`, text: big }), el('div', { class: 'small', text: kind === 'take' && rankBy !== 'roi' ? `test run gained · ${small}` : `${small}${rankBy === 'roi' ? '' : ' · est. after fees'}` }))),
      route(t),
      el('div', { class: 'meters' }, gapMeter(t), fences(t)),
      el('div', { class: 'proof' },
        el('div', {}, stampOf(t), !t.robotTakes ? el('span', { class: 'tag warn', style: 'margin-left:8px', text: t.threeSwap ? 'the robot does not add a SOL/USDC swap yet' : 'between two outside pools: the robot takes these only once proven' }) : null),
        p && p.why ? el('div', { class: 'ml', text: p.why }) : null,
        p ? el('div', { class: 'ml', text: `tried ${ago(Date.now() - p.at)}${p.slot ? ` · slot ${p.slot.toLocaleString()}` : ''}${p.units ? ` · ${p.units.toLocaleString()} compute units` : ''}` }) : null,
        t.why ? el('div', { class: 'ml', text: t.why }) : null),
      whoPaid(t));
  }

  function nearCard(t) {
    return el('div', { class: 'near' }, coinHead(t), route(t), gapMeter(t), t.why ? el('div', { class: 'ml', text: t.why }) : null);
  }

  function renderScanner(s, rs) {
    const feed = feedOf(s);
    const lamp = $('scanLamp');
    lamp.replaceChildren(el('span', { class: `dot ${feed.kind === 'live' ? 'good' : feed.kind === 'old' ? 'warn' : 'crit'}` }), `Scanner${s.scanner && s.scanner.page ? ` ${s.scanner.page}` : ''} · ${feed.kind === 'live' ? `${feed.text}${feed.view.slot ? ` · slot ${feed.view.slot.toLocaleString()}` : ''}` : feed.kind === 'old' ? 'not answering' : 'off'}`);
    const h = headline(s, feed, rs);
    fill('hlText', ...h.parts.map(([cls, text]) => (cls === 'em' ? el('em', { text }) : cls ? el('span', { class: cls, text }) : text)));
    $('hlSub').textContent = h.sub;
    drawSpine(s, feed);
    drawLamps(feed);
    $('market').classList.toggle('off', feed.kind !== 'live');
    $('scanOff').hidden = feed.kind === 'live';
    $('scanOff').textContent = feed.kind === 'old'
      ? `The scanner stopped answering (${s.scanner.problem}). Its last read is shown faded until ${new Date(s.scanner.readAt + 120_000).toLocaleTimeString()}, then cleared. The robot's figures are not affected.`
      : `The scanner's half of this page is empty: ${feed.text}. The robot's figures are not affected.`;
    const v = feed.view;
    const empty = (text) => el('span', { class: 'empty', text });
    fill('take', ...(v && v.take.length ? ranked(v.take).map((t) => tripCard(t, 'take')) : [empty(v ? 'None right now. A trip lands here only once a test run from the robot’s wallet passes; the watch list shows what is being tried.' : 'No scanner read.')]));
    fill('watch', ...(v && v.watch.length ? ranked(v.watch).map((t) => tripCard(t, 'watch')) : [empty(v ? 'No trip clears the floor on the latest chain read. Busy pools sit inside their fees; gaps open in thinner pools, and for seconds.' : 'No scanner read.')]));
    // Nearest to paying first, as the scanner sends them: none pays, so profit and ROI cannot rank them.
    fill('closest', ...(v && v.closest.length ? v.closest.map(nearCard) : [empty(v ? 'No coin read in the last 5 minutes yet.' : 'No scanner read.')]));
    $('refusedHead').textContent = `Turned away at the door (${v ? v.refused.length : 0}): the token gate`;
    fill('refused', ...(v ? v.refused.map((c) => el('li', {}, el('span', { class: 'claims', text: c.symbol }), el('div', { class: 'ml', text: c.problem }), el('div', { class: 'addr', text: c.mint }))) : []));
  }

  for (const [id, by] of [['byProfit', 'profit'], ['byRoi', 'roi']]) {
    $(id).addEventListener('click', () => {
      rankBy = by;
      $('byProfit').setAttribute('aria-pressed', String(by === 'profit'));
      $('byRoi').setAttribute('aria-pressed', String(by === 'roi'));
      if (lastAny) renderScanner(lastAny, robotState(lastAny));
    });
  }

  let last = null;
  let lastAny = null;
  let first = true;
  function render(s) {
    $('error').hidden = !s.error;
    if (s.error) $('error').textContent = `Last read failed: ${s.error}. Showing the read before it.`;
    const notes = [...(s.notes || [])];
    const age = s.builtAt ? Date.now() - s.builtAt : 0;
    if (age > 3 * 60_000) notes.unshift(`The figures below were read at ${new Date(s.builtAt).toLocaleTimeString()}, ${ago(age)}${s.reading ? ': a new read is under way' : ''}. The robot's state is current.`);
    $('notes').hidden = !notes.length;
    $('notes').textContent = notes.join(' · ');

    // The robot's own state is read live, so it shows before the first figures do.
    const rs = robotState(s);
    const r = s.robot;
    $('tRobot').textContent = rs.text;
    $('tRobot').className = `state ${rs.cls}`;
    $('tRobotSub').textContent = rs.sub || '';
    $('radar').className = `radar ${rs.cls}`;
    $('radar').style.setProperty('--sweep', `${r && r.checkSec > 0 ? r.checkSec : 10}s`);
    const budget = $('budget');
    if (r && r.maxDailySol > 0) {
      const used = Math.min(1, r.spentTodaySol / r.maxDailySol);
      budget.firstElementChild.style.width = `${used * 100}%`;
      budget.classList.toggle('hot', used >= 0.8);
      $('budgetText').textContent = `${amount(r.spentTodaySol)} of its ${r.maxDailySol} SOL daily limit · ${(used * 100).toFixed(1)}%`;
    } else {
      budget.firstElementChild.style.width = '0';
      $('budgetText').textContent = 'not reported';
    }

    // The scanner's half is read on its own clock, so it shows before the chain's first read lands.
    lastAny = s;
    renderScanner(s, rs);

    if (!s.wallet) return;
    last = s;
    $('wallet').textContent = s.wallet;
    const link = $('walletLink');
    if (B58.test(s.wallet)) { link.href = `https://solscan.io/account/${s.wallet}`; link.hidden = false; }
    $('updated').textContent = `Read ${new Date(s.builtAt).toLocaleTimeString()} · SOL ${usd(s.solUsd)} · live, read every 15 s`;

    const h = s.holdings;
    const res = s.results;
    const made = $('tMade');
    made.textContent = signedUsd(res.netUsd);
    made.className = `giant${res.netUsd < 0 ? ' neg' : res.netUsd > 0 ? '' : ' flat'}${first ? ' in' : ''}`;
    $('tWorth').textContent = usd(h.worthUsd);
    $('tTrades').textContent = String(res.trades);
    $('tTradesSub').textContent = `${res.refused} refused by the chain · ${res.sales} leftover sales`;
    first = false;

    const colors = drawMix(s);
    const solRow = (name, note, v) => el('tr', {}, el('td', {}, el('div', { class: 'coin' }, swatch(colors.get(`${name} ${note}`)), el('b', { text: name }), el('span', { class: 'muted', text: ` · ${note}` }))), el('td', { class: 'num', text: amount(v) }), el('td', { class: 'num', text: usd(s.solUsd === null ? null : v * s.solUsd) }));
    fill('holdings',
      solRow('SOL', 'for fees', h.solPlain),
      solRow('SOL', 'wrapped, for trading', h.solWrapped),
      ...h.coins.map((c) => el('tr', {}, el('td', {}, coinCell(c, colors.get(c.mint))), el('td', { class: 'num', text: amount(c.amount) }), el('td', { class: 'num', text: c.onVenue ? usd(c.usd) : 'not valued' }))));
    $('holdingsTotal').textContent = usd(h.worthUsd) + (h.unvalued ? ` + ${h.unvalued} not valued` : '');
    $('rentLine').textContent = `The total includes ${sol(h.rentSol)} held as deposits in its ${h.rentAccounts} coin accounts: it comes back if an account is closed.`;

    const solUsd = (v) => (s.solUsd === null ? '' : ` (${usd(v * s.solUsd)})`);
    fill('made',
      ...pair('Gaps closed', el('span', { class: signClass(res.madeSol), text: `${sol(res.madeSol, true)}${solUsd(res.madeSol)}` })),
      ...pair('Leftover coins', coinList(res.leftovers, true)),
      ...pair('Network fees', `${sol(-res.fees)}${solUsd(-res.fees)}`),
      ...pair('Setup deposits', el('span', {}, `${sol(-res.deposits)}${solUsd(-res.deposits)}`, el('div', { class: 'muted', text: 'one-time accounts other programs keep in its name' }))),
      ...pair('Net', el('b', { class: `netfig ${signClass(res.netUsd)}`, text: signedUsd(res.netUsd) + (res.unpriced ? ` + ${res.unpriced} unpriced coins` : '') })),
      ...pair('Put in', el('div', {}, el('div', { text: sol(res.putIn.sol) }), coinList(res.putIn.coins))),
      ...pair('Taken out', res.takenOut.sol || res.takenOut.coins.length ? el('div', {}, el('div', { text: sol(res.takenOut.sol) }), coinList(res.takenOut.coins)) : el('span', { class: 'empty', text: 'nothing' })));

    drawCurve(s);
    drawPools(s);

    const pass = r && r.pass;
    fill('robot',
      ...pair('State', el('span', {}, status(rs.cls, rs.text), rs.sub ? el('span', { class: 'muted', text: ` · ${rs.sub}` }) : null)),
      ...pair('Last pass', !pass ? el('span', { class: 'empty', text: 'none reported' }) : pass.error ? `stopped at ${new Date(pass.at).toLocaleTimeString()}: ${pass.error}` : `${new Date(pass.at).toLocaleTimeString()}: ${pass.pools} pools, ${pass.gaps} gaps, ${pass.sent} sent`),
      ...pair('Spent today', r ? `${amount(r.spentTodaySol)} of its ${r.maxDailySol} SOL daily limit` : el('span', { class: 'empty', text: 'not reported' })),
      ...pair('Checks', r ? `every ${r.checkSec} s, a full pass at least every ${r.intervalSec} s` : el('span', { class: 'empty', text: 'not reported' })),
      ...pair(s.stopped ? 'To resume' : 'To pause', el('span', {}, s.stopped ? 'delete the file ' : 'create the file ', el('span', { class: 'addr', text: s.stopFile }))));

    const best = Math.max(...s.days.map((d) => Math.abs(d.netUsd ?? 0)), 0);
    fill('days', ...(s.days.length ? s.days.map((d) => el('tr', {},
      el('td', { text: d.day }),
      el('td', { class: 'num', text: d.refused ? `${d.trades} (+${d.refused} refused)` : String(d.trades) }),
      el('td', { class: `num ${signClass(d.madeSol)}`, text: sol(d.madeSol, true) }),
      el('td', {}, coinList(d.leftovers, true)),
      el('td', { class: 'num', text: sol(-d.fees) }),
      el('td', { class: `num ${signClass(d.netUsd ?? 0)}` }, signedUsd(d.netUsd), d.netUsd > 0 && best > 0 ? el('span', { class: 'netbar' }, el('i', { style: `width:${(d.netUsd / best) * 100}%` })) : null))) : [el('tr', {}, el('td', { class: 'empty', colspan: '6', text: 'No trades yet' }))]));

    const what = { trade: 'Trade', sale: 'Leftover sale', setup: 'Setup', in: 'Money in', out: 'Money out' };
    fill('recent', ...(s.recent.length ? s.recent.map((a) => el('tr', {},
      el('td', { class: 'when', text: a.at ? new Date(a.at * 1000).toLocaleString() : '?' }),
      el('td', {}, el('span', { class: `chip${!a.ok ? ' bad' : a.kind === 'trade' ? ' trade' : ''}`, text: a.ok ? what[a.kind] : `${what[a.kind]}, refused (fee only)` })),
      el('td', {}, a.kind === 'in' && a.from
        ? el('div', {}, 'from ', el('div', { class: 'addr', text: a.from }))
        : el('div', {}, ...a.pools.map((p) => el('div', { class: 'coin' }, el('b', { text: poolName(p) }), el('div', { class: 'addr', text: p.pool }))))),
      el('td', { class: `num ${a.kind === 'trade' || a.kind === 'sale' ? signClass(a.sol) : ''}` }, a.sol === 0 ? '—' : sol(a.sol, true), a.kind === 'trade' || a.kind === 'sale' ? el('div', { class: 'muted', text: `fee ${amount(a.fee)}${a.deposits ? ` · deposit ${amount(a.deposits)}` : ''}` }) : null),
      el('td', {}, coinList(a.coins, true)),
      el('td', {}, solscan('tx', a.signature)))) : [el('tr', {}, el('td', { class: 'empty', colspan: '6', text: 'Nothing yet' }))]));

    const c = s.check;
    fill('check', !c ? el('span', { class: 'empty', text: 'not checked yet' }) : c.ok
      ? status('good', `Every figure matches the wallet: the history explains every coin it holds (slot ${c.slot}).`)
      : el('div', {}, status('crit', 'The history does not explain the wallet yet, so the figures above may be short:'), ...c.lines.map((l) => el('div', { class: 'addr', text: l }))));
  }

  // The curve is drawn to the page's width, so a resized window redraws it.
  let resizing = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizing);
    resizing = requestAnimationFrame(() => last && drawCurve(last));
  });

  // The dashboard sends each read as it lands and the robot's report as it changes, so the page
  // keeps no timer of its own (a hidden or minimized window stops those for hours). A stream
  // that drops, or a tab coming back from being frozen, reconnects and is sent the latest at once.
  let stream = null;
  function listen() {
    stream = new EventSource('/events');
    stream.onmessage = (e) => render(JSON.parse(e.data));
    stream.onerror = () => {
      if (stream.readyState === EventSource.OPEN) return;
      $('error').hidden = false;
      $('error').textContent = 'The dashboard is not answering: is its window still open? This page reconnects by itself once it is.';
    };
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && stream.readyState === EventSource.CLOSED) listen();
  });
  listen();
})();
