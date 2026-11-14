// The venue's own Cardano pools page, pressed through like a visitor would. As shipped (no
// deployment record) it says plainly that the pools are not open and builds nothing. With the
// batcher's test world deployed in its place, a deposit is reviewed, signed and sent, and the
// order it sends sits at OUR order script, never Minswap's; an order still open is cancelled
// from OUR order script's reference copy, never Minswap's.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../contexts/ThemeContext';
import type { PrivateKey } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from '../lib/cardano/csl';
import { composeAddress, hexToBytes, type ParsedAddress } from '../lib/cardano/address';
import { encodeDepositStep, encodeOrderDatum, MINSWAP_V2, orderAddressFor } from '../lib/cardano/minswapV2';
import { resetCardanoWalletForTests } from '../lib/cardano/walletStore';

const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../lib/cardano/csl', async (orig) => {
  const real = await orig<typeof import('../lib/cardano/csl')>();
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const wasm = createRequire(import.meta.url).resolve('@emurgo/cardano-serialization-lib-browser/cardano_serialization_lib_bg.wasm');
  const g = globalThis as { __cardanoTestCsl?: ReturnType<typeof real.loadCslFromBytes> };
  return {
    ...real,
    loadCsl: () => {
      loads.count++;
      return (g.__cardanoTestCsl ??= real.loadCslFromBytes(readFileSync(wasm)));
    },
  };
});
// The deployment as shipped (null), or the batcher's test world in its place.
const deployment = vi.hoisted(() => ({ deployed: false, refused: false }));
vi.mock('../lib/cardano/ownPools/deployment', async (orig) => {
  const real = await orig<typeof import('../lib/cardano/ownPools/deployment')>();
  const { TEST_RECORD } = await import('../lib/cardano/ownPools/testWorld.fixture');
  const world = real.readOwnPoolsDeployment(TEST_RECORD);
  return {
    ...real,
    get OWN_POOLS() {
      if (deployment.refused) return real.readOwnPoolsDeployment({ ...TEST_RECORD, orderScriptHash: 'c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c' });
      return deployment.deployed ? world : real.OWN_POOLS;
    },
  };
});
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../components/PageArtBackdrop', () => ({ PageArtBackdrop: () => null }));

import CardanoPoolsPage from './CardanoPoolsPage';
import { PLUTUS, TEST_RECORD, WORLD } from '../lib/cardano/ownPools/testWorld.fixture';
import { readOwnPoolsDeployment } from '../lib/cardano/ownPools/deployment';
import type { LpOrderNote } from '../lib/cardano/ownPools/lpWatch';
import { testCsl } from '../lib/cardano/testkit.fixture';

const PARAMS = { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310, maxTxSize: 16384, maxValueSize: 5000, stakeAddressDeposit: 2000000, stakePoolDeposit: 500000000, minFeeRefScriptCostPerByte: 15 };
const TOK_INFO = [{ policy_id: WORLD.token.policyId, asset_name: WORLD.token.assetName, asset_name_ascii: 'TOK', fingerprint: 'asset1test', token_registry_metadata: { ticker: 'TOK', name: 'Test token', decimals: 6 }, cip68_metadata: null }];

let csl: Csl;
let key: PrivateKey;
let trader: ParsedAddress;
let submitted: string[] = [];
/** What the chain answers for our pool: the world's, or a variant a test swaps in. */
let poolAnswer: () => unknown[] = () => [poolRow()];
let assetAnswer: () => unknown = () => TOK_INFO;
/** Extra coins in the stand-in wallet (LP tokens). */
let extraUtxos: () => string[] = () => [];
/** What the chain answers for one UTxO (an order's status, or a cancel's fresh read). */
let utxoAnswer: () => unknown = () => [];

