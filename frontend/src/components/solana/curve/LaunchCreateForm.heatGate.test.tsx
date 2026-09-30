// The heat door at submit on the Solana create path, against the REAL gate (launchGate,
// gateAudit, heatClient): only the network is stubbed, at the heat read. The island:
// "Resident opens the torches, the plant and the launches." A refusal happens before the
// upload request, the build and every wallet prompt, and an unreadable island refuses.
// LaunchCreateForm.test.tsx holds the gate open to test everything else about the form.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { LaunchCreateForm } from './LaunchCreateForm';
import { CREATOR, KEY, SIG, fakeApi, openGate, prepared } from './fakeWriteApi.fixture';
import type { CreateLaunchInput, TxSummary, UploadInput, WriteApi, WriteRpc } from './ports';
import type { CurveSignerState } from './useCurveSigner';
import { clearGateAudit, readGateAudit } from '../../../lib/heat/gateAudit';
import { clearHeatCache } from '../../../lib/heat/heatClient';
import { notifyBirth } from '../../../lib/launcher/notifyBirth';
import { enqueueBirth, flushBirthQueue, readBirthQueue } from '../../../lib/launcher/birthNotify';

vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));
// Inert unless something on this path imports them: the guard below proves nothing does.
vi.mock('../../../lib/launcher/notifyBirth', async (orig) => ({
  ...(await orig<typeof import('../../../lib/launcher/notifyBirth')>()),
  notifyBirth: vi.fn(async () => ({ queued: false as const, reason: 'test' })),
}));
vi.mock('../../../lib/launcher/birthNotify', async (orig) => {
  const actual = await orig<typeof import('../../../lib/launcher/birthNotify')>();
  return { ...actual, enqueueBirth: vi.fn(actual.enqueueBirth), flushBirthQueue: vi.fn(async () => 0) };
});

const signMessage = vi.fn(async (m: Uint8Array) => m);
const ready: CurveSignerState = {
  kind: 'ready',
  address: CREATOR.toBase58(),
  signer: { publicKey: CREATOR, signTransaction: async (t) => t },
  signMessage,
};
const PNG = { bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png' as const, width: 64, height: 64 };
const IPFS = 'ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const NOT_OPEN = 'Not sent. The launch door did not open for this wallet, so nothing was uploaded, built or signed.';

const nowSec = () => Math.floor(Date.now() / 1000);

/** The island's envelope, in its own wire spelling. */
function reading(degrees: number, tier: string, asOfUnix = nowSec() - 3_600) {
  return {
    address: CREATOR.toBase58(),
    degrees,
    tier,
    is_cold: false,
    held_since_unix: nowSec() - 200 * 86_400,
    as_of_unix: asOfUnix,
    token_count: 1,
    breakdown: [
      {
        token_address: '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump',
        chain: 'solana',
        name: 'BAYLA',
        symbol: 'BAYLA',
        heat_degrees: degrees,
        first_seen_at_unix: nowSec() - 200 * 86_400,
        last_transfer_at_unix: null,
      },
    ],
  };
}
const WARM = reading(95, 'Resident');
const COLD = reading(12, 'Observer');

type Reply = 'unreachable' | { status: number; body: unknown };

/** Every fetch the page makes. Only the heat read is answered; anything else fails the test. */
function stubHeat(first: Reply) {
  let reply = first;
  const f = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (!u.startsWith('/api/aggregator?resource=heat&address=')) throw new Error(`unexpected fetch: ${u}`);
    const r = reply;
    if (r === 'unreachable') throw new TypeError('fetch failed');
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
  });
  vi.stubGlobal('fetch', f);
  return { fetch: f, next: (r: Reply) => (reply = r) };
}

function MintPage() {
  const { mint } = useParams();
  return <p>launch page {mint}</p>;
}

