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
const ASCEND_FINGERPRINT = 'asset1e4gd65smur5wa0p5z5pyuqjp08flxw82hf5asn';
/** What the chain lists under a pasted policy id, and under a pasted asset1… id; set per test. */
let policyRows: unknown[] = [];
let fingerprintRows: unknown[] = [];

let csl: Csl;
let key: PrivateKey;
let trader: ParsedAddress;
let submitted: string[] = [];
let signed: string[] = [];

function walletUtxoHex(i: number, lovelace: bigint, ascend?: bigint): string {
  const input = csl.TransactionInput.new(csl.TransactionHash.from_hex(i.toString(16).padStart(64, 'b')), i);
  const value = csl.Value.new(csl.BigNum.from_str(lovelace.toString()));
  if (ascend !== undefined) {
    const assets = csl.Assets.new();
    assets.insert(csl.AssetName.new(hexToBytes(ASCEND.assetName)), csl.BigNum.from_str(ascend.toString()));
    const ma = csl.MultiAsset.new();
    ma.insert(csl.ScriptHash.from_hex(ASCEND.policyId), assets);
    value.set_multiasset(ma);
  }
  const out = csl.TransactionOutput.new(csl.Address.from_bytes(hexToBytes(trader.hex)), value);
  return csl.TransactionUnspentOutput.new(input, out).to_hex();
}

/** The stand-in wallet's knobs, reset before each test. */
let wallet: { changeAddress: () => string; utxosGate: Promise<void>; utxos: () => string[] };

