// The range program's events and pool counters, decoded from bytes with no imports, so the
// hourly count (scripts/range-stats.mjs, run with no npm install) and the browser read them
// alike. An event is trusted only from a log frame the runtime opened for our program: any
// program can write a "Program data:" line, and Jupiter's SwapEvent has our discriminator.
// Layouts are the program's own; rangeEvents.test.js recomputes each from the Rust structs.

/** The range program, deployed 2026-10-21 (rangeEvents.test.js holds it to declare_id!). */
export const RANGE_PROGRAM_ID = "7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso";

/** `PoolState`, zero-copy and packed: the fields the count reads. */
export const POOL_STATE = {
  len: 1544,
  disc: [247, 237, 227, 245, 215, 195, 222, 70],
  ammConfig: 9,
  mint0: 73,
  mint1: 105,
  vault0: 137,
  vault1: 169,
  decimals0: 233,
  decimals1: 234,
  tickSpacing: 235,
  sqrtPriceX64: 253,
  protocolFeesToken0: 309,
  protocolFeesToken1: 317,
  fundFeesToken0: 1064,
  fundFeesToken1: 1072,
};

/** `AmmConfig`, Borsh: a tier's rates, per million. */
export const AMM_CONFIG = { len: 117, disc: [218, 244, 33, 104, 203, 203, 43, 111], protocolFeeRate: 43, tradeFeeRate: 47, fundFeeRate: 53 };

/** Each event's discriminator (sha256 of "event:<Name>", first 8 bytes) and its fields, in order. */
export const EVENTS = {
  SwapEvent: {
    disc: "40c6cde8260871e2",
    fields: [
      ["pool", "key"], ["sender", "key"], ["tokenAccount0", "key"], ["tokenAccount1", "key"],
      ["amount0", "u64"], ["transferFee0", "u64"], ["amount1", "u64"], ["transferFee1", "u64"],
      ["zeroForOne", "bool"], ["sqrtPriceX64", "u128"], ["liquidity", "u128"], ["tick", "i32"],
      ["tradeFee0", "u64"], ["tradeFee1", "u64"],
    ],
  },
  // Both collect_protocol_fee (the team's vault) and collect_fund_fee (the Workshop) emit
  // this one; the instruction that ran says which.
  CollectProtocolFeeEvent: {
    disc: "ce57114f2d29d53d",
    fields: [["pool", "key"], ["recipient0", "key"], ["recipient1", "key"], ["amount0", "u64"], ["amount1", "u64"]],
  },
  PoolCreatedEvent: {
    disc: "195e4b2f7063353f",
    fields: [
      ["mint0", "key"], ["mint1", "key"], ["tickSpacing", "u16"], ["pool", "key"],
      ["sqrtPriceX64", "u128"], ["tick", "i32"], ["vault0", "key"], ["vault1", "key"],
    ],
  },
};

const WIDTH = { key: 32, u64: 8, u128: 16, i32: 4, u16: 2, bool: 1 };
/** An event's full length, discriminator included. */
export const eventLength = (name) => EVENTS[name].fields.reduce((n, [, t]) => n + WIDTH[t], 8);

/** Which instruction collected, by the name Anchor logs at its start. */
export const COLLECT_BY = { CollectProtocolFee: "vault", CollectFundFee: "workshop" };

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Bytes as base58. */
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