function createApi(over: Partial<WriteApi> = {}) {
  const api = fakeApi(over);
  vi.mocked(api.meta.prepareLaunchImage).mockResolvedValue({ ok: true, image: PNG });
  vi.mocked(api.meta.uploadLaunchMetadata).mockImplementation(async (i: UploadInput) => {
    // The upload request is the first wallet prompt: it signs a message.
    await i.signMessage(new Uint8Array([1]));
    return {
      ok: true,
      metadataUri: IPFS,
      imageUri: IPFS,
      metadata: { name: i.name, symbol: i.symbol, description: i.description, image: IPFS, mint: i.mint, createdOn: 'https://memetics.finance' },
      reuseUntil: Date.now() + 60_000,
    };
  });
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
      platformReserve: { amount: 36_900_000_000_000n, bps: 369n, recipient: KEY(4), treasuryToken: KEY(12) },
      treasuryAccountRent: 1_488_440n,
    };
    return { ok: true, prepared: prepared(summary) };
  });
  return api;
}

function renderForm(api: WriteApi) {
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
              actions={{ create: true, buy: false, sell: false, migrate: false, poolSwap: false }}
              signerState={ready}
            />
          }
        />
        <Route path="/curve-launch/:mint" element={<MintPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return api;
}

async function fillAndReview() {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Farm Fresh' } });
  fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'fresh' } });
  const input = await screen.findByLabelText('Picture');
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' })] } });
  });
  await review();
}

async function review() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
  });
}

/** Refused at the door: said in the door's own words, and nothing reached the wallet. */
async function expectRefused(api: WriteApi, words: RegExp) {
  const outcome = await screen.findByTestId('tx-outcome');
  expect(outcome).toHaveAttribute('data-status', 'not-sent');
  expect(outcome).toHaveTextContent(NOT_OPEN);
  expect(outcome).toHaveTextContent(words);
  expect(outcome).toHaveTextContent('Nothing was charged.');
  expect(signMessage).not.toHaveBeenCalled();
  expect(api.meta.uploadLaunchMetadata).not.toHaveBeenCalled();
  expect(api.meta.readLaunchMetadataJson).not.toHaveBeenCalled();
  expect(api.prepareCreateLaunch).not.toHaveBeenCalled();
  expect(api.submitPrepared).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Sign in wallet' })).not.toBeInTheDocument();
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  sessionStorage.clear();
  localStorage.clear();
  clearGateAudit();
  clearHeatCache();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the Solana create path reads the heat door at submit', () => {
  it('a cold maker is not sent: no upload request, no build, no wallet prompt', async () => {
    const { fetch } = stubHeat({ status: 200, body: COLD });
    const api = renderForm(createApi());
    await fillAndReview();
    await expectRefused(api, /This wallet reads 12\.00° \(Observer\)\. The door opens at 80°/);
    // The maker is the wallet that signs the create.
    expect(String(fetch.mock.calls[0]![0])).toContain(`address=${CREATOR.toBase58()}`);
    // A refusal is logged too, against the signing wallet.
    expect(readGateAudit()[0]).toMatchObject({ address: CREATOR.toBase58(), verdict: 'COLD', floor: 80 });
  });

  it('an island that cannot be read is not sent: the door fails closed', async () => {
    stubHeat('unreachable');
    const api = renderForm(createApi());
    await fillAndReview();
    await expectRefused(api, /instrument is unreachable/);
  });

  it('a 200 that is not a reading is not sent', async () => {
    stubHeat({ status: 200, body: '<!doctype html>' });
    const api = renderForm(createApi());
    await fillAndReview();
    await expectRefused(api, /instrument is unreachable/);
  });

  it('a reading older than the freshness window is not sent', async () => {
    stubHeat({ status: 200, body: reading(300, 'Builder', nowSec() - 30 * 86_400) });
    const api = renderForm(createApi());
    await fillAndReview();
    await expectRefused(api, /cannot pass or fail anyone/);
  });

  it('paste mode, a cold maker: the details link is not even loaded', async () => {
    stubHeat({ status: 200, body: COLD });
    const api = createApi();
    vi.mocked(api.meta.uploadsAvailable).mockResolvedValue('no');
    renderForm(api);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Farm Fresh' } });
    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'fresh' } });
    fireEvent.change(await screen.findByLabelText('Details link'), { target: { value: IPFS } });
    await review();
    await expectRefused(api, /The door opens at 80°/);
  });

  it('a warm maker proceeds, and the door is read before the upload request', async () => {
    const { fetch } = stubHeat({ status: 200, body: WARM });
    const api = renderForm(createApi());
    await fillAndReview();
    expect(await screen.findByTestId('tx-review')).toBeInTheDocument();
    expect(vi.mocked(api.prepareCreateLaunch).mock.calls[0]![2].creator.toBase58()).toBe(CREATOR.toBase58());
    expect(fetch.mock.invocationCallOrder[0]!).toBeLessThan(signMessage.mock.invocationCallOrder[0]!);
    expect(readGateAudit()[0]).toMatchObject({ address: CREATOR.toBase58(), verdict: 'WARM' });
  });

  it('the door is read again at every Review, never from a cache', async () => {
    const heat = stubHeat({ status: 200, body: WARM });
    const api = renderForm(createApi());
    await fillAndReview();
    await screen.findByTestId('tx-review');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    heat.next({ status: 200, body: COLD });
    vi.mocked(api.prepareCreateLaunch).mockClear();
    vi.mocked(api.meta.uploadLaunchMetadata).mockClear();
    signMessage.mockClear();
    await review();
    await expectRefused(api, /12\.00° \(Observer\)/);
    expect(heat.fetch).toHaveBeenCalledTimes(2);
  });

  it('dialled off, a cold maker proceeds, and the reading is still logged', async () => {
    vi.stubEnv('VITE_HEAT_GATE', 'off');
    stubHeat({ status: 200, body: COLD });
    const api = renderForm(createApi());
    await fillAndReview();
    expect(await screen.findByTestId('tx-review')).toBeInTheDocument();
    expect(api.prepareCreateLaunch).toHaveBeenCalledTimes(1);
    expect(readGateAudit()[0]).toMatchObject({ address: CREATOR.toBase58(), verdict: 'COLD' });
  });
});

