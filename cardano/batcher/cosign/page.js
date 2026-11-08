// The co-signing page (scripts/cosign.ts serves it). Everything it shows comes from the server's
// reading of the transaction's own bytes; every signature it gets from a wallet goes back to the
// server, which checks it before keeping it. Text only: nothing read is ever parsed as HTML.
'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'onclick') e.addEventListener('click', v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};
const ada = (lovelace) => {
  const n = BigInt(lovelace);
  const whole = n / 1000000n;
  const part = (n % 1000000n).toString().padStart(6, '0');
  return `${whole.toLocaleString('en-US')}.${part} ADA (${n.toLocaleString('en-US')} lovelace)`;
};
const coins = (list) => (list && list.length ? list.map((c) => `${BigInt(c.quantity).toLocaleString('en-US')} x ${c.text ? `"${c.text}" ` : ''}${c.policy}.${c.name}`).join('; ') : '');
const addr = (a) => el('span', { class: 'addr' }, a);

let run = null;
let current = null;

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function table(head, rows) {
  const t = el('table', {}, el('tr', {}, ...head.map((h) => el('th', {}, h))));
  for (const r of rows) t.append(el('tr', {}, ...r.map((c) => el('td', {}, c))));
  return t;
}

/** One UTxO a line at a time: its whole address never squeezed into a column. */
function held(u, title) {
  const extra = [u.datum ? `inline datum, ${u.datum.length / 2} bytes` : '', u.datumHash ? `datum hash ${u.datumHash}` : '', u.scriptRef ? `reference script ${u.scriptRef.hash} (${u.scriptRef.bytes} bytes)` : ''].filter(Boolean);
  return el('div', { class: 'utxo' },
    el('div', {}, el('strong', {}, title), ' ', ada(u.lovelace)),
    el('div', {}, 'at ', addr(u.address)),
    ...(u.coins && u.coins.length ? [el('div', {}, 'with ', coins(u.coins))] : []),
    ...extra.map((x) => el('div', {}, x)),
    ...(u.from ? [el('div', { class: 'small' }, `read from ${u.from}${u.key ? `; spent by key ${u.key}` : ''}${u.script ? `; judged by script ${u.script}` : ''}`)] : []));
}
const helds = (list, title) => (list.length ? el('div', {}, ...list.map((u) => held(u, title(u)))) : el('p', {}, 'None'));

function render(s) {
  current = s;
  const r = s.review;
  $('tx').hidden = false;
  $('tx-title').textContent = s.step;
  $('tx-id').textContent = r.txId;
  const b = $('tx-body');
  b.replaceChildren();
  const part = (title, node) => b.append(el('h3', {}, title), node);
  part(`Inputs (${r.inputs.length}): what it spends`, helds(r.inputs, (u) => u.ref));
  part(`Outputs (${r.outputs.length}): where it pays`, helds(r.outputs, (u) => `#${u.index}:`));
  part('Network fee', el('p', {}, ada(r.fee)));
  if (r.collateral.length) part('Collateral (taken only if a script fails)', helds(r.collateral, (u) => u.ref));
  if (r.collateralReturn) part('Collateral return', helds([r.collateralReturn], () => 'returned:'));
  if (r.totalCollateral) part('Total collateral', el('p', {}, ada(r.totalCollateral)));
  if (r.referenceInputs.length) part('Reference inputs (read, not spent)', helds(r.referenceInputs, (u) => u.ref));
  part('Mint', r.mint.length ? table(['Policy', 'Name', 'Quantity'], r.mint.map((m) => [el('code', {}, m.policy), `${m.text ? `"${m.text}" ` : ''}${m.name}`, BigInt(m.quantity).toLocaleString('en-US')])) : el('p', {}, 'None'));
  part('Certificates', r.certificates.length ? table(['Kind', 'Credential'], r.certificates.map((c) => [c.kind, `${c.script ? 'script' : 'key'} ${c.credential}`])) : el('p', {}, 'None'));
  part('Withdrawals', r.withdrawals.length ? table(['Reward address', 'ADA'], r.withdrawals.map((w) => [addr(w.rewardAddress), ada(w.lovelace)])) : el('p', {}, 'None'));
  part('Required signers', r.requiredSigners.length ? el('ul', {}, ...r.requiredSigners.map((k) => el('li', {}, el('code', {}, k)))) : el('p', {}, 'None'));
  const v = r.validity;
  part('Valid', el('p', {}, `from ${v.from ? `slot ${v.from.slot} (${v.from.time})` : 'any time'} until ${v.until ? `slot ${v.until.slot} (${v.until.time})` : 'no end'}`));
  part('Scripts run', r.redeemers.length ? table(['Purpose', 'Index', 'Memory', 'Steps'], r.redeemers.map((x) => [x.tag, x.index, x.mem, x.steps])) : el('p', {}, 'None'));
  if (r.plutusScripts.length) part('Scripts carried in the transaction', el('ul', {}, ...r.plutusScripts.map((h) => el('li', {}, el('code', {}, h)))));
  part('Metadata', el('p', {}, r.metadataHash ? `hash ${r.metadataHash}` : 'None'));

  const n = $('needs');
  n.replaceChildren(el('tr', {}, el('th', {}, 'Key'), el('th', {}, 'Who'), el('th', {}, 'Why'), el('th', {}, 'Signed')));
  for (const k of r.needs) n.append(el('tr', {}, el('td', {}, el('code', {}, k.key)), el('td', {}, k.label || 'not one of the run\'s named keys'), el('td', {}, k.why.join('; ')), el('td', {}, s.signed.includes(k.key) ? el('span', { class: 'ok' }, 'yes') : 'not yet')));
  const res = $('result');
  if (s.stale) res.replaceChildren(el('span', { class: 'warn' }, 'The signatures kept were for an earlier version of this transaction. Delete its witnesses file and sign again.'));
  else if (!s.missing.length) res.replaceChildren(el('span', { class: 'ok' }, 'Every signature is in. Next, in the terminal: '), el('code', {}, run.submit.replace('<step>', s.step)));
  else res.textContent = `Still to sign: ${s.missing.length}.`;
  wallets();
}

