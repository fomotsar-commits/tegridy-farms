import { useCallback, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import {
  clipDetail,
  type CreateLaunchCost,
  type LaunchState,
  type MintFacts,
  type Read,
} from '../../../lib/launcher/solana/curve';

/** The three reads a read-only lookup makes, passed in so a test can hold each one open. */
export interface LaunchLookupReaders {
  launch(mint: PublicKey): Promise<LaunchState>;
  mint(address: string): Promise<Read<MintFacts>>;
  cost(mint: PublicKey, feeRecipient: PublicKey): Promise<Read<CreateLaunchCost>>;
}

export interface LaunchLookup {
  /** `null` = no lookup made yet. */
  snapshot: LaunchState | null;
  mint: Read<MintFacts> | null;
  /** The rent `create_launch` would charge the creator. `null` = not read (yet). */
  createCost: Read<CreateLaunchCost> | null;
  loading: boolean;
  lookUp(address: string): Promise<void>;
}

/**
 * The read-only page's "Look up a launch". The cost depends on the mint (it includes
 * the treasury's token account for THAT mint when it does not exist yet), so each
 * lookup clears the last one's cost before reading anything, and the checklist never
 * shows one mint's cost beside another mint's facts. Only the latest lookup may
 * write: an older answer that arrives late is dropped.
 */
export function useLaunchLookup(readers: LaunchLookupReaders): LaunchLookup {
  const [snapshot, setSnapshot] = useState<LaunchState | null>(null);
  const [mint, setMint] = useState<Read<MintFacts> | null>(null);
  const [createCost, setCreateCost] = useState<Read<CreateLaunchCost> | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const lookUp = useCallback(
    async (address: string) => {
      const mine = ++seq.current;
      const current = () => mine === seq.current;
      setCreateCost(null);
      setLoading(true);
      try {
        const key = new PublicKey(address);
        const [snap, facts] = await Promise.all([readers.launch(key), readers.mint(address)]);
        if (!current()) return;
        setSnapshot(snap);
        setMint(facts);
        // What opening a launch would cost needs the live recipient, so it waits for
        // `global`. No config, no figure: the checklist then says the terms are unknown.
        const cost = snap.global ? await readers.cost(key, snap.global.feeRecipient) : null;
        if (current()) setCreateCost(cost);
      } catch (e) {
        if (!current()) return;
        // A throw here is a client fault (a malformed address reaching PDA
        // derivation), not a finding: surface it as unreadable, not as absent.
        const detail = clipDetail(e);
        setSnapshot(null);
        setMint({ kind: 'unreadable', detail });
        setCreateCost(null);
      } finally {
        if (current()) setLoading(false);
      }
    },
    [readers],
  );

  return { snapshot, mint, createCost, loading, lookUp };
}
