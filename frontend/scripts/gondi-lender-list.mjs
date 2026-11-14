// Who lends on Gondi against the collections this venue lists (JBAC, NAKA, GNSS)?
//
// Reads Gondi's OWN loan contracts on Ethereum mainnet (v3.1 and v3.2, not ours): every loan
// opened or refinanced, then lists each lender with how many loans, how much WETH, the rates
// they took and when they last lent. Public chain data only. It writes a CSV and sends
// nothing to anyone: reaching out to these wallets is the owner's call.
//
// Usage (from frontend/):
//   node scripts/gondi-lender-list.mjs <out.csv> [--rpc https://eth.drpc.org] [--from-block N]
// With ETHERSCAN_API_KEY set, the logs come from Etherscan (see logsIn); the RPC still
// serves the block number and the ENS names.
//
// Why these lenders matter: Gondi v3.2 keeps 20% of a lender's interest (getProtocolFee,
// read 2026-11-09; v3.1 keeps 15%). Ours keeps 5%, so the same take-home costs a borrower
// less here (lib/gondi/lenderPitch.ts).
import { writeFileSync } from 'node:fs';
import { createPublicClient, http, getAddress, formatEther, decodeEventLog } from 'viem';
import { mainnet } from 'viem/chains';
import { GONDI_LOAN_ABI } from '../src/lib/gondi/abi.js';
import { LENDING_COLLECTIONS, WETH_ADDRESS } from '../src/lib/gondi/loanOffer.js';

// Gondi's own deploys. Deploy blocks found 2026-11-09 by bisecting eth_getCode (the block
// before each holds no code).
const GONDI_CONTRACTS = [
  { label: 'gondi-v3.1', address: '0xf41B389E0C1950dc0B16C9498eaE77131CC08A56', fromBlock: 23370217n },
  { label: 'gondi-v3.2', address: '0xE365fF3cad44d19cb7aBa81df8ffd6818A66Ac0a', fromBlock: 25875847n },
];

const LOAN_EVENTS = ['LoanEmitted', 'LoanRefinanced', 'LoanRefinancedFromNewOffers'];

// v3.2's Loan tuple ends with `lenderRefinanceDisabled`. v3.1's may not, which changes the
// event selector, so both shapes are asked for and the chain decides which one matches.
function withoutRefinanceFlag(input) {
  if (input.type !== 'tuple' || input.name !== 'loan') return input;
  return { ...input, components: input.components.filter((c) => c.name !== 'lenderRefinanceDisabled') };
}
const v32Events = GONDI_LOAN_ABI.filter((e) => e.type === 'event' && LOAN_EVENTS.includes(e.name));
const v31Events = v32Events.map((e) => ({ ...e, inputs: e.inputs.map(withoutRefinanceFlag) }));
const EVENTS = [...v32Events, ...v31Events];

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a) && !/^https?:/.test(a));
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const rpc = flag('--rpc') ?? 'https://eth.drpc.org';
const fromOverride = flag('--from-block') ? BigInt(flag('--from-block')) : null;
if (!out) {
  console.error('Usage: node scripts/gondi-lender-list.mjs <out.csv> [--rpc URL] [--from-block N]');
  process.exit(2);
}

const client = createPublicClient({ chain: mainnet, transport: http(rpc, { retryCount: 4, timeout: 60_000 }) });
const ours = new Map(LENDING_COLLECTIONS.map((c) => [c.address.toLowerCase(), c.symbol]));
const weth = WETH_ADDRESS.toLowerCase();

// drpc's free plan refuses a getLogs window over 10,000 blocks, and rate-limits bursts.
// 2026-11-09 it refused ANY window on these contracts ("ranges over 10000 blocks are not
// supported on free plan" for 300 blocks), and the other free RPCs refuse archive reads:
// with ETHERSCAN_API_KEY in the environment the logs come from Etherscan's API instead.
const MAX_STEP = 10_000n;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || '';

async function etherscanLogsIn(address, from, to) {
  const logs = [];
  // Etherscan returns at most 1,000 logs a call: a full page means the window is split.
  const windows = [[from, to]];
  while (windows.length) {
    const [a, b] = windows.shift();
    const q = new URLSearchParams({
      chainid: '1', module: 'logs', action: 'getLogs', address,
      fromBlock: a.toString(), toBlock: b.toString(), page: '1', offset: '1000', apikey: ETHERSCAN_KEY,
    });
    let body;
    for (let tries = 1; ; tries++) {
      const r = await fetch(`https://api.etherscan.io/v2/api?${q}`);
      body = await r.json().catch(() => null);
      const busy = !body || (body.status === '0' && /rate limit|max calls/i.test(String(body.result)));
      if (!busy) break;
      if (tries >= 6) throw new Error(`Etherscan kept refusing blocks ${a}-${b}`);
      await pause(1000 * tries);
    }
    const result = Array.isArray(body.result) ? body.result : [];
    if (body.status === '0' && !/no records/i.test(String(body.message))) {
      throw new Error(`Etherscan error for blocks ${a}-${b}: ${body.message}`);
    }
    if (result.length >= 1000 && b > a) {
      const mid = (a + b) / 2n;
      windows.unshift([a, mid], [mid + 1n, b]);
      continue;
    }
    for (const l of result) {
      try {
        const d = decodeEventLog({ abi: EVENTS, data: l.data, topics: l.topics });
        if (LOAN_EVENTS.includes(d.eventName)) logs.push({ args: d.args, eventName: d.eventName });
      } catch {
        // Not a loan event (offer cancels, approvals, ...): skip.
      }
    }
    await pause(250); // free key: 5 calls a second
  }
  return logs;
}

