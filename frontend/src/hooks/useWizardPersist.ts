import { useEffect, useRef, useState } from 'react';
import type { WizardState } from '../components/launchpad/wizard/wizardReducer';

const STORAGE_KEY = 'tegridy:launchpad:draft';
const DRAFT_VERSION = 1;

interface StoredDraft {
  version: number;
  savedAt: number;
  // File objects can't be serialized; only text/numeric fields + the IDs
  // we got back from Irys (so a crash mid-upload can skip re-uploading).
  payload: SerializableSlice;
}

type SerializableSlice = Pick<
  WizardState,
  | 'step'
  | 'csvText'
  | 'collectionName'
  | 'collectionSymbol'
  | 'description'
  | 'externalLink'
  | 'maxSupply'
  | 'mintPrice'
  | 'maxPerWallet'
  | 'royaltyBps'
  | 'validationWarnings'
  | 'fundTxId'
  | 'imagesManifestId'
  | 'metadataManifestId'
  | 'contractUriId'
  | 'bannerId'
  | 'coverId'
  | 'deployTxHash'
  | 'deployedAddress'
> & {
  // quoteWei is bigint — stringify/parse explicitly to avoid JSON.stringify errors
  quoteWei: string | null;
};

function toSerializable(state: WizardState): SerializableSlice {
  return {
    step: state.step,
    csvText: state.csvText,
    collectionName: state.collectionName,
    collectionSymbol: state.collectionSymbol,
    description: state.description,
    externalLink: state.externalLink,
    maxSupply: state.maxSupply,
    mintPrice: state.mintPrice,
    maxPerWallet: state.maxPerWallet,
    royaltyBps: state.royaltyBps,
    validationWarnings: state.validationWarnings,
    fundTxId: state.fundTxId,
    imagesManifestId: state.imagesManifestId,
    metadataManifestId: state.metadataManifestId,
    contractUriId: state.contractUriId,
    bannerId: state.bannerId,
    coverId: state.coverId,
    deployTxHash: state.deployTxHash,
    deployedAddress: state.deployedAddress,
    quoteWei: state.quoteWei?.toString() ?? null,
  };
}

/// Persist wizard state to localStorage so a browser crash mid-upload or a
/// cache-busting refresh doesn't nuke 5555 tokens of work. Files (image /
/// banner / cover) are not persisted — the user must re-pick them on restore.
/// Everything downstream of the first Irys upload (manifest IDs, fund tx) is
/// persisted so we can skip already-completed steps on restore.
export function useWizardPersist(state: WizardState) {
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (throttleRef.current) clearTimeout(throttleRef.current);
    throttleRef.current = setTimeout(() => {
      try {
        const draft: StoredDraft = {
          version: DRAFT_VERSION,
          savedAt: Date.now(),
          payload: toSerializable(state),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
      } catch {
        // Quota / private mode — silent.
      }
    }, 500);
    return () => {
      if (throttleRef.current) clearTimeout(throttleRef.current);
    };
  }, [state]);
}

/// Read whatever draft is in localStorage — null if none or if the version
/// doesn't match (avoids crashing on schema changes). Returns the partial
/// WizardState slice plus a timestamp so the UI can show "saved 3 min ago".
export function readDraft(): (SerializableSlice & { savedAt: number }) | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as StoredDraft;
    if (draft.version !== DRAFT_VERSION) return null;
    return { ...draft.payload, savedAt: draft.savedAt };
  } catch {
    return null;
  }
}

/// Drop the stored draft. Call on explicit reset or after successful deploy.
export function clearDraft() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/// UI helper: returns { hasDraft, savedAt, clearDraft } for banner components.
export function useDraftBanner() {
  const [hasDraft, setHasDraft] = useState(() => readDraft() !== null);
  const [savedAt, setSavedAt] = useState<number | null>(() => readDraft()?.savedAt ?? null);

  const dismiss = () => {
    clearDraft();
    setHasDraft(false);
    setSavedAt(null);
  };

  return { hasDraft, savedAt, dismiss };
}
