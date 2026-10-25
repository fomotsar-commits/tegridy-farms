// The fee-tier page. Bundled with rolldown by stage.mjs into app.bundle.js. Every action re-reads the
// chain and re-decides first, then asks the network to work the transaction out without sending it,
// and only then hands it to your wallet to sign.
import * as web3 from '@solana/web3.js';
import { Buffer } from 'buffer';
import { makeCore, decide } from '../scripts/lib/tiers.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const log = (w) => { const li = document.createElement('li'); li.textContent = `${new Date().toISOString().slice(11, 19)}  ${w}`; $('log').prepend(li); };
const cfg = await (await fetch('/config.json')).json();
const conn = new web3.Connection(`${location.origin}/rpc`, { commitment: 'confirmed', disableRetryOnRateLimit: true });
// A second RPC, for reads only: before a signature the page checks one against the other.
const check = new web3.Connection(`${location.origin}/rpc-check`, { commitment: 'confirmed', disableRetryOnRateLimit: true });
const core = makeCore({ web3, cfg });
const sha256hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
let member = null;
let busy = false;

// ---- one tab at a time ------------------------------------------------------------------------
const tabs = new BroadcastChannel('range-pools-fee-tier-page');
let otherTab = false;
tabs.onmessage = (e) => { if (e.data === 'is anyone here?') tabs.postMessage('here'); if (e.data === 'here') { otherTab = true; render(); } };
tabs.postMessage('is anyone here?');

// ---- the network, and what the proposal does ----------------------------------------------
const genesis = await conn.getGenesisHash();
const net = genesis === cfg.genesis.mainnet ? 'mainnet' : genesis === cfg.genesis.devnet ? 'devnet' : 'local';
$('net').textContent = net === 'mainnet' ? 'MAINNET: real money' : net === 'local' ? 'A LOCAL rehearsal chain' : 'DEVNET: this page does not run on devnet';
$('net').className = `net ${net}`;
const okNet = (cfg.kind === 'mainnet' && net === 'mainnet') || (cfg.kind === 'rehearsal' && net === 'local');
const pct = (r) => `${(r / 10000).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`;
$('what').innerHTML = `<h2>What this one proposal does, when it executes</h2>
<p>It makes the range program's one fee tier, with the island split, and points its fund share at the island's Workshop. The vault signs it; the vault pays 0.0012 SOL of rent.</p>
<table><tr><th>Tier</th><th>Fee of each swap</th><th>Price steps</th><th>LPs keep</th><th>Venue (vault)</th><th>Island (Workshop)</th><th>Account</th></tr>
${cfg.tiers.map((t) => `<tr><td>${t.index}</td><td>${pct(t.tradeFeeRate)}</td><td>${t.tickSpacing}</td><td>${pct((t.tradeFeeRate * (1e6 - t.protocolFeeRate - t.fundFeeRate)) / 1e6)}</td><td>${pct((t.tradeFeeRate * t.protocolFeeRate) / 1e6)}</td><td>${pct((t.tradeFeeRate * t.fundFeeRate) / 1e6)}</td><td><code>${core.ammConfig(t.index).toBase58()}</code></td></tr>`).join('')}</table>
<p>Program <code>${esc(cfg.programId)}</code> · vault <code>${esc(cfg.addr.vault)}</code> · Workshop <code>${esc(cfg.addr.workshop)}</code></p>`;

// ---- the wallet ---------------------------------------------------------------------------------
const provider = () => window.phantom?.solana ?? window.solflare ?? window.backpack?.solana ?? window.solana ?? null;
$('connect').onclick = async () => {
  const p = provider();
  if (!p) return log('no Solana wallet found in this browser');
  try { const r = await p.connect(); member = (r?.publicKey ?? p.publicKey).toBase58(); log(`connected ${member}`); } catch (e) { log(`not connected: ${e.message}`); }
  await refresh();
};
$('disconnect').onclick = async () => { try { await provider()?.disconnect(); } catch { /* the wallet decides */ } member = null; log('disconnected'); await refresh(); };

// ---- reading, deciding, showing --------------------------------------------------------------
let last = null;
async function notice() { try { return (await (await fetch('/notice')).json()).record; } catch { return null; } }
async function positionLink() { try { return await (await fetch('/position-link')).json(); } catch (e) { return { ok: null, why: `the position link could not be asked (${e.message})` }; } }
async function read() { return decide(cfg, await core.readState(conn, { sha256hex, member, notice: await notice(), positionLink: await positionLink() })); }

