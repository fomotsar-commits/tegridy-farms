import { useCallback, useState } from 'react';
import {
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
