// The Arweave upload cost is what the visitor pays to fund the upload, so it is rounded UP at
// the fifth decimal shown, never below the quote.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test-utils/render';
import { initialState, type WizardState } from './wizardReducer';

vi.mock('../../../hooks/useIrysUpload', () => ({
  useIrysUpload: () => ({
    quote: vi.fn(), fund: vi.fn(), uploadFolder: vi.fn(), uploadJsonFolder: vi.fn(), uploadJson: vi.fn(),
    progress: { uploaded: 0, total: 0 }, busy: false, error: null,
  }),
}));

import { Step4_FundUpload } from './Step4_FundUpload';

describe('Step 4 upload cost', () => {
  it('a held quote of 0.001234561 ETH reads ~0.00124 ETH, not ~0.00123', async () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: 10_000 });
    const state: WizardState = { ...initialState, imageFiles: [file], quoteWei: 1_234_561_000_000_000n, quotedBytes: 5_000_000 };
    renderWithProviders(<Step4_FundUpload state={state} dispatch={vi.fn()} onNext={vi.fn()} onBack={vi.fn()} />);
    expect(await screen.findByText('~0.00124 ETH')).toBeInTheDocument();
  });
});
