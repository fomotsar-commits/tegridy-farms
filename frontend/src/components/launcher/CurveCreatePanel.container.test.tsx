// The create flow's orchestration (the view's states are in CurveCreatePanel.test.tsx):
// the heat gate reads the connected wallet before the image-upload signature and fails
// closed; the image uploads before the create tx; the token comes from the LaunchCreated
// log; a tx with no such log fails loudly; an identity failure lands the coin and the
// retry re-runs only the publish. Heat is stubbed at the network edge (heatClient), so
// the real assertMayLaunch decides.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { clearGateAudit } from '../../lib/heat/gateAudit';
import { parseHeatReading } from '../../lib/heat/heatOracle';

// ── mocks — vi.hoisted so the (hoisted) vi.mock factories can see them ──
const { uploadFile, uploadJson, writeContractAsync, waitForTransactionReceipt, parseEventLogs, toastSuccess, toastError, fetchHeat, wallet } =
  vi.hoisted(() => ({
    uploadFile: vi.fn(),
    uploadJson: vi.fn(),
    writeContractAsync: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    parseEventLogs: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    fetchHeat: vi.fn(),
    wallet: { address: undefined as string | undefined },
  }));
const order: string[] = []; // records call ordering: heat, then upload, then write

vi.mock('framer-motion', () => {
  const pass = new Proxy({}, { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> });
  return { m: { ...pass, div: ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> }, motion: pass, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>, LazyMotion: ({ children }: { children?: React.ReactNode }) => <>{children}</>, domAnimation: {} };
});
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock('../../hooks/useIrysUpload', () => ({ useIrysUpload: () => ({ uploadFile, uploadJson }) }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: wallet.address }),
  useWriteContract: () => ({ writeContractAsync, isPending: false }),
  usePublicClient: () => ({ waitForTransactionReceipt }),
  // AUDIT TF-023: the panel now READS the launch terms it displays. Undefined
  // data is the in-flight case, which the view renders as "still reading".
  useReadContract: () => ({ data: undefined }),
}));
vi.mock('viem', async (importOriginal) => ({ ...(await importOriginal<typeof import('viem')>()), parseEventLogs }));
vi.mock('../../lib/heat/heatClient', () => ({
  fetchHeat: (...args: unknown[]) => fetchHeat(...args),
  isSupportedHeatAddress: () => true,
  clearHeatCache: () => {},
  HeatUnavailableError: class HeatUnavailableError extends Error {},
}));

import { CurveCreatePanel } from './CurveCreatePanel';

const LAUNCHER = ('0x' + '1'.repeat(40)) as `0x${string}`;
const TOKEN = ('0x' + 'a'.repeat(40)) as `0x${string}`;
const CHAIN = 1;
const MAKER = '0x71be63f3384f5fb98995898a86b02fb2426c5788';

/** A fresh reading of `degrees` for the maker, reckoned an hour ago. */
function reading(degrees: number, tier: string) {
  const now = Math.floor(Date.now() / 1000);
  return parseHeatReading({
    address: MAKER,
    degrees,
    tier,
    is_cold: false,
    held_since_unix: now - 400 * 86_400,
    as_of_unix: now - 3_600,
    token_count: 1,
    breakdown: [],
  });
}

function png(name = 'coin.png'): File {
  return new File([new Uint8Array(2048)], name, { type: 'image/png' });
}

function renderPanel() {
  const onCreated = vi.fn();
  const onTrade = vi.fn();
  render(
    <MemoryRouter>
      <CurveCreatePanel launcher={LAUNCHER} chainId={CHAIN} onCreated={onCreated} onTrade={onTrade} />
    </MemoryRouter>,
  );
  return { onCreated, onTrade };
}

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/token name/i), { target: { value: 'Towelie Jr' } });
  fireEvent.change(screen.getByLabelText(/token symbol/i), { target: { value: 'twljr' } });
  fireEvent.change(screen.getByLabelText(/^token image$/i), { target: { files: [png()] } });
  fireEvent.click(screen.getByRole('button', { name: /create launch/i }));
}

