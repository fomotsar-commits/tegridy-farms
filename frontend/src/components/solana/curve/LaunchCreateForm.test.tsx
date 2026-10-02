import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { LaunchCreateForm } from './LaunchCreateForm';
import { CREATOR, KEY, PLANT_SUMMARY, SIG, SOL, fakeApi, openGate, prepared } from './fakeWriteApi.fixture';
import { readPendingLaunch, savePendingLaunch } from './pendingLaunch';
import type { CreateLaunchInput, OpenGate, TxOutcome, TxSummary, UploadInput, WriteApi, WriteRpc } from './ports';
import type { CurveSignerState } from './useCurveSigner';
import { IPFS_STEP_TIMEOUT_MS, ipfsGatewayUrls } from '../../../lib/ipfsGateways';
import { assertMayLaunch } from '../../../lib/heat/launchGate';

vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));
// The heat door at submit is proved against the real gate in LaunchCreateForm.heatGate.test.tsx;
// here it is held open, so the rest of the form can be tested on its own.
vi.mock('../../../lib/heat/launchGate', async (orig) => ({
  ...(await orig<typeof import('../../../lib/heat/launchGate')>()),
  assertMayLaunch: vi.fn(async () => null),
}));

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
  return renderFormView(api, signerState).api;
}

function renderFormView(api: WriteApi = fakeApi(), signerState: CurveSignerState = ready, gate: OpenGate = openGate()) {
  const view = render(
    <MemoryRouter initialEntries={['/curve-launch']}>
      <Routes>
        <Route
          path="/curve-launch"
          element={
            <LaunchCreateForm
              api={api}
              rpc={{} as WriteRpc}
              gate={gate}
              actions={{ create: true, buy: false, sell: false, migrate: false, poolSwap: false }}
              signerState={signerState}
            />
          }
        />
        <Route path="/curve-launch/:mint" element={<MintPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return { api, view };
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
      platformReserve: {
        amount: 36_900_000_000_000n,
        bps: 369n,
        recipient: KEY(4),
        // A stand-in address: deriving the real one needs PDA maths, which fails under jsdom.
        treasuryToken: KEY(12),
      },
      // Today's mainnet rent for a token account; the real value is read from the cluster.
      treasuryAccountRent: 1_488_440n,
      plant: PLANT_SUMMARY,
    };
    return { ok: true, prepared: prepared(summary) };
  });
  return api;
}