// The island has not said whether a SOL-priced launch is a birth (Q2), so a Solana
// create sends no birth notice: nothing is queued and nothing reaches the births relay.
describe('a Solana create is not announced as a birth', () => {
  it('a confirmed create calls no birth notifier and queues nothing', async () => {
    const heat = stubHeat({ status: 200, body: WARM });
    const api = renderForm(
      createApi({ submitPrepared: vi.fn(async () => ({ status: 'confirmed' as const, signature: SIG, slot: 7 })) }),
    );
    await fillAndReview();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in wallet' }));
    });
    const mint = vi.mocked(api.prepareCreateLaunch).mock.calls[0]![2].mint.publicKey.toBase58();
    await waitFor(() => expect(screen.getByText(`launch page ${mint}`)).toBeInTheDocument());
    expect(notifyBirth).not.toHaveBeenCalled();
    expect(enqueueBirth).not.toHaveBeenCalled();
    expect(flushBirthQueue).not.toHaveBeenCalled();
    expect(readBirthQueue()).toEqual([]);
    for (const [url] of heat.fetch.mock.calls) expect(String(url)).not.toMatch(/resource=births/);
  });

  it('no file on the Solana launch path imports the birth notifier', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = [
      join(here, 'LaunchCreateForm.tsx'),
      join(here, 'useTxFlow.ts'),
      join(here, 'pendingLaunch.ts'),
      join(here, 'writeApi.ts'),
      join(here, '..', '..', '..', 'pages', 'CurveLaunchPage.tsx'),
      join(here, '..', '..', '..', 'pages', 'CurveLaunchDetailPage.tsx'),
    ];
    for (const f of files) expect(readFileSync(f, 'utf-8'), f).not.toMatch(/notifyBirth|birthNotify|resource=births/);
  });
});
