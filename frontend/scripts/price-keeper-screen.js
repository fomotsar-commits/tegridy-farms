/* The gap screen's script (price-keeper-screen.html). Reads /state.json every 3 s and draws it.
 * Every value is set as text, never as markup. */
/* global document, window */
(() => {
  const $ = (id) => document.getElementById(id);
  const OUTCOMES = {
    'quote-short': 'Jupiter’s real quote fell short of the floor',
    'no-route': 'Jupiter has no route that avoids Raydium',
    error: 'Jupiter refused the call (often: too many calls)',
    'no-plan': 'Too small, or no price for the coin',
    'no-coin': 'The robot holds none of the pool’s coin',
    'no-sol-price': 'No SOL price to count a new account’s rent',
    'test-failed': 'Test run refused by the chain',
    'test-checks': 'Test run made less than the floor',
    banned: 'Banned for a day: the chain refused two of its trips',
    'not-sent': 'Test run PASSED: a trip (not sent: dry run, stop file or day’s cap)',
    sent: 'SENT',
    unsure: 'Sent, not confirmed yet',
  };
  const el = (tag, props = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') n.textContent = v;
      else if (k === 'cls') n.className = v;
      else n.setAttribute(k, v);
    }
    for (const c of kids) n.append(c);
    return n;
  };
  const usd = (n) => (typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : '–');
  const time = (iso) => (iso ? iso.slice(11, 19) : '–');
  const fill = (body, rows, cols, emptyText) => {
    body.replaceChildren(...(rows.length ? rows : [el('tr', {}, [el('td', { colspan: String(cols), cls: 'empty', text: emptyText })])]));
  };

  function draw(s) {
    $('mode').textContent = s.live ? 'LIVE' : 'DRY RUN';
    $('mode').className = s.live ? 'mode live' : 'mode';
    $('who').replaceChildren('Robot wallet ', el('code', { text: s.wallet }), ` · running since ${s.since.replace('T', ' ').slice(0, 19)} UTC · Jupiter ${s.keyed ? 'with its own key' : 'keyless (1 call in 2 s, shared by this PC)'}`);
    const c = s.calls;
    const made = c.quote + c.swap + c.price + c.labels;
    $('tPasses').textContent = String(s.passes.length ? s.passCount : 0);
    $('tLast').textContent = s.passes.length ? `latest at ${time(s.passes[0].at)} UTC` : '';
    $('tCalls').textContent = String(made);
    $('tCallsBy').textContent = `${c.quote} quotes · ${c.swap} swap builds · ${c.price} price reads · ${c.labels} venue lists`;
    const pricesSaved = Math.max(0, s.asks.price - c.price);
    const labelsSaved = Math.max(0, s.asks.labels - c.labels);
    $('tSaved').textContent = String(pricesSaved + labelsSaved + s.remembered);
    $('tSavedBy').textContent = `${pricesSaved} price reads reused · ${labelsSaved} venue lists reused · ${s.remembered} gaps answered from memory (at least 1 quote each)`;
    $('tLoops').textContent = String(s.loops);

    const last = s.passes[0];
    fill(
      $('gaps'),
      (last?.rows ?? []).map((g) =>
        el('tr', {}, [
          el('td', {}, [el('code', { text: g.name ?? `? (${g.tokenMint}) / ${g.coin}` })]),
          el('td', {}, [el('code', { text: g.pool })]),
          el('td', { cls: 'num', text: usd(g.listedUsd) }),
          el('td', { cls: 'num', text: usd(g.wantUsd) }),
          el('td', {}, [el('span', { cls: g.byChain ? 'tag chain' : 'tag', text: g.byChain ? 'chain + Jupiter' : 'Jupiter listed' })]),
          el('td', { text: OUTCOMES[g.outcome] ?? g.outcome }),
          el('td', {}, [el('span', { cls: g.remembered ? 'tag saved' : 'tag', text: g.remembered ? 'saved' : 'made' })]),
        ]),
      ),
      7,
      last ? 'No gap worth the floor in the latest pass.' : 'No pass yet.',
    );
    fill(
      $('passes'),
      s.passes.map((p) =>
        el('tr', {}, [
          el('td', { text: time(p.at) }),
          el('td', { cls: 'num', text: String(p.pools) }),
          el('td', { cls: 'num', text: String(p.gaps) }),
          el('td', { cls: 'num', text: String(p.loops) }),
          el('td', { cls: 'num', text: String(p.jupiterCalls) }),
          el('td', { cls: 'num', text: String(p.sent) }),
        ]),
      ),
      6,
      'No pass yet.',
    );
  }

  async function read() {
    try {
      const r = await fetch('/state.json', { cache: 'no-store' });
      if (!r.ok) throw new Error(`the robot answered ${r.status}`);
      draw(await r.json());
      $('error').textContent = '';
    } catch (e) {
      $('error').textContent = `Not read: ${e instanceof Error ? e.message : String(e)}. Is the robot still running?`;
    }
  }
  read();
  window.setInterval(read, 3000);
})();
