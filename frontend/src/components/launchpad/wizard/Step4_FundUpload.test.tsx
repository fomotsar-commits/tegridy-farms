// Why the Step 4 quote is not allowed to be reused.
//
// The Arweave quote is what the user's funding tx is sized against. The wizard
// lets the user walk back to Step 2 and add images, which grows the payload
// while the held quote stays where it was. Funding short is not a rendering
// defect: the funding tx settles, the upload starts, and it dies partway
// through with the ETH already gone.
//
// Three properties are pinned here: a quote is bound to the byte total it was
// priced against, a grown payload is re-priced before anything is spent, and
// the "already funded, retries skip funding" shortcut does not apply to a
// payload larger than the one that was funded.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { renderWithProviders } from '../../../test-utils/render';
import { initialState, type WizardState } from './wizardReducer';

const quote = vi.fn(async (bytes: number) => BigInt(bytes) * 10n);
const fund = vi.fn(async () => '0xfund');
const uploadFolder = vi.fn(async () => 'manifest');

vi.mock('../../../hooks/useIrysUpload', () => ({
  useIrysUpload: () => ({
    quote,
    fund,
    uploadFolder,
    uploadJsonFolder: vi.fn(async () => 'metadata-manifest'),
    uploadJson: vi.fn(async () => 'contract-uri'),
    progress: { uploaded: 0, total: 0 },
    busy: false,
    error: null,
  }),
}));

import { Step4_FundUpload } from './Step4_FundUpload';

function fileOfSize(name: string, size: number): File {
  const f = new File(['x'], name, { type: 'image/png' });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

/** bytesToPay as Step 4 computes it, so the test asserts against real numbers. */
function payloadBytes(state: WizardState): number {
  return state.imageFiles.reduce((a, f) => a + f.size, 0) + state.rows.length * 512 + 2048;
}

function renderStep(overrides: Partial<WizardState>) {
  const state: WizardState = { ...initialState, ...overrides };
  const dispatch = vi.fn();
  renderWithProviders(
    <Step4_FundUpload state={state} dispatch={dispatch} onNext={vi.fn()} onBack={vi.fn()} />,
  );
  return { state, dispatch };
}

describe('Step 4 upload quote', () => {
  beforeEach(() => {
    quote.mockClear();
    fund.mockClear();
    uploadFolder.mockClear();
  });

  it('prices the quote against the byte total it is taken on', async () => {
    const state = renderStep({ imageFiles: [fileOfSize('a.png', 50_000)] }).state;
    await waitFor(() => expect(quote).toHaveBeenCalled());
    const bytes = payloadBytes(state);
    expect(quote).toHaveBeenCalledWith(bytes);
    const { dispatch } = renderStep({ imageFiles: [fileOfSize('a.png', 50_000)] });
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'QUOTE_RECEIVED', bytes }),
      ),
    );
  });

  it('re-prices when the file set grew past the quoted byte total', async () => {
    // The held quote covers 40k; the folder now holds 400k.
    renderStep({
      imageFiles: [fileOfSize('a.png', 400_000)],
      quoteWei: 400_000n,
      quotedBytes: 40_000,
    });
    await waitFor(() => expect(quote).toHaveBeenCalled());
    expect(quote.mock.calls[0]![0]).toBeGreaterThan(400_000);
  });

  it('reuses a quote that still covers the payload', async () => {
    renderStep({
      imageFiles: [fileOfSize('a.png', 10_000)],
      quoteWei: 999_999n,
      quotedBytes: 5_000_000,
    });
    await screen.findByText(/Fund \+ Upload/);
    expect(quote).not.toHaveBeenCalled();
  });

  it('treats a restored draft with no recorded byte total as unpriced', async () => {
    // Drafts persist quoteWei but cannot persist File objects, so a hydrated
    // quote has no payload behind it and must never be spent as-is.
    renderStep({ imageFiles: [fileOfSize('a.png', 10_000)], quoteWei: 5n, quotedBytes: null });
    await waitFor(() => expect(quote).toHaveBeenCalled());
  });

  it('tops up funding when the payload outgrew the funded amount', async () => {
    const bytes = 900_000;
    const { dispatch } = renderStep({
      imageFiles: [fileOfSize('a.png', bytes)],
      rows: [],
      quoteWei: 123n,
      quotedBytes: bytes + 2048,
      fundTxId: '0xearlier',
      fundedBytes: 1_000, // funded back when the folder was tiny
    });
    const btn = await screen.findByText('Fund + Upload');
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(fund).toHaveBeenCalled());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'FUND_SUCCESS', bytes: bytes + 2048 }),
    );
  });

  it('skips funding only when the settled funding covers the payload', async () => {
    renderStep({
      imageFiles: [fileOfSize('a.png', 1_000)],
      quoteWei: 123n,
      quotedBytes: 5_000_000,
      fundTxId: '0xearlier',
      fundedBytes: 5_000_000,
    });
    const btn = await screen.findByText('Fund + Upload');
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(uploadFolder).toHaveBeenCalled());
    expect(fund).not.toHaveBeenCalled();
  });

  it('discloses that a grown file set needs a top-up rather than implying it is funded', async () => {
    renderStep({
      imageFiles: [fileOfSize('a.png', 900_000)],
      quoteWei: 123n,
      quotedBytes: 902_048,
      fundTxId: '0xearlier',
      fundedBytes: 1_000,
    });
    expect(await screen.findByText(/top-up tx is required/)).toBeTruthy();
    expect(screen.queryByText(/retries skip funding/)).toBeNull();
  });
});
