// The swap transaction: built with the real library, then every way a transaction could pay
// someone else is tried against the check. Each tamper is a separate test, so a check that
// stops catching one fails by name.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Csl } from './csl';
import type { ProtocolParams } from './chain';
import { bytesToHex, composeAddress, hexToBytes, type ParsedAddress } from './address';
import { ADA, lpAsset, orderAddressFor, type PoolState } from './minswapV2';
import { venueFeeFor } from './venueFee';
import {
  MAX_NETWORK_FEE,
  TTL_SLOTS,
  SwapBuildError,
  assembleSigned,
  buildSwapTx,
  checkSwapTx,
  minAdaForPayment,
  parseWalletUtxos,
  type SwapPlan,
  type WalletUtxo,
} from './swapTx';
import { ASCEND, testCsl } from './testkit.fixture';

/** Mainnet's parameters as Koios read them on 2026-10-24 (cli_protocol_params). */
const PARAMS: ProtocolParams = {
  txFeePerByte: 44n,
  txFeeFixed: 155381n,
  utxoCostPerByte: 4310n,
  maxTxSize: 16384,
  maxValueSize: 5000,
  stakeAddressDeposit: 2000000n,
  stakePoolDeposit: 500000000n,
  minFeeRefScriptCostPerByte: 15,
};

const TIP = 201_255_884;
const ADA_1 = 1_000_000n;

let csl: Csl;
let key: InstanceType<Csl['PrivateKey']>;
let trader: ParsedAddress;
let venue: ParsedAddress;
let stranger: ParsedAddress;
let wallet: WalletUtxo[];

const POOL: PoolState = {
  ref: { txHash: '11'.repeat(32), index: 0 },
  assetA: ADA,
  assetB: ASCEND,
  lp: lpAsset(ADA, ASCEND),
  reserveA: 1019463084218n,
  reserveB: 945869519487n,
  totalLiquidity: 807036682412n,
  feeANumerator: 100n,
  feeBNumerator: 100n,
  feeSharingNumerator: 1666n,
  allowDynamicFee: false,
};

type Body = InstanceType<Csl['TransactionBody']>;
type Out = InstanceType<Csl['TransactionOutput']>;
type In = InstanceType<Csl['TransactionInput']>;

function addrOf(a: ParsedAddress) {
  return csl.Address.from_bytes(hexToBytes(a.hex));
}

function lovelace(n: bigint) {
  return csl.Value.new(csl.BigNum.from_str(n.toString()));
}

function utxo(i: number, to: ParsedAddress, ada: bigint, tokens: bigint = 0n): WalletUtxo {
  const value = lovelace(ada);
  if (tokens > 0n) {
    const ma = csl.MultiAsset.new();
    ma.set_asset(csl.ScriptHash.from_hex(ASCEND.policyId), csl.AssetName.new(hexToBytes(ASCEND.assetName)), csl.BigNum.from_str(tokens.toString()));
    value.set_multiasset(ma);
  }
  const input = csl.TransactionInput.new(csl.TransactionHash.from_hex(i.toString(16).padStart(64, 'a')), i);
  const u = csl.TransactionUnspentOutput.new(input, csl.TransactionOutput.new(addrOf(to), value));
  return { txHash: input.transaction_id().to_hex(), index: i, hex: u.to_hex() };
}

beforeAll(async () => {
  csl = await testCsl();
  key = csl.PrivateKey.generate_ed25519();
  const stake = { kind: 'key' as const, hash: '73d3e74cbd4539a7ec925ef8ad057d945e3668021cf4f3e877d24d4d' };
  trader = composeAddress({ kind: 'key', hash: key.to_public().hash().to_hex() }, stake);
  venue = composeAddress({ kind: 'key', hash: '9c'.repeat(28) }, { kind: 'key', hash: '93'.repeat(28) });
  stranger = composeAddress({ kind: 'key', hash: 'ee'.repeat(28) }, { kind: 'key', hash: 'ef'.repeat(28) });
  wallet = [utxo(1, trader, 600n * ADA_1), utxo(2, trader, 3n * ADA_1, 500_000_000n), utxo(3, trader, 50n * ADA_1)];
});

function adaInPlan(overrides: Partial<SwapPlan> = {}): SwapPlan {
  const minOut = minAdaForPayment(csl, PARAMS, venue);
  return {
    trader,
    pool: POOL,
    assetIn: ADA,
    swapAmount: 400n * ADA_1,
    minimumReceive: 360_000_000n,
    venueFee: venueFeeFor(400n * ADA_1, minOut, { address: venue, bps: 50 }),
    tipSlot: TIP,
    ...overrides,
  };
}

