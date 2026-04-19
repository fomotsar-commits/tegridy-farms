import type { CsvRow } from '../../../lib/nftMetadata';

/// Wizard step indices. Kept in sync with CreateWizard's step order.
export type Step = 1 | 2 | 3 | 4 | 5;

export interface WizardError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface WizardState {
  step: Step;

  // Step 2 inputs ─────────────────────────────────────────────────
  imageFiles: File[];
  csvText: string;
  collectionName: string;
  collectionSymbol: string;
  description: string;
  externalLink: string;
  maxSupply: string;      // string so the user can clear it mid-edit
  mintPrice: string;      // "0.05"  → parseEther later
  maxPerWallet: string;
  royaltyBps: number;
  bannerFile: File | null;
  coverFile: File | null;

  // Step 3 derived ────────────────────────────────────────────────
  rows: CsvRow[];
  validationWarnings: string[];
  validationErrors: string[];

  // Step 4 upload artifacts ───────────────────────────────────────
  quoteWei: bigint | null;
  fundTxId: string | null;
  imagesManifestId: string | null;
  metadataManifestId: string | null;
  contractUriId: string | null;
  bannerId: string | null;
  coverId: string | null;

  // Step 5 deploy ─────────────────────────────────────────────────
  deployTxHash: `0x${string}` | null;
  deployedAddress: `0x${string}` | null;

  // Overall flow ──────────────────────────────────────────────────
  error: WizardError | null;
}

export type WizardAction =
  | { type: 'STEP_NEXT' }
  | { type: 'STEP_BACK' }
  | { type: 'STEP_GOTO'; step: Step }
  | { type: 'HYDRATE'; payload: Partial<WizardState> }
  | { type: 'SET_IMAGE_FILES'; files: File[] }
  | { type: 'SET_CSV'; text: string }
  | { type: 'SET_FIELD'; field: keyof WizardState; value: unknown }
  | { type: 'SET_COVER'; file: File | null }
  | { type: 'SET_BANNER'; file: File | null }
  | { type: 'CSV_PARSED'; rows: CsvRow[]; warnings: string[] }
  | { type: 'EDIT_ROW'; index: number; patch: Partial<CsvRow> }
  | { type: 'VALIDATION_ERRORS'; errors: string[] }
  | { type: 'QUOTE_RECEIVED'; wei: bigint }
  | { type: 'FUND_SUCCESS'; txId: string }
  | { type: 'IMAGES_UPLOADED'; manifestId: string }
  | { type: 'METADATA_UPLOADED'; manifestId: string }
  | { type: 'CONTRACT_URI_UPLOADED'; txId: string }
  | { type: 'COVER_UPLOADED'; txId: string }
  | { type: 'BANNER_UPLOADED'; txId: string }
  | { type: 'DEPLOY_SUCCESS'; txHash: `0x${string}`; collection: `0x${string}` }
  | { type: 'ERROR'; code: string; message: string; recoverable: boolean }
  | { type: 'CLEAR_ERROR' }
  | { type: 'RESET' };

export const initialState: WizardState = {
  step: 1,
  imageFiles: [],
  csvText: '',
  collectionName: '',
  collectionSymbol: '',
  description: '',
  externalLink: '',
  maxSupply: '10000',
  mintPrice: '0.05',
  maxPerWallet: '5',
  royaltyBps: 500,
  bannerFile: null,
  coverFile: null,
  rows: [],
  validationWarnings: [],
  validationErrors: [],
  quoteWei: null,
  fundTxId: null,
  imagesManifestId: null,
  metadataManifestId: null,
  contractUriId: null,
  bannerId: null,
  coverId: null,
  deployTxHash: null,
  deployedAddress: null,
  error: null,
};

function clampStep(step: number): Step {
  return Math.min(5, Math.max(1, step)) as Step;
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'STEP_NEXT':
      return { ...state, step: clampStep(state.step + 1) };
    case 'STEP_BACK':
      return { ...state, step: clampStep(state.step - 1) };
    case 'STEP_GOTO':
      return { ...state, step: clampStep(action.step) };

    case 'HYDRATE':
      // Merge-hydrate from a stored draft. We deliberately preserve the
      // incoming `imageFiles`, `bannerFile`, `coverFile` because File objects
      // can't be serialized — the restore banner asks the user to re-pick them.
      return { ...state, ...action.payload };

    case 'SET_IMAGE_FILES':
      return { ...state, imageFiles: action.files };
    case 'SET_CSV':
      return { ...state, csvText: action.text };
    case 'SET_FIELD':
      return { ...state, [action.field]: action.value } as WizardState;
    case 'SET_COVER':
      return { ...state, coverFile: action.file };
    case 'SET_BANNER':
      return { ...state, bannerFile: action.file };

    case 'CSV_PARSED':
      return {
        ...state,
        rows: action.rows,
        validationWarnings: action.warnings,
      };
    case 'EDIT_ROW': {
      // Out-of-range index would silently corrupt state — guard explicitly.
      if (action.index < 0 || action.index >= state.rows.length) return state;
      const next = state.rows.slice();
      const current = next[action.index]!;
      next[action.index] = { ...current, ...action.patch };
      return { ...state, rows: next };
    }
    case 'VALIDATION_ERRORS':
      return { ...state, validationErrors: action.errors };

    case 'QUOTE_RECEIVED':
      return { ...state, quoteWei: action.wei };
    case 'FUND_SUCCESS':
      return { ...state, fundTxId: action.txId };
    case 'IMAGES_UPLOADED':
      return { ...state, imagesManifestId: action.manifestId };
    case 'METADATA_UPLOADED':
      return { ...state, metadataManifestId: action.manifestId };
    case 'CONTRACT_URI_UPLOADED':
      return { ...state, contractUriId: action.txId };
    case 'COVER_UPLOADED':
      return { ...state, coverId: action.txId };
    case 'BANNER_UPLOADED':
      return { ...state, bannerId: action.txId };

    case 'DEPLOY_SUCCESS':
      return {
        ...state,
        deployTxHash: action.txHash,
        deployedAddress: action.collection,
      };

    case 'ERROR':
      return {
        ...state,
        error: { code: action.code, message: action.message, recoverable: action.recoverable },
      };
    case 'CLEAR_ERROR':
      return { ...state, error: null };

    case 'RESET':
      return initialState;

    default:
      return state;
  }
}

// ─── Selectors ───────────────────────────────────────────────────

/// Can the user advance past step 2? Requires at least name/symbol + images + CSV.
export function canAdvanceFromStep2(s: WizardState): boolean {
  return (
    s.collectionName.trim().length > 0 &&
    s.collectionSymbol.trim().length > 0 &&
    s.imageFiles.length > 0 &&
    s.csvText.trim().length > 0 &&
    s.validationErrors.length === 0
  );
}

/// Can the user start the upload from step 3? Requires parsed rows + no errors.
export function canAdvanceFromStep3(s: WizardState): boolean {
  return s.rows.length > 0 && s.validationErrors.length === 0;
}

/// Is everything uploaded and ready to deploy?
export function canAdvanceFromStep4(s: WizardState): boolean {
  return s.imagesManifestId !== null && s.metadataManifestId !== null;
}