async function fillValid() {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Farm Fresh' } });
  fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'fresh' } });
  const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
  const input = await screen.findByLabelText('Picture');
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
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Safe‮token' } });
    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'SOL' } });
    const form = screen.getByTestId('launch-create-form');
    expect(form.querySelectorAll('.text-rose-300\\/90').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: 'Review launch' })).toBeDisabled();
    expect(api.meta.uploadLaunchMetadata).not.toHaveBeenCalled();
    expect(api.prepareCreateLaunch).not.toHaveBeenCalled();
  });

  it('turns to paste-a-link mode when uploads are not available', async () => {
    const api = createApi();
    vi.mocked(api.meta.uploadsAvailable).mockResolvedValue('no');
    renderForm(api);
    expect(await screen.findByLabelText('Details link')).toBeInTheDocument();
    expect(screen.queryByLabelText('Picture')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Details link'), { target: { value: 'https://example.com/x.json' } });
    expect(screen.getByRole('button', { name: 'Review launch' })).toBeDisabled();
  });

  // F6: one slow or failed status check used to switch the form to paste mode for
  // the whole visit and say uploads "are not available on this site yet".
  it('a failed upload-status check is not "uploads are off": it offers to check again', async () => {
    const api = createApi();
    vi.mocked(api.meta.uploadsAvailable).mockResolvedValueOnce('unknown').mockResolvedValueOnce('yes');
    renderForm(api);
    expect(await screen.findByText(/could not reach the picture upload service/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Details link')).not.toBeInTheDocument();
    expect(screen.queryByText(/not switched on|not available on this site/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Picture')).toBeInTheDocument();
    expect(api.meta.uploadsAvailable).toHaveBeenCalledTimes(2);
  });

  it('paste mode is still there as a choice when the check fails, without claiming uploads are off', async () => {
    const api = createApi();
    vi.mocked(api.meta.uploadsAvailable).mockResolvedValue('unknown');
    renderForm(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Paste a details link instead' }));
    expect(screen.getByLabelText('Details link')).toBeInTheDocument();
    expect(screen.queryByText(/not switched on/)).not.toBeInTheDocument();
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
    expect(form).toHaveTextContent(
      `The other 3.69% is the platform reserve: it is sent to the platform treasury (${KEY(4).toBase58()}) in the same transaction that creates the token.`,
    );
    expect(form).not.toHaveTextContent(/whole supply/i);
  });

  // F1, then the 2026-09-26 owner decision: the reserve is paid to the treasury at create.
  it('the reserve row says who gets the reserve, and when', async () => {
    renderForm(createApi());
    await screen.findByTestId('launch-create-form');
    const row = screen.getByText('Platform reserve').parentElement!;
    expect(row).toHaveTextContent(
      `3.69% of supply, sent to the platform treasury (${KEY(4).toBase58()}) when the token is created.`,
    );
    expect(row.textContent ?? '').not.toMatch(/graduat|release|multisig/i);
  });

  it('calls the treasury a multisig only when the settings name the known vault', async () => {
    const { PLATFORM_TREASURY_VAULT } = await import('../../../lib/launcher/solana/curve');
    const gate = openGate({ global: { ...openGate().global, feeRecipient: PLATFORM_TREASURY_VAULT } });
    renderFormView(createApi(), ready, gate);
    await screen.findByTestId('launch-create-form');
    expect(screen.getByText('Platform reserve').parentElement).toHaveTextContent(
      '3.69% of supply, sent to the platform treasury (a multisig) when the token is created.',
    );
  });

  // F4: buy caps and migrate_to_amm require target + migration reserve (lib.rs), not the target alone.
  it('graduation needs the target plus the migration reserve (25 + 1 SOL in the fixture)', async () => {
    renderForm(createApi());
    await screen.findByTestId('launch-create-form');
    expect(screen.getByText('Graduates at').parentElement).toHaveTextContent('26 SOL raised');
    expect(screen.getByText('…of which migration reserve').parentElement).toHaveTextContent('1 SOL');
  });
});

describe('launch form: it says what is wrong, and screen readers hear it', () => {
  // UX8: "abc" or "0" as the opening buy silently turned Review off.
  it('a bad opening-buy amount says what to enter', async () => {
    renderForm(createApi());
    await fillValid();
    fireEvent.click(screen.getByRole('checkbox'));
    const buy = screen.getByLabelText('Opening buy (SOL)');
    for (const v of ['abc', '0', '1.2.3']) {
      fireEvent.change(buy, { target: { value: v } });
      expect(buy).toHaveAttribute('aria-invalid', 'true');
      expect(buy).toHaveAccessibleDescription(/Enter an amount of SOL, like 0\.5\./);
    }
    expect(screen.getByRole('button', { name: 'Review launch' })).toBeDisabled();
    fireEvent.change(buy, { target: { value: '0.5' } });
    expect(buy).not.toHaveAttribute('aria-invalid');
  });

  // UX8: the picture requirement was never stated, and a disabled Review said nothing.
  it('a disabled Review lists what is missing, the picture included, and says the picture is required', async () => {
    renderForm(createApi());
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Farm Fresh' } });
    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'FRESH' } });
    const picture = await screen.findByLabelText('Picture');
    expect(picture).toHaveAccessibleDescription(/Required\./);
    const reviewBtn = screen.getByRole('button', { name: 'Review launch' });
    expect(reviewBtn).toBeDisabled();
    expect(reviewBtn).toHaveAccessibleDescription('Before you can review your launch: add a picture.');
    await act(async () => {
      fireEvent.change(picture, { target: { files: [new File([new Uint8Array([1])], 'p.png', { type: 'image/png' })] } });
    });
    expect(screen.getByRole('button', { name: 'Review launch' })).not.toBeDisabled();
    expect(screen.queryByTestId('review-missing')).not.toBeInTheDocument();
  });

  // UXR9: every reason read after "add", so "add the picture upload check to finish".
  it('the reasons Review is off read as whole instructions, whatever they are', async () => {
    const api = createApi();
    vi.mocked(api.meta.uploadsAvailable).mockReturnValue(new Promise(() => undefined)); // still checking
    renderForm(api);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Farm Fresh' } });
    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'FRESH' } });
    fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: 'x'.repeat(2_000) } });
    const why = screen.getByTestId('review-missing');
    expect(why).toHaveTextContent(
      'Before you can review your launch: wait for the picture upload check to finish; shorten the description.',
    );
    expect(why).not.toHaveTextContent(/add the picture upload|add a shorter/);
    expect(screen.getByRole('button', { name: 'Review launch' })).toHaveAccessibleDescription(why.textContent!);
  });

  // UXR4 (WCAG 2.5.3): each field's spoken name is its visible label.
  it('every field is named by its visible label', async () => {
    renderForm(createApi());
    for (const name of ['Name', 'Symbol', 'Description (optional)', 'Website link (optional)', 'X link (optional)', 'Telegram link (optional)']) {
      expect(screen.getByRole('textbox', { name })).toBeInTheDocument();
    }
    expect(await screen.findByLabelText('Picture')).toHaveAccessibleName('Picture');
  });

  // UX10: a bad link printed the internal key ("twitter: ...") below all three inputs.
  it('a bad link is named the way the form names it, under its own input', async () => {
    renderForm(createApi());
    await fillValid();
    const x = screen.getByLabelText('X link (optional)');
    fireEvent.change(x, { target: { value: 'javascript:alert(1)' } });
    expect(x).toHaveAttribute('aria-invalid', 'true');
    expect(x).toHaveAccessibleDescription(/^X link: /);
    expect(screen.getByTestId('launch-create-form')).not.toHaveTextContent(/twitter:/);
    expect(screen.getByLabelText('Website link (optional)')).not.toHaveAttribute('aria-invalid');
  });

  // F8/UX4: every input carries an aria-label, which hid the hint and the error.
  it('hints and errors are read out with their field', async () => {
    renderForm(createApi());
    const nameInput = await screen.findByLabelText('Name');
    // F13: "bytes" means nothing to a creator.
    expect(nameInput).toHaveAccessibleDescription(/Up to 32 characters \(emoji and accented letters count as more than one\)\./);
    fireEvent.change(nameInput, { target: { value: 'Safe\u202Etoken' } });
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Symbol')).toHaveAccessibleDescription(/letters A to Z or digits/);
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
    expect(card).toHaveTextContent(
      `When the token is created, the platform receives 3.69% of the supply, sent to the platform treasury (${KEY(4).toBase58()}). This page cannot confirm that the treasury is a multisig. The program does not stop the treasury selling those tokens, including while the curve is live.`,
    );
    expect(card).toHaveTextContent(/You can lose everything/);
  });

  // Reserve at create (2026-09-26): the review names the reserve, where it goes, and
  // the rent the creator pays for the treasury's token account, all from the prepared
  // transaction (the rent is read from the cluster, never a constant).
  it('the review shows the platform reserve paid now, its receiver, and the treasury account rent', async () => {
    renderForm(createApi());
    await fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    const review = await screen.findByTestId('tx-review');
    expect(screen.getByText('Platform reserve, paid in this transaction').parentElement).toHaveTextContent(
      '36,900,000 (3.69% of the supply)',
    );
    expect(screen.getByText('Sent to (platform treasury)').parentElement).toHaveTextContent(KEY(4).toBase58());
    expect(screen.getByText('You pay for that token account').parentElement).toHaveTextContent(
      '0.00148844 SOL (rent, read from the network just now)',
    );
    expect(review.textContent ?? '').not.toMatch(/release|if the launch graduates|held by the program/i);
  });

  it('uploads, builds, and shows the public-forever list before the wallet opens', async () => {
    const api = renderForm(createApi());
    await fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    // The door is asked first, about the wallet that signs the create.
    expect(assertMayLaunch).toHaveBeenCalledWith(CREATOR.toBase58());
    expect(vi.mocked(assertMayLaunch).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(api.meta.uploadLaunchMetadata).mock.invocationCallOrder[0]!,
    );
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
    vi.mocked(api.meta.uploadsAvailable).mockResolvedValue('no');
    vi.mocked(api.meta.readLaunchMetadataJson).mockResolvedValue({
      kind: 'ok',
      json: { name: 'Farm Fresh', symbol: 'FRESH', description: '', image: null, mint: CREATOR.toBase58() },
      mintMatches: false,
      issues: [],
    });
    renderForm(api);
    fireEvent.change(await screen.findByLabelText('Details link'), {
      target: { value: 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy' },
    });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Farm Fresh' } });
    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'FRESH' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    expect(await screen.findByText(/was made for a different token/)).toBeInTheDocument();
  });

  it('the opening buy carries no tolerance: its floor is the exact quote', async () => {
    const api = renderForm(createApi());
    await fillValid();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Opening buy (SOL)'), { target: { value: '0.1' } });
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
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Farm Fresher' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    expect(api.meta.uploadLaunchMetadata).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(api.prepareCreateLaunch).mock.calls;
    expect(calls[1]![2].mint.publicKey.toBase58()).not.toBe(calls[0]![2].mint.publicKey.toBase58());
  });

  // The real gate throws only HeatGateDenied (LaunchCreateForm.heatGate.test.tsx); any
  // other throw from the door read must still leave the launch unsent.
  it('a door read that fails in any other way is not sent either', async () => {
    vi.mocked(assertMayLaunch).mockRejectedValueOnce(new Error('storage exploded'));
    const api = renderForm(createApi());
    await fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    const outcome = await screen.findByTestId('tx-outcome');
    expect(outcome).toHaveAttribute('data-status', 'not-sent');
    expect(outcome).toHaveTextContent('The launch door did not open for this wallet');
    expect(outcome).toHaveTextContent('The island could not be read, so the door stays shut.');
    expect(signMessage).not.toHaveBeenCalled();
    expect(api.meta.uploadLaunchMetadata).not.toHaveBeenCalled();
    expect(api.prepareCreateLaunch).not.toHaveBeenCalled();
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

  // UXR11: the wallet opened for the upload request while the screen said only
  // "Building the transaction", so the prompt came with no explanation.
  it('while preparing, it says the wallet will ask to sign the upload request, and that it is not a transaction', async () => {
    const api = createApi();
    let finish: (v: Awaited<ReturnType<WriteApi['meta']['uploadLaunchMetadata']>>) => void = () => undefined;
    vi.mocked(api.meta.uploadLaunchMetadata).mockImplementation(() => new Promise((r) => (finish = r)));
    renderForm(api);
    await fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/Approve the upload request in your wallet\. It is a message to sign, not a transaction/);
    expect(document.activeElement).toBe(status);
    await act(async () => finish({ ok: false, reason: 'x', notConfigured: false, retryable: false }));
  });

  // UXR3: Cancel left focus on the page body.
  it('Cancel puts focus back on Review launch', async () => {
    renderForm(createApi());
    await fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    cancel.focus();
    act(() => {
      fireEvent.click(cancel);
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Review launch' }));
  });

  // FS-1: during the wait for the network nothing was saved, and the mint key lived
  // only in memory, so a reload gave a fresh form with a NEW mint: a second launch.
  it('a launch still waiting for the network survives a reload: the note exists before the wait ends, and Review is held', async () => {
    const api = createApi({
      submitPrepared: vi.fn((_r, _s, _p, deps) => {
        deps?.onSent?.(SIG, 1234);
        return new Promise<TxOutcome>(() => undefined); // the network never answers here
      }),
      recheckOutcome: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'The network has no record of it yet.' })),
    });
    const first = renderFormView(api);
    await fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in wallet' }));
    });
    const mint = vi.mocked(api.prepareCreateLaunch).mock.calls[0]![2].mint.publicKey.toBase58();
    expect(await screen.findByTestId('tx-sent')).toHaveTextContent(SIG);
    // Written while the launch is still in the air.
    expect(readPendingLaunch(mint)).toMatchObject({ signature: SIG, lastValidBlockHeight: 1234 });

    first.view.unmount(); // the reload
    renderForm(api);
    const earlier = await screen.findByTestId('earlier-launch');
    await waitFor(() => expect(earlier).toHaveTextContent(/may still be landing/));
    expect(earlier).toHaveTextContent(mint);
    expect(screen.getByRole('link', { name: /Open that launch/ })).toHaveAttribute('href', `/curve-launch/${mint}`);
    await fillValid();
    const reviewBtn = screen.getByRole('button', { name: 'Review launch' });
    expect(reviewBtn).toBeDisabled();
    expect(reviewBtn).toHaveAccessibleDescription(/check your earlier launch above/);
    // A deliberate step, then a new launch can be reviewed.
    fireEvent.click(screen.getByRole('button', { name: 'My earlier launch did not land: start a new one' }));
    expect(screen.getByRole('button', { name: 'Review launch' })).not.toBeDisabled();
  });

  it('an earlier launch the network refused or let expire does not hold Review, and its note goes', async () => {
    const other = '7'.repeat(88);
    savePendingLaunch(CREATOR.toBase58(), other, 99);
    const api = createApi({ recheckOutcome: vi.fn(async () => ({ status: 'expired' as const, signature: other, message: '' })) });
    renderForm(api);
    await waitFor(() => expect(api.recheckOutcome).toHaveBeenCalledWith(expect.anything(), other, { lastValidBlockHeight: 99 }));
    await waitFor(() => expect(screen.queryByTestId('earlier-launch')).not.toBeInTheDocument());
    expect(readPendingLaunch(CREATOR.toBase58())).toBeNull();
    await fillValid();
    expect(screen.getByRole('button', { name: 'Review launch' })).not.toBeDisabled();
  });

  it('a launch the network turned away at the first send clears the note written when it was sent', async () => {
    const api = createApi({
      submitPrepared: vi.fn(async (_r, _s, _p, deps) => {
        deps?.onSent?.(SIG, 1234);
        return { status: 'not-sent' as const, stage: 'send' as const, message: 'Blockhash not found.' };
      }),
    });
    renderForm(api);
    await fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in wallet' }));
    });
    const mint = vi.mocked(api.prepareCreateLaunch).mock.calls[0]![2].mint.publicKey.toBase58();
    expect(readPendingLaunch(mint)).toBeNull();
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