/**
 * Rebuilds the transaction from a changed body. CSL hands back COPIES of a body's lists, so an
 * edit to body.outputs() never reaches the body: every tamper here builds a new one, and
 * expectRefused first proves the tampered bytes differ from the original.
 */
function rebuild(
  txHex: string,
  edit: { outputs?: (outs: Out[]) => Out[]; inputs?: (ins: In[]) => In[]; fee?: bigint; ttl?: bigint; also?: (b: Body) => void },
): string {
  const tx = csl.FixedTransaction.from_hex(txHex);
  const old = csl.TransactionBody.from_bytes(tx.raw_body());
  const ins: In[] = [];
  for (let i = 0; i < old.inputs().len(); i++) ins.push(old.inputs().get(i));
  const outs: Out[] = [];
  for (let i = 0; i < old.outputs().len(); i++) outs.push(old.outputs().get(i));
  const newIns = csl.TransactionInputs.new();
  for (const i of edit.inputs ? edit.inputs(ins) : ins) newIns.add(i);
  const newOuts = csl.TransactionOutputs.new();
  for (const o of edit.outputs ? edit.outputs(outs) : outs) newOuts.add(o);
  const body = csl.TransactionBody.new_tx_body(newIns, newOuts, edit.fee === undefined ? old.fee() : csl.BigNum.from_str(edit.fee.toString()));
  body.set_ttl(edit.ttl === undefined ? old.ttl_bignum()! : csl.BigNum.from_str(edit.ttl.toString()));
  edit.also?.(body);
  return csl.FixedTransaction.new(body.to_bytes(), tx.raw_witness_set(), true).to_hex();
}

/** A copy of `old` paying `to`, keeping its value and its datum. */
function redirect(old: Out, to: ParsedAddress): Out {
  const o = csl.TransactionOutput.new(addrOf(to), old.amount());
  const d = old.plutus_data();
  if (d) o.set_plutus_data(d);
  return o;
}

function bodyOf(txHex: string) {
  return csl.TransactionBody.from_bytes(csl.FixedTransaction.from_hex(txHex).raw_body());
}

let original = '';

function expectRefused(txHex: string, plan: SwapPlan, problem: RegExp) {
  expect(txHex).not.toBe(original);
  const r = checkSwapTx(csl, txHex, plan, wallet);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.problems.join(' | ')).toMatch(problem);
}

describe('buildSwapTx + checkSwapTx: the untampered build', () => {
  it('builds ADA → token with the venue fee, and the check passes with what you pay', () => {
    const plan = adaInPlan();
    expect(plan.venueFee.kind).toBe('charged');
    const built = buildSwapTx(csl, PARAMS, wallet, plan);
    const r = checkSwapTx(csl, built.txHex, plan, wallet);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.swap.txHash).toBe(built.txHash);
    expect(r.swap.orderLovelace).toBe(404n * ADA_1);
    expect(r.swap.venueFeeLovelace).toBe(2n * ADA_1); // 0.5% of 400 ADA
    expect(r.swap.networkFee).toBeGreaterThan(0n);
    expect(r.swap.networkFee).toBeLessThan(MAX_NETWORK_FEE);
    // All in: the order, the fee and the network fee, nothing else.
    expect(r.swap.paidLovelace).toBe(r.swap.orderLovelace + r.swap.venueFeeLovelace + r.swap.networkFee);
    const body = bodyOf(built.txHex);
    expect(bytesToHex(body.outputs().get(0).address().to_bytes())).toBe(orderAddressFor(trader).hex);
    expect(bytesToHex(body.outputs().get(1).address().to_bytes())).toBe(venue.hex);
    expect(Number(body.ttl_bignum()!.to_str())).toBe(TIP + TTL_SLOTS);
  });

  it('builds token → ADA with no fee line when no fee is charged', () => {
    const plan = adaInPlan({ assetIn: ASCEND, swapAmount: 100_000_000n, minimumReceive: 50_000_000n, venueFee: { kind: 'none', reason: 'no-address' } });
    const built = buildSwapTx(csl, PARAMS, wallet, plan);
    const r = checkSwapTx(csl, built.txHex, plan, wallet);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.swap.venueFeeLovelace).toBe(0n);
    expect(r.swap.paidToken).toEqual({ asset: ASCEND, quantity: 100_000_000n });
    // Only the order and the change: no output to any fee address.
    const outs = bodyOf(built.txHex).outputs();
    for (let i = 1; i < outs.len(); i++) expect(bytesToHex(outs.get(i).address().to_bytes())).toBe(trader.hex);
  });

  it('refuses to build past what the wallet holds', () => {
    expect(() => buildSwapTx(csl, PARAMS, wallet, adaInPlan({ swapAmount: 5_000n * ADA_1 }))).toThrow(SwapBuildError);
  });

  it('reads the wallet’s UTxOs whole, or not at all', () => {
    expect(parseWalletUtxos(csl, wallet.map((u) => u.hex))).toHaveLength(3);
    expect(parseWalletUtxos(csl, [...wallet.map((u) => u.hex), 'zz'])).toBeNull();
    expect(parseWalletUtxos(csl, 'not a list')).toBeNull();
  });
});

