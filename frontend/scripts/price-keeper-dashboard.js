// The price keeper's dashboard page script (scripts/price-keeper-dashboard.html), served as
// /app.js by `node scripts/price-keeper.mjs dashboard`: the only script the page's content
// security policy lets run. It reads /state.json and writes every figure as text: coin names
// are the coins' own claims, so nothing is ever written as HTML. It runs in the browser.
/* global document, window, Node, requestAnimationFrame, cancelAnimationFrame */
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

  // What the trades made, trade by trade: SOL from the gaps closed, before fees.
  function drawCurve(s) {
    const box = $('curve');
    const t = tripsOf(s);
    if (!t.trips.length) {
      box.replaceChildren();
      $('curveNote').textContent = 'The curve starts with its first trade.';
      $('curveEnd').textContent = '';
      return;
    }
    const W = Math.max(280, Math.round(box.getBoundingClientRect().width || 640));
    const H = 170;
    const pad = { l: 2, r: 10, t: 16, b: 22 };
    let run = 0;
    const pts = t.trips.map((a) => ({ a, t: a.at, v: (run += a.sol) }));
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
        svg('title', {}, `${new Date(p.t * 1000).toLocaleString()} · ${sol(p.a.sol, true)} · ${p.a.pools.length ? p.a.pools.map(poolName).join(' ⇄ ') : 'leftover sale'}`))),
      svg('circle', { class: 'now', cx: x(t1), cy: y(run), r: 3.5 }),
      svg('text', { class: 'tick', x: W - pad.r, y: y(hi) - 5, 'text-anchor': 'end' }, sol(hi, true)),
      svg('text', { class: 'tick', x: pad.l, y: H - 4 }, day(t0)),
      svg('text', { class: 'tick', x: W - pad.r, y: H - 4, 'text-anchor': 'end' }, 'now'));
    $('curveNote').textContent = `SOL from the gaps it closed, before fees: ${span(t)}`;
    $('curveEnd').textContent = sol(run, true);
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

  // Which pools' gaps paid: SOL from the gaps closed in each, before fees.
  function drawPools(s) {
    const t = tripsOf(s);
    const by = new Map();
    for (const a of t.trips) {
      const key = a.pools.length ? a.pools.map((p) => p.pool).join(' ') : 'sale';
      const was = by.get(key) || { pools: a.pools, sol: 0, n: 0 };
      by.set(key, { ...was, sol: was.sol + a.sol, n: was.n + 1 });
    }
    const rows = [...by.values()].sort((a, b) => b.sol - a.sol);
    const top = Math.max(...rows.map((r) => Math.abs(r.sol)), 0);
    fill('pools', ...(rows.length ? rows.map((r) => el('div', { class: 'row' },
      el('div', { class: 'coin' }, el('b', { text: r.pools.length ? r.pools.map(poolName).join(' ⇄ ') : 'Leftover sales' }), el('span', { class: 'muted', text: ` · ${r.n} trade${r.n === 1 ? '' : 's'}` }),
        ...r.pools.map((p) => el('div', { class: 'addr', text: p.pool }))),
      el('span', { class: `amt ${signClass(r.sol)}`, text: sol(r.sol, true) }),
      el('div', { class: 'bar' }, el('i', { style: `width:${top > 0 ? (Math.abs(r.sol) / top) * 100 : 0}%` })))) : [el('span', { class: 'empty', text: 'No trades yet' })]));
    $('poolsNote').textContent = rows.length ? `Over ${span(t)}. Before network fees; leftover coins are not counted here.` : '';
  }

  let last = null;
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

    if (!s.wallet) return;
    last = s;
    $('wallet').textContent = s.wallet;
    const link = $('walletLink');
    if (B58.test(s.wallet)) { link.href = `https://solscan.io/account/${s.wallet}`; link.hidden = false; }
    $('updated').textContent = `Read ${new Date(s.builtAt).toLocaleTimeString()} · SOL ${usd(s.solUsd)} · refreshes every 30 s`;

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

  // Asked every 30 s; every 5 s while a new read is under way; and at once when the tab is shown
  // again, since a hidden or minimized window can stop the page's timers for hours.
  let timer = null;
  async function tick() {
    let soon = false;
    try {
      const r = await fetch('/state.json', { cache: 'no-store' });
      if (!r.ok) throw new Error(`the dashboard answered ${r.status}`);
      const s = await r.json();
      render(s);
      soon = s.reading === true;
    } catch (e) {
      $('error').hidden = false;
      $('error').textContent = `The dashboard is not answering (${e instanceof Error ? e.message : e}): is its window still open?`;
    }
    clearTimeout(timer);
    timer = setTimeout(tick, soon ? 5_000 : 30_000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
  });
  tick();
})();
