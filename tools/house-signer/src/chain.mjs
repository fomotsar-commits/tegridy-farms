// The signer's own view of the chain: plain JSON-RPC over fetch to the endpoints in
// house-bidder.env. The bot never supplies a counter, a nonce or a fee.
//
// Endpoint URLs often carry an API key in their path, so nothing here ever puts a URL in an
// error, a log line or the audit file: an endpoint is named by its host only.

import { SELECTORS, wordAt } from './abi.mjs';
import { OPENSEA_CONDUIT, SEAPORT, WETH } from './constants.mjs';
import { hexToBigint, isHexData } from './hex.mjs';

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'an unreadable endpoint';
  }
}

export function isLoopbackUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

export class RpcError extends Error {
  constructor(message, { kind, code, host } = {}) {
    super(message);
    this.kind = kind;
    this.code = code;
    this.host = host;
  }
}

const pad = (address) => address.toLowerCase().slice(2).padStart(64, '0');

/**
 * readUrls: endpoints for reads (tried in order; counter reads ask all of them and must agree).
 * sendUrls: endpoints every signed transaction is broadcast to.
 */
export function createChain({ readUrls, sendUrls, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  if (!Array.isArray(readUrls) || readUrls.length === 0) throw new Error('at least one read RPC is needed');
  let nextId = 1;

  async function rpcOne(url, method, params) {
    const host = hostOf(url);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new RpcError(`${host}: ${e?.name === 'TimeoutError' ? 'timed out' : 'could not be reached'}`, { kind: 'network', host });
    }
    if (!res.ok) throw new RpcError(`${host}: HTTP ${res.status}`, { kind: 'http', code: res.status, host });
    let body;
    try {
      body = await res.json();
    } catch {
      throw new RpcError(`${host}: answered with something that is not JSON`, { kind: 'http', host });
    }
    if (body?.error) {
      const msg = typeof body.error.message === 'string' ? body.error.message.slice(0, 200) : 'error';
      throw new RpcError(`${host}: ${msg}`, { kind: 'rpc', code: body.error.code, host });
    }
    if (!('result' in (body ?? {}))) throw new RpcError(`${host}: answered without a result`, { kind: 'rpc', host });
    return body.result;
  }

  async function read(method, params) {
    const errors = [];
    for (const url of readUrls) {
      try {
        return await rpcOne(url, method, params);
      } catch (e) {
        // A JSON-RPC error is the node's answer (for example a revert), not an outage: do not
        // ask the next endpoint and risk a different answer being taken as the truth.
        if (e.kind === 'rpc') throw e;
        errors.push(e.message);
      }
    }
    throw new RpcError(`no read endpoint answered (${errors.join('; ')})`, { kind: 'network' });
  }

  async function call(to, data, from) {
    const result = await read('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
    if (!isHexData(result)) throw new RpcError('eth_call returned something that is not hex', { kind: 'rpc' });
    return result;
  }

  const quantity = (v) => {
    if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) throw new RpcError('the node returned a malformed number', { kind: 'rpc' });
    return hexToBigint(v);
  };

  return {
    async chainId() {
      return quantity(await read('eth_chainId', []));
    },
    /** chainId from every read endpoint, so start-up can refuse one on the wrong chain. */
    async chainIds() {
      return Promise.all(readUrls.map(async (u) => ({ host: hostOf(u), chainId: quantity(await rpcOne(u, 'eth_chainId', [])) })));
    },
    async code(address) {
      const result = await read('eth_getCode', [address, 'latest']);
      if (!isHexData(result)) throw new RpcError('eth_getCode returned something that is not hex', { kind: 'rpc' });
      return result.toLowerCase();
    },
    /**
     * Seaport 1.6 getCounter(house), asked of every read endpoint. Every endpoint that
     * answers must give the same number, and at least one must answer.
     */
    async counter(house) {
      const data = `${SELECTORS.getCounter}${pad(house)}`;
      const answers = await Promise.allSettled(readUrls.map((u) => rpcOne(u, 'eth_call', [{ to: SEAPORT, data }, 'latest'])));
      const values = answers.filter((a) => a.status === 'fulfilled' && isHexData(a.value)).map((a) => wordAt(a.value, 0));
      if (values.length === 0) throw new RpcError('no endpoint answered Seaport getCounter', { kind: 'network' });
      if (values.some((v) => v !== values[0])) throw new RpcError('the read endpoints disagree about the Seaport counter', { kind: 'disagree' });
      return values[0];
    },
    async nonce(address, tag) {
      return quantity(await read('eth_getTransactionCount', [address, tag]));
    },
    /** The base fee the next block will charge. */
    async nextBaseFee() {
      const h = await read('eth_feeHistory', ['0x1', 'latest', []]);
      const fees = h?.baseFeePerGas;
      if (!Array.isArray(fees) || fees.length === 0) throw new RpcError('eth_feeHistory returned no base fee', { kind: 'rpc' });
      return quantity(fees[fees.length - 1]);
    },
    async blockNumber() {
      return quantity(await read('eth_blockNumber', []));
    },
    async receipt(hash) {
      const r = await read('eth_getTransactionReceipt', [hash]);
      if (r === null) return null;
      return { status: r.status === '0x1' ? 'success' : 'reverted', blockNumber: quantity(r.blockNumber) };
    },
    /** Simulate a call as the house would make it; throws RpcError(kind 'rpc') on a revert. */
    async simulate({ from, to, data, value }) {
      await read('eth_call', [{ from, to, data, value: `0x${value.toString(16)}` }, 'latest']);
    },
    async wethBalance(address) {
      return wordAt(await call(WETH, `${SELECTORS.balanceOf}${pad(address)}`), 0);
    },
    async wethAllowance(address) {
      return wordAt(await call(WETH, `${SELECTORS.allowance}${pad(address)}${pad(OPENSEA_CONDUIT)}`), 0);
    },
    call,
    /** Broadcast to every send endpoint at once; never throws. */
    async broadcast(raw) {
      const urls = sendUrls ?? [];
      const results = await Promise.allSettled(urls.map((u) => rpcOne(u, 'eth_sendRawTransaction', [raw])));
      return results.map((r, i) => (r.status === 'fulfilled'
        ? { host: hostOf(urls[i]), ok: true }
        : { host: hostOf(urls[i]), ok: false, message: r.reason?.message ?? 'failed' }));
    },
  };
}