/** The world's pool row, its datum's total LP supply optionally replaced. */
function poolRow(totalLiquidity?: bigint) {
  const out = csl.TransactionOutput.from_hex(WORLD.pool.outputHex);
  const ma = out.amount().multiasset()!;
  const assets = [];
  for (let i = 0; i < ma.keys().len(); i++) {
    const p = ma.keys().get(i);
    const a = ma.get(p)!;
    for (let j = 0; j < a.keys().len(); j++) assets.push({ policy_id: p.to_hex(), asset_name: Buffer.from(a.keys().get(j).name()).toString('hex'), quantity: a.get(a.keys().get(j))!.to_str() });
  }
  let datum = WORLD.pool.datumHex;
  if (totalLiquidity !== undefined) {
    const c = csl.PlutusData.from_hex(datum).as_constr_plutus_data()!;
    const fields = csl.PlutusList.new();
    for (let i = 0; i < c.data().len(); i++) fields.add(i === 3 ? csl.PlutusData.new_integer(csl.BigInt.from_str(totalLiquidity.toString())) : c.data().get(i));
    datum = csl.PlutusData.new_constr_plutus_data(csl.ConstrPlutusData.new(c.alternative(), fields)).to_hex();
  }
  return { tx_hash: WORLD.pool.txHash, tx_index: 0, address: WORLD.pool.addressBech32, value: out.amount().coin().to_str(), asset_list: assets, inline_datum: { bytes: datum } };
}

function walletUtxoHex(i: number, lovelace: bigint, tok?: bigint): string {
  const input = csl.TransactionInput.new(csl.TransactionHash.from_hex(i.toString(16).padStart(64, 'b')), i);
  const value = csl.Value.new(csl.BigNum.from_str(lovelace.toString()));
  if (tok !== undefined) {
    const ma = csl.MultiAsset.new();
    ma.set_asset(csl.ScriptHash.from_hex(WORLD.token.policyId), csl.AssetName.new(hexToBytes(WORLD.token.assetName)), csl.BigNum.from_str(tok.toString()));
    value.set_multiasset(ma);
  }
  return csl.TransactionUnspentOutput.new(input, csl.TransactionOutput.new(csl.Address.from_bytes(hexToBytes(trader.hex)), value)).to_hex();
}

function installWallet() {
  const api = {
    getNetworkId: async () => 1,
    getChangeAddress: async () => trader.hex,
    getUtxos: async () => [walletUtxoHex(1, 900_000_000n, 5_000_000_000n), walletUtxoHex(2, 40_000_000n), ...extraUtxos()],
    signTx: async (txHex: string) => {
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
        op === 'ownpool' ? poolAnswer()
        : op === 'params' ? { ...PARAMS, costModels: { PlutusV2: PLUTUS.costModelV2 }, executionUnitPrices: { priceMemory: 0.0577, priceSteps: 7.21e-5 }, collateralPercentage: 150, maxCollateralInputs: 3 }
        : op === 'asset' ? assetAnswer()
        : op === 'tip' ? [{ abs_slot: 201256000, block_height: 14108900, block_time: 1792822300 }]
        : op === 'utxo' ? utxoAnswer()
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
  loads.count = 0;
  installWallet();
  stubChain();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { cardano?: unknown }).cardano;
  localStorage.clear();
  deployment.deployed = false;
  deployment.refused = false;
  poolAnswer = () => [poolRow()];
  assetAnswer = () => TOK_INFO;
  extraUtxos = () => [];
  utxoAnswer = () => [];
});