function wallets() {
  const w = $('wallets');
  w.replaceChildren();
  const found = Object.entries(window.cardano || {}).filter(([, x]) => x && typeof x.enable === 'function');
  if (!found.length) return w.append('No Cardano wallet found in this browser. Install or unlock it, then reload.');
  for (const [id, x] of found) w.append(el('button', { type: 'button', onclick: () => sign(id) }, `Sign with ${x.name || id}`));
}

async function sign(id) {
  const s = current;
  const res = $('result');
  const holds = $('wallet-holds');
  holds.textContent = '';
  try {
    res.textContent = 'Asking the wallet...';
    const w = await window.cardano[id].enable();
    const networkId = await w.getNetworkId();
    const addresses = [...((await w.getUsedAddresses()) || []), ...((await w.getUnusedAddresses()) || []), await w.getChangeAddress()].filter(Boolean);
    const h = await api('/api/wallet', { step: s.step, networkId, addresses });
    holds.textContent = h.holds.length ? `This wallet holds: ${h.holds.map((k) => `${k.label || 'key'} ${k.key}`).join(', ')}.` : 'This wallet shows none of the keys still needed: if it holds one at another address, it can still sign.';
    res.textContent = 'Read the transaction in the wallet too, then sign there.';
    const witnessSet = await w.signTx(s.txHex, true);
    const after = await api('/api/witness', { step: s.step, txId: s.review.txId, witnessSet, networkId });
    render(after);
    holds.textContent = `Kept the signature of ${after.kept.map((k) => (after.review.needs.find((x) => x.key === k) || {}).label || k).join(', ')}.`;
  } catch (e) {
    res.replaceChildren(el('span', { class: 'warn' }, `Refused: ${e && (e.message || e.info) ? e.message || e.info : String(e)}`));
  }
}

async function open(step) {
  $('result').textContent = 'Reading...';
  try {
    render(await api(`/api/tx?step=${encodeURIComponent(step)}`));
  } catch (e) {
    $('tx').hidden = false;
    $('tx-title').textContent = step;
    $('tx-body').replaceChildren();
    $('needs').replaceChildren();
    $('result').replaceChildren(el('span', { class: 'warn' }, `Cannot show it: ${e.message}`));
  }
}

async function load() {
  run = await api('/api/run');
  const n = $('network');
  n.textContent = run.network === 1 ? 'MAINNET: these transactions spend real ADA once sent.' : `Network: ${run.networkName} (test ADA only)`;
  n.className = `network ${run.network === 1 ? 'mainnet' : ''}`;
  const ul = $('steps');
  ul.replaceChildren();
  for (const s of run.steps) ul.append(el('li', {}, `${s.step}: ${s.sent ? 'sent' : `${s.signatures} signature${s.signatures === 1 ? '' : 's'} kept`}`, el('button', { type: 'button', onclick: () => open(s.step) }, 'Open')));
}

load().catch((e) => {
  $('network').textContent = `The page could not start: ${e.message}`;
});
