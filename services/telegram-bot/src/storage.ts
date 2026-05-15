import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Address } from 'viem';

/**
 * Persistent state for the bot. Plain JSON file — easy to back up, easy
 * to inspect, easy to rotate. SQLite would be overkill for a service
 * whose hot loop is "ask the indexer what changed."
 *
 * Shape:
 *   bindings: chatId → { wallet, boundAt }
 *   pendingBinds: chatId → { nonce, expires } (one-shot challenges)
 *   thresholds: chatId → { restakeMinWei: bigint as decimal-string }
 *   cursors: per-watcher last-seen markers (e.g. block / event-id)
 */

type Hex = `0x${string}`;

type Bindings = Record<string, { wallet: Address; boundAt: number }>;
type PendingBinds = Record<string, { nonce: string; expires: number }>;
type Thresholds = Record<string, { restakeMinWei?: string }>;
type Cursors = {
  // Highest indexer-id seen for each watcher, so we don't re-notify.
  lendingOffersFilled?: string;
  lendingNearDefault?: string;
  dropsSoldOut?: Record<string, boolean>; // collection address → notified
  gaugeVotesCounted?: string;
  restakeRewardsAboveThreshold?: string;
};

type State = {
  bindings: Bindings;
  pendingBinds: PendingBinds;
  thresholds: Thresholds;
  cursors: Cursors;
};

const DEFAULT_STATE: State = {
  bindings: {},
  pendingBinds: {},
  thresholds: {},
  cursors: {},
};

export class Storage {
  private state: State;
  private dirty = false;

  constructor(private readonly path: string) {
    this.state = this.load();
    // Periodic flush — every 5s if dirty.
    setInterval(() => this.flush(), 5_000).unref();
    // Flush on process exit, best effort.
    const flushOnExit = () => {
      if (this.dirty) this.flushSync();
    };
    process.on('beforeExit', flushOnExit);
    process.on('SIGINT', () => { flushOnExit(); process.exit(0); });
    process.on('SIGTERM', () => { flushOnExit(); process.exit(0); });
  }

  private load(): State {
    if (!existsSync(this.path)) {
      const dir = dirname(this.path);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      return structuredClone(DEFAULT_STATE);
    }
    try {
      const raw = readFileSync(this.path, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<State>;
      return { ...DEFAULT_STATE, ...parsed };
    } catch (e) {
      console.warn(`[storage] failed to read ${this.path}; starting fresh:`, e);
      return structuredClone(DEFAULT_STATE);
    }
  }

  private flush() {
    if (!this.dirty) return;
    this.flushSync();
  }

  private flushSync() {
    try {
      writeFileSync(this.path, JSON.stringify(this.state, null, 2), 'utf-8');
      this.dirty = false;
    } catch (e) {
      console.warn(`[storage] flush failed:`, e);
    }
  }

  // ── Bindings ─────────────────────────────────────────────────────
  bind(chatId: string, wallet: Address) {
    this.state.bindings[chatId] = { wallet: wallet.toLowerCase() as Address, boundAt: Date.now() };
    delete this.state.pendingBinds[chatId];
    this.dirty = true;
  }

  unbind(chatId: string) {
    delete this.state.bindings[chatId];
    delete this.state.pendingBinds[chatId];
    delete this.state.thresholds[chatId];
    this.dirty = true;
  }

  getWallet(chatId: string): Address | undefined {
    return this.state.bindings[chatId]?.wallet;
  }

  listChatIds(): string[] {
    return Object.keys(this.state.bindings);
  }

  /** Reverse-lookup — used by watchers when an event references a wallet. */
  findChatIdsForWallet(wallet: Address): string[] {
    const target = wallet.toLowerCase();
    return Object.entries(this.state.bindings)
      .filter(([, b]) => b.wallet.toLowerCase() === target)
      .map(([id]) => id);
  }

  // ── Pending binds (signature challenges) ─────────────────────────
  setPendingBind(chatId: string, nonce: string, ttlMs: number) {
    this.state.pendingBinds[chatId] = { nonce, expires: Date.now() + ttlMs };
    this.dirty = true;
  }

  getPendingBind(chatId: string): { nonce: string; expires: number } | undefined {
    const p = this.state.pendingBinds[chatId];
    if (!p) return undefined;
    if (p.expires < Date.now()) {
      delete this.state.pendingBinds[chatId];
      this.dirty = true;
      return undefined;
    }
    return p;
  }

  // ── Per-user thresholds ──────────────────────────────────────────
  setRestakeMinWei(chatId: string, minWei: bigint) {
    if (!this.state.thresholds[chatId]) this.state.thresholds[chatId] = {};
    this.state.thresholds[chatId].restakeMinWei = minWei.toString();
    this.dirty = true;
  }

  getRestakeMinWei(chatId: string): bigint {
    const raw = this.state.thresholds[chatId]?.restakeMinWei;
    if (!raw) return 0n;
    try {
      return BigInt(raw);
    } catch {
      return 0n;
    }
  }

  // ── Cursors ──────────────────────────────────────────────────────
  getCursors(): Cursors {
    return this.state.cursors;
  }

  setCursor<K extends keyof Cursors>(key: K, value: Cursors[K]) {
    this.state.cursors[key] = value;
    this.dirty = true;
  }

  markDropNotified(collection: Hex) {
    const map = this.state.cursors.dropsSoldOut ?? {};
    map[collection.toLowerCase()] = true;
    this.state.cursors.dropsSoldOut = map;
    this.dirty = true;
  }

  wasDropNotified(collection: Hex): boolean {
    return !!this.state.cursors.dropsSoldOut?.[collection.toLowerCase()];
  }
}
