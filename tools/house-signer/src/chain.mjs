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
 * readUrls: endpoints for reads (tried in order; the counter, NFT balances, order status and
 *           receipts ask all of them and must agree; the kill's nonces ask all of them).
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

  /** The answer of every read endpoint that answers at all; throws only if none does. */
  async function askAll(method, params, what) {
    const answers = await Promise.allSettled(readUrls.map((u) => rpcOne(u, method, params)));
    const got = answers.filter((a) => a.status === 'fulfilled').map((a) => a.value);
    if (got.length === 0) throw new RpcError(`no endpoint answered ${what}`, { kind: 'network' });
    return got;
  }

  /**
   * An eth_call asked of every read endpoint, for the numbers a limit is checked against:
   * every endpoint that answers must give the same bytes, and at least one must answer.
   */
  async function agreedCall(to, data, what) {
    const values = (await askAll('eth_call', [{ to, data }, 'latest'], what)).filter(isHexData).map((v) => v.toLowerCase());
    if (values.length === 0) throw new RpcError(`no endpoint answered ${what} with hex`, { kind: 'network' });
    if (values.some((v) => v !== values[0])) throw new RpcError(`the read endpoints disagree about ${what}`, { kind: 'disagree' });
    return values[0];
  }

  return {
    async chainId() {
      return quantity(await read('eth_chainId', []));
    },
    /**
     * chainId from every read endpoint, so start-up can refuse one on the wrong chain. One
     * that does not answer is listed with chainId null and its error, not thrown: an outage
     * at one provider must not stop the kill (preflight.checkReadEndpoints decides).
     */
    async chainIds() {
      const answers = await Promise.allSettled(readUrls.map(async (u) => quantity(await rpcOne(u, 'eth_chainId', []))));
      return answers.map((a, i) => (a.status === 'fulfilled'
        ? { host: hostOf(readUrls[i]), chainId: a.value }
        : { host: hostOf(readUrls[i]), chainId: null, error: a.reason?.message ?? 'failed' }));
    },
    async code(address) {
      const result = await read('eth_getCode', [address, 'latest']);
      if (!isHexData(result)) throw new RpcError('eth_getCode returned something that is not hex', { kind: 'rpc' });
      return result.toLowerCase();
    },
    /** Seaport 1.6 getCounter(house), agreed by every read endpoint that answers. */
    async counter(house) {
      return wordAt(await agreedCall(SEAPORT, `${SELECTORS.getCounter}${pad(house)}`, 'the Seaport counter'), 0);
    },
    /** How many NFTs of `collection` the house holds (ERC-721 balanceOf), agreed by every endpoint. */
    async nftBalance(collection, owner) {
      return wordAt(await agreedCall(collection, `${SELECTORS.balanceOf}${pad(owner)}`, `the house's ${collection} balance`), 0);
    },
    /** Seaport 1.6 getOrderStatus(orderHash), agreed by every endpoint. */
    async orderStatus(orderHash) {
      const data = await agreedCall(SEAPORT, `${SELECTORS.getOrderStatus}${orderHash.slice(2).toLowerCase()}`, `the status of order ${orderHash}`);
      return { isValidated: wordAt(data, 0) === 1n, isCancelled: wordAt(data, 1) === 1n, totalFilled: wordAt(data, 2), totalSize: wordAt(data, 3) };
    },
    async nonce(address, tag) {
      return quantity(await read('eth_getTransactionCount', [address, tag]));
    },
    /**
     * The nonce from every read endpoint that answers. The kill takes the lowest "latest"
     * and the highest "pending" among them, so no single endpoint decides where it sends.
     */
    async nonces(address, tag) {
      const values = (await askAll('eth_getTransactionCount', [address, tag], 'eth_getTransactionCount')).filter((v) => typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)).map(hexToBigint);
      if (values.length === 0) throw new RpcError('no endpoint answered eth_getTransactionCount with a number', { kind: 'network' });
      return values;
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
    /**
     * Mined only when every read endpoint that answers has the same receipt: one endpoint
     * alone (lagging, broken or lying) can neither confirm a transaction nor fake one.
     */
    async receipt(hash) {
      const got = await askAll('eth_getTransactionReceipt', [hash], 'eth_getTransactionReceipt');
      if (got.some((r) => r === null)) return null;
      const seen = got.map((r) => ({ status: r?.status === '0x1' ? 'success' : 'reverted', blockNumber: quantity(r?.blockNumber) }));
      if (seen.some((s) => s.status !== seen[0].status || s.blockNumber !== seen[0].blockNumber)) return null;
      return seen[0];
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
