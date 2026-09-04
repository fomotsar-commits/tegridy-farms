// What the ledger will and will not say happened.
//
// Every case below is a mutation of one honest rule, and each rule is one this
// module would produce a plausible, filed, WRONG number without:
//
//   · a figure exists only when BOTH legs were read from the same transaction;
//   · a stranger cannot write a disposal into someone else's report;
//   · a half-read transaction is not classified from the half that survived;
//   · a transfer with no counter-leg is not a zero-cost buy or a zero-proceeds
//     sale, a multi-leg transaction is not split into invented trades, and a
//     reverted transaction is not a trade at all.

import { describe, it, expect } from 'vitest';
import { buildLedger, ledgerToEvents, type LedgerTruncation } from './ledger';
import { matchLots } from './lots';
import type { TokenTxRow, TxRecord } from '../txHistory';
import { REVENUE_DISTRIBUTOR_ADDRESS, TEGRIDY_STAKING_ADDRESS, WETH_ADDRESS } from '../constants';

const WALLET = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x9999999999999999999999999999999999999999';
const ROUTER = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SCAM = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const T = Math.floor(Date.UTC(2025, 5, 2, 14, 30) / 1000);
const HASH = `0x${'11'.repeat(32)}`;

function txlist(over: Partial<TxRecord> & { hash?: string } = {}): TxRecord {
  return {
    hash: HASH,
    to: ROUTER,
    from: WALLET,
    timeStamp: String(T),
    value: '0',
    functionName: 'swapExactTokensForETH()',
    isError: '0',
    gasUsed: '100000',
    gasPrice: '20000000000',
    ...over,
  };
}

function internal(over: Partial<TxRecord> = {}): TxRecord {
  return {
    hash: HASH,
    to: WALLET,
    from: ROUTER,
    timeStamp: String(T),
    value: '500000000000000000',
    functionName: '',
    isError: '0',
    ...over,
  };
}

function tokentx(over: Partial<TokenTxRow> = {}): TokenTxRow {
  return {
    hash: HASH,
    from: WALLET,
    to: ROUTER,
    contractAddress: USDC,
    value: '1000000000',
    tokenSymbol: 'USDC',
    tokenName: 'USD Coin',
    tokenDecimal: '6',
    timeStamp: String(T),
    blockNumber: '21000000',
    ...over,
  };
}

function build(over: {
  txlist?: TxRecord[];
  internal?: TxRecord[];
  tokentx?: TokenTxRow[];
  truncated?: LedgerTruncation[];
} = {}) {
  return buildLedger({
    wallet: WALLET,
    txlist: over.txlist ?? [],
    internal: over.internal ?? [],
    tokentx: over.tokentx ?? [],
    truncated: over.truncated ?? [],
  });
}

const events = (l: ReturnType<typeof build>) => ledgerToEvents(l, { quote: 'eth' });

