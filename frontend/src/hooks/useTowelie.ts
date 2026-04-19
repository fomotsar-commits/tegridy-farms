import { createContext, useCallback, useContext, useState, useRef, type ReactNode, createElement } from 'react';

/**
 * Hook API so any component can push a message through Towelie.
 *
 * Usage:
 *   const { say } = useTowelie();
 *   say('You have unclaimed yield.');
 *   say('Slippage is high.', { priority: 'urgent' });
 *
 * - `urgent` bypasses Towelie's cooldown and jumps the queue.
 * - `info` (default) respects the cooldown; queued if Towelie is busy.
 * - `flavor` is best-effort; dropped if queue is full or cooldown active.
 *
 * Messages don't repeat-show on remount (consumers should call say() in
 * effects gated on the underlying state change, not on every render).
 */
export type ToweliePriority = 'urgent' | 'info' | 'flavor';

export interface TowelieMessage {
  id: number;
  text: string;
  priority: ToweliePriority;
  /** Optional: caller-supplied dedup key to skip if same key is already queued. */
  key?: string;
}

interface TowelieContextValue {
  say: (text: string, opts?: { priority?: ToweliePriority; key?: string }) => void;
  // Internal — TowelieAssistant subscribes to these:
  queue: TowelieMessage[];
  consume: (id: number) => void;
}

const TowelieContext = createContext<TowelieContextValue | null>(null);

const MAX_QUEUE = 5;

export function TowelieProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<TowelieMessage[]>([]);
  const nextId = useRef(1);

  const say = useCallback((text: string, opts: { priority?: ToweliePriority; key?: string } = {}) => {
    const priority: ToweliePriority = opts.priority ?? 'info';
    setQueue((prev) => {
      // Dedup against existing queue items with same key.
      if (opts.key && prev.some((m) => m.key === opts.key)) return prev;
      // Drop flavor messages if queue full; trim oldest non-urgent for info; urgent always wins.
      let next = [...prev];
      if (next.length >= MAX_QUEUE) {
        if (priority === 'flavor') return prev;
        const dropIdx = next.findIndex((m) => m.priority !== 'urgent');
        if (dropIdx !== -1) next.splice(dropIdx, 1);
        else if (priority !== 'urgent') return prev;
      }
      const msg: TowelieMessage = { id: nextId.current++, text, priority, key: opts.key };
      // Urgent jumps to the front; everything else appends.
      if (priority === 'urgent') next.unshift(msg);
      else next.push(msg);
      return next;
    });
  }, []);

  const consume = useCallback((id: number) => {
    setQueue((prev) => prev.filter((m) => m.id !== id));
  }, []);

  return createElement(
    TowelieContext.Provider,
    { value: { say, queue, consume } },
    children,
  );
}

/**
 * Public hook for app code. Safe to call from anywhere — if Towelie is
 * disabled by the user, say() is a no-op (provider still mounted; the
 * UI just doesn't render anything).
 */
export function useTowelie() {
  const ctx = useContext(TowelieContext);
  if (!ctx) {
    // Allow consumers to be unconditional. In dev this surfaces as a warning.
    if (typeof console !== 'undefined') {
      console.warn('[useTowelie] called outside TowelieProvider — say() is a no-op.');
    }
    return { say: () => {} };
  }
  return { say: ctx.say };
}

/**
 * Internal — only TowelieAssistant should use this. Returns the live
 * queue + a dequeue function so the assistant can drive its bubble.
 */
export function useToweliQueueInternal() {
  const ctx = useContext(TowelieContext);
  if (!ctx) return { queue: [] as TowelieMessage[], consume: (_: number) => {} };
  return { queue: ctx.queue, consume: ctx.consume };
}
