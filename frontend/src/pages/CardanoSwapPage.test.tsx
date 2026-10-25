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
import { ADA, MINSWAP_V2, encodeSwapOrderDatum, lpAsset, orderAddressFor } from '../lib/cardano/minswapV2';
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
/** Mainnet's parameters with the script prices and cost model a cancel needs (2026-10-24). */
const PARAMS_FULL = fixture<unknown>('koios-cli-protocol-params.json');

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
    expect(within(row).queryByRole('button', { name: 'Cancel order' })).toBeNull();
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

  describe('Cancel order', () => {
    const ORDER_TX = 'a1'.repeat(32);
    const PLACED_AT = () => Date.now() - 60_000;

    function noteOrder() {
      localStorage.setItem(
        'tegridy.minswap.orders.v1',
        JSON.stringify([
          {
            txHash: ORDER_TX, orderIndex: 0, traderHex: trader.hex, traderPaymentHash: trader.payment.hash,
            assetIn: { policyId: '', assetName: '' }, assetOut: ASCEND, amountIn: '400000000', minimumReceive: '1',
            inLabel: { ticker: 'ADA', decimals: 6 }, outLabel: { ticker: 'ASCEND', decimals: 6 }, ttlSlot: 201256900, submitted: true, placedAt: PLACED_AT(),
          },
        ]),
      );
    }

    /** The chain: the order open until a cancel is submitted, then spent by that cancel, which paid the trader. */
    function stubOrderChain(spentOnSubmit = true) {
      const datum = encodeSwapOrderDatum(csl, { trader, pool: { ref: { txHash: '11'.repeat(32), index: 0 }, assetA: ADA, assetB: ASCEND, lp: lpAsset(ADA, ASCEND), reserveA: 1n, reserveB: 1n, totalLiquidity: 1n, feeANumerator: 100n, feeBNumerator: 100n, feeSharingNumerator: null, allowDynamicFee: false }, assetIn: ADA, swapAmount: 400_000_000n, minimumReceive: 1n });
      const orderRow = { tx_hash: ORDER_TX, tx_index: 0, address: orderAddressFor(trader).bech32, value: '404000000', asset_list: null, inline_datum: { bytes: datum } };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = new URL(url, 'https://site.test');
          const op = u.pathname.replace('/api/cardano/', '');
          const cancel = spentOnSubmit && submitted[0] ? csl.FixedTransaction.from_hex(submitted[0]) : null;
          const cancelHash = cancel?.transaction_hash().to_hex();
          const back = cancel ? csl.TransactionBody.from_bytes(cancel.raw_body()).outputs().get(0).amount().coin().to_str() : '0';
          const body =
            op === 'params' ? PARAMS_FULL
            : op === 'asset' ? ASCEND_INFO
            : op === 'tip' ? [{ abs_slot: 201256000, block_height: 14108900, block_time: 1792822300 }]
            : op === 'utxo' ? [{ ...orderRow, is_spent: cancel !== null }]
            : op === 'txstatus' ? [{ tx_hash: u.searchParams.get('tx'), num_confirmations: 3 }]
            : op === 'credtxs' ? (cancelHash ? [{ tx_hash: cancelHash, block_height: 14108899 }] : [])
            : op === 'tx' && cancelHash ? [{ tx_hash: cancelHash, inputs: [{ tx_hash: ORDER_TX, tx_index: 0 }], outputs: [{ tx_index: 0, payment_addr: { bech32: trader.bech32 }, value: back, inline_datum: null, asset_list: null }] }]
            : undefined;
          if (body === undefined) return new Response('no', { status: 500 });
          return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        }),
      );
    }

    it('shows on an open order, says what comes back, sends exactly the checked cancel, and then reads Returned', async () => {
      noteOrder();
      stubOrderChain();
      renderPage();
      await connect();
      const row = await screen.findByTestId('cardano-order');
      await within(row).findByText(/Order placed \(3 blocks deep\)/);
      expect(row.textContent).toMatch(/All of it comes back to your wallet, less the network fee\. A cancel pays no batcher fee\./);
      fireEvent.click(within(row).getByRole('button', { name: 'Cancel order' }));
      const review = await within(row).findByTestId('cardano-cancel-review', {}, { timeout: 3000 });
      // 404 ADA locked, less a network fee of about 0.24 ADA.
      expect(within(review).getByText('You get back').parentElement!.textContent).toMatch(/403\.7\d+ ADA/);
      expect(within(review).getByText('Batcher fee').parentElement!.textContent).toMatch(/None/);
      expect(within(review).getByTestId('cardano-cancel-paid-to').textContent).toBe(trader.bech32);
      expect(review.textContent).toContain(`ASCEND: ${ASCEND.policyId}.${ASCEND.assetName}`);
      await act(async () => {
        fireEvent.click(within(review).getByRole('button', { name: 'Sign the cancel' }));
      });
      expect(signed).toHaveLength(1);
      expect(submitted).toHaveLength(1);
      // What went out: the checked body, spending only the order with Minswap's owner cancel, the trader's signature on it.
      const sent = csl.FixedTransaction.from_hex(submitted[0]!);
      expect(sent.raw_body()).toEqual(csl.FixedTransaction.from_hex(signed[0]!).raw_body());
      const body = csl.TransactionBody.from_bytes(sent.raw_body());
      expect(body.inputs().len()).toBe(1);
      expect(body.inputs().get(0).transaction_id().to_hex()).toBe(ORDER_TX);
      expect(sent.witness_set().redeemers()!.get(0).data().to_hex()).toBe('d87a80');
      expect(sent.witness_set().vkeys()!.get(0).vkey().public_key().hash().to_hex()).toBe(trader.payment.hash);
      expect(JSON.parse(localStorage.getItem('tegridy.minswap.orders.v1') ?? '[]')[0].cancel.txHash).toBe(sent.transaction_hash().to_hex());
      await within(row).findByText(/Returned: you cancelled it, and all of it came back to your wallet, less the network fee\./, {}, { timeout: 3000 });
      expect(within(row).queryByRole('button', { name: 'Cancel order' })).toBeNull();
    });

    it('says the cancel is on its way, with no second Cancel, while the chain still shows the order open, after a reload too', async () => {
      noteOrder();
      stubOrderChain(false);
      const page = renderPage();
      await connect();
      const row = await screen.findByTestId('cardano-order');
      fireEvent.click(await within(row).findByRole('button', { name: 'Cancel order' }));
      const review = await within(row).findByTestId('cardano-cancel-review', {}, { timeout: 3000 });
      await act(async () => {
        fireEvent.click(within(review).getByRole('button', { name: 'Sign the cancel' }));
      });
      await within(row).findByText(/Cancel sent\. Your coins come back to your wallet when it lands\./, {}, { timeout: 3000 });
      expect(within(row).queryByRole('button', { name: 'Cancel order' })).toBeNull();
      page.unmount();
      renderPage();
      const again = await screen.findByTestId('cardano-order');
      await within(again).findByText(/Cancel sent\. Your coins come back to your wallet when it lands\./, {}, { timeout: 3000 });
      expect(within(again).queryByRole('button', { name: 'Cancel order' })).toBeNull();
    });

    it('is not offered on an order the chain has not shown', async () => {
      noteOrder();
      renderPage();
      await connect();
      const row = await screen.findByTestId('cardano-order');
      await within(row).findByText(/Sent\. The chain has not shown it yet\./);
      expect(within(row).queryByRole('button', { name: 'Cancel order' })).toBeNull();
    });
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