describe('checkSwapTx refuses every tamper', () => {
  let plan: SwapPlan;
  let txHex: string;
  let last: number;
  beforeAll(() => {
    plan = adaInPlan();
    txHex = buildSwapTx(csl, PARAMS, wallet, plan).txHex;
    original = txHex;
    last = bodyOf(txHex).outputs().len() - 1;
    expect(checkSwapTx(csl, txHex, plan, wallet).ok).toBe(true);
    // The rebuild itself changes nothing: an untouched rebuild still passes.
    expect(checkSwapTx(csl, rebuild(txHex, {}), plan, wallet).ok).toBe(true);
  });

  it('an extra output to a stranger', () => {
    const bad = rebuild(txHex, { outputs: (o) => [...o, csl.TransactionOutput.new(addrOf(stranger), lovelace(ADA_1))] });
    expectRefused(bad, plan, /not yours/);
  });

  it('change paid to your payment key with someone else’s stake part', () => {
    const lookalike = composeAddress(trader.payment, { kind: 'key', hash: 'ef'.repeat(28) });
    const bad = rebuild(txHex, { outputs: (o) => o.map((x, i) => (i === last ? redirect(x, lookalike) : x)) });
    expectRefused(bad, plan, /not yours/);
  });

  it('the order sent with another stake part', () => {
    const other = composeAddress(orderAddressFor(trader).payment, { kind: 'key', hash: 'ef'.repeat(28) });
    const bad = rebuild(txHex, { outputs: (o) => o.map((x, i) => (i === 0 ? redirect(x, other) : x)) });
    expectRefused(bad, plan, /order is not addressed/);
  });

  it('the order’s terms rewritten (a lower minimum)', () => {
    const bad = buildSwapTx(csl, PARAMS, wallet, adaInPlan({ minimumReceive: 1n })).txHex;
    expectRefused(bad, plan, /order’s terms/);
  });

  it('the order paying out to a stranger', () => {
    const bad = buildSwapTx(csl, PARAMS, wallet, adaInPlan({ trader: stranger })).txHex;
    expectRefused(bad, plan, /order is not addressed/);
  });

  it('the order locking a different amount', () => {
    const bad = rebuild(txHex, {
      outputs: (o) =>
        o.map((x, i) => {
          if (i !== 0) return x;
          const y = csl.TransactionOutput.new(x.address(), lovelace(3n * ADA_1));
          y.set_plutus_data(x.plutus_data()!);
          return y;
        }),
    });
    expectRefused(bad, plan, /locks a different amount/);
  });

  it('the venue fee paid to another address', () => {
    const bad = rebuild(txHex, { outputs: (o) => o.map((x, i) => (i === 1 ? redirect(x, stranger) : x)) });
    expectRefused(bad, plan, /registered address/);
  });

  it('the venue fee at a different amount', () => {
    const bad = rebuild(txHex, { outputs: (o) => o.map((x, i) => (i === 1 ? csl.TransactionOutput.new(x.address(), lovelace(9n * ADA_1)) : x)) });
    expectRefused(bad, plan, /not the stated amount/);
  });

  it('the venue fee line dropped', () => {
    const bad = rebuild(txHex, { outputs: (o) => o.filter((_, i) => i !== 1) });
    expectRefused(bad, plan, /registered address|not the stated amount/);
  });

  it('a stake delegation certificate', () => {
    const bad = rebuild(txHex, {
      also: (b) => {
        const certs = csl.Certificates.new();
        certs.add(
          csl.Certificate.new_stake_delegation(
            csl.StakeDelegation.new(csl.Credential.from_keyhash(csl.Ed25519KeyHash.from_hex(trader.stake!.hash)), csl.Ed25519KeyHash.from_hex('ab'.repeat(28))),
          ),
        );
        b.set_certs(certs);
      },
    });
    expectRefused(bad, plan, /certificate/);
  });

  it('a reward withdrawal', () => {
    const bad = rebuild(txHex, {
      also: (b) => {
        const w = csl.Withdrawals.new();
        w.insert(csl.RewardAddress.new(1, csl.Credential.from_keyhash(csl.Ed25519KeyHash.from_hex(trader.stake!.hash))), csl.BigNum.from_str('5000000'));
        b.set_withdrawals(w);
      },
    });
    expectRefused(bad, plan, /withdraws rewards/);
  });

  it('a required signer', () => {
    const bad = rebuild(txHex, {
      also: (b) => {
        const k = csl.Ed25519KeyHashes.new();
        k.add(csl.Ed25519KeyHash.from_hex('ab'.repeat(28)));
        b.set_required_signers(k);
      },
    });
    expectRefused(bad, plan, /extra signers/);
  });

  it('an input that is not the wallet’s', () => {
    const bad = rebuild(txHex, { inputs: (i) => [...i, csl.TransactionInput.new(csl.TransactionHash.from_hex('cd'.repeat(32)), 7)] });
    expectRefused(bad, plan, /not in this wallet/);
  });

  it('a network fee above 1 ADA, balanced by taking it from the change', () => {
    const fee = BigInt(bodyOf(txHex).fee().to_str()) + 2n * ADA_1;
    const bad = rebuild(txHex, {
      fee,
      outputs: (o) =>
        o.map((x, i) => {
          if (i !== last) return x;
          const v = x.amount();
          v.set_coin(csl.BigNum.from_str((BigInt(v.coin().to_str()) - 2n * ADA_1).toString()));
          return csl.TransactionOutput.new(x.address(), v);
        }),
    });
    expectRefused(bad, plan, /network fee is above 1 ADA/);
    const r = checkSwapTx(csl, bad, plan, wallet);
    if (!r.ok) expect(r.problems.join(' | ')).not.toMatch(/add up/);
  });

  it('a different expiry', () => {
    expectRefused(rebuild(txHex, { ttl: BigInt(TIP + TTL_SLOTS + 86_400) }), plan, /expiry/);
  });

  it('an unbalanced transaction', () => {
    const bad = rebuild(txHex, { outputs: (o) => o.map((x, i) => (i === last ? csl.TransactionOutput.new(x.address(), lovelace(ADA_1)) : x)) });
    expectRefused(bad, plan, /add up/);
  });

  it('metadata', () => {
    const tx = csl.FixedTransaction.from_hex(txHex);
    const aux = csl.AuxiliaryData.new();
    const md = csl.GeneralTransactionMetadata.new();
    md.insert(csl.BigNum.from_str('674'), csl.TransactionMetadatum.new_text('hi'));
    aux.set_metadata(md);
    const bad = csl.FixedTransaction.new_with_auxiliary(tx.raw_body(), tx.raw_witness_set(), aux.to_bytes(), true).to_hex();
    expectRefused(bad, plan, /metadata/);
  });

  it('a transaction that arrives pre-signed', () => {
    const tx = csl.FixedTransaction.from_hex(txHex);
    tx.add_vkey_witness(csl.make_vkey_witness(tx.transaction_hash(), key));
    expectRefused(tx.to_hex(), plan, /already signed/);
  });
});