describe('a figure exists only when both legs of the trade were read', () => {
  it('prices a sale from the ETH that came back in the SAME transaction', () => {
    const set = events(build({ txlist: [txlist()], internal: [internal()], tokentx: [tokentx()] }));
    expect(set.lotEvents).toHaveLength(1);
    expect(set.lotEvents[0]).toMatchObject({
      kind: 'dispose',
      asset: USDC,
      quantity: 1_000_000_000n,
      proceeds: 500_000_000_000_000_000n,
      proceedsSource: 'settle-leg',
      initiator: 'self',
    });
    // The ETH that arrived is the proceeds, not a second acquisition to match later.
    expect(set.lotEvents.some((e) => e.kind === 'acquire')).toBe(false);
  });

  // MUTATION: the internal list is what makes a router sale priceable at all —
  // a V2/V3 router returns its ETH as an INTERNAL transfer. Drop that list and
  // the same transaction has one leg, and the module must not fill the other in.
  // Note what it does NOT do: it does not report a disposal with null proceeds
  // either. The function name says `swap`, the counterparty is a router, and it
  // is still only ONE leg — asserting a sale happened would be a classification
  // read off a label rather than off the chain. It is listed as what was
  // actually seen, with the reason.
  it('DROP the internal leg and there is no sale at all — listed, not priced, not assumed', () => {
    const set = events(build({ txlist: [txlist()], tokentx: [tokentx()] }));
    expect(set.lotEvents).toEqual([]);
    const matched = matchLots({ events: set.lotEvents, method: 'fifo', quoteCurrency: 'ETH' });
    expect(matched.totals.proceeds).toBe(0n);
    expect(matched.disposals).toEqual([]);
    const row = set.informational.find((i) => i.category === 'transfer-out')!;
    expect(row).toBeDefined();
    expect(row.detail).toMatch(/not a sale and it is NOT given zero proceeds/i);
  });

  it('a matched buy and sell produce a real gain and a complete total', () => {
    const buy = build({
      txlist: [txlist({ hash: `0x${'22'.repeat(32)}`, functionName: 'swapExactETHForTokens()' })],
      tokentx: [
        tokentx({
          hash: `0x${'22'.repeat(32)}`,
          from: ROUTER,
          to: WALLET,
          timeStamp: String(T - 86_400),
        }),
      ],
      internal: [],
    });
    // The ETH paid out is the transaction's own value on the txlist row.
    const buySet = events(
      build({
        txlist: [
          txlist({
            hash: `0x${'22'.repeat(32)}`,
            functionName: 'swapExactETHForTokens()',
            value: '200000000000000000',
            timeStamp: String(T - 86_400),
          }),
        ],
        tokentx: [
          tokentx({ hash: `0x${'22'.repeat(32)}`, from: ROUTER, to: WALLET, timeStamp: String(T - 86_400) }),
        ],
      }),
    );
    expect(buy.txs).toHaveLength(1);
    expect(buySet.lotEvents[0]).toMatchObject({
      kind: 'acquire',
      asset: USDC,
      costBasis: 200_000_000_000_000_000n,
      costSource: 'settle-leg',
    });

    const sellSet = events(build({ txlist: [txlist()], internal: [internal()], tokentx: [tokentx()] }));
    const matched = matchLots({
      events: [...buySet.lotEvents, ...sellSet.lotEvents],
      method: 'fifo',
      quoteCurrency: 'ETH',
    });
    expect(matched.totals.complete).toBe(true);
    expect(matched.totals.realisedGain).toBe(300_000_000_000_000_000n);
    expect(matched.disposals[0]!.costBasisSource).toBe('settle-leg');
  });
});

describe('WETH is the ETH quote by contract code, and wrapping is not a trade', () => {
  it('prices a sale settled in WETH, and says WHICH quote it was', () => {
    const set = events(
      build({
        txlist: [txlist()],
        tokentx: [
          tokentx(),
          tokentx({
            contractAddress: WETH_ADDRESS.toLowerCase(),
            from: ROUTER,
            to: WALLET,
            value: '500000000000000000',
            tokenSymbol: 'WETH',
            tokenDecimal: '18',
          }),
        ],
      }),
    );
    expect(set.lotEvents[0]).toMatchObject({
      kind: 'dispose',
      proceeds: 500_000_000_000_000_000n,
      proceedsSource: 'settle-leg-weth',
    });
  });

  it('treats ETH → WETH as informational, with no lot event at all', () => {
    const set = events(
      build({
        txlist: [
          txlist({ to: WETH_ADDRESS.toLowerCase(), functionName: 'deposit()', value: '1000000000000000000' }),
        ],
        tokentx: [
          tokentx({
            contractAddress: WETH_ADDRESS.toLowerCase(),
            from: WETH_ADDRESS.toLowerCase(),
            to: WALLET,
            value: '1000000000000000000',
            tokenSymbol: 'WETH',
            tokenDecimal: '18',
          }),
        ],
      }),
    );
    expect(set.lotEvents).toEqual([]);
    expect(set.informational.filter((i) => i.category === 'wrap-unwrap')).toHaveLength(1);
  });
});