// The review's picture is on IPFS in paste mode, and a gateway can HANG (no answer,
// no error event). A plain <img> walking the list only on error sits on a hung
// gateway forever and the creator reviews a blank picture. It must move on after
// one step, with no error event.
describe('launch form: the review picture moves past a hung IPFS gateway', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('paste mode: a picture on a gateway that never answers moves to the next one after one step', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
    const urls = ipfsGatewayUrls(`ipfs://${CID}`);
    const api = createApi();
    vi.mocked(api.meta.uploadsAvailable).mockResolvedValue('no');
    vi.mocked(api.meta.readLaunchMetadataJson).mockResolvedValue({
      kind: 'ok',
      json: { name: 'Farm Fresh', symbol: 'FRESH', description: '', image: `ipfs://${CID}`, mint: null },
      mintMatches: false,
      issues: [],
    });
    renderForm(api);
    fireEvent.change(await screen.findByLabelText('Details link'), {
      target: { value: `https://ipfs.io/ipfs/${CID}` },
    });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Farm Fresh' } });
    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'FRESH' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    });
    const pic = await screen.findByAltText('Your token picture');
    expect(pic).toHaveAttribute('src', urls[0]);
    await act(async () => {
      vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS);
    });
    expect(screen.getByAltText('Your token picture')).toHaveAttribute('src', urls[1]);
  });
});
