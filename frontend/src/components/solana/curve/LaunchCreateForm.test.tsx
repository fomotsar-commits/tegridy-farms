import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { LaunchCreateForm } from './LaunchCreateForm';
import { CREATOR, SIG, SOL, fakeApi, openGate, prepared } from './fakeWriteApi.fixture';
import { readPendingLaunch } from './pendingLaunch';
import type { CreateLaunchInput, TxSummary, UploadInput, WriteApi, WriteRpc } from './ports';
import type { CurveSignerState } from './useCurveSigner';

vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

const signMessage = vi.fn(async (m: Uint8Array) => m);
const ready: CurveSignerState = {
  kind: 'ready',
  address: CREATOR.toBase58(),
  signer: { publicKey: CREATOR, signTransaction: async (t) => t },
  signMessage,
};

const PNG = { bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png' as const, width: 64, height: 64 };

function MintPage() {
  const { mint } = useParams();
  return <p>launch page {mint}</p>;
}

function renderForm(api: WriteApi = fakeApi(), signerState: CurveSignerState = ready) {
  render(
    <MemoryRouter initialEntries={['/curve-launch']}>
      <Routes>
        <Route
          path="/curve-launch"
          element={
            <LaunchCreateForm
              api={api}
              rpc={{} as WriteRpc}
              gate={openGate()}
              actions={{ create: true, buy: false, sell: false, migrate: false, release: false, poolSwap: false }}
              signerState={signerState}
            />
          }
        />
        <Route path="/curve-launch/:mint" element={<MintPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return api;
}

function createApi(over: Partial<WriteApi> = {}) {
  const api = fakeApi(over);
  vi.mocked(api.meta.prepareLaunchImage).mockResolvedValue({ ok: true, image: PNG });
  vi.mocked(api.meta.uploadLaunchMetadata).mockImplementation(async (i: UploadInput) => ({
    ok: true,
    metadataUri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
    imageUri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
    metadata: {
      name: i.name,
      symbol: i.symbol,
      description: i.description,
      image: 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
      mint: i.mint,
      createdOn: 'https://tegridyfarms.xyz',
    },
    reuseUntil: Date.now() + 60_000,
  }));
  vi.mocked(api.prepareCreateLaunch).mockImplementation(async (_rpc, _gate, input: CreateLaunchInput) => {
    const summary: TxSummary = {
      kind: 'create',
      mint: input.mint.publicKey,
      creator: input.creator,
      name: input.metadata.name,
      symbol: input.metadata.symbol,
      uri: input.metadata.uri,
      decimals: 6,
      openingBuy: null,
    };
    return { ok: true, prepared: prepared(summary) };
  });
  return api;
}

async function fillValid() {
  fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'Farm Fresh' } });
  fireEvent.change(screen.getByLabelText('Token symbol'), { target: { value: 'fresh' } });
  const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
  const input = await screen.findByLabelText('Token picture');
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  sessionStorage.clear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('launch form: validation happens before anything is signed', () => {
  it('refuses a name with hidden direction characters and a reserved ticker, and cannot be reviewed', async () => {
    const api = renderForm(createApi());
    fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'Safe‮token' } });
    fireEvent.change(screen.getByLabelText('Token symbol'), { target: { value: 'SOL' } });
    const form = screen.getByTestId('launch-create-form');
    expect(form.querySelectorAll('.text-rose-300\\/90').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: 'Review launch' })).toBeDisabled();
    expect(api.meta.uploadLaunchMetadata).not.toHaveBeenCalled();
    expect(api.prepareCreateLaunch).not.toHaveBeenCalled();
  });

  it('turns to paste-a-link mode when uploads are not available', async () => {
    const api = createApi();
    vi.mocked(api.meta.uploadsAvailable).mockResolvedValue(false);
    renderForm(api);
    expect(await screen.findByLabelText('Token details link')).toBeInTheDocument();
    expect(screen.queryByLabelText('Token picture')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Token details link'), { target: { value: 'https://example.com/x.json' } });
    expect(screen.getByRole('button', { name: 'Review launch' })).toBeDisabled();
  });

  it('a wallet that cannot sign messages cannot upload, and is offered paste mode', async () => {
    renderForm(createApi(), { ...ready, signMessage: null } as CurveSignerState);
    await fillValid();
    expect(screen.getByText(/cannot sign the upload request/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review launch' })).toBeDisabled();
  });
});

describe('launch form: the terms it states match the program', () => {
  // UX1: with a platform reserve, the curve can sell only what is left after it.
  it('says what share of the supply goes onto the curve, never "the whole supply", when there is a reserve', async () => {
    renderForm(createApi());
    const form = await screen.findByTestId('launch-create-form');
    expect(form).toHaveTextContent('96.31% of the supply goes onto the curve');
    expect(form).toHaveTextContent('The other 3.69% is held by the program as the platform reserve');
    expect(form).not.toHaveTextContent(/whole supply/i);
  });

  // F4: buy caps and migrate_to_amm require target + migration reserve (lib.rs), not the target alone.
  it('graduation needs the target plus the migration reserve (25 + 1 SOL in the fixture)', async () => {
    renderForm(createApi());
    await screen.findByTestId('launch-create-form');
    expect(screen.getByText('Graduates at').parentElement).toHaveTextContent('26 SOL raised');
    expect(screen.getByText('…of which migration reserve').parentElement).toHaveTextContent('1 SOL');
  });
});

describe('launch form: review and send', () => {
  // UX2: the risks and venue facts are in the review, before the wallet opens.
  it('the review carries the "before you trade" facts: venue, fees, LP burn, reserve, loss', async () => {
    renderForm(createApi());
    await fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    const card = await screen.findByTestId('before-you-trade');
    expect(card).toHaveTextContent(/only on this site/);
    expect(card).toHaveTextContent(/not on Jupiter/);
    expect(card).toHaveTextContent('1.00% fee: 50.00% of it goes to the creator and 50.00% to the platform');
    expect(card).toHaveTextContent('the pool charges 0.25% per trade; 12.00% of that goes to the platform');
    expect(card).toHaveTextContent(/creator gets nothing from pool trades/);
    expect(card).toHaveTextContent(/LP tokens are burned/);
    expect(card).toHaveTextContent(/3\.69% of the supply is held back as the platform reserve.*may sell it/);
    expect(card).toHaveTextContent(/You can lose everything/);
  });

  it('uploads, builds, and shows the public-forever list before the wallet opens', async () => {
    const api = renderForm(createApi());
    await fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    const input = vi.mocked(api.meta.uploadLaunchMetadata).mock.calls[0]![0];
    expect(input).toMatchObject({ name: 'Farm Fresh', symbol: 'FRESH', creator: CREATOR.toBase58() });
    const created = vi.mocked(api.prepareCreateLaunch).mock.calls[0]![2];
    // The uploaded details name the same mint the transaction creates.
    expect(created.mint.publicKey.toBase58()).toBe(input.mint);
    expect(created.openingBuy).toBeUndefined();
    const forever = await screen.findByTestId('public-forever');
    expect(forever.textContent).toMatch(/can never be changed, and no more tokens can ever be made/);
    expect(forever.textContent).toContain(input.mint);
  });

  // F5: in paste mode the token's address is made at Review, after the pasted file
  // was written, so a file that names a token names ANOTHER one, and every page will
  // show "Copied details". The creator is told before signing.
  it('paste mode: a details file naming another token is flagged BEFORE the wallet opens', async () => {
    const api = createApi();
    vi.mocked(api.meta.uploadsAvailable).mockResolvedValue(false);
    vi.mocked(api.meta.readLaunchMetadataJson).mockResolvedValue({
      kind: 'ok',
      json: { name: 'Farm Fresh', symbol: 'FRESH', description: '', image: null, mint: CREATOR.toBase58() },
      mintMatches: false,
      issues: [],
    });
    renderForm(api);
    fireEvent.change(await screen.findByLabelText('Token details link'), {
      target: { value: 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy' },
    });
    fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'Farm Fresh' } });
    fireEvent.change(screen.getByLabelText('Token symbol'), { target: { value: 'FRESH' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    expect(await screen.findByText(/was made for a different token/)).toBeInTheDocument();
  });

  it('the opening buy carries no tolerance: its floor is the exact quote', async () => {
    const api = renderForm(createApi());
    await fillValid();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Opening buy in SOL'), { target: { value: '0.1' } });
    expect(screen.getByText(/of supply\)/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    expect(vi.mocked(api.prepareCreateLaunch).mock.calls[0]![2].openingBuy).toEqual({ lamportsIn: SOL / 10n, slippageBps: 0n });
  });

  it('pressing Review again with the same details reuses the upload and the mint, so the wallet is asked once', async () => {
    const api = renderForm(createApi());
    await fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    expect(api.meta.uploadLaunchMetadata).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(api.prepareCreateLaunch).mock.calls;
    expect(calls[1]![2].mint.publicKey.toBase58()).toBe(calls[0]![2].mint.publicKey.toBase58());
  });

  it('changed details mean a new mint and a new upload', async () => {
    const api = renderForm(createApi());
    await fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'Farm Fresher' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    expect(api.meta.uploadLaunchMetadata).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(api.prepareCreateLaunch).mock.calls;
    expect(calls[1]![2].mint.publicKey.toBase58()).not.toBe(calls[0]![2].mint.publicKey.toBase58());
  });

  it('an upload that is refused stops before any transaction is built', async () => {
    const api = createApi();
    vi.mocked(api.meta.uploadLaunchMetadata).mockResolvedValue({ ok: false, reason: 'Too many uploads.', notConfigured: false, retryable: true });
    renderForm(api);
    await fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    expect(api.prepareCreateLaunch).not.toHaveBeenCalled();
    expect(screen.getByText(/could not be uploaded: Too many uploads\./)).toBeInTheDocument();
    expect(screen.getByText('Nothing was charged.')).toBeInTheDocument();
  });

  it('sent but not confirmed: goes to the launch page and leaves a "still landing" note, never a failure', async () => {
    const api = createApi({ submitPrepared: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'slow' })) });
    renderForm(api);
    await fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in wallet' }));
    });
    const mint = vi.mocked(api.prepareCreateLaunch).mock.calls[0]![2].mint.publicKey.toBase58();
    await waitFor(() => expect(screen.getByText(`launch page ${mint}`)).toBeInTheDocument());
    expect(readPendingLaunch(mint)).toMatchObject({ signature: SIG, lastValidBlockHeight: 1234 });
  });

  it('a transaction that expired stays on the form and says it is safe to try again', async () => {
    const api = createApi({ submitPrepared: vi.fn(async () => ({ status: 'expired' as const, signature: SIG, message: '' })) });
    renderForm(api);
    await fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in wallet' }));
    });
    expect(screen.getByText(/safe to try again/)).toBeInTheDocument();
    expect(readPendingLaunch(vi.mocked(api.prepareCreateLaunch).mock.calls[0]![2].mint.publicKey.toBase58())).toBeNull();
  });
});
