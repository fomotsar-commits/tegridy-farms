import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LaunchList } from './LaunchList';
import { CREATOR, KEY, MINT, SIG, bondingCurve, curveAccount, fakeApi, openGate } from './fakeWriteApi.fixture';
import type { LaunchListItem, TokenMetadata, WriteApi } from './ports';
import type { SolanaRpc } from '../../../lib/launcher/solana/curve';

// readMint goes through the raw JSON-RPC callable; answer "no mint" so rows render
// their share as unreadable rather than inventing a supply.
const rpc: SolanaRpc = vi.fn(async () => ({ value: null }));
const curveRpc = { getAccountInfo: vi.fn(async () => null), getMinimumBalanceForRentExemption: vi.fn(async () => 0) };

function md(over: Partial<TokenMetadata> = {}): TokenMetadata {
  return { address: KEY(20), mint: MINT, updateAuthority: CREATOR, name: 'Farm Fresh', symbol: 'FRESH', uri: 'https://ipfs.io/ipfs/x', isMutable: false, ...over };
}

function item(over: Partial<LaunchListItem> = {}): LaunchListItem {
  return {
    mint: MINT,
    creator: CREATOR,
    signature: SIG,
    blockTime: 1,
    openingBuyTokens: 0n,
    curve: { kind: 'ok', value: curveAccount(bondingCurve()) },
    metadata: { kind: 'ok', value: md() },
    ...over,
  };
}

function renderList(api: WriteApi, wallet = null as null | typeof CREATOR) {
  render(
    <MemoryRouter>
      <LaunchList api={api} cfg={openGate().cfg} rpc={rpc} curveRpc={curveRpc} wallet={wallet} />
    </MemoryRouter>,
  );
}

describe('launch list', () => {
  it('says anyone can appear and nothing was checked', async () => {
    renderList(fakeApi());
    expect(screen.getByText(/Anyone can appear here, and we have not checked any of them/)).toBeInTheDocument();
  });

  it('an empty list says how far it looked, never "no launches"', async () => {
    renderList(fakeApi());
    expect(await screen.findByText('No launches in the most recent 60 transactions we checked.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/no launches exist|there are no launches/i);
  });

  // UX9: a program with no history at all used to read "in the latest 0 entries we read".
  it('a program with no history yet says "No launches yet.", never "the latest 0 entries"', async () => {
    renderList(
      fakeApi({
        listRecentLaunches: vi.fn(async () => ({ kind: 'ok' as const, value: { items: [], before: null, scanned: 0, hidden: 0 } })),
      }),
    );
    expect(await screen.findByText('No launches yet.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b0 (entries|transactions)/);
  });

  it('a failed read says the list could not be read, not that it is empty', async () => {
    renderList(fakeApi({ listRecentLaunches: vi.fn(async () => ({ kind: 'unreadable' as const, detail: 'HTTP 429' })) }));
    expect(await screen.findByText(/could not be read right now \(HTTP 429\)/)).toBeInTheDocument();
    expect(screen.queryByText(/No launches/)).not.toBeInTheDocument();
  });

  it('flags a copied ticker, editable details and missing metadata on the row itself', async () => {
    const api = fakeApi({
      listRecentLaunches: vi.fn(async () => ({
        kind: 'ok' as const,
        value: {
          items: [
            item({ metadata: { kind: 'ok', value: md({ symbol: 'USDC', name: 'USD Coin', isMutable: true }) } }),
            item({ mint: KEY(30), metadata: { kind: 'absent' } }),
          ],
          before: null,
          scanned: 20,
          hidden: 0,
        },
      })),
    });
    renderList(api);
    const rows = await screen.findAllByTestId('launch-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toMatch(/Details can change/);
    expect(rows[0]!.textContent).toMatch(/copying|reserved|pass for|looks like|imperson/i);
    expect(rows[1]!.textContent).toMatch(/No name \(made outside this site\)/);
    expect(rows[0]!.textContent).toContain(MINT.toBase58());
  });

  it("the creator's opening buy: unreadable reads 'could not read', never 0", async () => {
    const api = fakeApi({
      listRecentLaunches: vi.fn(async () => ({
        kind: 'ok' as const,
        value: { items: [item({ openingBuyTokens: null })], before: null, scanned: 20, hidden: 0 },
      })),
    });
    renderList(api);
    const row = await screen.findByTestId('launch-row');
    await waitFor(() => expect(row.textContent).toMatch(/Bought in the launch transaction \(any wallet\)\s*could not read/));
  });

  it('"Yours" reads the wallet\'s own history, and is off without a wallet', async () => {
    const api = fakeApi();
    renderList(api, CREATOR);
    fireEvent.click(screen.getByRole('button', { name: 'Yours' }));
    await waitFor(() => expect(api.listLaunchesByCreator).toHaveBeenCalledWith(rpc, expect.anything(), CREATOR, {}));
  });

  // The sibling of UXR2: "Show more" vanished while the next page loaded, dropping
  // keyboard focus to the page.
  it('"Show more" stays focused while the next page loads, and does nothing on a second press', async () => {
    let answer: (v: Awaited<ReturnType<WriteApi['listRecentLaunches']>>) => void = () => undefined;
    const api = fakeApi({
      listRecentLaunches: vi
        .fn()
        .mockResolvedValueOnce({ kind: 'ok', value: { items: [item()], before: 'cursor', scanned: 20, hidden: 0 } })
        .mockImplementationOnce(() => new Promise((r) => (answer = r))),
    });
    renderList(api);
    const more = await screen.findByRole('button', { name: 'Show more' });
    more.focus();
    fireEvent.click(more);
    const during = screen.getByRole('button', { name: 'Show more' });
    expect(during).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(during);
    fireEvent.click(during);
    expect(api.listRecentLaunches).toHaveBeenCalledTimes(2);
    answer({ kind: 'ok', value: { items: [], before: 'cursor2', scanned: 20, hidden: 0 } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show more' })).not.toHaveAttribute('aria-disabled'));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show more' }));
  });
});
