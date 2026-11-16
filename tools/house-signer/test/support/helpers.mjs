// Shared by the tests. Not a test file: node --test loads it, finds no tests, and moves on.
//
// Test keys are keccak256("house-bidder test key <n>"), never a well-known key: those carry
// EIP-7702 code on mainnet and Seaport would check them through EIP-1271.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { addressOf } from '../../src/sign.mjs';
import { validatePolicy } from '../../src/policy.mjs';
import { bytesToHex, bytesToBigint, hexToBytes } from '../../src/hex.mjs';

export const FIXTURE = JSON.parse(fs.readFileSync(new URL('../fixtures/viem-fixture.json', import.meta.url), 'utf8'));

export function testKey(n) {
  return keccak_256(new TextEncoder().encode(`house-bidder test key ${n}`));
}

export const HOUSE_KEY = testKey(1);
export const HOUSE = addressOf(HOUSE_KEY);
export const OTHER_KEY = testKey(2);
export const OTHER = addressOf(OTHER_KEY);
export const FUNDING = '0x1111111111111111111111111111111111111111';
export const STRANGER = '0x2222222222222222222222222222222222222222';

export const JBAC = '0xd37264c71e9af940e49795f0d3a8336afaafdda9';
export const GNSS = '0xa1de9f93c56c290c48849b1393b09eb616d55dbb';
export const SIGNED_ZONE_ADDR = '0x000056f7000000ece9003ca63978907a00ffd100';
export const ZERO32 = `0x${'00'.repeat(32)}`;

/** A valid policy.json (as parsed JSON). `edit` changes a deep copy before it is returned. */
export function rawPolicy(edit = () => {}) {
  const p = {
    version: 1,
    chainId: 1,
    house: HOUSE,
    fundingWallet: FUNDING,
    collections: {
      junglebay: { address: '0xd37264c71e9af940e49795F0d3a8336afAaFDdA9', enabled: true, maxUnitPriceWei: '45000000000000000', maxQty: 2, inventoryCap: 3, creatorFee: null },
      gnssart: { address: '0xa1De9f93c56C290C48849B1393b09eB616D55dbb', enabled: false, maxUnitPriceWei: '16000000000000000', maxQty: 1, inventoryCap: 2, creatorFee: null },
    },
    openseaFee: { recipient: '0x0000a26b00c1F0DF003000390027140000fAa719', bps: 100 },
    venueFee: null,
    maxLifetimeSec: 1800,
    maxAllowanceWei: '150000000000000000',
    maxWrapWei: '200000000000000000',
    gas: { maxFeeGwei: 20, priorityGwei: 0.05, killPriorityGwei: 2, maxGasLimit: 300000 },
    listing: { enabled: false, maxLifetimeSec: 259200, minUnitPriceWei: { junglebay: '40000000000000000', gnssart: '15000000000000000' } },
  };
  const copy = structuredClone(p);
  edit(copy);
  return copy;
}

export function makePolicy(edit) {
  const v = validatePolicy(rawPolicy(edit));
  if (!v.ok) throw new Error(`test policy invalid: ${v.field} ${v.reason}`);
  return v.policy;
}

// Every temp folder a test makes is removed when its test process exits (node --test runs
// each file in its own process), so a mutation run's few hundred suite runs leave nothing.
const madeDirs = [];
process.once('exit', () => {
  for (const dir of madeDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* a folder still open on Windows is left for the OS to clear */ }
  }
});

export function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `house-signer-${label}-`));
  madeDirs.push(dir);
  return dir;
}

/** The NFT line OpenSea's build returns for a collection bid by `house`. */
export function buildFor({ token = JBAC, qty = 1, recipient = HOUSE } = {}) {
  return {
    zone: '0x000056f7000000ece9003ca63978907a00ffd100',
    zoneHash: ZERO32,
    consideration: [{ itemType: 4, token, identifierOrCriteria: '0', startAmount: String(qty), endAmount: String(qty), recipient }],
  };
}

export function bidRequest(overrides = {}, nowSec = 1_763_251_200) {
  const qty = overrides.qty ?? 1;
  return {
    id: 'req-1',
    op: 'signBid',
    slug: 'junglebay',
    qty,
    unitPriceWei: '30000000000000000',
    startTime: nowSec,
    endTime: nowSec + 1800,
    build: buildFor({ qty }),
    ...overrides,
  };
}

// --- RLP decoding, written separately from src/rlp.mjs so the tests read transactions
// back with code that shares nothing with the encoder. --------------------------------

