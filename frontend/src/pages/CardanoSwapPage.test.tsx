// The Cardano swap, pressed through like a visitor would: connect, paste a coin, see the price
// from a real pool (ADA/ASCEND, read from mainnet 2026-10-24), review, sign, send, follow.
// The wallet is a CIP-30 stand-in holding real keys; the chain answers are the fixtures.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../contexts/ThemeContext';
import type { PrivateKey } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from '../lib/cardano/csl';
import { composeAddress, hexToBytes, type ParsedAddress } from '../lib/cardano/address';
import { MINSWAP_V2 } from '../lib/cardano/minswapV2';
import { resetCardanoWalletForTests } from '../lib/cardano/walletStore';
import { ASCEND, fixture, testCsl } from '../lib/cardano/testkit.fixture';

// The page's loader, pointed at the .wasm on disk. Loaded here, not through testkit.fixture,
// which imports this very module: importing it from inside the mock waits on itself for ever.
vi.mock('../lib/cardano/csl', async (orig) => {
  const real = await orig<typeof import('../lib/cardano/csl')>();
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const wasm = createRequire(import.meta.url).resolve('@emurgo/cardano-serialization-lib-browser/cardano_serialization_lib_bg.wasm');
  // The same instance testkit.fixture's testCsl() hands out (it keys it on globalThis).
  const g = globalThis as { __cardanoTestCsl?: ReturnType<typeof real.loadCslFromBytes> };
  return { ...real, loadCsl: () => (g.__cardanoTestCsl ??= real.loadCslFromBytes(readFileSync(wasm))) };
});
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));
// The network drop-down reads wagmi, which the app provides around every page; it is not under test here.
vi.mock('../components/swap/ChainSwitch', () => ({ ChainSwitch: () => null }));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../components/PageArtBackdrop', () => ({ PageArtBackdrop: () => null }));

import CardanoSwapPage from './CardanoSwapPage';

const PARAMS = {
  txFeePerByte: 44,
  txFeeFixed: 155381,
  utxoCostPerByte: 4310,
  maxTxSize: 16384,
  maxValueSize: 5000,
  stakeAddressDeposit: 2000000,
  stakePoolDeposit: 500000000,
  minFeeRefScriptCostPerByte: 15,
};
const ASCEND_INFO = [
  {
    policy_id: ASCEND.policyId,
    asset_name: ASCEND.assetName,
    asset_name_ascii: '\u0000\u0014ßASCEND',
    fingerprint: 'asset1e4gd65smur5wa0p5z5pyuqjp08flxw82hf5asn',
    token_registry_metadata: { ticker: 'ASCEND', name: 'Ascend', decimals: 6 },
    cip68_metadata: null,
  },
];
const POOLS = fixture<unknown[]>('koios-asset-utxos-two-pools.json');

let csl: Csl;
let key: PrivateKey;
let trader: ParsedAddress;
let submitted: string[] = [];
let signed: string[] = [];

function walletUtxoHex(i: number, lovelace: bigint): string {
  const input = csl.TransactionInput.new(csl.TransactionHash.from_hex(i.toString(16).padStart(64, 'b')), i);
  const out = csl.TransactionOutput.new(csl.Address.from_bytes(hexToBytes(trader.hex)), csl.Value.new(csl.BigNum.from_str(lovelace.toString())));
  return csl.TransactionUnspentOutput.new(input, out).to_hex();
}

function installWallet() {
  const api = {
    getNetworkId: async () => 1,
    getChangeAddress: async () => trader.hex,
    getUtxos: async () => [walletUtxoHex(1, 900_000_000n), walletUtxoHex(2, 40_000_000n)],
    signTx: async (txHex: string) => {
      signed.push(txHex);
      const tx = csl.FixedTransaction.from_hex(txHex);
      const ws = csl.TransactionWitnessSet.new();
      const keys = csl.Vkeywitnesses.new();
      keys.add(csl.make_vkey_witness(tx.transaction_hash(), key));
      ws.set_vkeys(keys);
      return ws.to_hex();
    },
    submitTx: async (txHex: string) => {
      submitted.push(txHex);
      return csl.FixedTransaction.from_hex(txHex).transaction_hash().to_hex();
    },
  };
  (window as unknown as { cardano: unknown }).cardano = { eternl: { name: 'eternl', enable: async () => api, isEnabled: async () => false } };
}

function stubChain() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = new URL(url, 'https://site.test');
      const op = u.pathname.replace('/api/cardano/', '');
      const body =
        op === 'pool' ? POOLS
        : op === 'params' ? PARAMS
        : op === 'asset' ? ASCEND_INFO
        : op === 'tip' ? [{ abs_slot: 201256000, block_height: 14108900, block_time: 1792822300 }]
        : op === 'utxo' ? []
        : op === 'txstatus' ? [{ tx_hash: u.searchParams.get('tx'), num_confirmations: null }]
        : undefined;
      if (body === undefined) return new Response('no', { status: 500 });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