function renderPage() {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/cardano-pools']}>
        <CardanoPoolsPage />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('CardanoPoolsPage, as shipped (no deployment)', () => {
  it('says plainly the pools are not open, and every action button says so', async () => {
    renderPage();
    expect(screen.getByTestId('cardano-pools-not-open').textContent).toMatch(/Not open yet.*not on chain yet, so nothing here can be signed/);
    expect(screen.getByText(/No positions yet/)).toBeTruthy();
    for (const tab of ['Add', 'Remove', 'Open a pool']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      const cta = screen.getByRole('button', { name: 'Pools are not open yet' });
      expect((cta as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('shows how money moves: what LPs keep, what the venue takes and its basis, and the opening fee', () => {
    renderPage();
    const money = screen.getByTestId('cardano-pools-money').textContent ?? '';
    expect(money).toMatch(/about 0\.26% of each trade/);
    expect(money).toMatch(/about 0\.04% of each trade/);
    expect(money).toMatch(/1,333 of each 10,000 of the 0\.3% fee/);
    expect(money).toMatch(/73 ADA.*to the venue’s treasury/);
  });

  it('never loads the Cardano library or reads a pool before the pools exist', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText(/The coin paired with ADA/), { target: { value: WORLD.token.policyId + WORLD.token.assetName } });
    await screen.findByText('TOK');
    fireEvent.change(screen.getByLabelText('ADA to add'), { target: { value: '10' } });
    await new Promise((r) => setTimeout(r, 400));
    expect(loads.count).toBe(0);
    const ops = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(([u]) => new URL(u, 'https://site.test').pathname);
    expect(ops.some((p) => p.includes('ownpool') || p.endsWith('/pool'))).toBe(false);
  });
});

describe('CardanoPoolsPage, with the test world deployed', () => {
  it('names the coin by ticker and whole id, quotes from our pool, and sends the deposit to OUR order script', async () => {
    deployment.deployed = true;
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Add' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a Cardano wallet' }));
    fireEvent.click(await screen.findByRole('button', { name: /Eternl/ }));
    await screen.findByTitle(trader.bech32);
    fireEvent.change(screen.getByLabelText(/The coin paired with ADA/), { target: { value: WORLD.token.policyId + WORLD.token.assetName } });
    const id = await screen.findByTestId('cardano-pools-coin');
    await within(id).findByText('TOK');
    expect(id.textContent).toContain(WORLD.token.policyId);
    fireEvent.change(screen.getByLabelText('ADA to add'), { target: { value: '10' } });
    const quote = await screen.findByTestId('cardano-pools-quote', {}, { timeout: 4000 });
    expect(quote.textContent).toMatch(/LP tokens/);
    fireEvent.click(await screen.findByRole('button', { name: 'Review deposit' }, { timeout: 4000 }));
    const review = await screen.findByTestId('cardano-pools-review', {}, { timeout: 8000 });
    expect(review.textContent).toContain(WORLD.token.policyId);
    expect(review.textContent).toMatch(/TOK/);
    fireEvent.click(within(review).getByRole('button', { name: 'Sign in wallet' }));
    await waitFor(() => expect(submitted.length).toBe(1), { timeout: 4000 });
    const order = csl.TransactionBody.from_bytes(csl.FixedTransaction.from_hex(submitted[0]!).raw_body()).outputs().get(0);
    const payment = Buffer.from(order.address().to_bytes()).toString('hex').slice(2, 58);
    expect(payment).toBe(WORLD.scripts.order.hash);
    expect(payment).not.toBe(MINSWAP_V2.orderScriptHash);
    await screen.findByTestId('cardano-pools-order');
  }, 30_000);
});

describe('CardanoPoolsPage, after review', () => {
  async function connectAndPick(tab: string) {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: tab }));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a Cardano wallet' }));
    fireEvent.click(await screen.findByRole('button', { name: /Eternl/ }));
    await screen.findByTitle(trader.bech32);
  }

  it('after the pool moved, reads it again: the new figures show, and the next press reviews', async () => {
    deployment.deployed = true;
    await connectAndPick('Add');
    fireEvent.change(screen.getByLabelText(/The coin paired with ADA/), { target: { value: WORLD.token.policyId + WORLD.token.assetName } });
    await screen.findByText('TOK');
    fireEvent.change(screen.getByLabelText('ADA to add'), { target: { value: '10' } });
    const before = (await screen.findByTestId('cardano-pools-quote', {}, { timeout: 4000 })).textContent ?? '';
    // The pool's LP supply halves before the press: the fresh quote mints half the minimum shown.
    poolAnswer = () => [poolRow(BigInt(WORLD.pool.totalLiquidity) / 2n)];
    fireEvent.click(await screen.findByRole('button', { name: 'Review deposit' }, { timeout: 4000 }));
    await screen.findByText(/The pool moved past the minimum you saw/, {}, { timeout: 8000 });
    await waitFor(() => expect(screen.getByTestId('cardano-pools-quote').textContent).not.toBe(before), { timeout: 4000 });
    fireEvent.click(await screen.findByRole('button', { name: 'Review deposit' }, { timeout: 4000 }));
    await screen.findByTestId('cardano-pools-review', {}, { timeout: 8000 });
  }, 30_000);

  it('a position whose coin could not be read shows no coin amount in the wrong units', async () => {
    deployment.deployed = true;
    assetAnswer = () => {
      throw new Error('no');
    };
    extraUtxos = () => {
      const input = csl.TransactionInput.new(csl.TransactionHash.from_hex('c'.repeat(64)), 3);
      const value = csl.Value.new(csl.BigNum.from_str('2000000'));
      const ma = csl.MultiAsset.new();
      ma.set_asset(csl.ScriptHash.from_hex(WORLD.scripts.authen.hash), csl.AssetName.new(hexToBytes(WORLD.lpName)), csl.BigNum.from_str('1000000000'));
      value.set_multiasset(ma);
      return [csl.TransactionUnspentOutput.new(input, csl.TransactionOutput.new(csl.Address.from_bytes(hexToBytes(trader.hex)), value)).to_hex()];
    };
    await connectAndPick('Your positions');
    const row = await screen.findByTestId('cardano-pools-position', {}, { timeout: 8000 });
    await waitFor(() => expect(row.textContent).toMatch(/the coin could not be read/), { timeout: 4000 });
    expect(row.textContent).not.toMatch(/units/);
    expect(row.textContent).toContain(WORLD.lpName);
  }, 30_000);

  it('a refused deployment record is said as refused, with its reason, never as "not on chain yet"', () => {
    deployment.refused = true;
    renderPage();
    const banner = screen.getByTestId('cardano-pools-not-open').textContent ?? '';
    expect(banner).toMatch(/record was refused \(it names one of Minswap’s own scripts\)/);
    expect(banner).not.toMatch(/not on chain yet/);
  });
});

