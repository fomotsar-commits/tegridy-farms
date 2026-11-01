// The price keeper's dashboard page script (scripts/price-keeper-dashboard.html), served as
// /app.js by `node scripts/price-keeper.mjs dashboard`: the only script the page's content
// security policy lets run. It reads /state.json and writes every figure as text: coin names
// are the coins' own claims, so nothing is ever written as HTML. It runs in the browser.
/* global document, Node */
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
  const fill = (id, ...kids) => $(id).replaceChildren(...kids);
  const solscan = (kind, id) => B58.test(id) ? el('a', { href: `https://solscan.io/${kind}/${id}`, target: '_blank', rel: 'noopener noreferrer', text: 'Solscan' }) : null;
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
  const coinCell = (c) => el('div', { class: 'coin' }, el('b', { text: c.symbol || '?' }), c.onVenue ? null : el('span', { class: 'muted', text: ' · on no pool of ours' }), el('div', { class: 'addr', text: c.mint }));
  const coinList = (list, signed) => list.length
    ? el('div', {}, ...list.map((c) => el('div', {}, `${amount(c.amount, signed)} `, el('b', { text: c.symbol || '?' }), c.usd === null ? el('span', { class: 'muted', text: ' (not priced)' }) : el('span', { class: 'muted', text: ` (${usd(c.usd)})` }), el('div', { class: 'addr', text: c.mint }))))
    : el('span', { class: 'empty', text: 'none' });
  const pair = (dt, dd) => [el('dt', { text: dt }), el('dd', {}, dd)];
  const status = (cls, text) => el('span', {}, el('span', { class: `dot ${cls}` }), text);

  function robotState(s) {
    const r = s.robot;
    if (s.stopped) return { cls: 'warn', text: 'Paused', sub: 'the stop file exists' };
    if (!r) return { cls: 'crit', text: 'No report', sub: s.robotNote === 'no status yet' ? 'it reports once restarted with this version' : s.robotNote };
    const age = Date.now() - Date.parse(r.at);
    if (!(age < 5 * 60_000)) return { cls: 'crit', text: 'Not seen', sub: `last report ${ago(age)}` };
    if (r.hold) return { cls: 'warn', text: 'Paused', sub: r.hold };
    return { cls: 'good', text: 'Running', sub: `last report ${ago(age)}` };
  }

  function render(s) {
    $('error').hidden = !s.error;
    if (s.error) $('error').textContent = `Last read failed: ${s.error}. Showing the read before it.`;
    $('notes').hidden = !(s.notes && s.notes.length);
    if (s.notes) $('notes').textContent = s.notes.join(' · ');
    if (!s.wallet) return;
    $('wallet').textContent = s.wallet;
    const link = $('walletLink');
    if (B58.test(s.wallet)) { link.href = `https://solscan.io/account/${s.wallet}`; link.hidden = false; }
    $('updated').textContent = `Read ${new Date(s.builtAt).toLocaleTimeString()} · SOL ${usd(s.solUsd)} · refreshes every 30 s`;

    const h = s.holdings;
    const res = s.results;
    $('tWorth').textContent = usd(h.worthUsd);
    $('tMade').textContent = signedUsd(res.netUsd);
    $('tTrades').textContent = String(res.trades);
    $('tTradesSub').textContent = `${res.refused} refused by the chain · ${res.sales} leftover sales`;
    const rs = robotState(s);
    fill('tRobot', status(rs.cls, rs.text));
    $('tRobotSub').textContent = rs.sub || '';

    const solRow = (name, note, v) => el('tr', {}, el('td', {}, el('div', { class: 'coin' }, el('b', { text: name }), el('span', { class: 'muted', text: ` · ${note}` }))), el('td', { class: 'num', text: amount(v) }), el('td', { class: 'num', text: usd(s.solUsd === null ? null : v * s.solUsd) }));
    fill('holdings',
      solRow('SOL', 'for fees', h.solPlain),
      solRow('SOL', 'wrapped, for trading', h.solWrapped),
      ...h.coins.map((c) => el('tr', {}, el('td', {}, coinCell(c)), el('td', { class: 'num', text: amount(c.amount) }), el('td', { class: 'num', text: c.onVenue ? usd(c.usd) : 'not valued' }))));
    $('holdingsTotal').textContent = usd(h.worthUsd) + (h.unvalued ? ` + ${h.unvalued} not valued` : '');
    $('rentLine').textContent = `The total includes ${sol(h.rentSol)} held as deposits in its ${h.rentAccounts} coin accounts: it comes back if an account is closed.`;

    const solUsd = (v) => (s.solUsd === null ? '' : ` (${usd(v * s.solUsd)})`);
    fill('made',
      ...pair('Gaps closed', `${sol(res.madeSol, true)}${solUsd(res.madeSol)}`),
      ...pair('Leftover coins', coinList(res.leftovers, true)),
      ...pair('Network fees', `${sol(-res.fees)}${solUsd(-res.fees)}`),
      ...pair('Setup deposits', el('span', {}, `${sol(-res.deposits)}${solUsd(-res.deposits)}`, el('div', { class: 'muted', text: 'one-time accounts other programs keep in its name' }))),
      ...pair('Net', el('b', { text: signedUsd(res.netUsd) + (res.unpriced ? ` + ${res.unpriced} unpriced coins` : '') })),
      ...pair('Put in', el('div', {}, el('div', { text: sol(res.putIn.sol) }), coinList(res.putIn.coins))),
      ...pair('Taken out', res.takenOut.sol || res.takenOut.coins.length ? el('div', {}, el('div', { text: sol(res.takenOut.sol) }), coinList(res.takenOut.coins)) : el('span', { class: 'empty', text: 'nothing' })));

    const r = s.robot;
    const pass = r && r.pass;
    fill('robot',
      ...pair('State', el('span', {}, status(rs.cls, rs.text), rs.sub ? el('span', { class: 'muted', text: ` · ${rs.sub}` }) : null)),
      ...pair('Last pass', !pass ? el('span', { class: 'empty', text: 'none reported' }) : pass.error ? `stopped at ${new Date(pass.at).toLocaleTimeString()}: ${pass.error}` : `${new Date(pass.at).toLocaleTimeString()}: ${pass.pools} pools, ${pass.gaps} gaps, ${pass.sent} sent`),
      ...pair('Spent today', r ? `${amount(r.spentTodaySol)} of its ${r.maxDailySol} SOL daily limit` : el('span', { class: 'empty', text: 'not reported' })),
      ...pair('Checks', r ? `every ${r.checkSec} s, a full pass at least every ${r.intervalSec} s` : el('span', { class: 'empty', text: 'not reported' })),
      ...pair(s.stopped ? 'To resume' : 'To pause', el('span', {}, s.stopped ? 'delete the file ' : 'create the file ', el('span', { class: 'addr', text: s.stopFile }))));

    fill('days', ...(s.days.length ? s.days.map((d) => el('tr', {},
      el('td', { text: d.day }),
      el('td', { class: 'num', text: d.refused ? `${d.trades} (+${d.refused} refused)` : String(d.trades) }),
      el('td', { class: 'num', text: sol(d.madeSol, true) }),
      el('td', {}, coinList(d.leftovers, true)),
      el('td', { class: 'num', text: sol(-d.fees) }),
      el('td', { class: 'num', text: signedUsd(d.netUsd) }))) : [el('tr', {}, el('td', { class: 'empty', colspan: '6', text: 'No trades yet' }))]));

    const what = { trade: 'Trade', sale: 'Leftover sale', setup: 'Setup', in: 'Money in', out: 'Money out' };
    fill('recent', ...(s.recent.length ? s.recent.map((a) => el('tr', {},
      el('td', { text: a.at ? new Date(a.at * 1000).toLocaleString() : '?' }),
      el('td', {}, a.ok ? what[a.kind] : `${what[a.kind]}, refused (fee only)`),
      el('td', {}, a.kind === 'in' && a.from
        ? el('div', {}, 'from ', el('div', { class: 'addr', text: a.from }))
        : el('div', {}, ...a.pools.map((p) => el('div', { class: 'coin' }, el('b', { text: `${p.symbol || '?'} / ${p.quote || '?'}` }), el('div', { class: 'addr', text: p.pool }))))),
      el('td', { class: 'num' }, a.sol === 0 ? '—' : sol(a.sol, true), a.kind === 'trade' || a.kind === 'sale' ? el('div', { class: 'muted', text: `fee ${amount(a.fee)}${a.deposits ? ` · deposit ${amount(a.deposits)}` : ''}` }) : null),
      el('td', {}, coinList(a.coins, true)),
      el('td', {}, solscan('tx', a.signature)))) : [el('tr', {}, el('td', { class: 'empty', colspan: '6', text: 'Nothing yet' }))]));

    const c = s.check;
    fill('check', !c ? el('span', { class: 'empty', text: 'not checked yet' }) : c.ok
      ? status('good', `Every figure matches the wallet: the history explains every coin it holds (slot ${c.slot}).`)
      : el('div', {}, status('crit', 'The history does not explain the wallet yet, so the figures above may be short:'), ...c.lines.map((l) => el('div', { class: 'addr', text: l }))));
  }

  async function tick() {
    try {
      const r = await fetch('/state.json', { cache: 'no-store' });
      if (!r.ok) throw new Error(`the dashboard answered ${r.status}`);
      render(await r.json());
    } catch (e) {
      $('error').hidden = false;
      $('error').textContent = `The dashboard is not answering (${e instanceof Error ? e.message : e}): is its window still open?`;
    }
  }
  tick();
  setInterval(tick, 30_000);
})();