function decodeItem(bytes, at) {
  const b = bytes[at];
  if (b < 0x80) return { item: bytes.slice(at, at + 1), next: at + 1 };
  if (b < 0xb8) return { item: bytes.slice(at + 1, at + 1 + b - 0x80), next: at + 1 + b - 0x80 };
  if (b < 0xc0) {
    const ll = b - 0xb7;
    const len = Number(bytesToBigint(bytes.slice(at + 1, at + 1 + ll)));
    return { item: bytes.slice(at + 1 + ll, at + 1 + ll + len), next: at + 1 + ll + len };
  }
  let len;
  let start;
  if (b < 0xf8) {
    len = b - 0xc0;
    start = at + 1;
  } else {
    const ll = b - 0xf7;
    len = Number(bytesToBigint(bytes.slice(at + 1, at + 1 + ll)));
    start = at + 1 + ll;
  }
  const items = [];
  let p = start;
  while (p < start + len) {
    const d = decodeItem(bytes, p);
    items.push(d.item);
    p = d.next;
  }
  return { item: items, next: start + len };
}

/** A signed type-2 raw transaction -> its fields. */
export function decodeTx(raw) {
  const bytes = hexToBytes(raw);
  if (bytes[0] !== 2) throw new Error('not a type 2 transaction');
  const f = decodeItem(bytes, 1).item;
  const n = (x) => bytesToBigint(x);
  return {
    chainId: n(f[0]),
    nonce: n(f[1]),
    maxPriorityFeePerGas: n(f[2]),
    maxFeePerGas: n(f[3]),
    gas: n(f[4]),
    to: bytesToHex(f[5]),
    value: n(f[6]),
    data: bytesToHex(f[7]),
    accessList: f[8],
    yParity: n(f[9]),
    r: n(f[10]),
    s: n(f[11]),
  };
}

export const txHashOf = (raw) => bytesToHex(keccak_256(hexToBytes(raw)));

/**
 * An in-memory chain with the same methods as src/chain.mjs. Transactions it is sent are
 * decoded and kept in `sent`; by default each is mined (a receipt appears and the latest
 * nonce moves past it) the first time its receipt is asked for. Hooks change that.
 */
export function fakeChain(opts = {}) {
  const state = {
    counter: opts.counter ?? 0n,
    code: opts.code ?? '0x',
    latest: opts.latest ?? 0n,
    pending: opts.pending ?? opts.latest ?? 0n,
    baseFee: opts.baseFee ?? 5_000_000_000n,
    block: 1000n,
    weth: opts.weth ?? 0n,
    allowance: opts.allowance ?? 0n,
    sent: [],
    receipts: new Map(),
    broadcastCount: new Map(),
    autoMine: opts.autoMine ?? true,
    neverMine: new Set(),
    simulateError: null,
    counterError: null,
    onCounter: null,
    onSimulate: null,
  };
  return {
    state,
    async counter() {
      if (state.onCounter) await state.onCounter();
      if (state.counterError) throw state.counterError;
      return state.counter;
    },
    async code() {
      return state.code;
    },
    async nonce(_address, tag) {
      return tag === 'pending' ? (state.pending > state.latest ? state.pending : state.latest) : state.latest;
    },
    async nextBaseFee() {
      return state.baseFee;
    },
    async blockNumber() {
      state.block += 1n;
      return state.block;
    },
    async receipt(hash) {
      if (state.receipts.has(hash)) return state.receipts.get(hash);
      const tx = state.sent.find((t) => t.hash === hash);
      if (!tx || !state.autoMine || state.neverMine.has(hash) || state.neverMine.has(Number(tx.decoded.nonce))) return null;
      const r = { status: 'success', blockNumber: state.block };
      state.receipts.set(hash, r);
      if (tx.decoded.nonce + 1n > state.latest) state.latest = tx.decoded.nonce + 1n;
      return r;
    },
    async simulate(call) {
      if (state.onSimulate) await state.onSimulate(call);
      if (state.simulateError) throw state.simulateError;
    },
    async wethBalance() {
      return state.weth;
    },
    async wethAllowance() {
      return state.allowance;
    },
    async chainIds() {
      return [{ host: 'fake', chainId: 1n }];
    },
    async broadcast(raw) {
      const hash = txHashOf(raw);
      state.broadcastCount.set(hash, (state.broadcastCount.get(hash) ?? 0) + 1);
      if (!state.sent.some((t) => t.hash === hash)) {
        const decoded = decodeTx(raw);
        state.sent.push({ hash, raw, decoded });
        // Like a node's mempool view: the pending count moves past what it has seen.
        if (decoded.nonce + 1n > state.pending) state.pending = decoded.nonce + 1n;
        if (state.onBroadcast) state.onBroadcast({ hash, raw, decoded });
      }
      return state.broadcastResult ? state.broadcastResult(raw) : [{ host: 'fake.send', ok: true }];
    },
  };
}

/** A clock the signer's sleep() moves forward, so waiting three minutes takes no time. */
export function fakeClock(start = 1_763_251_200_000) {
  let t = start;
  return {
    nowMs: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}