async function logsIn(address, from, to) {
  if (ETHERSCAN_KEY) return etherscanLogsIn(address, from, to);
  let step = MAX_STEP;
  let tries = 0;
  const logs = [];
  for (let start = from; start <= to; ) {
    const end = start + step - 1n > to ? to : start + step - 1n;
    try {
      const got = await client.getLogs({ address, events: EVENTS, fromBlock: start, toBlock: end, strict: false });
      logs.push(...got);
      start = end + 1n;
      tries = 0;
      if (step < MAX_STEP) step *= 2n;
    } catch (err) {
      // Retry the same window with a pause first (rate limits), then shrink it (size caps).
      tries++;
      if (tries <= 3) { await pause(1500 * tries); continue; }
      if (step <= 500n) throw err;
      step /= 2n;
      tries = 0;
    }
  }
  return logs;
}

const head = await client.getBlockNumber();
const lenders = new Map();
const seenTranches = new Set();
const perContract = {};
let undecoded = 0;

for (const g of GONDI_CONTRACTS) {
  const from = fromOverride ?? g.fromBlock;
  const logs = await logsIn(g.address, from, head);
  perContract[g.label] = { logs: logs.length, ours: 0, last30d: 0 };
  for (const log of logs) {
    const loan = log.args?.loan;
    if (!loan) { undecoded++; continue; }
    const symbol = ours.get(String(loan.nftCollateralAddress).toLowerCase());
    if (!symbol) continue;
    perContract[g.label].ours++;
    for (const t of loan.tranche) {
      // A refinance re-emits the tranches it kept: count each tranche once.
      const key = `${g.address}:${t.loanId}:${t.lender}:${t.startTime}:${t.principalAmount}`;
      if (seenTranches.has(key)) continue;
      seenTranches.add(key);
      const when = Number(t.startTime);
      if (when > Date.now() / 1000 - 30 * 86400) perContract[g.label].last30d++;
      const lender = getAddress(t.lender);
      const row = lenders.get(lender) ?? {
        lender, loans: 0, wethWei: 0n, otherCurrencyLoans: 0, collections: new Set(), contracts: new Set(),
        aprMin: Infinity, aprMax: 0, first: Infinity, last: 0,
      };
      row.loans++;
      if (String(loan.principalAddress).toLowerCase() === weth) row.wethWei += t.principalAmount;
      else row.otherCurrencyLoans++;
      row.collections.add(symbol);
      row.contracts.add(g.label);
      row.aprMin = Math.min(row.aprMin, Number(t.aprBps));
      row.aprMax = Math.max(row.aprMax, Number(t.aprBps));
      row.first = Math.min(row.first, when);
      row.last = Math.max(row.last, when);
      lenders.set(lender, row);
    }
  }
}

const rows = [...lenders.values()].sort((a, b) => b.last - a.last || b.loans - a.loans);
// ENS names help a human recognise a wallet; best effort, top 60 by recency only.
for (const r of rows.slice(0, 60)) {
  try { r.ens = (await client.getEnsName({ address: r.lender })) ?? ''; } catch { r.ens = ''; }
}

const day = (s) => (Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString().slice(0, 10) : '');
const pct = (bps) => (Number.isFinite(bps) ? (bps / 100).toFixed(2) : '');
const lines = [
  'lender,ens,loans,weth_lent,other_currency_loans,collections,apr_min_pct,apr_max_pct,first_loan,last_loan,gondi_contracts',
  ...rows.map((r) =>
    [
      r.lender, r.ens ?? '', r.loans, formatEther(r.wethWei), r.otherCurrencyLoans, [...r.collections].sort().join(' '),
      pct(r.aprMin), pct(r.aprMax), day(r.first), day(r.last), [...r.contracts].sort().join(' '),
    ].join(','),
  ),
];
writeFileSync(out, lines.join('\n') + '\n');

console.log(`head block ${head}`);
for (const [label, c] of Object.entries(perContract)) {
  console.log(`${label}: ${c.logs} loan events, ${c.ours} on JBAC/NAKA/GNSS, ${c.last30d} of those tranches in the last 30 days`);
}
if (undecoded) console.log(`WARNING: ${undecoded} log(s) did not decode: an event shape this script does not know`);
console.log(`${rows.length} lenders written to ${out}`);
