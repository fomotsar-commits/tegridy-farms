import { describe, it, expect } from 'vitest';
import { doorOf, plainDoor } from './plain-door.mjs';

const tx = { serialize: () => Uint8Array.from([1, 2, 3]) };
// web3.js's own wording of a failed preflight (SendTransactionError), as the public RPC answered one.
const PREFLIGHT = new Error(
  'Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1774. \nLogs: \n[\n  "Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA failed: custom program error: 0x1774"\n]. \nCatch the `SendTransactionError` and call `getLogs()` on it for full details.',
);

describe('doorOf: what the RPC made of the trip', () => {
  it('a failed test run is a refusal, with the instruction and the program’s error', () => {
    expect(doorOf(PREFLIGHT)).toEqual({ door: 'refused', why: 'instruction 2: custom program error: 0x1774' });
    expect(doorOf(new Error('Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.'))).toMatchObject({ door: 'refused' });
  });

  it('with no instruction named, gives the last program failure in the logs, else the RPC’s words without web3.js’s tail', () => {
    // The public RPC's own wording on 2026-11-14 (scripts/plain-door-proof.mjs).
    const bare = new Error('Simulation failed. \nMessage: Transaction simulation failed. \nLogs: \n[]. \nCatch the `SendTransactionError` and call `getLogs()` on it for full details.');
    expect(doorOf(bare)).toEqual({ door: 'refused', why: 'Simulation failed. Message: Transaction simulation failed. Logs: [].' });
    const withLogs = Object.assign(new Error('Simulation failed. \nMessage: Transaction simulation failed. \nLogs: \n[...]. '), { logs: ['Program A invoke [1]', 'Program EKS4 failed: custom program error: 0x1775'] });
    expect(doorOf(withLogs)).toEqual({ door: 'refused', why: 'Program EKS4 failed: custom program error: 0x1775' });
  });

  it('a transaction the chain already has went out: sent, never a refusal', () => {
    expect(doorOf(new Error('Transaction simulation failed: This transaction has already been processed'))).toEqual({ door: 'sent' });
  });

  it('a busy or unreachable RPC, or one that does not know the blockhash yet, says nothing about the trip', () => {
    expect(doorOf(new Error('429 Too Many Requests'))).toMatchObject({ door: 'unread' });
    expect(doorOf(new TypeError('fetch failed'))).toEqual({ door: 'unread', why: 'fetch failed' });
    expect(doorOf(new Error('Transaction simulation failed: Blockhash not found'))).toEqual({ door: 'unread', why: 'the RPC did not know the blockhash yet' });
    expect(doorOf('boom')).toEqual({ door: 'unread', why: 'boom' });
  });
});

describe('plainDoor: the signed trip handed to the usual RPC too (KEEPER_TWO_DOORS)', () => {
  it('sends the transaction’s own bytes, and once the main RPC took it, the same bytes to every other', async () => {
    const main = [];
    const others = [];
    const door = plainDoor({
      sendRaw: async (raw) => void main.push([...raw]),
      also: ['https://second.example', 'https://third.example'],
      fetchImpl: async (url, init) => {
        others.push({ url, ...JSON.parse(init.body) });
        return new Response('{}');
      },
    });
    expect(await door(tx)).toEqual({ door: 'sent' });
    await new Promise((r) => setTimeout(r, 0));
    expect(main).toEqual([[1, 2, 3]]);
    expect(others.map((o) => o.url)).toEqual(['https://second.example', 'https://third.example']);
    expect(others[0]).toMatchObject({ method: 'sendTransaction', params: ['AQID', { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] });
  });

  it('a trip the main RPC’s test run refuses goes nowhere by this door', async () => {
    const others = [];
    const door = plainDoor({
      sendRaw: async () => {
        throw PREFLIGHT;
      },
      also: ['https://second.example'],
      fetchImpl: async (url) => void others.push(url),
    });
    expect(await door(tx)).toEqual({ door: 'refused', why: 'instruction 2: custom program error: 0x1774' });
    await new Promise((r) => setTimeout(r, 0));
    expect(others).toEqual([]);
  });

  it('is sent all the same when another RPC cannot be reached', async () => {
    const door = plainDoor({
      sendRaw: async () => 'sig',
      also: ['https://second.example'],
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await door(tx)).toEqual({ door: 'sent' });
  });
});