describe('assembleSigned', () => {
  function witnessFor(txHash: string) {
    const ws = csl.TransactionWitnessSet.new();
    const keys = csl.Vkeywitnesses.new();
    keys.add(csl.make_vkey_witness(csl.TransactionHash.from_hex(txHash), key));
    ws.set_vkeys(keys);
    return ws;
  }

  it('puts the wallet’s signature on the checked bytes, and nothing else', () => {
    const built = buildSwapTx(csl, PARAMS, wallet, adaInPlan());
    const r = assembleSigned(csl, built.txHex, witnessFor(built.txHash).to_hex(), built.txHash);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.txHash).toBe(built.txHash);
      expect(csl.FixedTransaction.from_hex(r.signedHex).raw_body()).toEqual(csl.FixedTransaction.from_hex(built.txHex).raw_body());
    }
  });

  it('refuses an empty answer', () => {
    const built = buildSwapTx(csl, PARAMS, wallet, adaInPlan());
    expect(assembleSigned(csl, built.txHex, csl.TransactionWitnessSet.new().to_hex(), built.txHash)).toEqual({ ok: false, reason: 'The wallet did not sign.' });
  });

  it('refuses a witness set carrying more than signatures', () => {
    const built = buildSwapTx(csl, PARAMS, wallet, adaInPlan());
    const ws = witnessFor(built.txHash);
    const data = csl.PlutusList.new();
    data.add(csl.PlutusData.new_integer(csl.BigInt.from_str('1')));
    ws.set_plutus_data(data);
    expect(assembleSigned(csl, built.txHex, ws.to_hex(), built.txHash).ok).toBe(false);
  });

  it('refuses when the body is not the one that was checked', () => {
    const built = buildSwapTx(csl, PARAMS, wallet, adaInPlan());
    expect(assembleSigned(csl, built.txHex, witnessFor(built.txHash).to_hex(), 'ab'.repeat(32)).ok).toBe(false);
  });
});
