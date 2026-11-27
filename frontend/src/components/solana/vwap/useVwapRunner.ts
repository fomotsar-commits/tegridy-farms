// The swap page's runner for a VWAP order: while the page is open with the order's wallet
// connected, it runs lib/solana/swap/vwapRun.ts runOrder with the page's own reads, wallet
// and swap notes.
//
// ONE TAB. The order is run by the tab that holds the browser's lock for its wallet (Web
// Locks); any other tab of the site only shows it, and takes over when that tab closes. A
// browser without the lock never runs it: two tabs on one slice would ask the wallet twice.
// A wallet that cannot sign without sending never runs it either: the page could not hold
// back a slice signed after Stop or signed too late.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { VersionedTransaction } from '@solana/web3.js';
import { buildSwapTransaction, getQuote, simulateSwap, swapCarriesPlatformFee, type PriorityLevel } from '../../../lib/jupiter';
import { whileJupiterBusy } from '../../../lib/solana/swap/jupiterBusy';
import { prepareJupiterSwap } from '../../../lib/solana/swap/jupiterFeeRetry';
import { fetchPairAverage } from '../../../lib/solana/swap/pairAverage';
import { sendWalletSwap, type SwapNote } from '../../../lib/solana/swap/walletSwapSend';
import { signatureOf } from '../../../lib/solana/sendSigned';
import { recentBlockhashOf } from '../../../lib/solana/blockhashWindow';
import { amountText, receivedIn } from '../../../lib/solana/receiptRead';
import { holdReload } from '../../../lib/reloadHold';
import { SOL_MINT } from '../../../lib/solana';
import { SLICE_SLIPPAGE_BPS, clearOrder, orderStorageKey, parseOrder, readOrder, writeOrder, type VwapOrder } from '../../../lib/solana/swap/vwapOrder';
import { LOOK_MS, needsRunner, runOrder, type RunEnv } from '../../../lib/solana/swap/vwapRun';

const CHANGED = 'vwap-order-changed';
const SWAP_CONFIRM_TIMEOUT_MS = 90_000;

const quoteBusy = whileJupiterBusy((p: Parameters<typeof getQuote>[0]) => getQuote(p));
const buildBusy = whileJupiterBusy((p: Parameters<typeof buildSwapTransaction>[0]) => buildSwapTransaction(p));

/** Saves the order and tells every view of it on this page. False: the browser would not keep it. */
export function saveOrder(o: VwapOrder): boolean {
  const ok = writeOrder(o);
  window.dispatchEvent(new Event(CHANGED));
  return ok;
}

export function forgetOrder(wallet: string): void {
  clearOrder(wallet);
  window.dispatchEvent(new Event(CHANGED));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** The wallet's order as stored, kept current across this page and the site's other tabs. */
export function useVwapOrder(wallet: string | null): VwapOrder | null {
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      if (!wallet) return null;
      try {
        return localStorage.getItem(orderStorageKey(wallet));
      } catch {
        return null;
      }
    },
    () => null,
  );
  return useMemo(() => {
    if (!wallet || raw === null) return null;
    try {
      return parseOrder(JSON.parse(raw), wallet);
    } catch {
      return null;
    }
  }, [raw, wallet]);
}

/** 'here': this tab runs it · 'elsewhere': another tab does · 'no-signer' / 'no-lock': it cannot run in this browser. */
export type RunnerWhere = 'here' | 'elsewhere' | 'no-signer' | 'no-lock' | 'idle';

/** The page's swap notes for this wallet (useVenueSwap), so a slice and the Instant swap hold each other. */
export interface RunnerNotes {
  holdsNow(): boolean;
  hold(note: SwapNote): void;
  stillHeld(note: { signature: string | null; sentAt: number }): boolean;
  release(signature: string): void;
}