beforeAll(async () => {
  csl = await testCsl();
  key = csl.PrivateKey.generate_ed25519();
  trader = composeAddress({ kind: 'key', hash: key.to_public().hash().to_hex() }, { kind: 'key', hash: '73d3e74cbd4539a7ec925ef8ad057d945e3668021cf4f3e877d24d4d' });
});

beforeEach(() => {
  resetCardanoWalletForTests();
  submitted = [];
  signed = [];
  installWallet();
  stubChain();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { cardano?: unknown }).cardano;
  localStorage.clear();
});

function renderPage() {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/cardano']}>
        <CardanoSwapPage />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

async function connect() {
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a Cardano wallet' }));
  fireEvent.click(await screen.findByRole('button', { name: /Eternl/ }));
  await screen.findByTitle(trader.bech32);
}

describe('CardanoSwapPage', () => {
  it('names the coin by its ticker AND its whole id, with the warning that names can be copied', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/The coin/), { target: { value: ASCEND.policyId + ASCEND.assetName } });
    const id = await screen.findByTestId('cardano-coin-identity');
    await within(id).findByText('ASCEND');
    expect(id.textContent).toContain(ASCEND.policyId);
    expect(id.textContent).toContain(ASCEND.assetName);
    expect(id.textContent).toMatch(/Anyone can mint a coin with any name/);
  });

  it('quotes from the real pool, with every fee, its basis and who gets it, in view', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/The coin/), { target: { value: ASCEND.policyId + ASCEND.assetName } });
    await screen.findByText('ASCEND');
    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: '400' } });
    const q = await screen.findByTestId('cardano-quote', {}, { timeout: 3000 });
    expect(q.textContent).toMatch(/Venue fee/);
    expect(q.textContent).toMatch(/None: the venue has no Cardano fee address yet/);
    expect(q.textContent).toMatch(/1% of what you pay in/);
    expect(q.textContent).toMatch(/Minswap keeps 16\.66% of it/);
    expect(q.textContent).toMatch(/up to 2 ADA/);
    expect(q.textContent).toMatch(/comes back with your coins/);
  });

  it('reviews the checked transaction, then signs and sends exactly those bytes', async () => {
    renderPage();
    await connect();
    fireEvent.change(screen.getByLabelText(/The coin/), { target: { value: ASCEND.policyId + ASCEND.assetName } });
    await screen.findByText('ASCEND');
    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: '400' } });
    await screen.findByTestId('cardano-quote', {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    const review = await screen.findByTestId('cardano-review', {}, { timeout: 3000 });
    expect(review.textContent).toMatch(/Leaves your wallet, all in/);
    expect(review.textContent).toMatch(/404 ADA/); // the 400 ADA swap + 4 ADA order lock
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in wallet' }));
    });
    await screen.findByText(/Order sent/);
    expect(signed).toHaveLength(1);
    expect(submitted).toHaveLength(1);
    // What went out is the body that was checked and signed, with the wallet's signature on it.
    const sent = csl.FixedTransaction.from_hex(submitted[0]!);
    expect(sent.raw_body()).toEqual(csl.FixedTransaction.from_hex(signed[0]!).raw_body());
    const order = csl.TransactionBody.from_bytes(sent.raw_body()).outputs().get(0);
    expect(order.address().to_hex().slice(2, 58)).toBe(MINSWAP_V2.orderScriptHash);
    // The order is followed below, and was noted before it left.
    await waitFor(() => expect(screen.getAllByTestId('cardano-order')).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem('tegridy.cardano.orders.v1') ?? '[]')).toHaveLength(1);
  });

  it('says nothing was sent when the visitor declines in the wallet', async () => {
    renderPage();
    await connect();
    const w = (window as unknown as { cardano: { eternl: { enable: () => Promise<{ signTx: unknown }> } } }).cardano.eternl;
    const api = await w.enable();
    api.signTx = async () => {
      throw { code: 2, info: 'user declined' };
    };
    fireEvent.change(screen.getByLabelText(/The coin/), { target: { value: ASCEND.policyId + ASCEND.assetName } });
    await screen.findByText('ASCEND');
    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: '400' } });
    await screen.findByTestId('cardano-quote', {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    await screen.findByTestId('cardano-review', {}, { timeout: 3000 });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in wallet' }));
    });
    await screen.findByText(/You declined in the wallet\. Nothing was sent\./);
    expect(submitted).toHaveLength(0);
  });

  it('says a pool read that failed is not "no pool"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const op = new URL(url, 'https://site.test').pathname.replace('/api/cardano/', '');
        if (op === 'asset') return new Response(JSON.stringify(ASCEND_INFO), { status: 200 });
        if (op === 'params') return new Response(JSON.stringify(PARAMS), { status: 200 });
        return new Response('down', { status: 502 });
      }),
    );
    renderPage();
    fireEvent.change(screen.getByLabelText(/The coin/), { target: { value: ASCEND.policyId + ASCEND.assetName } });
    await screen.findByText('ASCEND');
    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: '400' } });
    await screen.findByText(/That does not mean there is none/, {}, { timeout: 3000 });
    expect(screen.queryByText(/No Minswap V2 pool holds/)).toBeNull();
  });
});
