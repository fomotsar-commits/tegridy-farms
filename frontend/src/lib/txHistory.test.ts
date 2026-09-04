import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  categorizeTx, HISTORY_CONTRACTS, parseTxRecords, parseTokenTxRows,
  explorerPageUrl, readExplorerPage, fetchAddressTxList, isTokenTxRow, type TxRecord,
} from './txHistory';
import {
  LP_FARMING_ADDRESS, TEGRIDY_ROUTER_ADDRESS, TEGRIDY_STAKING_ADDRESS,
  SWAP_FEE_ROUTER_ADDRESS, isDeployed,
} from './constants';

// Minimal valid TxRecord factory for categorize tests.
function tx(to: string, functionName = ''): TxRecord {
  return {
    hash: '0x' + 'a'.repeat(64),
    to,
    timeStamp: '1700000000',
    value: '0',
    functionName,
    isError: '0',
  };
}

describe('categorizeTx', () => {
  it('labels native SwapFeeRouter swaps as Swap', () => {
    expect(categorizeTx(tx(SWAP_FEE_ROUTER_ADDRESS, 'swapExactETHForTokens()')).type).toBe('Swap');
  });

  it('labels staking stake/withdraw/claim', () => {
    expect(categorizeTx(tx(TEGRIDY_STAKING_ADDRESS, 'stake()')).type).toBe('Stake');
    expect(categorizeTx(tx(TEGRIDY_STAKING_ADDRESS, 'withdraw()')).type).toBe('Unstake');
    expect(categorizeTx(tx(TEGRIDY_STAKING_ADDRESS, 'getReward()')).type).toBe('Claim');
  });

  it('F382: labels live LP Farming stakes/claims', () => {
    // LP Farming is live post-relaunch; guard so the test is meaningful only
    // when the address is non-zero.
    if (!isDeployed(LP_FARMING_ADDRESS)) return;
    expect(categorizeTx(tx(LP_FARMING_ADDRESS, 'stake()')).type).toBe('Stake LP');
    expect(categorizeTx(tx(LP_FARMING_ADDRESS, 'withdraw()')).type).toBe('Unstake LP');
    expect(categorizeTx(tx(LP_FARMING_ADDRESS, 'getReward()')).type).toBe('Claim');
  });

  it('F382: labels native Tegridy Router liquidity adds + swaps', () => {
    if (!isDeployed(TEGRIDY_ROUTER_ADDRESS)) return;
    expect(categorizeTx(tx(TEGRIDY_ROUTER_ADDRESS, 'addLiquidity()')).type).toBe('Liquidity');
    expect(categorizeTx(tx(TEGRIDY_ROUTER_ADDRESS, 'swapExactTokensForETH()')).type).toBe('Swap');
  });

  it('falls back to Approve for an approve to an untracked address', () => {
    expect(categorizeTx(tx('0x' + '9'.repeat(40), 'approve()')).type).toBe('Approve');
  });

  it('falls back to Other for unknown destinations', () => {
    expect(categorizeTx(tx('0x' + '9'.repeat(40), 'frobnicate()')).type).toBe('Other');
  });

  it('F478: a tx to the zero address is Other, not Restake/Grants/etc.', () => {
    // The zeroed (undeployed) contract addresses are all 0x000…0. Without the
    // isDeployed() guards, a burn / zero-send `to` collided with the first
    // zero-compare branch (Restaking) and got mislabelled.
    const zero = '0x0000000000000000000000000000000000000000';
    expect(categorizeTx(tx(zero, 'restake()')).type).toBe('Other');
    expect(categorizeTx(tx(zero, '')).type).toBe('Other');
  });
});