function installWallet() {
  wallet = { changeAddress: () => trader.hex, utxosGate: Promise.resolve(), utxos: () => [walletUtxoHex(1, 900_000_000n), walletUtxoHex(2, 40_000_000n)] };
  const api = {
    getNetworkId: async () => 1,
    getChangeAddress: async () => wallet.changeAddress(),
    getUtxos: async () => {
      await wallet.utxosGate;
      return wallet.utxos();
    },
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
        : op === 'policy' ? policyRows
        : op === 'fingerprint' ? fingerprintRows
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
  policyRows = [];
  fingerprintRows = [];
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

  it('takes the policy id alone, as people paste it, and finds the one coin under it', async () => {
    policyRows = [
      { asset_name: '000643b0415343454e44', asset_name_ascii: null, total_supply: '1', ticker: null },
      { asset_name: ASCEND.assetName, asset_name_ascii: null, total_supply: '1000000000000', ticker: 'ASCEND' },
    ];
    renderPage();
    fireEvent.change(screen.getByLabelText(/The coin/), { target: { value: ` ${ASCEND.policyId} ` } });
    const id = await screen.findByTestId('cardano-coin-identity');
    await within(id).findByText('ASCEND');
    expect(id.textContent).toContain(`${ASCEND.policyId}.${ASCEND.assetName}`);
    expect(screen.queryByTestId('cardano-coin-picks')).toBeNull();
  });

  it('lists the coins by ticker when several share the policy id, and takes none until one is picked', async () => {
    policyRows = [
      { asset_name: '69425443', asset_name_ascii: 'iBTC', total_supply: '4991218', ticker: 'iBTC' },
      { asset_name: ASCEND.assetName, asset_name_ascii: null, total_supply: '1000000000000', ticker: 'ASCEND' },
    ];
    renderPage();
    fireEvent.change(screen.getByLabelText(/The coin/), { target: { value: ASCEND.policyId } });
    const picks = await screen.findByTestId('cardano-coin-picks');
    expect(screen.queryByTestId('cardano-coin-identity')).toBeNull();
    fireEvent.click(within(picks).getByRole('button', { name: 'ASCEND' }));
    const id = await screen.findByTestId('cardano-coin-identity');
    await within(id).findByText('ASCEND');
    expect(within(picks).getByRole('button', { name: 'ASCEND' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('never takes the one coin it found on its own when the list was cut: there may be others', async () => {
    policyRows = [
      ...Array.from({ length: 50 }, (_, i) => ({ asset_name: i.toString(16).padStart(4, '0'), asset_name_ascii: null, total_supply: '1', ticker: null })),
      { asset_name: ASCEND.assetName, asset_name_ascii: null, total_supply: '1000000000000', ticker: 'ASCEND' },
    ];
    renderPage();
    fireEvent.change(screen.getByLabelText(/The coin/), { target: { value: ASCEND.policyId } });
    const picks = await screen.findByTestId('cardano-coin-picks');
    expect(within(picks).getByText(/Not everything under this id is listed/)).toBeInTheDocument();
    expect(screen.queryByTestId('cardano-coin-identity')).toBeNull();
  });

  it('takes an asset1… id, and an explorer link holding one', async () => {
    fingerprintRows = [{ policy_id: ASCEND.policyId, asset_name: ASCEND.assetName, fingerprint: ASCEND_FINGERPRINT }];
    renderPage();
    fireEvent.change(screen.getByLabelText(/The coin/), { target: { value: `https://cexplorer.io/asset/${ASCEND_FINGERPRINT}` } });
    const id = await screen.findByTestId('cardano-coin-identity');
    await within(id).findByText('ASCEND');
    expect(id.textContent).toContain(ASCEND.policyId);
  });

  it('says what is wrong with a pair link or text that is no coin, and shows no coin', async () => {
    renderPage();
    const box = screen.getByLabelText(/The coin/);
    fireEvent.change(box, { target: { value: 'https://dexscreener.com/cardano/f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c2ffadbb87144e875749122e0bbb9f535eeaa7f5660c6c4a91bcc4121e477f08d' } });
    expect(screen.getByText(/That names a trading pair, not a coin/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'SNEK' } });
    expect(screen.getByText(/That isn’t a Cardano coin’s address/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: ASCEND.policyId } });
    expect(await screen.findByText(/No coin under this id/)).toBeInTheDocument();
    expect(screen.queryByTestId('cardano-coin-identity')).toBeNull();
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

  it('with no venue fee address, the explainer never speaks of a venue fee being paid', async () => {
    renderPage();
    const explainer = (await screen.findByText('How a Cardano swap works')).closest('details') ?? document.body;
    expect(explainer.textContent).toMatch(/pays only the order and your change to your own address/);
    expect(explainer.textContent).not.toMatch(/venue fee/i);
    expect(explainer.textContent).not.toMatch(/must send your coins back/);
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
    // Paid to the trader's whole address, to match against the wallet's own screen.
    expect(within(review).getByTestId('cardano-review-paid-to').textContent).toBe(trader.bech32);
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
    expect(JSON.parse(localStorage.getItem('tegridy.minswap.orders.v1') ?? '[]')).toHaveLength(1);
    // The row says its own coins, by ticker and whole id, whatever the form holds now.
    fireEvent.change(screen.getByLabelText(/The coin/), { target: { value: '' } });
    const row = screen.getByTestId('cardano-order');
    expect(row.textContent).toMatch(/400 ADA for at least [\d,.]+ ASCEND/);
    expect(row.textContent).toContain(`ASCEND: ${ASCEND.policyId}.${ASCEND.assetName}`);
  });

  it('shows an order that ended on an earlier visit as saved, and never reads the chain for it again', async () => {
    localStorage.setItem(
      'tegridy.minswap.orders.v1',
      JSON.stringify([
        {
          txHash: 'e'.repeat(64), orderIndex: 0, traderHex: trader.hex, traderPaymentHash: trader.payment.hash,
          assetIn: { policyId: '', assetName: '' }, assetOut: ASCEND, amountIn: '400000000', minimumReceive: '1',
          inLabel: { ticker: 'ADA', decimals: 6 }, outLabel: { ticker: 'ASCEND', decimals: 6 }, ttlSlot: 1, submitted: true, placedAt: Date.now(),
          settled: { kind: 'filled', fillTx: 'f'.repeat(64), received: '5000000', depositBack: '2000000' },
        },
      ]),
    );
    renderPage();
    await connect();
    const row = await screen.findByTestId('cardano-order');
    await waitFor(() => expect(row.textContent).toMatch(/Filled: 5 ASCEND/));
    const reads = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(reads.filter((u) => /\/api\/cardano\/(utxo|txstatus|credtxs|tx)\b/.test(u))).toEqual([]);
  });

  it('reviews a sell as one: the order holds the coin sold beside its 4 ADA, never "the swap" in ADA', async () => {
    wallet.utxos = () => [walletUtxoHex(1, 40_000_000n), walletUtxoHex(3, 2_000_000n, 500_000_000n)];
    renderPage();
    await connect();
    fireEvent.click(screen.getByRole('button', { name: 'Sell for ADA' }));
    fireEvent.change(screen.getByLabelText(/The coin/), { target: { value: ASCEND.policyId + ASCEND.assetName } });
    await screen.findByText('ASCEND');
    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: '100' } });
    await screen.findByTestId('cardano-quote', {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    const review = await screen.findByTestId('cardano-review', {}, { timeout: 3000 });
    const order = within(review).getByText('Of that: the order').parentElement!;
    expect(order.textContent).toMatch(/4 ADA/);
    expect(order.textContent).toMatch(/and the 100 ASCEND you sell/);
    expect(order.textContent).not.toMatch(/the swap,/);
    expect(review.textContent).toMatch(/Leaves your wallet, all in[\s\S]*and 100 ASCEND/);
    expect(within(review).getByTestId('cardano-review-paid-to').textContent).toBe(trader.bech32);
  });

  it('holds the form still while a review is built, so what is signed is what was asked', async () => {
    renderPage();
    await connect();
    let release = () => {};
    wallet.utxosGate = new Promise<void>((r) => {
      release = r;
    });
    fireEvent.change(screen.getByLabelText(/The coin/), { target: { value: ASCEND.policyId + ASCEND.assetName } });
    await screen.findByText('ASCEND');
    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: '400' } });
    await screen.findByTestId('cardano-quote', {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    await screen.findByRole('button', { name: 'Building and checking…' });
    expect(screen.getByLabelText(/The coin/)).toBeDisabled();
    expect(screen.getByLabelText(/You pay/)).toBeDisabled();
    expect(screen.getByRole('button', { name: '3%' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sell for ADA' })).toBeDisabled();
    await act(async () => release());
    await screen.findByTestId('cardano-review', {}, { timeout: 3000 });
    // Changing anything after the review is built takes the review away.
    fireEvent.click(screen.getByRole('button', { name: '3%' }));
    expect(screen.queryByTestId('cardano-review')).toBeNull();
  });

  it('builds nothing when the wallet switched account since it connected', async () => {
    renderPage();
    await connect();
    wallet.changeAddress = () => composeAddress({ kind: 'key', hash: 'ee'.repeat(28) }, null).hex;
    fireEvent.change(screen.getByLabelText(/The coin/), { target: { value: ASCEND.policyId + ASCEND.assetName } });
    await screen.findByText('ASCEND');
    fireEvent.change(screen.getByLabelText(/You pay/), { target: { value: '400' } });
    await screen.findByTestId('cardano-quote', {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }));
    await screen.findByText(/switched to another account/, {}, { timeout: 3000 });
    expect(screen.queryByTestId('cardano-review')).toBeNull();
    expect(signed).toHaveLength(0);
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