describe('a stranger cannot write a disposal into somebody else’s report', () => {
  const poisoning = {
    // No txlist row: the wallet never sent this transaction.
    tokentx: [tokentx({ contractAddress: SCAM, tokenSymbol: 'USDC', from: WALLET, to: STRANGER })],
    internal: [internal({ value: '1' })],
  };

  it('lists a third-party transaction with its legs instead of classifying it', () => {
    const set = events(build(poisoning));
    expect(set.lotEvents).toEqual([]);
    const row = set.informational.find((i) => i.category === 'third-party-tx')!;
    expect(row).toBeDefined();
    expect(row.legs).toHaveLength(2);
    expect(set.limitations.map((l) => l.code)).toContain('third-party-unclassified');
  });

  // MUTATION: the same two legs, with a txlist row proving the wallet sent it,
  // ARE a sale. Provenance is the whole difference — drop the initiator check
  // and the poisoning case above silently becomes a priced disposal of a token
  // the victim never owned.
  it('classifies the SAME two legs once the wallet is shown to have sent them', () => {
    const set = events(build({ ...poisoning, txlist: [txlist()] }));
    expect(set.lotEvents).toHaveLength(1);
    expect(set.lotEvents[0]).toMatchObject({ kind: 'dispose', asset: SCAM, initiator: 'self' });
  });

  it('classifies a third-party fill of a KNOWN token, because a stranger cannot mint one', () => {
    const set = events(
      build({
        tokentx: [tokentx({ from: WALLET, to: STRANGER })],
        internal: [internal()],
      }),
    );
    expect(set.lotEvents[0]).toMatchObject({
      kind: 'dispose',
      asset: USDC,
      proceeds: 500_000_000_000_000_000n,
      initiator: 'third-party',
    });
  });
});

describe('a half-read transaction is never classified from the half that survived', () => {
  const OLD = T - 10 * 86_400;
  const oldTx = `0x${'33'.repeat(32)}`;

  it('drops everything before the NEWEST truncation boundary and counts it', () => {
    const ledger = build({
      txlist: [txlist()],
      internal: [internal()],
      tokentx: [tokentx(), tokentx({ hash: oldTx, timeStamp: String(OLD - 1) })],
      truncated: [
        { action: 'txlistinternal', oldestRowAt: OLD },
        { action: 'txlist', oldestRowAt: OLD - 5 * 86_400 },
      ],
    });
    expect(ledger.cut).toBe(OLD);
    expect(ledger.belowCut).toBe(1);
    expect(ledger.txs.map((t) => t.hash)).toEqual([HASH]);
    const set = events(ledger);
    expect(set.informational.some((i) => i.txHash === oldTx)).toBe(false);
    expect(set.limitations.map((l) => l.code)).toContain('explorer-window-bounded');
  });

  it('classifies a transaction NEWER than the cut normally', () => {
    const ledger = build({
      txlist: [txlist()],
      internal: [internal()],
      tokentx: [tokentx()],
      truncated: [{ action: 'txlistinternal', oldestRowAt: T - 1 }],
    });
    expect(ledger.belowCut).toBe(0);
    expect(events(ledger).lotEvents).toHaveLength(1);
  });

  it('claims no cut at all when every list was read to its end', () => {
    expect(build({ txlist: [txlist()] }).cut).toBeNull();
  });
});

describe('nothing is invented for a transaction with one side missing', () => {
  it('an airdrop is a listed receipt, not a zero-cost lot', () => {
    const set = events(
      build({ tokentx: [tokentx({ contractAddress: SCAM, from: STRANGER, to: WALLET, tokenSymbol: 'FREE' })] }),
    );
    expect(set.lotEvents).toEqual([]);
    expect(set.informational.filter((i) => i.category === 'transfer-in')).toHaveLength(1);
  });

  it('a plain send is a listed transfer, not a zero-proceeds sale', () => {
    const set = events(
      build({ txlist: [txlist({ to: STRANGER, functionName: '', value: '100000000000000000' })] }),
    );
    expect(set.lotEvents).toEqual([]);
    expect(set.informational.filter((i) => i.category === 'transfer-out')).toHaveLength(1);
  });

  it('a multi-leg transaction is listed with its legs, never split into trades', () => {
    const set = events(
      build({
        txlist: [txlist({ functionName: 'addLiquidity()', value: '100000000000000000' })],
        tokentx: [
          tokentx(),
          tokentx({ contractAddress: SCAM, tokenSymbol: 'LP', from: ROUTER, to: WALLET, value: '5' }),
        ],
      }),
    );
    expect(set.lotEvents).toEqual([]);
    const row = set.informational.find((i) => i.category === 'multi-leg')!;
    expect(row.legs).toHaveLength(3);
    expect(set.limitations.map((l) => l.code)).toContain('multi-leg-unclassified');
  });

  it('a REVERTED transaction contributes a fee row and no legs', () => {
    const set = events(
      build({ txlist: [txlist({ isError: '1' })], tokentx: [tokentx()] }),
    );
    expect(set.lotEvents).toEqual([]);
    expect(set.informational).toHaveLength(1);
    expect(set.informational[0]!.label).toMatch(/Reverted/);
    expect(set.informational[0]!.detail).toMatch(/0\.002 ETH/);
  });

  it('always declares the chains it did NOT read', () => {
    expect(events(build()).limitations.map((l) => l.code)).toContain('chain-scope-eth-only');
  });

  it('declares rows it could not read at all rather than letting them vanish', () => {
    const ledger = buildLedger({
      wallet: WALLET,
      txlist: [txlist()],
      internal: [],
      tokentx: [],
      truncated: [],
      unreadRows: 3,
    });
    const limitation = ledgerToEvents(ledger, { quote: 'eth' }).limitations.find(
      (l) => l.code === 'explorer-rows-unread',
    )!;
    expect(limitation.detail).toMatch(/3 row\(s\)/);
    expect(limitation.detail).toMatch(/not zero/i);
  });
});

