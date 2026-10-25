// Follows the chain at its tip over Ogmios's WebSocket (chain-sync): every new block, or step
// back, is reported, and the watcher runs a round on it. The watcher reads everything fresh each
// round, so after a lost connection the follower simply starts again at the new tip.
// Ogmios orders answers only within one protocol: every answer is matched to its request by id.
// Demeter takes the key in the host (wss://<key>.mainnet-v6.ogmios-m1.demeter.run); a WebSocket
// cannot send headers, so the URL holds it and is never logged.
import { parseExact, stringifyExact } from './json.ts';

export interface Block {
  slot: bigint;
  id: string;
  height: bigint;
  /** The transactions in the block, by id. */
  txIds: string[];
}

export interface FollowEvents {
  forward(block: Block): void;
  backward(point: { slot: bigint; id: string } | 'origin'): void;
  /** The connection failed or closed; the follower reconnects by itself. */
  down(error: string): void;
}

/** What the follower needs of a WebSocket (the global one, or a stand-in in tests). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

export class Follower {
  readonly #url: string;
  readonly #events: FollowEvents;
  readonly #socket: SocketFactory;
  readonly #maxBackoffMs: number;
  #ws: SocketLike | null = null;
  #stopped = false;
  #backoffMs = 1_000;
  #nextId = 1;
  #pending = new Map<number, (r: { result?: unknown; error?: unknown }) => void>();

  constructor(url: string, events: FollowEvents, opts: { socket?: SocketFactory; maxBackoffMs?: number } = {}) {
    this.#url = url;
    this.#events = events;
    this.#socket = opts.socket ?? ((u) => new WebSocket(u) as unknown as SocketLike);
    this.#maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#ws) this.#lost(this.#ws, 'stopped');
  }

  #connect(): void {
    if (this.#stopped) return;
    let ws: SocketLike;
    try {
      ws = this.#socket(this.#url);
    } catch (e) {
      this.#events.down(e instanceof Error ? e.message : String(e));
      return this.#retry();
    }
    this.#ws = ws;
    ws.onopen = () => void this.#run(ws).catch((e) => this.#lost(ws, e instanceof Error ? e.message : String(e)));
    ws.onmessage = (ev) => this.#answer(ws, ev.data);
    ws.onerror = () => this.#lost(ws, 'the connection failed');
    ws.onclose = () => this.#lost(ws, 'the connection closed');
  }

  /** `ws` failed: only the socket in use counts (an error and a close on one socket reconnect once). */
  #lost(ws: SocketLike, why: string): void {
    if (this.#ws !== ws) return;
    this.#ws = null;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close();
    } catch {
      // already closed
    }
    for (const resolve of this.#pending.values()) resolve({ error: why });
    this.#pending.clear();
    if (this.#stopped) return;
    this.#events.down(why);
    this.#retry();
  }

  #retry(): void {
    const wait = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, this.#maxBackoffMs);
    setTimeout(() => this.#connect(), wait).unref?.();
  }

  #answer(ws: SocketLike, data: unknown): void {
    let msg: unknown;
    try {
      msg = parseExact(String(data));
    } catch {
      return this.#lost(ws, 'an unreadable message');
    }
    if (!isObject(msg) || typeof msg.id !== 'bigint') return;
    const resolve = this.#pending.get(Number(msg.id));
    if (!resolve) return;
    this.#pending.delete(Number(msg.id));
    resolve({ result: msg.result, error: msg.error });
  }

  #call(ws: SocketLike, method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (r) => (r.error !== undefined ? reject(new Error(`${method}: ${typeof r.error === 'string' ? r.error : stringifyExact(r.error)}`)) : resolve(r.result)));
      ws.send(stringifyExact(params === undefined ? { jsonrpc: '2.0', method, id } : { jsonrpc: '2.0', method, params, id }));
    });
  }

  /** Find the tip, intersect there, then ask for one block at a time (at the tip they come one by one). */
  async #run(ws: SocketLike): Promise<void> {
    const first = await this.#call(ws, 'findIntersection', { points: ['origin'] });
    const tip = isObject(first) ? first.tip : undefined;
    if (!isObject(tip) || typeof tip.slot !== 'bigint' || typeof tip.id !== 'string') throw new Error('findIntersection: no tip');
    await this.#call(ws, 'findIntersection', { points: [{ slot: tip.slot, id: tip.id }] });
    this.#backoffMs = 1_000;
    while (this.#ws === ws && !this.#stopped) {
      const r = await this.#call(ws, 'nextBlock');
      if (!isObject(r)) throw new Error('nextBlock: not an object');
      if (r.direction === 'forward' && isObject(r.block)) this.#events.forward(blockOf(r.block));
      else if (r.direction === 'backward') this.#events.backward(isObject(r.point) && typeof r.point.slot === 'bigint' && typeof r.point.id === 'string' ? { slot: r.point.slot, id: r.point.id } : 'origin');
      else throw new Error(`nextBlock: direction ${String(r.direction)}`);
    }
  }
}

function blockOf(b: Json): Block {
  if (typeof b.slot !== 'bigint' || typeof b.id !== 'string' || typeof b.height !== 'bigint') throw new Error('nextBlock: a block without slot, id or height');
  const txs = Array.isArray(b.transactions) ? b.transactions : [];
  return { slot: b.slot, id: b.id, height: b.height, txIds: txs.flatMap((t) => (isObject(t) && typeof t.id === 'string' ? [t.id] : [])) };
}
