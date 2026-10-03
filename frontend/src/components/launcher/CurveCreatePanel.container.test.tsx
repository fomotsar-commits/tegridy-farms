// The create flow's orchestration (the view's states are in CurveCreatePanel.test.tsx):
// the heat gate reads the wallet before the image-upload signature and fails closed; the
// image uploads before the create tx; the token comes from the LaunchCreated log; a tx with
// no such log fails loudly; an identity failure lands the coin and the retry re-runs only
// the publish; an unread receipt holds the form behind "Check again"; a revert says so.
// Heat is stubbed at the network edge (heatClient), so the real assertMayLaunch decides.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { clearGateAudit } from '../../lib/heat/gateAudit';
import { parseHeatReading } from '../../lib/heat/heatOracle';

// ── mocks — vi.hoisted so the (hoisted) vi.mock factories can see them ──
const {
  uploadFile, uploadJson, writeContractAsync, waitForTransactionReceipt, getTransactionReceipt, parseEventLogs,
  toastSuccess, toastError, toastWarning, fetchHeat, wallet,
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
  fetchHeat: vi.fn(),
  wallet: { address: undefined as string | undefined },
}));
const order: string[] = []; // records call ordering: heat, then upload, then write

vi.mock('framer-motion', () => {
  const pass = new Proxy({}, { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> });
  return { m: { ...pass, div: ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> }, motion: pass, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>, LazyMotion: ({ children }: { children?: React.ReactNode }) => <>{children}</>, domAnimation: {} };
});
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError, warning: toastWarning } }));
vi.mock('../../hooks/useIrysUpload', () => ({ useIrysUpload: () => ({ uploadFile, uploadJson }) }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: wallet.address }),
  useWriteContract: () => ({ writeContractAsync, isPending: false }),
  usePublicClient: () => ({ waitForTransactionReceipt, getTransactionReceipt }),
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

import { WaitForTransactionReceiptTimeoutError, TransactionReceiptNotFoundError } from 'viem';
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

describe('CurveCreatePanel container — the create receipt', () => {
  const unread = () => new WaitForTransactionReceiptTimeoutError({ hash: '0xhash' });

  it('UNREAD: says it cannot tell, is not an error, and does not hand back an armed form', async () => {
    waitForTransactionReceipt.mockRejectedValue(unread());
    const { onCreated } = renderPanel();
    fillAndSubmit();
    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith("We couldn't confirm this transaction", expect.anything()));
    // The gate still read first: heat, then upload, then the create whose receipt went unread.
    expect(order).toEqual(['heat', 'upload', 'write']);
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

describe('CurveCreatePanel container: a create the wallet replaced', () => {
  // viem's direct wait does not fail on a replaced tx: it calls onReplaced, then
  // RESOLVES with the replacement's receipt (pinned in lib/txErrors.direct.test.ts).
  const R_HASH = `0x${'ef'.repeat(32)}`;
  const replacedWait = (reason: 'cancelled' | 'repriced', logs: unknown[]) =>
    async (args: { hash: string; onReplaced?: (r: unknown) => void }) => {
      args.onReplaced?.({ reason, replacedTransaction: { hash: args.hash }, transaction: { hash: R_HASH }, transactionReceipt: {} });
      return { status: 'success', transactionHash: R_HASH, logs };
    };

  it('asks viem why a replaced create was replaced (onReplaced on the wait)', async () => {
    renderPanel();
    fillAndSubmit();
    await screen.findByText(TOKEN);
    expect(waitForTransactionReceipt).toHaveBeenCalledWith(expect.objectContaining({ hash: '0xhash', onReplaced: expect.any(Function) }));
  });

  it('a wallet CANCEL says it was cancelled, is no error, and gives the form back: no coin was made', async () => {
    waitForTransactionReceipt.mockImplementation(replacedWait('cancelled', []));
    parseEventLogs.mockReturnValue([]); // a 0-value send to yourself emits nothing
    const { onCreated } = renderPanel();
    fillAndSubmit();
    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith('Transaction cancelled', expect.anything()));
    // Pre-fix: "Launch confirmed (tx 0xhash) but no LaunchCreated log was found."
    expect(toastError).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /create launch/i })).toBeInTheDocument();
  });

  it('a SPEED-UP is the same create: the launch finishes from the transaction that mined', async () => {
    waitForTransactionReceipt.mockImplementation(replacedWait('repriced', [{ fake: 'log' }]));
    const { onCreated } = renderPanel();
    fillAndSubmit();
    await screen.findByText(TOKEN);
    expect(onCreated).toHaveBeenCalledWith(TOKEN);
    expect(toastWarning).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
