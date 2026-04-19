import { describe, it, expect } from 'vitest';
import {
  wizardReducer,
  initialState,
  canAdvanceFromStep2,
  canAdvanceFromStep3,
  canAdvanceFromStep4,
  type WizardState,
} from './wizardReducer';
import type { CsvRow } from '../../../lib/nftMetadata';

// Tiny helper: build a stub File without reading actual bytes. Mirrors the
// helper used in nftMetadata.test.ts.
function mockFile(name: string, type = 'image/png', size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('wizardReducer — step navigation', () => {
  it('STEP_NEXT increments the current step', () => {
    const s = wizardReducer(initialState, { type: 'STEP_NEXT' });
    expect(s.step).toBe(2);
  });

  it('STEP_NEXT clamps at step 5 (never overflows)', () => {
    const atFive: WizardState = { ...initialState, step: 5 };
    const s = wizardReducer(atFive, { type: 'STEP_NEXT' });
    expect(s.step).toBe(5);
  });

  it('STEP_BACK decrements the current step', () => {
    const atThree: WizardState = { ...initialState, step: 3 };
    const s = wizardReducer(atThree, { type: 'STEP_BACK' });
    expect(s.step).toBe(2);
  });

  it('STEP_BACK clamps at step 1 (never underflows)', () => {
    const s = wizardReducer(initialState, { type: 'STEP_BACK' });
    expect(s.step).toBe(1);
  });

  it('STEP_GOTO jumps to the given step', () => {
    const s = wizardReducer(initialState, { type: 'STEP_GOTO', step: 4 });
    expect(s.step).toBe(4);
  });

  it('STEP_GOTO clamps out-of-range values to [1,5]', () => {
    // The action type forces Step = 1..5 but the reducer also guards against
    // arbitrary numeric input via the internal clampStep — test both bounds.
    const hi = wizardReducer(initialState, { type: 'STEP_GOTO', step: 99 as 5 });
    expect(hi.step).toBe(5);
    const lo = wizardReducer(initialState, { type: 'STEP_GOTO', step: -3 as 1 });
    expect(lo.step).toBe(1);
  });
});

describe('wizardReducer — HYDRATE', () => {
  it('merges draft payload onto current state (shallow)', () => {
    const s = wizardReducer(initialState, {
      type: 'HYDRATE',
      payload: { collectionName: 'Towelies', collectionSymbol: 'TOWEL', step: 2 },
    });
    expect(s.collectionName).toBe('Towelies');
    expect(s.collectionSymbol).toBe('TOWEL');
    expect(s.step).toBe(2);
    // Unrelated fields untouched
    expect(s.maxSupply).toBe(initialState.maxSupply);
  });

  it('preserves incoming File objects that can\'t be serialized into drafts', () => {
    // A realistic draft payload will NOT contain File instances (IndexedDB
    // serializes them as null), so hydrating with a state that already holds
    // live File objects should not lose them. We simulate by pre-seeding.
    const withFiles: WizardState = {
      ...initialState,
      imageFiles: [mockFile('1.png')],
      coverFile: mockFile('cover.png'),
      bannerFile: mockFile('banner.png'),
    };
    // Draft persist strips Files before save, so HYDRATE payload omits them.
    const s = wizardReducer(withFiles, {
      type: 'HYDRATE',
      payload: { collectionName: 'X', step: 3 },
    });
    expect(s.imageFiles).toHaveLength(1);
    expect(s.coverFile?.name).toBe('cover.png');
    expect(s.bannerFile?.name).toBe('banner.png');
    expect(s.collectionName).toBe('X');
  });
});

describe('wizardReducer — SET_FIELD', () => {
  it('writes a typed field update', () => {
    const s = wizardReducer(initialState, {
      type: 'SET_FIELD',
      field: 'collectionName',
      value: 'Towelies',
    });
    expect(s.collectionName).toBe('Towelies');
  });

  it('supports numeric fields (royaltyBps)', () => {
    const s = wizardReducer(initialState, {
      type: 'SET_FIELD',
      field: 'royaltyBps',
      value: 750,
    });
    expect(s.royaltyBps).toBe(750);
  });

  it('leaves other fields untouched', () => {
    const s = wizardReducer(initialState, {
      type: 'SET_FIELD',
      field: 'description',
      value: 'Don\'t forget to bring a towel',
    });
    expect(s.description).toBe('Don\'t forget to bring a towel');
    expect(s.collectionName).toBe('');
    expect(s.maxSupply).toBe('10000');
  });
});

describe('wizardReducer — cover / banner', () => {
  it('SET_COVER stores the file', () => {
    const f = mockFile('cover.png');
    const s = wizardReducer(initialState, { type: 'SET_COVER', file: f });
    expect(s.coverFile).toBe(f);
  });

  it('SET_COVER with null clears the cover', () => {
    const withCover: WizardState = { ...initialState, coverFile: mockFile('x.png') };
    const s = wizardReducer(withCover, { type: 'SET_COVER', file: null });
    expect(s.coverFile).toBeNull();
  });

  it('SET_BANNER stores the file', () => {
    const f = mockFile('banner.png');
    const s = wizardReducer(initialState, { type: 'SET_BANNER', file: f });
    expect(s.bannerFile).toBe(f);
  });
});

describe('wizardReducer — images / CSV inputs', () => {
  it('SET_IMAGE_FILES stores the full array', () => {
    const files = [mockFile('1.png'), mockFile('2.png'), mockFile('3.png')];
    const s = wizardReducer(initialState, { type: 'SET_IMAGE_FILES', files });
    expect(s.imageFiles).toHaveLength(3);
    expect(s.imageFiles[0]!.name).toBe('1.png');
  });

  it('SET_IMAGE_FILES with an empty array clears the input', () => {
    const withImgs: WizardState = { ...initialState, imageFiles: [mockFile('1.png')] };
    const s = wizardReducer(withImgs, { type: 'SET_IMAGE_FILES', files: [] });
    expect(s.imageFiles).toEqual([]);
  });

  it('SET_CSV stores the raw text', () => {
    const s = wizardReducer(initialState, {
      type: 'SET_CSV',
      text: 'file_name,name\n1.png,Towelie',
    });
    expect(s.csvText).toBe('file_name,name\n1.png,Towelie');
  });
});

describe('wizardReducer — CSV parse + validation', () => {
  it('CSV_PARSED writes rows and warnings together', () => {
    const rows: CsvRow[] = [
      { file_name: '1.png', name: 'Towelie #1', attributes: [] },
    ];
    const s = wizardReducer(initialState, {
      type: 'CSV_PARSED',
      rows,
      warnings: ['Row 3: missing file_name — skipped'],
    });
    expect(s.rows).toEqual(rows);
    expect(s.validationWarnings).toEqual(['Row 3: missing file_name — skipped']);
  });

  it('VALIDATION_ERRORS replaces any prior errors', () => {
    const withErrs: WizardState = {
      ...initialState,
      validationErrors: ['old error'],
    };
    const s = wizardReducer(withErrs, {
      type: 'VALIDATION_ERRORS',
      errors: ['new error A', 'new error B'],
    });
    expect(s.validationErrors).toEqual(['new error A', 'new error B']);
  });

  it('VALIDATION_ERRORS with empty array clears errors', () => {
    const withErrs: WizardState = {
      ...initialState,
      validationErrors: ['x', 'y'],
    };
    const s = wizardReducer(withErrs, { type: 'VALIDATION_ERRORS', errors: [] });
    expect(s.validationErrors).toEqual([]);
  });
});

describe('wizardReducer — upload artifact actions', () => {
  it('QUOTE_RECEIVED stores the bigint wei amount', () => {
    const wei = 123_456_789_000_000_000n;
    const s = wizardReducer(initialState, { type: 'QUOTE_RECEIVED', wei });
    expect(s.quoteWei).toBe(wei);
    // sanity: it really is a bigint, not coerced to number
    expect(typeof s.quoteWei).toBe('bigint');
  });

  it('FUND_SUCCESS records the txId', () => {
    const s = wizardReducer(initialState, {
      type: 'FUND_SUCCESS',
      txId: '0xfund',
    });
    expect(s.fundTxId).toBe('0xfund');
  });

  it('IMAGES_UPLOADED records the manifest id', () => {
    const s = wizardReducer(initialState, {
      type: 'IMAGES_UPLOADED',
      manifestId: 'ar-images-manifest',
    });
    expect(s.imagesManifestId).toBe('ar-images-manifest');
  });

  it('METADATA_UPLOADED records the manifest id', () => {
    const s = wizardReducer(initialState, {
      type: 'METADATA_UPLOADED',
      manifestId: 'ar-meta-manifest',
    });
    expect(s.metadataManifestId).toBe('ar-meta-manifest');
  });

  it('CONTRACT_URI_UPLOADED records the tx id', () => {
    const s = wizardReducer(initialState, {
      type: 'CONTRACT_URI_UPLOADED',
      txId: 'ar-contract-uri',
    });
    expect(s.contractUriId).toBe('ar-contract-uri');
  });

  it('COVER_UPLOADED records the tx id', () => {
    const s = wizardReducer(initialState, {
      type: 'COVER_UPLOADED',
      txId: 'ar-cover',
    });
    expect(s.coverId).toBe('ar-cover');
  });

  it('BANNER_UPLOADED records the tx id', () => {
    const s = wizardReducer(initialState, {
      type: 'BANNER_UPLOADED',
      txId: 'ar-banner',
    });
    expect(s.bannerId).toBe('ar-banner');
  });
});

describe('wizardReducer — deploy', () => {
  it('DEPLOY_SUCCESS writes both txHash and collection address', () => {
    const s = wizardReducer(initialState, {
      type: 'DEPLOY_SUCCESS',
      txHash: '0xabc123',
      collection: '0xdeadbeef',
    });
    expect(s.deployTxHash).toBe('0xabc123');
    expect(s.deployedAddress).toBe('0xdeadbeef');
  });
});

describe('wizardReducer — error actions', () => {
  it('ERROR stores the full error record', () => {
    const s = wizardReducer(initialState, {
      type: 'ERROR',
      code: 'UPLOAD_FAILED',
      message: 'Arweave node timeout',
      recoverable: true,
    });
    expect(s.error).toEqual({
      code: 'UPLOAD_FAILED',
      message: 'Arweave node timeout',
      recoverable: true,
    });
  });

  it('CLEAR_ERROR nulls the error', () => {
    const withErr: WizardState = {
      ...initialState,
      error: { code: 'X', message: 'y', recoverable: false },
    };
    const s = wizardReducer(withErr, { type: 'CLEAR_ERROR' });
    expect(s.error).toBeNull();
  });
});

describe('wizardReducer — RESET', () => {
  it('returns to initialState even from a fully-populated state', () => {
    const populated: WizardState = {
      ...initialState,
      step: 4,
      collectionName: 'Towelies',
      imageFiles: [mockFile('1.png')],
      csvText: 'file_name,name\n1.png,X',
      quoteWei: 10_000_000_000n,
      fundTxId: '0xf',
      imagesManifestId: 'im',
      metadataManifestId: 'mm',
      deployTxHash: '0xd',
      deployedAddress: '0xc',
      error: { code: 'X', message: 'y', recoverable: true },
    };
    const s = wizardReducer(populated, { type: 'RESET' });
    expect(s).toEqual(initialState);
  });
});

describe('wizardReducer — unknown action (default branch)', () => {
  it('returns the same state unchanged', () => {
    // Cast to any to force an action type the reducer doesn't recognise —
    // the default branch should be a no-op and return the state by reference.
    const s = wizardReducer(initialState, { type: 'NOT_A_REAL_ACTION' } as never);
    expect(s).toBe(initialState);
  });
});

// ─── Selectors ───────────────────────────────────────────────────

describe('canAdvanceFromStep2', () => {
  const ready: WizardState = {
    ...initialState,
    collectionName: 'Towelies',
    collectionSymbol: 'TOWEL',
    imageFiles: [mockFile('1.png')],
    csvText: 'file_name,name\n1.png,Towelie #1',
    validationErrors: [],
  };

  it('returns true when all required fields are present and no errors', () => {
    expect(canAdvanceFromStep2(ready)).toBe(true);
  });

  it('returns false when collection name is blank', () => {
    expect(canAdvanceFromStep2({ ...ready, collectionName: '   ' })).toBe(false);
  });

  it('returns false when symbol is blank', () => {
    expect(canAdvanceFromStep2({ ...ready, collectionSymbol: '' })).toBe(false);
  });

  it('returns false when no images selected', () => {
    expect(canAdvanceFromStep2({ ...ready, imageFiles: [] })).toBe(false);
  });

  it('returns false when CSV text is empty', () => {
    expect(canAdvanceFromStep2({ ...ready, csvText: '' })).toBe(false);
  });

  it('returns false when there are validation errors', () => {
    expect(
      canAdvanceFromStep2({ ...ready, validationErrors: ['missing file'] })
    ).toBe(false);
  });
});

describe('canAdvanceFromStep3', () => {
  it('returns true when rows are parsed and no errors', () => {
    const s: WizardState = {
      ...initialState,
      rows: [{ file_name: '1.png', name: 'x', attributes: [] }],
      validationErrors: [],
    };
    expect(canAdvanceFromStep3(s)).toBe(true);
  });

  it('returns false with zero rows', () => {
    const s: WizardState = {
      ...initialState,
      rows: [],
      validationErrors: [],
    };
    expect(canAdvanceFromStep3(s)).toBe(false);
  });

  it('returns false when validation errors exist, even with rows', () => {
    const s: WizardState = {
      ...initialState,
      rows: [{ file_name: '1.png', name: 'x', attributes: [] }],
      validationErrors: ['bad'],
    };
    expect(canAdvanceFromStep3(s)).toBe(false);
  });
});

describe('canAdvanceFromStep4', () => {
  it('returns true when both manifest ids are set', () => {
    const s: WizardState = {
      ...initialState,
      imagesManifestId: 'im',
      metadataManifestId: 'mm',
    };
    expect(canAdvanceFromStep4(s)).toBe(true);
  });

  it('returns false when only images manifest id is set', () => {
    const s: WizardState = {
      ...initialState,
      imagesManifestId: 'im',
      metadataManifestId: null,
    };
    expect(canAdvanceFromStep4(s)).toBe(false);
  });

  it('returns false when only metadata manifest id is set', () => {
    const s: WizardState = {
      ...initialState,
      imagesManifestId: null,
      metadataManifestId: 'mm',
    };
    expect(canAdvanceFromStep4(s)).toBe(false);
  });

  it('returns false when neither is set', () => {
    expect(canAdvanceFromStep4(initialState)).toBe(false);
  });
});