/** The same accounts and clock from the second RPC, and the computer's own clock: all must agree. */
async function crossCheck(index) {
  const keys = [new web3.PublicKey(cfg.addr.multisig), core.txPda(index), core.proposalPda(index), new web3.PublicKey('SysvarC1ock11111111111111111111111111111111')];
  const [a, b] = await Promise.all([conn.getMultipleAccountsInfo(keys, 'confirmed'), check.getMultipleAccountsInfo(keys, 'confirmed')]);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ? Buffer.from(a[i].data).toString('hex') : null; const y = b[i] ? Buffer.from(b[i].data).toString('hex') : null;
    if (x !== y) return `the two RPCs disagree about ${keys[i].toBase58()}`;
  }
  const t = (acc) => Number(Buffer.from(acc.data).readBigInt64LE(32));
  if (Math.abs(t(a[3]) - t(b[3])) > 120) return 'the two RPCs give clocks more than two minutes apart';
  if (Math.abs(t(a[3]) - Date.now() / 1000) > 600) return "the network's clock and this computer's are more than ten minutes apart";
  return null;
}
function render() {
  $('who').textContent = member ? `connected: ${member}` : '';
  $('connect').hidden = !!member; $('disconnect').hidden = !member;
  const d = last;
  $('lines').innerHTML = !d ? '<li>Not read yet.</li>' : d.lines.map((l) => `<li class="${l.ok ? 'ok' : 'stop'}">${l.ok ? 'OK' : 'STOP'}: ${esc(l.w)}</li>`).join('');
  const act = $('act');
  if (!okNet) { act.innerHTML = '<div class="halt">STOP: this pack is not for this network.</div>'; return; }
  if (otherTab) { act.innerHTML = '<div class="halt">STOP: this page is open in another tab. Close every other tab of it, then reload this one.</div>'; return; }
  if (!d) { act.innerHTML = ''; return; }
  const words = { propose: 'Sign: create the tier proposal and approve it', approve: `Approve proposal #${d.index}`, execute: `EXECUTE proposal #${d.index}` };
  if (d.action === 'done') act.innerHTML = '<div class="ready">ALREADY DONE: the fee tier exists. Nothing to sign. Run 6-verify-tiers.mjs.</div>';
  else if (d.action) act.innerHTML = `<div class="ready">Ready. <button id="go">${words[d.action]}</button> <button id="again">Check again</button></div>`;
  else act.innerHTML = '<div class="halt">Nothing for this wallet to sign now. <button id="again">Check again</button></div>';
  if ($('go')) $('go').onclick = () => run(d.action);
  if ($('again')) $('again').onclick = refresh;
}
async function refresh() {
  try { last = await read(); } catch (e) { last = { action: null, lines: [{ ok: false, w: `UNREAD: the chain could not be read just now (${e.message}). Check again` }] }; }
  render();
}

// ---- one action: re-decide, simulate, sign, send, confirm ---------------------------------------
async function run(action) {
  if (busy) return; busy = true;
  try {
    const d = await read();
    if (d.action !== action) { last = d; render(); return log(`the chain changed since the last check: now ${d.action ?? 'nothing to do'}. Nothing was signed`); }
    const ms = await core.readMultisig(conn);
    const index = action === 'propose' ? ms.transactionIndex + 1 : d.index;
    const ixs = action === 'propose' ? core.proposeIxs(member, index) : action === 'approve' ? [core.approveIx(member, index)] : [core.executeIx(member, index)];
    if (provider()?.publicKey?.toBase58() !== member) { log('STOP: the wallet now shows another account than the one connected. Click Disconnect / switch wallet, then connect again. Nothing was signed'); return refresh(); }
    const disagree = await crossCheck(index);
    if (disagree) { log(`STOP: ${disagree}. Nothing was signed. Check again in a minute; if it stays, stop and ask`); return refresh(); }
    const sim = await core.simulate(conn, member, ixs);
    if (!sim.ok) { log(`STOP: the network says this would fail (${JSON.stringify(sim.err)}). Nothing was signed. Last lines: ${sim.logs.slice(-3).join(' | ')}`); return refresh(); }
    log(`the network worked it out without sending: it would succeed${action === 'execute' ? ' and make the fee tier' : ''}`);
    const { vtx, lastValidBlockHeight } = await core.txFor(conn, member, ixs);
    const signed = await provider().signTransaction(vtx);
    if (!Buffer.from(signed.message.serialize()).equals(Buffer.from(vtx.message.serialize()))) { log('STOP: your wallet changed the transaction before signing it. Nothing was sent'); return refresh(); }
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 5 });
    log(`sent ${sig}`);
    for (;;) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st?.err) { log(`FAILED: ${JSON.stringify(st.err)}. A failed transaction uses nothing up: check again`); break; }
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') {
        log({ propose: `Done: proposal #${index} is created and you approved it.`, approve: `Done: you approved proposal #${index}.`, execute: `Done: proposal #${index} is EXECUTED. Run 6-verify-tiers.mjs.` }[action]);
        break;
      }
      if ((await conn.getBlockHeight('confirmed')) > lastValidBlockHeight) { log('UNKNOWN: the answer could not be read. It does not mean it failed. Do not sign again: check again'); break; }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (e) { log(`stopped: ${e.message}. Check again before anything else`); } finally { busy = false; }
  await refresh();
}

await refresh();
