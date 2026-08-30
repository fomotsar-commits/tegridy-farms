// Container tests for the create-flow ORCHESTRATION — the newest, riskiest code
// on the first-creator path (the view's states are covered in
// CurveCreatePanel.test.tsx). These pin the load-bearing invariants a real
// creator depends on, each mutation-checkable:
//   1. SAFETY ORDERING: the image uploads BEFORE the create tx — a failed upload
//      must never mine a token on-chain.
//   2. The token is parsed from the LaunchCreated receipt log and handed on.
//   3. A confirmed tx with no LaunchCreated log fails loudly (never a silent
//      "done" with no token).
//   4. An identity-publish failure never blocks the launch — it lands the coin,
//      surfaces the retry, and the retry re-runs ONLY the publish.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ── mocks — vi.hoisted so the (hoisted) vi.mock factories can see them ──
const { uploadFile, uploadJson, writeContractAsync, waitForTransactionReceipt, parseEventLogs, toastSuccess, toastError } =
  vi.hoisted(() => ({
    uploadFile: vi.fn(),
    uploadJson: vi.fn(),
    writeContractAsync: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    parseEventLogs: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
  }));
const order: string[] = []; // records call ordering for invariant #1

vi.mock('framer-motion', () => {
  const pass = new Proxy({}, { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> });
  return { m: { ...pass, div: ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> }, motion: pass, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>, LazyMotion: ({ children }: { children?: React.ReactNode }) => <>{children}</>, domAnimation: {} };
});
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock('../../hooks/useIrysUpload', () => ({ useIrysUpload: () => ({ uploadFile, uploadJson }) }));
vi.mock('wagmi', () => ({
  useWriteContract: () => ({ writeContractAsync, isPending: false }),
  usePublicClient: () => ({ waitForTransactionReceipt }),
}));
vi.mock('viem', async (importOriginal) => ({ ...(await importOriginal<typeof import('viem')>()), parseEventLogs }));

import { CurveCreatePanel } from './CurveCreatePanel';

const LAUNCHER = ('0x' + '1'.repeat(40)) as `0x${string}`;
const TOKEN = ('0x' + 'a'.repeat(40)) as `0x${string}`;
const CHAIN = 1;

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
    expect(order).toEqual(['upload', 'write']); // ordering invariant holds on success too
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
