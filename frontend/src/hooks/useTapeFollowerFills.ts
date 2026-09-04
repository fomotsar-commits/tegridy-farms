import { useMemo } from 'react';
import type { MirrorIntent } from '../lib/copytrade/follows';
import type { IslandTape } from '../lib/copytrade/tape';
import {
  reconcileTapeMirrors,
  summariseTapeByLeader,
  type TapeFollowerSummary,
  type TapeOutcomeRow,
} from '../lib/copytrade/tapeReconcile';

// The reader's own mirrors, reconciled against the tape already in memory.
//
// NO FETCH, NO CLOCK, NO WALLET PROVIDER. Every input is something the page
// already has: the walk's result and the intents this browser logged.
//
// ─── TWO IDENTITIES, EACH USED ONLY ON ITS OWN CHAIN ─────────────────────────
//
// An EVM intent is reconciled against the wagmi address; a Solana intent against
// a pubkey the reader PASTED, because this route mounts no Solana wallet
// provider (SolanaProviders is lazy-mounted inside the Solana surfaces only) and
// calling useWallet() here would throw. Nothing is signed either way — the
// address is a string used to look for the reader's own fills.
//
// An intent whose venue has no address supplied is left OUT of the reconcile
// rather than reconciled against the other chain's address. Reconciled wrongly
// it would report "not filled" for a mirror nobody looked for.

export interface UseTapeFollowerFillsOptions {
  tape: IslandTape | null;
  intents: readonly MirrorIntent[];
  /** The connected EVM wallet, when there is one. */
  evmAddress?: string | null;
  /** The pasted, validated Solana pubkey, when there is one. */
  solanaAddress?: string | null;
}

export interface TapeFollowerFillsState {
  outcomes: TapeOutcomeRow[];
  byLeader: TapeFollowerSummary[];
  /** False when there is no tape or no identity — the counts say nothing. */
  readable: boolean;
  /** Intents left unjudged because their venue has no address supplied. */
  unaddressed: number;
}

export function useTapeFollowerFills(opts: UseTapeFollowerFillsOptions): TapeFollowerFillsState {
  const { tape, intents, evmAddress, solanaAddress } = opts;

  const evm = evmAddress ? evmAddress.trim().toLowerCase() : null;
  const solana = solanaAddress ? solanaAddress.trim() : null;

  const mine = useMemo(
    () =>
      intents.filter((i) =>
        i.venue === 'solana' ? solana !== null && i.follower === solana : evm !== null && i.follower === evm,
      ),
    [intents, evm, solana],
  );

  const unaddressed = useMemo(
    () => intents.length - intents.filter((i) => (i.venue === 'solana' ? solana !== null : evm !== null)).length,
    [intents, evm, solana],
  );

  const outcomes = useMemo(
    () => (tape === null ? [] : reconcileTapeMirrors(mine, tape)),
    [mine, tape],
  );

  const byLeader = useMemo(() => summariseTapeByLeader(outcomes), [outcomes]);

  return {
    outcomes,
    byLeader,
    readable: tape !== null && (evm !== null || solana !== null),
    unaddressed,
  };
}