describe('HISTORY_CONTRACTS', () => {
  it('contains only deployed (non-zero), lowercased addresses', () => {
    expect(HISTORY_CONTRACTS.length).toBeGreaterThan(0);
    for (const a of HISTORY_CONTRACTS) {
      expect(a).toBe(a.toLowerCase());
      expect(a).not.toBe('0x0000000000000000000000000000000000000000');
    }
  });

  it('F382: includes live LP Farming + native Tegridy Router when deployed', () => {
    if (isDeployed(LP_FARMING_ADDRESS)) {
      expect(HISTORY_CONTRACTS).toContain(LP_FARMING_ADDRESS.toLowerCase());
    }
    if (isDeployed(TEGRIDY_ROUTER_ADDRESS)) {
      expect(HISTORY_CONTRACTS).toContain(TEGRIDY_ROUTER_ADDRESS.toLowerCase());
    }
  });
});

describe('parseTxRecords', () => {
  it('drops malformed rows and keeps valid ones', () => {
    const valid = {
      hash: '0x' + 'b'.repeat(64),
      to: '0x' + 'c'.repeat(40),
      timeStamp: '1700000000',
      value: '1000',
      functionName: 'stake()',
      isError: '0',
    };
    const out = parseTxRecords([valid, { hash: 'nope' }, null, 42]);
    expect(out).toHaveLength(1);
    expect(out[0]!.hash).toBe(valid.hash);
  });

  it('returns [] for non-array input', () => {
    expect(parseTxRecords(null)).toEqual([]);
    expect(parseTxRecords({})).toEqual([]);
  });
});

// ─── The explorer rail ───────────────────────────────────────────────────────
//
// Two invariants, both of which failed silently before they were pinned:
//
//   1. EMPTINESS IS A SHAPE. Etherscan reports failure inside a 200 body and
//      does not put the reason in `message`. The prose test this replaces
//      (`message === 'No transactions found'`) meant a wording change upstream
//      turned "we could not read" into a thrown error — and, in the sibling
//      implementation on /deployer, into "this address has no history": a claim
//      about somebody's wallet manufactured out of our own missing API key.
//   2. NEVER AN UNBOUNDED PAGE. Without page/offset Etherscan returns its
//      10,000-row default, ~7 MB, over the proxy's body cap, so /api/etherscan
//      answers 502 deterministically for any busy address.

const ADDRESS = '0x14898258122c0740106391e6e8e4f17f3b6d456e';

