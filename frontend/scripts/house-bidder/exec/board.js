// The house bidder board's page script (exec/board.html), served as /app.js by
// `node scripts/house-bidder.mjs board`: the only script the page's content security policy lets
// run. It reads /status.json every 5 seconds and writes every figure as text, never as HTML.
// It runs in the browser.
/* global document, window */

const WEI = 10n ** 18n;
const ethText = (v) => {
  if (v === null || v === undefined || v === '') return 'n/a';
  let w;
  try {
    w = BigInt(v);
  } catch {
    return String(v);
  }
  const neg = w < 0n;
  const a = neg ? -w : w;
  const frac = (a % WEI).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / WEI}${frac ? `.${frac}` : ''} ETH`;
};
const el = (id) => document.getElementById(id);
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
function pairs(node, list) {
  clear(node);
  for (const [k, v] of list) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    node.append(dt, dd);
  }
}
function items(node, list, empty) {
  clear(node);
  for (const text of list.length ? list : [empty]) {
    const li = document.createElement('li');
    li.textContent = text;
    node.append(li);
  }
}
const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 120 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};

function render(s) {
  if (s.missing) {
    el('sub').textContent = s.note;
    return;
  }
  el('sub').textContent = `${s.mode === 'shadow' ? 'SHADOW (nothing is signed or posted)' : 'LIVE'} · house ${s.house ?? 'not set'} · last tick ${ago(s.lastTickAt)}`;
  const state = el('state');
  if (s.halted) {
    state.className = 'state bad';
    state.textContent = `HALTED (${s.halted.reason}): ${s.halted.detail ?? ''}. A person restarts it with --ack-halt.`;
  } else if (s.paused) {
    state.className = 'state warn';
    state.textContent = `Paused (${s.paused.reason}) until ${new Date(s.paused.until).toISOString().slice(11, 16)} UTC`;
  } else if (s.capped) {
    state.className = 'state warn';
    state.textContent = `Daily cap reached (${s.capped.reason}): no new bid until tomorrow (UTC)`;
  } else {
    state.className = 'state ok';
    state.textContent = s.gate?.canPost ? 'Bidding' : `Holding: ${s.gate?.reason ?? ''}`;
  }

  const box = el('collections');
  clear(box);
  for (const [slug, c] of Object.entries(s.collections ?? {})) {
    const sec = document.createElement('section');
    const h = document.createElement('h2');
    h.textContent = `${c.ticker} (${slug})${c.enabled ? '' : ' · off'}`;
    const dl = document.createElement('dl');
    pairs(dl, [
      ['fair value F', ethText(c.F)],
      ['sales value S', ethText(c.S)],
      ['listing check L', ethText(c.L)],
      ['cheapest fillable', ethText(c.cheapestFillable)],
      ['standing bid', c.standing ? `${ethText(c.standing.unitPriceWei)} × ${c.standing.qty} (${c.standing.filled} filled), ends ${new Date(c.standing.endTime * 1000).toISOString().slice(11, 16)} UTC` : 'none'],
      ['plan', c.plan ? (c.plan.none ? `no bid: ${c.plan.reason}` : `${ethText(c.plan.unitPriceWei)} × ${c.plan.qty} (set by the ${c.plan.binding} line)`) : 'n/a'],
      ['held', String(c.held)],
      ['outstanding', `${c.outstanding} unit(s), ${c.tailUnits} in a cancel tail`],
    ]);
    sec.append(h, dl);
    box.append(sec);
  }
  pairs(el('wallet'), [
    ['WETH', ethText(s.chain?.weth)],
    ['approval', ethText(s.chain?.allowance)],
    ['ETH (gas)', ethText(s.chain?.eth)],
    ['Seaport counter', s.chain?.counter ?? 'n/a'],
    ['block', s.chain?.block ?? 'n/a'],
  ]);
  pairs(el('today'), [
    ['bought', `${s.today?.units ?? 0} NFT(s)`],
    ['WETH spent', ethText(s.today?.wethSpent)],
    ['transactions', String(s.today?.txs ?? 0)],
    ['stream gaps', String(s.stream?.gaps ?? 0)],
  ]);
  items(el('trips'), (s.trips ?? []).slice().reverse().map((t) => `${new Date(t.at).toISOString().slice(0, 16).replace('T', ' ')} ${t.kind}: ${t.reason}`), 'none');
  items(el('errors'), (s.errors ?? []).slice().reverse().map((e) => `${new Date(e.at).toISOString().slice(11, 19)} ${e.line}`), 'none');
}

async function refresh() {
  try {
    const r = await window.fetch('/status.json', { cache: 'no-store' });
    render(await r.json());
  } catch {
    el('sub').textContent = 'the board could not read status.json';
  }
}
refresh();
window.setInterval(refresh, 5000);
