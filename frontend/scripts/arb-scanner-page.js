// The arbitrage scanner's page (scripts/arb-scanner.mjs serves it). Every name a token or pool
// chose is written as text, never as markup; links are built only from checked addresses.
/* global document */
(() => {
  const $ = (id) => document.getElementById(id);
  const NETWORK = { solana: 'solana', robinhood: 'robinhood' };
  const ADDRESS = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
  let state = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const usd = (n) => (n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`);
  const pct = (n) => `${n.toFixed(n < 1 ? 3 : 2)}%`;
  const price = (n) => (n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : n.toPrecision(4));
  const ago = (t) => {
    if (!t) return 'not yet';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
  };

  function poolLink(chain, pool, text) {
    if (!NETWORK[chain] || !ADDRESS.test(pool)) return el('span', null, text);
    const a = el('a', null, text);
    a.href = `https://www.geckoterminal.com/${NETWORK[chain]}/pools/${pool}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function legCell(chain, leg, unit) {
    const td = el('td');
    td.append(poolLink(chain, leg.pool, leg.dex));
    td.append(el('span', 'sub', `fee ${(leg.fee * 100).toFixed(3)}%${leg.feeKnown ? '' : ' (assumed)'} · ${price(leg.price)} ${unit}`));
    td.append(el('span', 'sub', `depth ${usd(leg.reserveUsd)} · ${leg.tradesHour} trade${leg.tradesHour === 1 ? '' : 's'} in the last hour`));
    td.append(el('span', 'addr', leg.pool));
    return td;
  }

  function row(chain, r) {
    const tr = el('tr');
    const token = el('td');
    token.append(el('span', 'chain', chain === 'solana' ? 'SOL' : 'HOOD'));
    token.append(el('span', 'ticker', r.label));
    if (r.key.startsWith('token:')) token.append(el('span', 'addr', r.token));
    token.append(el('span', 'sub', `${r.pools} pools`));
    tr.append(token, legCell(chain, r.buy, r.unit), legCell(chain, r.sell, r.unit));
    tr.append(el('td', 'n', pct(r.gapPct)), el('td', 'n', pct(r.costPct)));
    tr.append(el('td', 'n', r.sizeUsd > 0 ? usd(r.sizeUsd) : '—'));
    tr.append(el('td', `n ${r.profitUsd > 0 ? 'pays' : 'nopay'}`, r.profitUsd > 0 ? usd(r.profitUsd) : 'no'));
    const notes = el('td');
    if (r.sameTicker) notes.append(el('span', 'tag bad', `ticker also used by ${r.sameTicker} other token${r.sameTicker > 1 ? 's' : ''}`));
    if (r.suspect) notes.append(el('span', 'tag bad', 'gap over 50%: usually an old price or a coin that cannot be sold'));
    if (r.quiet) notes.append(el('span', 'tag warn', 'a pool had no trade in the last hour: its price may be old'));
    if (r.feeAssumed) notes.append(el('span', 'tag', 'a fee is assumed'));
    if (r.buy.coin !== r.sell.coin) notes.append(el('span', 'tag', 'priced in two coins: a third swap between them'));
    tr.append(notes);
    return tr;
  }

  function render() {
    if (!state) return;
    const chainPick = $('chain').value;
    const paying = $('paying').checked;
    const min = Number($('min').value) || 0;
    const sure = $('sure').checked;

    const status = $('status');
    status.replaceChildren();
    for (const c of state.chains) {
      const s = el('span');
      s.append(el('b', null, c.name), document.createTextNode(`: ${c.note ?? `${c.pools} pools of ${c.tokens} tokens · prices ${ago(c.pricesAt)} · busy list ${ago(c.universeAt)}`}`));
      status.append(s);
    }

    const all = state.chains.filter((c) => chainPick === 'all' || c.id === chainPick).flatMap((c) => c.rows.map((r) => ({ chain: c.id, r })));
    const kept = all.filter(({ r }) => !(sure && (r.quiet || r.suspect || r.sameTicker)));
    let shown = paying ? kept.filter(({ r }) => r.profitUsd >= Math.max(min, 0.000001)) : kept;
    const empty = $('empty');
    empty.hidden = true;
    if (paying && !shown.length && kept.length) {
      empty.hidden = false;
      empty.textContent = `No gap pays $${min} or more after fees right now. The busiest pools are kept in line by professional bots; gaps open in thinner pools, and for seconds. Below: the ${Math.min(10, kept.length)} closest.`;
      shown = [...kept].sort((a, b) => b.r.gapPct - b.r.costPct - (a.r.gapPct - a.r.costPct)).slice(0, 10);
    }
    $('rows').replaceChildren(...shown.map(({ chain, r }) => row(chain, r)));
  }

  async function load() {
    try {
      const r = await fetch('/state.json', { cache: 'no-store' });
      if (r.ok) state = await r.json();
    } catch {
      // the next read tries again
    }
    render();
  }

  for (const id of ['chain', 'paying', 'min', 'sure']) $(id).addEventListener('input', render);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && load());
  setInterval(load, 10_000);
  load();
})();
