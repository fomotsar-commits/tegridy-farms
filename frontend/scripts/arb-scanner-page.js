// The arbitrage scanner's page (scripts/arb-scanner.mjs serves it). Every name a token chose is
// written as text, never as markup; links are built only from checked addresses.
/* global document */
(() => {
  const $ = (id) => document.getElementById(id);
  const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const usd = (n) => (Math.abs(n) >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(Math.abs(n) < 1 ? 4 : 2)}`);
  const pct = (n) => `${n.toFixed(Math.abs(n) < 1 ? 3 : 2)}%`;
  const ago = (t) => {
    if (!t) return 'not yet';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
  };
  const COIN = { So11111111111111111111111111111111111111112: 'SOL', EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC' };

  function link(address, text) {
    if (!ADDRESS.test(address)) return el('span', null, text);
    const a = el('a', null, text);
    a.href = `https://solscan.io/account/${address}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function coinCell(r) {
    const td = el('td');
    td.append(el('span', 'ticker', r.symbol));
    if (r.ours) td.append(el('span', 'tag', 'in our pools'));
    td.append(el('span', 'addr', r.mint));
    return td;
  }

  function tripCell(r) {
    const td = el('td');
    r.legs.forEach((l, i) => {
      const line = el('div', 'leg');
      const from = COIN[l.from] ?? r.symbol;
      const to = COIN[l.to] ?? r.symbol;
      line.append(el('span', 'step', `${i + 1}. ${from} → ${to} on `), link(l.pool, l.venue), el('span', 'sub', ` fee ${pct(l.fee * 100)}${l.rough ? ' · depth rough (price bins)' : ''}`));
      line.append(el('span', 'addr', l.pool));
      td.append(line);
    });
    td.append(el('span', 'sub', `gap ${pct(r.gapPct)} against fees ${pct(r.costPct)}${r.threeSwap ? ' · three swaps: the SOL/USDC swap is counted' : ''}`));
    return td;
  }

  function takeRow(r) {
    const tr = el('tr');
    tr.append(coinCell(r), tripCell(r));
    tr.append(el('td', 'n', `${usd(r.inUsd)} ${COIN[r.coin]}${r.sizedBy === 'holdings' ? ' (all the robot holds)' : ''}`));
    tr.append(el('td', 'n pays', usd(r.proof.gainedUsd)));
    const td = el('td');
    td.append(el('span', 'sub', `slot ${r.proof.slot ?? r.slot}, ${ago(r.proof.at)}`));
    td.append(el('span', 'sub', `${r.proof.units ?? '?'} compute units`));
    tr.append(td);
    return tr;
  }

  function watchRow(r) {
    const tr = el('tr');
    tr.append(coinCell(r), tripCell(r));
    tr.append(el('td', 'n', `${usd(r.inUsd)} ${COIN[r.coin]}${r.sizedBy === 'holdings' ? ' (all the robot holds)' : ''}`));
    tr.append(el('td', 'n', usd(r.netUsd)));
    const td = el('td');
    if (!r.proof) td.append(el('span', 'sub', 'waiting for its test run'));
    else {
      td.append(el('span', r.proof.ok ? 'tag good' : r.proof.quiet ? 'tag warn' : 'tag bad', r.proof.ok ? 'passed (over 3 min ago)' : r.proof.quiet ? 'quiet pool' : 'test run said no'));
      if (r.proof.why) td.append(el('span', 'sub', r.proof.why));
      td.append(el('span', 'sub', `tried ${ago(r.proof.at)}`));
    }
    tr.append(td);
    return tr;
  }

  function render(s) {
    const status = $('status');
    status.replaceChildren();
    const line = (b, text) => {
      const sp = el('span');
      sp.append(el('b', null, b), document.createTextNode(text));
      status.append(sp);
    };
    line('Chain', `: slot ${s.slot || '…'}${s.note ? ` · ${s.note}` : ''}`);
    line('Coins', `: ${s.coins} (${s.looked} looked up on six venues + ours), ${s.pools} pools deep enough to trade`);
    line('SOL', `: ${s.solUsd ? usd(s.solUsd) : '…'} (from the Orca SOL/USDC pool, same slot)`);
    line('Robot holds', `: ${Object.entries(s.holds).map(([k, v]) => `${v.toFixed(k === 'SOL' ? 4 : 2)} ${k}`).join(', ') || '…'}`);

    const st = s.stats;
    const perHour = (n) => (n / st.hours).toFixed(1);
    $('summary').textContent = `Since the scanner started (${(st.hours * 60).toFixed(0)} min): ${st.paying} trips paid on the chain read (${perHour(st.paying)} an hour), ${st.tried} were test-run, ${st.passed} passed (${perHour(st.passed)} an hour, ${st.routesPassed} different routes).`;

    $('take').replaceChildren(...s.take.map(takeRow));
    $('take-empty').hidden = s.take.length > 0;
    $('take-empty').textContent = 'None right now. A trip lands here only once a test run from the robot’s wallet passes; the watch list below shows what is being tried.';
    $('watch').replaceChildren(...s.watch.map(watchRow));
    $('watch-empty').hidden = s.watch.length > 0;
    $('watch-empty').textContent = 'No trip clears the floor on the latest chain read. Busy pools sit inside their fees; gaps open in thinner pools, and for seconds.';
    $('refused-head').textContent = `Coins the robot refuses (${s.refused.length}): the token gate`;
    $('refused').replaceChildren(
      ...s.refused.map((c) => {
        const li = el('li');
        li.append(el('span', 'ticker', c.symbol), el('span', 'sub', c.problem), el('span', 'addr', c.mint));
        return li;
      }),
    );
  }

  async function load() {
    try {
      const r = await fetch('/state.json', { cache: 'no-store' });
      if (r.ok) render(await r.json());
    } catch {
      // the next read tries again
    }
  }

  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && load());
  setInterval(load, 5_000);
  load();
})();
