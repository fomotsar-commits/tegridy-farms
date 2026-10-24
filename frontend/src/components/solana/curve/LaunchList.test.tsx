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
    boughtByOwner: [],
    birthSupply: 1_000_000_000_000_000n,
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
  // The program accepts any wallet, and the list is read from the chain, so it cannot
  // know which launches the venue's heat door let through.
  it('says anyone can appear, and that the list cannot tell who came through the gate', async () => {
    renderList(fakeApi());
    expect(
      screen.getByText(
        /Anyone can appear here, and this list cannot tell which makers came through the gate\. Always compare the full token address before you buy\./,
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/we have not checked any of them/);
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

  it("the maker's create-buy: unreadable reads 'could not read', never 0", async () => {
    const api = fakeApi({
      listRecentLaunches: vi.fn(async () => ({
        kind: 'ok' as const,
        value: { items: [item({ openingBuyTokens: null, boughtByOwner: null })], before: null, scanned: 20, hidden: 0 },
      })),
    });
    renderList(api);
    const row = await screen.findByTestId('launch-row');
    expect(row).toHaveTextContent(
      "Could not read the maker's create-buy right now. This is our read failing, not a finding about the launch.",
    );
    expect(row.textContent).not.toMatch(/create-buy: 0|bought nothing|any wallet/);
  });

  // Parity with the launch page (ruling 3): the same maker figure, first, as a share of the supply at birth.
  it("each row shows the maker's create-buy, the same figure as the launch page, before what the creator holds now", async () => {
    const api = fakeApi({
      listRecentLaunches: vi.fn(async () => ({
        kind: 'ok' as const,
        value: {
          items: [
            item({
              openingBuyTokens: 55_000_000_000_000n,
              boughtByOwner: [
                { owner: CREATOR, tokens: 50_000_000_000_000n },
                { owner: KEY(9), tokens: 5_000_000_000_000n },
              ],
            }),
          ],
          before: null,
          scanned: 20,
          hidden: 0,
        },
      })),
    });
    renderList(api);
    const row = await screen.findByTestId('launch-row');
    const text = row.textContent ?? '';
    expect(text).toMatch(/The maker's create-buy: 5\.00% of the supply \(50000000000000 base units\), bought in the launch transaction/);
    expect(text).toContain('Other wallets got 0.50% of the supply in the same transaction (1 wallet).');
    expect(text.indexOf("The maker's create-buy")).toBeLessThan(text.indexOf("Creator's wallet holds now"));
    expect(text).not.toMatch(/any wallet/);
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

// Reserve at create (2026-09-26): the list says the reserve is already paid, from the
// launch's own account, and never that it waits on graduation.
describe('launch list: the platform reserve', () => {
  const listOf = (items: LaunchListItem[]) =>
    fakeApi({
      listRecentLaunches: vi.fn(async () => ({ kind: 'ok' as const, value: { items, before: null, scanned: 20, hidden: 0 } })),
    });

  it('a launch the program created reads "already paid ... when the token was created"', async () => {
    renderList(listOf([item()]));
    const row = (await screen.findAllByTestId('launch-row'))[0]!;
    // No mint supply was read in this fixture, so no share is invented.
    expect(row).toHaveTextContent(
      'Platform reserve (part of the supply): already paid to the platform treasury when the token was created.',
    );
    expect(row.textContent ?? '').not.toMatch(/release|graduates/i);
  });

  it('an account that does not record it paid says exactly that', async () => {
    renderList(listOf([item({ curve: { kind: 'ok', value: curveAccount(bondingCurve({ platformReserveReleased: false })) } })]));
    const row = (await screen.findAllByTestId('launch-row'))[0]!;
    expect(row).toHaveTextContent("Platform reserve (part of the supply): this launch's account does not record it as paid.");
    expect(row.textContent ?? '').not.toMatch(/already paid/);
  });
});
