import { useCallback, useState } from 'react';
import { safeGetItem, safeSetItem } from '../lib/storage';
import { isSolanaPubkey } from '../lib/copytrade/base58';
import {
  SOLANA_FOLLOWER_STORAGE_KEY,
  addMirrorIntent,
  loadFollows,
  loadMirrorIntents,
  saveFollows,
  saveMirrorIntents,
  validateFollow,
  type FollowConfig,
  type FollowDraft,
  type FollowValidation,
  type MirrorIntent,
} from '../lib/copytrade/follows';

// The follow list and the mirror log, held in this browser and nowhere else.
//
// A failed write is REPORTED rather than swallowed. `safeSetItem` returns false
// under quota pressure or when site data is blocked, and a follow that looks
// saved and is gone on reload teaches a user that the caps on this page are
// decorative — which, for a control whose whole job is to bound a trade size, is
// worse than not offering it. In-memory state still updates so the session
// behaves, and the caller prints `persistError` beside the list.
//
// NOTHING HERE REACHES A SERVER. See lib/copytrade/follows.ts: the stored records
// are public addresses, caps and timestamps, no key material of any kind, and no
// api/ route reads or writes them.

const PERSIST_FAILED =
  'This could not be saved to browser storage, so it will not survive a reload. Storage may be full or blocked for this site.';

export interface CopyFollowsState {
  follows: FollowConfig[];
  intents: MirrorIntent[];
  /** Validates first; a rejection changes nothing and carries its reason back. */
  addFollow: (draft: FollowDraft) => FollowValidation;
  removeFollow: (leader: string, quoteToken: string) => void;
  /** Records that the user chose to mirror a leader trade. Not a fill. */
  recordMirror: (intent: MirrorIntent) => void;
  /** Non-null when the last write did not reach storage. */
  persistError: string | null;
}

export function useCopyFollows(): CopyFollowsState {
  const [follows, setFollows] = useState<FollowConfig[]>(() => loadFollows());
  const [intents, setIntents] = useState<MirrorIntent[]>(() => loadMirrorIntents());
  const [persistError, setPersistError] = useState<string | null>(null);

  const addFollow = useCallback(
    (draft: FollowDraft): FollowValidation => {
      const result = validateFollow(draft, follows);
      if (!result.ok) return result;
      const next = [...follows, result.config];
      setFollows(next);
      setPersistError(saveFollows(next, draft.now) ? null : PERSIST_FAILED);
      return result;
    },
    [follows],
  );

  const removeFollow = useCallback((leader: string, quoteToken: string) => {
    const target = leader.toLowerCase();
    const quote = quoteToken.toLowerCase();
    setFollows((current) => {
      const next = current.filter((f) => !(f.leader === target && f.quoteToken === quote));
      setPersistError(saveFollows(next, Math.floor(Date.now() / 1000)) ? null : PERSIST_FAILED);
      return next;
    });
  }, []);

  const recordMirror = useCallback((intent: MirrorIntent) => {
    setIntents((current) => {
      const next = addMirrorIntent(current, intent);
      setPersistError(saveMirrorIntents(next, intent.confirmedAt) ? null : PERSIST_FAILED);
      return next;
    });
  }, []);

  return { follows, intents, addFollow, removeFollow, recordMirror, persistError };
}

// ─── The reader's Solana identity, pasted rather than connected ──────────────
//
// This route mounts no Solana WalletProvider — SolanaProviders is lazy-mounted
// inside the Solana surfaces only — so `useWallet()` cannot be called here and
// pulling the adapter in would drag its chunk onto a page that signs nothing.
//
// What the reconciliation actually needs is a STRING: an address to look for the
// reader's own fills under. So the reader pastes one, it is validated as a real
// 32-byte pubkey before it is stored, and nothing is ever signed with it. It
// lives under the `tegridy-own-` namespace, which lib/storage protects from the
// quota sweeper: a pasted address is a thing the user typed, and evicting it
// would silently stop their own record from being found.

export type SolanaAddressResult = 'ok' | 'invalid' | 'persist-failed';

export interface SolanaFollowerAddressState {
  address: string | null;
  save: (input: string) => SolanaAddressResult;
  clear: () => void;
}

export function useSolanaFollowerAddress(): SolanaFollowerAddressState {
  const [address, setAddress] = useState<string | null>(() => {
    const stored = safeGetItem(SOLANA_FOLLOWER_STORAGE_KEY);
    // Re-validated on read, not trusted because it is ours: storage is editable
    // by anything running on this origin, and this value is interpolated into a
    // comparison and rendered.
    return stored && isSolanaPubkey(stored) ? stored.trim() : null;
  });

  const save = useCallback((input: string): SolanaAddressResult => {
    const trimmed = input.trim();
    if (!isSolanaPubkey(trimmed)) return 'invalid';
    setAddress(trimmed);
    return safeSetItem(SOLANA_FOLLOWER_STORAGE_KEY, trimmed) ? 'ok' : 'persist-failed';
  }, []);

  const clear = useCallback(() => {
    setAddress(null);
    safeSetItem(SOLANA_FOLLOWER_STORAGE_KEY, '');
  }, []);

  return { address, save, clear };
}