describe('CardanoPoolsPage, an add order of yours still open', () => {
  const ORDER_TX = 'd1'.repeat(32);
  const dep = () => {
    const r = readOwnPoolsDeployment(TEST_RECORD);
    if (r.kind !== 'deployed') throw new Error('test record refused');
    return r.pools;
  };
  const lp = () => ({ policyId: WORLD.scripts.authen.hash, assetName: WORLD.lpName });

  function note(over: Partial<LpOrderNote> = {}): LpOrderNote {
    return {
      kind: 'deposit',
      txHash: ORDER_TX,
      orderIndex: 0,
      traderHex: trader.hex,
      traderPaymentHash: trader.payment.hash,
      token: WORLD.token,
      lp: lp(),
      tokenLabel: { ticker: 'TOK', decimals: 6 },
      amountAda: '10000000',
      amountToken: '500000000',
      lpAmount: '2000000',
      ttlSlot: 201256900,
      submitted: true,
      placedAt: Date.now(),
      ...over,
    };
  }

  /** The order at OUR order script, unspent, as Koios answers utxo_info extended. */
  function openOrder() {
    const datum = encodeOrderDatum(csl, { trader, lp: lp(), step: encodeDepositStep(csl, 10_000_000n, 500_000_000n, 2_000_000n), maxBatcherFee: 2_000_000n });
    return [
      {
        tx_hash: ORDER_TX,
        tx_index: 0,
        address: orderAddressFor(trader, dep()).bech32,
        value: '14000000',
        asset_list: [{ policy_id: WORLD.token.policyId, asset_name: WORLD.token.assetName, quantity: '500000000' }],
        inline_datum: { bytes: datum },
        is_spent: false,
      },
    ];
  }

  async function connect() {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a Cardano wallet' }));
    fireEvent.click(await screen.findByRole('button', { name: /Eternl/ }));
    await screen.findByTitle(trader.bech32);
  }

  it('offers Cancel order, says what comes back, and sends the owner’s cancel from OUR order script', async () => {
    deployment.deployed = true;
    utxoAnswer = openOrder;
    localStorage.setItem('tegridy.ownpools.orders.v1', JSON.stringify([note()]));
    await connect();
    const row = await screen.findByTestId('cardano-pools-order');
    await within(row).findByText(/Order placed/, {}, { timeout: 4000 });
    expect(row.textContent).toMatch(/Your 10 ADA and 500 TOK, the batcher fee and the 2 ADA deposit all come back to your wallet, less the network fee/);
    fireEvent.click(await within(row).findByRole('button', { name: 'Cancel order' }, { timeout: 4000 }));
    const review = await screen.findByTestId('cardano-pools-cancel-review', {}, { timeout: 8000 });
    expect(review.textContent).toMatch(/You get back\s*13\.\d+ ADA and 500 TOK/);
    expect(review.textContent).toContain(`TOK: ${WORLD.token.policyId}.${WORLD.token.assetName}`);
    expect(review.textContent).toMatch(/Batcher feeNone/);
    expect(review.textContent).toContain(trader.bech32);
    fireEvent.click(within(review).getByRole('button', { name: 'Sign the cancel' }));
    await waitFor(() => expect(submitted.length).toBe(1), { timeout: 4000 });
    const tx = csl.FixedTransaction.from_hex(submitted[0]!);
    const body = csl.TransactionBody.from_bytes(tx.raw_body());
    expect(body.inputs().get(0).transaction_id().to_hex()).toBe(ORDER_TX);
    const ref = body.reference_inputs()!.get(0);
    expect(`${ref.transaction_id().to_hex()}#${ref.index()}`).toBe(TEST_RECORD.orderRef.ref);
    expect(ref.transaction_id().to_hex()).not.toBe('cf4ecddde0d81f9ce8fcc881a85eb1f8ccdaf6807f03fea4cd02da896a621776');
    expect(tx.witness_set().redeemers()!.get(0).data().to_hex()).toBe('d87a80');
    expect(Buffer.from(body.outputs().get(0).address().to_bytes()).toString('hex')).toBe(trader.hex);
    await within(row).findByText(/Cancel sent/, {}, { timeout: 4000 });
    expect(within(row).queryByRole('button', { name: 'Cancel order' })).toBeNull();
  }, 30_000);

  it('offers no cancel while a cancel sent from here may still land', async () => {
    deployment.deployed = true;
    utxoAnswer = openOrder;
    localStorage.setItem('tegridy.ownpools.orders.v1', JSON.stringify([note({ cancel: { txHash: 'c1'.repeat(32), sentAt: Date.now(), ttlSlot: 201256900 } })]));
    await connect();
    const row = await screen.findByTestId('cardano-pools-order');
    await within(row).findByText(/Cancel sent/, {}, { timeout: 4000 });
    expect(within(row).queryByRole('button', { name: 'Cancel order' })).toBeNull();
  }, 30_000);

  it('offers no cancel on an order the chain has not shown, one already settled, or a pool opening', async () => {
    deployment.deployed = true;
    utxoAnswer = () => [];
    const filled = note({ txHash: 'd2'.repeat(32), settled: { kind: 'filled', fillTx: 'f9'.repeat(32), lp: '2236067', ada: '0', token: '0' } });
    const opening = note({ txHash: 'd3'.repeat(32), kind: 'open', totalLiquidity: '2236077' });
    localStorage.setItem('tegridy.ownpools.orders.v1', JSON.stringify([note(), filled, opening]));
    await connect();
    await waitFor(() => expect(screen.getAllByTestId('cardano-pools-order').length).toBe(3));
    await screen.findByText(/Filled:/, {}, { timeout: 4000 });
    await screen.findAllByText(/Sent. The chain has not shown it yet/, {}, { timeout: 4000 });
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
  }, 30_000);
});