function respond(body: unknown, init: { status?: number; text?: string } = {}) {
  const status = init.status ?? 200;
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(init.text ?? JSON.stringify(body)),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('explorerPageUrl never asks the explorer for an unbounded page', () => {
  it('always sends page, offset and sort, and pins the window with endblock alone', () => {
    const url = explorerPageUrl('tokentx', ADDRESS, 3, 500, 21_000_000n);
    expect(url).toContain('action=tokentx');
    expect(url).toContain('page=3');
    expect(url).toContain('offset=500');
    expect(url).toContain('sort=desc');
    expect(url).toContain('endblock=21000000');
    // api/etherscan.js rejects a span wider than 10k blocks when BOTH bounds are
    // present, so a startblock would 400 the whole read.
    expect(url).not.toContain('startblock');
  });

  it('omits endblock when no window is pinned', () => {
    expect(explorerPageUrl('txlist', ADDRESS, 1)).not.toContain('endblock');
  });

  it('bounds the legacy throwing wrapper too — the 502 hazard is closed for its callers', async () => {
    const fetchMock = respond({ status: '1', result: [] });
    vi.stubGlobal('fetch', fetchMock);
    await fetchAddressTxList(ADDRESS, new AbortController().signal);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('page=1');
    expect(url).toContain('offset=500');
  });
});

describe('a failed read never becomes an empty history', () => {
  const cases = [
    {
      name: 'a missing API key',
      body: { status: '0', message: 'NOTOK', result: 'Missing/Invalid API Key' },
      reason: 'explorer-keyless',
    },
    {
      name: 'a throttled deployment',
      body: { status: '0', message: 'NOTOK', result: 'Max rate limit reached' },
      reason: 'explorer-rate-limited',
    },
  ] as const;

  for (const c of cases) {
    it(`classifies ${c.name} as FAILED, not as empty`, async () => {
      vi.stubGlobal('fetch', respond(c.body));
      const read = await readExplorerPage('txlist', ADDRESS, 1, new AbortController().signal);
      expect(read).toMatchObject({ kind: 'failed', reason: c.reason });
    });
  }

  it('classifies a genuine empty answer by its ARRAY result, not by its wording', async () => {
    vi.stubGlobal('fetch', respond({ status: '0', message: 'No transactions found', result: [] }));
    expect(await readExplorerPage('txlist', ADDRESS, 1, new AbortController().signal)).toEqual({ kind: 'empty' });
  });

  // MUTATION: this is the same empty envelope with different prose. The old
  // rule compared `message` to a literal sentence and threw here, so an
  // upstream re-wording read as an outage; the shape rule still reads it as the
  // empty answer it is.
  it('still reads an empty answer as empty when the upstream re-words the message', async () => {
    vi.stubGlobal('fetch', respond({ status: '0', message: 'Nothing here, sorry', result: [] }));
    expect(await readExplorerPage('txlist', ADDRESS, 1, new AbortController().signal)).toEqual({ kind: 'empty' });
  });

  it('treats the proxy own 429 and its 5xx as distinct failures, never as data', async () => {
    vi.stubGlobal('fetch', respond(null, { status: 429, text: '' }));
    expect(await readExplorerPage('txlist', ADDRESS, 1, new AbortController().signal)).toMatchObject({
      kind: 'failed',
      reason: 'proxy-rate-limited',
    });
    vi.stubGlobal('fetch', respond(null, { status: 502, text: '<html>gateway</html>' }));
    expect(await readExplorerPage('txlist', ADDRESS, 1, new AbortController().signal)).toMatchObject({
      kind: 'failed',
      reason: 'proxy-error',
    });
  });

  it('reports a full page as full, measured on the RAW rows so a dropped row cannot end the read', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      hash: `0x${String(i).padStart(64, '0')}`,
      to: `0x${'c'.repeat(40)}`,
      from: ADDRESS,
      timeStamp: '1700000000',
      value: '1',
    }));
    rows[0] = { ...rows[0]!, hash: 'malformed' };
    vi.stubGlobal('fetch', respond({ status: '1', result: rows }));
    const read = await readExplorerPage('txlist', ADDRESS, 1, new AbortController().signal);
    expect(read).toMatchObject({ kind: 'rows', full: true });
    expect(read.kind === 'rows' && read.rows).toHaveLength(499);
  });
});

describe('a token transfer row keeps its contract, and its attacker-authored fields are bounded', () => {
  const row = {
    hash: `0x${'a'.repeat(64)}`,
    from: ADDRESS,
    to: `0x${'b'.repeat(40)}`,
    contractAddress: `0x${'c'.repeat(40)}`,
    value: '1000000',
    tokenSymbol: 'X'.repeat(200),
    tokenName: 'Y'.repeat(200),
    tokenDecimal: '6',
    timeStamp: '1700000000',
    blockNumber: '21000000',
  };

  it('truncates a hostile symbol rather than DROPPING the transfer', () => {
    const [parsed] = parseTokenTxRows([row]);
    expect(parsed!.tokenSymbol).toHaveLength(64);
    expect(parsed!.contractAddress).toBe(row.contractAddress);
  });

  it('keeps a transfer whose decimals field is unreadable — that is a display fact, not a validity one', () => {
    expect(parseTokenTxRows([{ ...row, tokenDecimal: '' }])).toHaveLength(1);
  });

  it('parses by ACTION, so a token row is never silently read as a native one', async () => {
    vi.stubGlobal('fetch', respond({ status: '1', result: [row] }));
    const read = await readExplorerPage('tokentx', ADDRESS, 1, new AbortController().signal);
    expect(read.kind === 'rows' && read.rows.every(isTokenTxRow)).toBe(true);
    // The same row through the txlist parser keeps nothing that identifies the token.
    expect(parseTxRecords([row])[0]).not.toHaveProperty('contractAddress');
  });
});