export function useVwapRunner(a: {
  /** Off on the home page's card, which is an instant swap only. */
  enabled: boolean;
  notes: RunnerNotes;
  priority: PriorityLevel;
  /** A slice landed: the page's receipt and activity line. */
  onLanded(signature: string, o: VwapOrder, paid: bigint): void;
}): RunnerWhere {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const order = useVwapOrder(wallet);
  // What the lock said, for the run it was asked for: 'elsewhere' until it answers.
  const [lockSaid, setLockSaid] = useState<{ run: string; where: 'here' | 'elsewhere' | 'no-lock' } | null>(null);
  // The latest notes, priority and callback, read at each step rather than captured once.
  const live = useRef(a);
  useEffect(() => {
    live.current = a;
  });
  const needed = needsRunner(order);
  const orderId = order?.id ?? null;
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const run = a.enabled && wallet && orderId && needed ? `${wallet}:${orderId}` : null;
  const where: RunnerWhere =
    run === null ? 'idle'
    : !signTransaction ? 'no-signer'
    : !locks?.request ? 'no-lock'
    : lockSaid?.run === run ? lockSaid.where
    : 'elsewhere';

  useEffect(() => {
    // The pair is the order's own for as long as its id is: read once here.
    const pinned = order;
    if (run === null || !wallet || !publicKey || !orderId || !pinned || !signTransaction || !locks?.request) return;
    const stop = new AbortController();
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        if (stop.signal.aborted) return resolve();
        const t = setTimeout(resolve, Math.max(0, ms));
        stop.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    const owner = publicKey;
    const notes = () => live.current.notes;
    const readTx = (signature: string) => connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 1 });

    const env: RunEnv = {
      read: () => readOrder(wallet),
      save: saveOrder,
      now: () => Date.now(),
      sleep,
      aborted: () => stop.signal.aborted,
      walletSign: (tx) => signTransaction(tx),
      signed: (tx) => {
        try {
          // Read back from its bytes, as the send does: a wallet bundling its own web3.js returns a lookalike class.
          const s = VersionedTransaction.deserialize(tx.serialize());
          return { signature: signatureOf(s), blockhash: recentBlockhashOf(s) };
        } catch {
          return { signature: null, blockhash: null };
        }
      },
      slice: {
        average: () => fetchPairAverage(pinned.pay.mint, pinned.buy.mint),
        quote: (amount) => quoteBusy({ inputMint: pinned.pay.mint, outputMint: pinned.buy.mint, amount, slippageBps: SLICE_SLIPPAGE_BPS }),
        prepare: (fresh, amount) =>
          prepareJupiterSwap(
            { getQuote: quoteBusy, buildSwapTransaction: buildBusy, simulateSwap, swapCarriesPlatformFee },
            { fresh, shown: fresh, inputMint: pinned.pay.mint, outputMint: pinned.buy.mint, amount, slippageBps: SLICE_SLIPPAGE_BPS, user: wallet, priority: live.current.priority },
          ),
        words: (paid, out) => `≈${amountText(out, pinned.buy.decimals)} ${pinned.buy.symbol} with ${amountText(paid, pinned.pay.decimals)} ${pinned.pay.symbol}`,
        send: (b64, words, sign, onSent) =>
          sendWalletSwap(
            {
              rpc: connection,
              owner,
              sign,
              signAndSend: () => Promise.reject(new Error('A VWAP order only runs with a wallet that signs on its own.')),
              holdsNow: () => notes().holdsNow(),
              hold: (n) => notes().hold(n),
              stillHeld: (n) => notes().stillHeld(n),
              release: (s) => notes().release(s),
              onSent,
            },
            VersionedTransaction.deserialize(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
            { words, slippageBps: SLICE_SLIPPAGE_BPS, timeoutMs: SWAP_CONFIRM_TIMEOUT_MS },
          ),
      },
      settle: {
        holdsNow: () => notes().holdsNow(),
        status: async (sig) => {
          const st = (await connection.getSignatureStatuses([sig], { searchTransactionHistory: true }))?.value?.[0] ?? null;
          if (!st || (st.confirmationStatus !== 'confirmed' && st.confirmationStatus !== 'finalized')) return null;
          return st.err ? 'reverted' : 'confirmed';
        },
        history: async (sig) => {
          const tx = await readTx(sig);
          if (!tx) return null;
          return tx.meta?.err ? 'reverted' : 'confirmed';
        },
        // Asked only ten minutes after the send, of a confirmed bank: "not valid" then is "too old".
        blockhashDead: async (hash) => (await connection.isBlockhashValid(hash, { commitment: 'confirmed' })).value === false,
      },
      received: async (signature, o) => {
        // The node may not have indexed it yet: a few seconds at most.
        for (const wait of [0, 1_000, 2_000, 4_000]) {
          if (wait) await sleep(wait);
          try {
            const tx = await readTx(signature);
            if (tx) return receivedIn(tx, wallet, { mint: o.buy.mint, native: o.buy.mint === SOL_MINT });
          } catch {
            /* asked again */
          }
        }
        return null;
      },
      onLanded: (signature, o, paid) => live.current.onLanded(signature, o, paid),
      holdReload,
    };

    void (async () => {
      while (!stop.signal.aborted) {
        const ran = await locks
          .request(`vwap-order:${wallet}`, { ifAvailable: true }, async (lock) => {
            if (!lock || stop.signal.aborted) return false;
            setLockSaid({ run, where: 'here' });
            await runOrder(env, orderId);
            return true;
          })
          .catch(() => null);
        if (ran === null) {
          setLockSaid({ run, where: 'no-lock' });
          return;
        }
        if (ran) return;
        // Another tab runs it: this one shows it, and asks again in case that tab closed.
        setLockSaid({ run, where: 'elsewhere' });
        await sleep(LOOK_MS);
      }
    })();
    return () => stop.abort();
    // `order` is read through readOrder at every step; only its id and whether it needs a runner restart this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, wallet, publicKey, signTransaction, connection, orderId, locks]);

  return where;
}