describe('venue income is exact when it arrives in ETH, and is never listed twice', () => {
  it('turns a revenue claim paid in ETH into ONE priced income row', () => {
    const set = events(
      build({
        txlist: [txlist({ to: REVENUE_DISTRIBUTOR_ADDRESS.toLowerCase(), functionName: 'claim()' })],
        internal: [internal()],
      }),
    );
    expect(set.income).toHaveLength(1);
    expect(set.income[0]).toMatchObject({
      kind: 'revenue-share',
      value: 500_000_000_000_000_000n,
      valueSource: 'settle-leg',
      source: 'explorer',
    });
    // The receipt is consumed: it must not ALSO appear as an unexplained inflow.
    expect(set.informational.some((i) => i.category === 'transfer-in')).toBe(false);
  });

  it('reports a token reward as a quantity with NO value rather than guessing one', () => {
    const set = events(
      build({
        txlist: [txlist({ to: TEGRIDY_STAKING_ADDRESS.toLowerCase(), functionName: 'getReward()' })],
        tokentx: [
          tokentx({
            contractAddress: SCAM,
            tokenSymbol: 'TOWELI',
            from: TEGRIDY_STAKING_ADDRESS.toLowerCase(),
            to: WALLET,
            tokenDecimal: '18',
          }),
        ],
      }),
    );
    expect(set.income).toHaveLength(1);
    expect(set.income[0]!.value).toBeNull();
    expect(set.income[0]!.kind).toBe('staking-reward');
  });
});

describe('symbols are labels; the address is the identity', () => {
  it('prefers the venue’s own token list over what a contract claims', () => {
    const set = events(
      build({ tokentx: [tokentx({ tokenSymbol: 'NOT-USDC', from: STRANGER, to: WALLET })] }),
    );
    expect(set.informational[0]!.legs![0]).toMatchObject({ asset: USDC, symbol: 'USDC' });
  });

  it('accepts a ticker-shaped claim from an unknown contract, keyed on the address', () => {
    const set = events(
      build({ tokentx: [tokentx({ contractAddress: SCAM, tokenSymbol: 'USDC', from: STRANGER, to: WALLET })] }),
    );
    // It says "USDC" and it is NOT USDC — which is exactly why the asset column
    // is the contract address everywhere a figure is derived from it.
    expect(set.informational[0]!.legs![0]).toMatchObject({ asset: SCAM, symbol: 'USDC' });
  });

  it('REFUSES a symbol that is a formula and falls back to the address label', () => {
    const set = events(
      build({
        tokentx: [
          tokentx({
            contractAddress: SCAM,
            tokenSymbol: '=HYPERLINK("http://evil")',
            from: STRANGER,
            to: WALLET,
          }),
        ],
      }),
    );
    expect(set.informational[0]!.legs![0]!.symbol).toBe('0xdead…beef');
  });

  it('treats an unreadable decimals field as unknown rather than dropping the transfer', () => {
    const set = events(
      build({
        tokentx: [tokentx({ contractAddress: SCAM, tokenSymbol: 'ODD', tokenDecimal: '', from: STRANGER, to: WALLET })],
      }),
    );
    expect(set.informational[0]!.legs![0]).toMatchObject({ decimals: null });
  });
});
