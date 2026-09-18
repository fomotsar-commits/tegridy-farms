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
//   5. A receipt we could not READ is not a failure: the create tx may have
//      mined a coin, so the panel says it cannot tell, does not hand back an
//      armed form, and "Check again" finishes the launch from the same tx.
//   6. A reverted create says reverted, never "Launch confirmed".

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ── mocks — vi.hoisted so the (hoisted) vi.mock factories can see them ──
const {
  uploadFile, uploadJson, writeContractAsync, waitForTransactionReceipt, getTransactionReceipt, parseEventLogs,
  toastSuccess, toastError, toastWarning,
} = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  uploadJson: vi.fn(),
  writeContractAsync: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  getTransactionReceipt: vi.fn(),
  parseEventLogs: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));
const order: string[] = []; // records call ordering for invariant #1

vi.mock('framer-motion', () => {
  const pass = new Proxy({}, { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> });
  return { m: { ...pass, div: ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> }, motion: pass, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>, LazyMotion: ({ children }: { children?: React.ReactNode }) => <>{children}</>, domAnimation: {} };
});
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError, warning: toastWarning } }));
vi.mock('../../hooks/useIrysUpload', () => ({ useIrysUpload: () => ({ uploadFile, uploadJson }) }));
vi.mock('wagmi', () => ({
  useWriteContract: () => ({ writeContractAsync, isPending: false }),
  usePublicClient: () => ({ waitForTransactionReceipt, getTransactionReceipt }),
  // AUDIT TF-023: the panel now READS the launch terms it displays. Undefined
  // data is the in-flight case, which the view renders as "still reading".
  useReadContract: () => ({ data: undefined }),
}));
vi.mock('viem', async (importOriginal) => ({ ...(await importOriginal<typeof import('viem')>()), parseEventLogs }));

import { WaitForTransactionReceiptTimeoutError, TransactionReceiptNotFoundError } from 'viem';
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
  waitForTransactionReceipt.mockReset().mockResolvedValue({ status: 'success', logs: [{ fake: 'log' }] });
  getTransactionReceipt.mockReset();
  parseEventLogs.mockReset().mockReturnValue([{ address: LAUNCHER, args: { token: TOKEN } }]);
  toastSuccess.mockReset();
  toastError.mockReset();
  toastWarning.mockReset();
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

describe('CurveCreatePanel container — the create receipt', () => {
  const unread = () => new WaitForTransactionReceiptTimeoutError({ hash: '0xhash' });

  it('UNREAD: says it cannot tell, is not an error, and does not hand back an armed form', async () => {
    waitForTransactionReceipt.mockRejectedValue(unread());
    const { onCreated } = renderPanel();
    fillAndSubmit();
    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith("We couldn't confirm this transaction", expect.anything()));
    expect(toastError).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    // One click on an armed "Create launch" would mine a SECOND coin with its own opening buy.
    expect(screen.queryByRole('button', { name: /create launch/i })).toBeNull();
    expect(screen.getByRole('button', { name: /check again/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /explorer/i })).toHaveAttribute('href', expect.stringContaining('/tx/0xhash'));
  });

  it('UNREAD, then Check again reads success: finishes the launch from the SAME tx', async () => {
    waitForTransactionReceipt.mockRejectedValue(unread());
    const { onCreated } = renderPanel();
    fillAndSubmit();
    await screen.findByRole('button', { name: /check again/i });

    getTransactionReceipt.mockResolvedValue({ status: 'success', logs: [{ fake: 'log' }] });
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    await screen.findByText(TOKEN);
    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: '0xhash' });
    expect(onCreated).toHaveBeenCalledWith(TOKEN);
    expect(uploadJson).toHaveBeenCalled();
    expect(writeContractAsync).toHaveBeenCalledTimes(1); // no second create tx
  });

  it('UNREAD, then Check again still cannot read: stays unconfirmed, still no error', async () => {
    waitForTransactionReceipt.mockRejectedValue(unread());
    renderPanel();
    fillAndSubmit();
    await screen.findByRole('button', { name: /check again/i });

    getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: '0xhash' }));
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: /check again/i })).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('UNREAD, then Start over: the form comes back only on an explicit choice', async () => {
    waitForTransactionReceipt.mockRejectedValue(unread());
    renderPanel();
    fillAndSubmit();
    fireEvent.click(await screen.findByRole('button', { name: /start over/i }));
    expect(screen.getByRole('button', { name: /create launch/i })).toBeInTheDocument();
  });

  it('REVERTED: says reverted, never "Launch confirmed"', async () => {
    waitForTransactionReceipt.mockResolvedValue({ status: 'reverted', logs: [] });
    parseEventLogs.mockReturnValue([]);
    const { onCreated } = renderPanel();
    fillAndSubmit();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const msg = String(toastError.mock.calls[0]?.[0]);
    expect(msg).toMatch(/reverted/i);
    expect(msg).not.toMatch(/confirmed/i);
    expect(onCreated).not.toHaveBeenCalled();
    expect(toastWarning).not.toHaveBeenCalled();
  });
});