/** Base64 as bytes; throws on anything that is not base64. */
export function fromBase64(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new Error("not base64");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const view = (d) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u64At = (d, o) => view(d).getBigUint64(o, true);
const u128At = (d, o) => u64At(d, o) | (u64At(d, o + 8) << 64n);
const keyAt = (d, o) => base58(d.subarray(o, o + 32));
const discIs = (d, want) => d.length >= 8 && want.every((x, i) => d[i] === x);

/** A pool account's identity, price and the venue's four counters. Throws on another account. */
export function decodePool(data) {
  const d = typeof data === "string" ? fromBase64(data) : data;
  if (d.length !== POOL_STATE.len || !discIs(d, POOL_STATE.disc)) throw new Error("not a range pool account");
  const o = POOL_STATE;
  return {
    ammConfig: keyAt(d, o.ammConfig),
    mint0: keyAt(d, o.mint0),
    mint1: keyAt(d, o.mint1),
    vault0: keyAt(d, o.vault0),
    vault1: keyAt(d, o.vault1),
    decimals0: d[o.decimals0],
    decimals1: d[o.decimals1],
    tickSpacing: view(d).getUint16(o.tickSpacing, true),
    sqrtPriceX64: u128At(d, o.sqrtPriceX64),
    protocolFees0: u64At(d, o.protocolFeesToken0),
    protocolFees1: u64At(d, o.protocolFeesToken1),
    fundFees0: u64At(d, o.fundFeesToken0),
    fundFees1: u64At(d, o.fundFeesToken1),
  };
}

/** A tier's three rates, per million. Throws on another account. */
export function decodeAmmConfigRates(data) {
  const d = typeof data === "string" ? fromBase64(data) : data;
  if (d.length !== AMM_CONFIG.len || !discIs(d, AMM_CONFIG.disc)) throw new Error("not a range tier account");
  const v = view(d);
  return { tradeFeeRate: v.getUint32(AMM_CONFIG.tradeFeeRate, true), protocolFeeRate: v.getUint32(AMM_CONFIG.protocolFeeRate, true), fundFeeRate: v.getUint32(AMM_CONFIG.fundFeeRate, true) };
}

/**
 * One event's fields, or null for an event the count does not read. Throws when the
 * discriminator is one it reads and the bytes are not that event's shape.
 */
export function decodeEvent(data) {
  if (data.length < 8) return null;
  const tag = hex(data.subarray(0, 8));
  const name = Object.keys(EVENTS).find((n) => EVENTS[n].disc === tag);
  if (!name) return null;
  if (data.length !== eventLength(name)) throw new Error(`${name} is ${data.length} bytes, not ${eventLength(name)}`);
  const v = view(data);
  const out = { name };
  let o = 8;
  for (const [field, type] of EVENTS[name].fields) {
    if (type === "key") out[field] = keyAt(data, o);
    else if (type === "u64") out[field] = u64At(data, o);
    else if (type === "u128") out[field] = u128At(data, o);
    else if (type === "i32") out[field] = v.getInt32(o, true);
    else if (type === "u16") out[field] = v.getUint16(o, true);
    else if (data[o] > 1) throw new Error(`${name}.${field} is ${data[o]}, not a bool`);
    else out[field] = data[o] === 1;
    o += WIDTH[type];
  }
  return out;
}

const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const END = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed: .*)$/;
const IX_NAME = /^Program log: Instruction: ([A-Za-z0-9_]+)$/;

/**
 * Our program's "Program data:" lines, each with the instruction its frame ran. Frames come
 * from the runtime's invoke and success lines, which no program can write. `truncated`: the
 * runtime cut the log, so events may be missing. `malformed`: the frames do not nest.
 */
export function programFrames(logMessages, programId = RANGE_PROGRAM_ID) {
  const stack = [];
  const events = [];
  for (const line of logMessages) {
    if (line === "Log truncated") return { truncated: true, malformed: false, events };
    let m = INVOKE.exec(line);
    if (m) {
      if (Number(m[2]) !== stack.length + 1) return { truncated: false, malformed: true, events };
      stack.push({ program: m[1], ix: null });
      continue;
    }
    m = END.exec(line);
    if (m) {
      if (stack.pop()?.program !== m[1]) return { truncated: false, malformed: true, events };
      continue;
    }
    const top = stack[stack.length - 1];
    if (!top || top.program !== programId) continue;
    m = IX_NAME.exec(line);
    if (m && top.ix === null) top.ix = m[1];
    else if (line.startsWith("Program data: ")) events.push({ ix: top.ix, data: line.slice("Program data: ".length) });
  }
  if (stack.length) return { truncated: false, malformed: true, events };
  return { truncated: false, malformed: false, events };
}

/**
 * What one getTransaction answer holds for the count. `failed`: the transaction did not land,
 * so nothing in it happened. `no-log`, `truncated`, `malformed`, `undecodable`: it landed and
 * cannot be read whole, so none of it is summed and the caller writes a gap. `ok`: its events,
 * numbered in log order, collections tagged with who collected.
 */
export function rangeTxEvents(tx, programId = RANGE_PROGRAM_ID) {
  if (tx?.meta?.err) return { status: "failed" };
  const logs = tx?.meta?.logMessages;
  if (!Array.isArray(logs)) return { status: "no-log" };
  const frames = programFrames(logs, programId);
  if (frames.truncated) return { status: "truncated" };
  if (frames.malformed) return { status: "malformed" };
  const events = [];
  for (let index = 0; index < frames.events.length; index++) {
    const { ix, data } = frames.events[index];
    let ev;
    try {
      if (data.includes(" ")) throw new Error("more than one data slice");
      ev = decodeEvent(fromBase64(data));
    } catch (e) {
      return { status: "undecodable", why: `event ${index}: ${e.message}` };
    }
    if (!ev) continue;
    if (ev.name === "CollectProtocolFeeEvent") {
      ev.by = COLLECT_BY[ix];
      if (!ev.by) return { status: "undecodable", why: `event ${index}: a collection by ${ix ?? "an unnamed instruction"}` };
    }
    events.push({ index, ...ev });
  }
  return { status: "ok", events };
}