beforeEach(() => {
  order.length = 0;
  clearGateAudit();
  wallet.address = MAKER;
  fetchHeat.mockReset().mockImplementation(async () => { order.push('heat'); return reading(195.54, 'Resident'); });
  uploadFile.mockReset().mockImplementation(async () => { order.push('upload'); return 'imgTx'; });
  uploadJson.mockReset().mockResolvedValue('metaTx');
  writeContractAsync.mockReset().mockImplementation(async () => { order.push('write'); return '0xhash'; });
  waitForTransactionReceipt.mockReset().mockResolvedValue({ logs: [{ fake: 'log' }] });
  parseEventLogs.mockReset().mockReturnValue([{ address: LAUNCHER, args: { token: TOKEN } }]);
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe('CurveCreatePanel container — first-creator orchestration', () => {
  it('SAFETY: uploads the image BEFORE the create tx, and a failed upload mines NO token', async () => {
    uploadFile.mockReset().mockRejectedValueOnce(new Error('irys down'));
    renderPanel();
    fillAndSubmit();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // The tx must never fire if the image upload failed — nothing on-chain.
    expect(writeContractAsync).not.toHaveBeenCalled();
    // Form is usable again (back to idle), not stuck mid-flight.
    expect(screen.getByRole('button', { name: /create launch/i })).toBeInTheDocument();
  });

  it('happy path: token parsed from the LaunchCreated log → onCreated + address shown', async () => {
    const { onCreated } = renderPanel();
    fillAndSubmit();
    await screen.findByText(TOKEN);
    expect(order).toEqual(['heat', 'upload', 'write']); // ordering invariant holds on success too
    expect(onCreated).toHaveBeenCalledWith(TOKEN);
    expect(uploadJson).toHaveBeenCalled(); // identity published after the token exists
    expect(screen.getByText(/your launch is live/i)).toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('confirmed tx with NO LaunchCreated log fails loudly — never a silent done', async () => {
    parseEventLogs.mockReturnValue([]); // no matching event
    const { onCreated } = renderPanel();
    fillAndSubmit();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.queryByText(/your launch is live/i)).not.toBeInTheDocument();
  });

  it('identity-publish failure lands the coin, offers retry, and retry re-runs ONLY the publish', async () => {
    uploadJson.mockRejectedValueOnce(new Error('arweave hiccup'));
    const { onCreated } = renderPanel();
    fillAndSubmit();
    // The launch still succeeded — token captured, creator not blocked.
    await screen.findByText(TOKEN);
    expect(onCreated).toHaveBeenCalledWith(TOKEN);
    expect(screen.getByText(/identity didn.t publish/i)).toBeInTheDocument();
    const writesBefore = writeContractAsync.mock.calls.length;

    uploadJson.mockResolvedValueOnce('metaTx2');
    fireEvent.click(screen.getByRole('button', { name: /retry publishing identity/i }));
    await screen.findByText(/your launch is live/i);
    // Retry must NOT re-mine the token — no second create tx.
    expect(writeContractAsync.mock.calls.length).toBe(writesBefore);
    expect(uploadJson).toHaveBeenCalledTimes(2);
  });
});

describe('CurveCreatePanel container: the heat gate at submit', () => {
  const nothingSignedOrSent = () => {
    expect(uploadFile).not.toHaveBeenCalled();
    expect(writeContractAsync).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /create launch/i })).toBeEnabled();
  };

  it('GATE: a cold maker is refused before the image-upload signature, in the gate words', async () => {
    fetchHeat.mockReset().mockResolvedValue(reading(12, 'Observer'));
    renderPanel();
    fillAndSubmit();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0][0])).toContain('This wallet reads 12.00° (Observer). The door opens at 80°');
    nothingSignedOrSent();
  });

  it('GATE: an unreadable island refuses the same way (fails closed)', async () => {
    fetchHeat.mockReset().mockRejectedValue(new Error('unreachable'));
    renderPanel();
    fillAndSubmit();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0][0])).toContain('the door cannot read you');
    nothingSignedOrSent();
  });

  it('GATE: no connected wallet is refused before anything is read, signed or sent', async () => {
    wallet.address = undefined;
    renderPanel();
    fillAndSubmit();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(fetchHeat).not.toHaveBeenCalled();
    nothingSignedOrSent();
  });

  it('GATE: a warm maker is read by its own address first, then the upload, then the create from that address', async () => {
    renderPanel();
    fillAndSubmit();
    await screen.findByText(TOKEN);
    expect(fetchHeat.mock.calls[0][0]).toBe(MAKER);
    expect(order).toEqual(['heat', 'upload', 'write']);
    // The create goes out from that same wallet, whatever the connector holds by then.
    expect(writeContractAsync.mock.calls[0][0].account).toBe(MAKER);
  });

  it('GATE: the button is busy while the gate reads, so a second click starts nothing', async () => {
    let release: (() => void) | undefined;
    fetchHeat.mockReset().mockImplementation(
      () => new Promise((resolve) => { release = () => resolve(reading(195.54, 'Resident')); }),
    );
    renderPanel();
    fillAndSubmit();
    const busy = await screen.findByRole('button', { name: /reading held time/i });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(fetchHeat).toHaveBeenCalledTimes(1);
    release?.();
    await screen.findByText(TOKEN);
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
  });
});
