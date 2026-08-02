import { describe, it, expect, vi, afterEach } from 'vitest';
import { analyzeDistribution } from '../detection';
import {
  detectChain,
  isValidTokenAddress,
  buildCoverageNotes,
  scanToken,
  ScanError,
  type AdapterResult,
} from './index';
import { fetchSolanaScan, parseSolanaScan, type SolanaScanRaw } from './solanaAdapter';
import { fetchEthereumScan, parseEthereumScan } from './ethereumAdapter';

// These tests drive the REAL data-adapter parsers and the REAL detection core end
// to end on synthetic on-chain payloads — the closest runtime surface to the live
// scan pipeline that runs without a network. They pin invariants (owner grouping,
// program-owned exclusion, the mint-authority gate, honest coverage disclosure),
// not brittle literals.

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

describe('detectChain', () => {
  it('recognizes an EVM address', () => {
    const d = detectChain('0x420698CFdEDdEa6bc78D59bC17798113ad278F9D');
    expect(d.chain).toBe('ethereum');
    expect(d.valid).toBe(true);
  });
  it('recognizes a Solana mint (base58, 32-44)', () => {
    const d = detectChain('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(d.chain).toBe('solana');
    expect(d.valid).toBe(true);
  });
  it('rejects garbage and short strings', () => {
    expect(detectChain('0x123').valid).toBe(false);
    expect(detectChain('not-an-address').valid).toBe(false);
    expect(isValidTokenAddress('')).toBe(false);
  });
});

describe('parseSolanaScan → detection core', () => {
  // 3 token accounts: two owned by the same wallet (must GROUP), one owned by a
  // program vault (must be EXCLUDED). Mint authority present ⇒ gate floors the band.
  const raw: SolanaScanRaw = {
    mint: 'MintMintMintMintMintMintMintMintMintMint111',
    supply: { value: { amount: '300', decimals: 0 } },
    mintInfo: { value: { data: { parsed: { info: { mintAuthority: 'AuthAuthAuth', freezeAuthority: null } } } } },
    largest: {
      value: [
        { address: 'TokAcctA', amount: '100' },
        { address: 'TokAcctB', amount: '100' },
        { address: 'TokAcctVault', amount: '100' },
      ],
    },
    tokenAccounts: {
      value: [
        { data: { parsed: { info: { owner: 'WalletW1' } } } },
        { data: { parsed: { info: { owner: 'WalletW1' } } } },
        { data: { parsed: { info: { owner: 'VaultOwner' } } } },
      ],
    },
    ownerAccounts: {
      value: [
        { owner: SYSTEM_PROGRAM }, // WalletW1 → real wallet
        { owner: SYSTEM_PROGRAM }, // WalletW1 → real wallet
        { owner: 'SomeDexProgram1111111111111111111111111111' }, // program-owned vault
      ],
    },
  };

  it('resolves owners, groups ATAs, and reads mint/freeze authority', () => {
    const result = parseSolanaScan(raw);
    expect(result.input.chain).toBe('solana');
    expect(result.input.totalSupply).toBe(300n);
    expect(result.token.decimals).toBe(0);
    expect(result.holderCoverage).toBe('top-n');
    // two ATAs under WalletW1 collapse to one holder; the vault is the second → 2 total
    expect(result.enumeratedHolders).toBe(2);
    expect(result.input.hardFacts?.mintAuthorityLive).toBe(true);
    expect(result.input.hardFacts?.freezeAuthorityLive).toBe(false);
  });

  it('excludes the program-owned vault and lets the mint-authority gate floor the band', () => {
    const result = parseSolanaScan(raw);
    const analysis = analyzeDistribution(result.input);
    // vault excluded → only WalletW1 counts as a person-held holder
    expect(analysis.holderCounts.included).toBe(1);
    expect(analysis.holderCounts.excluded).toBe(1);
    const mintFinding = analysis.gate.findings.find((f) => f.id === 'mint-authority-live');
    expect(mintFinding?.fired).toBe(true);
    expect(analysis.band).toBe('concentrated'); // mintLiveFloor
  });

  it('reports a genuinely absent supply as not-found', () => {
    // `value: null` is the node answering "there is nothing token-like here". That
    // IS a finding about the address, and must survive the hardening below.
    const err = scanErrorFrom(() => parseSolanaScan({ ...raw, supply: { value: null } }));
    expect(err.code).toBe('not-found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS BLOCK EXISTS FOR
//
// Every read has three outcomes and only two are answers: (a) read it, the answer
// is no; (b) read it, the answer is yes; (c) COULD NOT READ IT. The adapter used to
// collapse (c) into (a) — `supply?.value?.amount` missing became "is it a valid
// mint?", `largest?.value ?? []` became an empty holder set that the core reads as
// "no concentrated holders", and a mint account without parsed authority fields
// became `mintAuthorityLive: false`, i.e. "renounced".
//
// A failed read routes to ScanError('network'), which the page renders as "Couldn't
// complete the scan" + retry. It must NEVER route to 'not-found'/'empty', which
// render "No holder data for this token — double-check the address is a token".
// ─────────────────────────────────────────────────────────────────────────────

/** Capture the thrown ScanError, or fail loudly if nothing was thrown. */
function scanErrorFrom(fn: () => unknown): ScanError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ScanError) return e;
    throw e;
  }
  throw new Error('expected a ScanError, but the call returned normally');
}

async function asyncScanErrorFrom(fn: () => Promise<unknown>): Promise<ScanError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ScanError) return e;
    throw e;
  }
  throw new Error('expected a ScanError, but the call resolved');
}

describe('parseSolanaScan — a non-answer is never an answer', () => {
  const ok: SolanaScanRaw = {
    mint: 'MintMintMintMintMintMintMintMintMintMint111',
    supply: { value: { amount: '300', decimals: 0 } },
    mintInfo: { value: { data: { parsed: { info: { mintAuthority: 'AuthAuthAuth', freezeAuthority: null } } } } },
    largest: {
      value: [
        { address: 'TokAcctA', amount: '100' },
        { address: 'TokAcctB', amount: '100' },
        { address: 'TokAcctVault', amount: '100' },
      ],
    },
    tokenAccounts: {
      value: [
        { data: { parsed: { info: { owner: 'WalletW1' } } } },
        { data: { parsed: { info: { owner: 'WalletW1' } } } },
        { data: { parsed: { info: { owner: 'VaultOwner' } } } },
      ],
    },
    ownerAccounts: {
      value: [
        { owner: SYSTEM_PROGRAM },
        { owner: SYSTEM_PROGRAM },
        { owner: 'SomeDexProgram1111111111111111111111111111' },
      ],
    },
  };

  describe('supply', () => {
    it('does NOT report a malformed payload as "is it a valid mint?"', () => {
      // ⚠ THE ORIGINAL BUG. A 200 carrying no `value` used to produce a `not-found`,
      // which the page renders as a verdict about someone else's address.
      const err = scanErrorFrom(() => parseSolanaScan({ ...ok, supply: { context: { slot: 1 } } }));
      expect(err.code).toBe('network');
      expect(err.code).not.toBe('not-found');
      expect(err.message).toMatch(/no `value`/);
    });

    it('treats a call that never answered as unreadable, not as an absent mint', () => {
      const err = scanErrorFrom(() => parseSolanaScan({ ...ok, supply: undefined }));
      expect(err.code).toBe('network');
    });

    it('rejects a supply whose shape drifted rather than reading "no supply" from it', () => {
      const err = scanErrorFrom(() => parseSolanaScan({ ...ok, supply: { value: { decimals: 0 } } }));
      expect(err.code).toBe('network');
      expect(err.message).toMatch(/no `amount`/);
    });

    it('refuses an unreadable supply AMOUNT rather than publishing a verdict built on it', () => {
      // ⚠ THE WORST CASE, because it does not fail — it SUCCEEDS and renders a report.
      // safeBig('') is 0n (BigInt('') does not even throw), and the detection core reads a
      // zero total as "no total known", substituting the enumerated top-20 sum as the
      // denominator (detection/exclusions.ts). Measured on this exact fixture: top-holder
      // share went from 0.0001 to 0.667 and the `single-holder-majority` gate FIRED —
      // a published red flag about someone's token, computed from an empty string.
      for (const amount of ['', 'abc', '1.5']) {
        const err = scanErrorFrom(() => parseSolanaScan({ ...ok, supply: { value: { amount, decimals: 0 } } }));
        expect(err.code).toBe('network');
        expect(err.message).toMatch(/integer base-unit amount/);
      }
    });

    it('never returns a scan whose totalSupply was not actually read', () => {
      // The invariant behind the case above, stated without reference to a message: if a
      // scan comes back at all, its denominator came off the wire.
      const r = parseSolanaScan(ok);
      expect(r.input.totalSupply).toBe(300n);
      expect(r.input.totalSupply).not.toBe(0n);
    });

    it('keeps an explicit null value as the real answer it is', () => {
      expect(scanErrorFrom(() => parseSolanaScan({ ...ok, supply: { value: null } })).code).toBe('not-found');
    });
  });

  describe('hard facts — the flattering direction to be wrong in', () => {
    it('refuses a mint account with no parsed authority fields instead of reading "renounced"', () => {
      // ⚠ THE WORST OF THE SET. `mintParsed?.mintAuthority != null` evaluated to
      // `false` here — "authority renounced" — and a live mint authority is exactly
      // what floors the verdict at `concentrated`. Drift silently REMOVED the floor.
      const err = scanErrorFrom(() =>
        parseSolanaScan({ ...ok, mintInfo: { value: { data: ['base64blob', 'base64'] } } }),
      );
      expect(err.code).toBe('network');
      expect(err.message).toMatch(/parsed authority fields/);
    });

    it('never lets an unreadable mint account produce an un-floored verdict', () => {
      // The consequence, stated as the invariant rather than as a message match:
      // there is no payload here that yields a scan whose band was NOT floored.
      const drifted = { ...ok, mintInfo: { value: { data: { parsed: {} } } } };
      const err = scanErrorFrom(() => parseSolanaScan(drifted));
      expect(err.code).toBe('network');
    });

    it('leaves both facts unknown when the mint account is genuinely absent', () => {
      const r = parseSolanaScan({ ...ok, mintInfo: { value: null } });
      expect(r.input.hardFacts).toEqual({});
      // Unknown never fires the gate — an absent fact is not a red flag.
      expect(analyzeDistribution(r.input).gate.findings.find((f) => f.id === 'mint-authority-live')?.fired).toBe(false);
    });

    it('treats a missing `value` member on the mint read as unreadable', () => {
      expect(scanErrorFrom(() => parseSolanaScan({ ...ok, mintInfo: { context: { slot: 1 } } })).code).toBe('network');
      expect(scanErrorFrom(() => parseSolanaScan({ ...ok, mintInfo: undefined })).code).toBe('network');
    });
  });

  describe('holders', () => {
    it('does NOT turn a missing `value` into an empty holder set', () => {
      // `?? []` made a failed read indistinguishable from a token nobody holds —
      // which the core reads as "no concentrated holders", a clean bill of health.
      const err = scanErrorFrom(() => parseSolanaScan({ ...ok, largest: { context: { slot: 1 } } }));
      expect(err.code).toBe('network');
      expect(err.message).toMatch(/no `value`/);
    });

    it('keeps a genuinely empty holder set as a real answer', () => {
      const r = parseSolanaScan({ ...ok, largest: { value: [] }, tokenAccounts: undefined, ownerAccounts: undefined });
      expect(r.enumeratedHolders).toBe(0);
      expect(r.input.holders).toEqual([]);
    });

    it('refuses to resolve owners when the owner-resolution batch did not answer', () => {
      // `tokenAccts[i]` defaulting to `[]` made every ATA its own holder, so a whale
      // split across three ATAs read as three independent holders — concentration
      // understated by a failed read.
      expect(scanErrorFrom(() => parseSolanaScan({ ...ok, tokenAccounts: undefined })).code).toBe('network');
      expect(scanErrorFrom(() => parseSolanaScan({ ...ok, tokenAccounts: { context: {} } })).code).toBe('network');
    });

    it('refuses to classify owners when the classification batch did not answer', () => {
      // `ownerAccts[i]` defaulting to `[]` left every program-owned vault labelled as
      // a person — the excluded-vault logic silently switched itself off.
      expect(scanErrorFrom(() => parseSolanaScan({ ...ok, ownerAccounts: undefined })).code).toBe('network');
    });

    it('rejects a short follow-up array rather than mis-aligning owners against holders', () => {
      const err = scanErrorFrom(() =>
        parseSolanaScan({ ...ok, ownerAccounts: { value: [{ owner: SYSTEM_PROGRAM }] } }),
      );
      expect(err.code).toBe('network');
      expect(err.message).toMatch(/expected 3/);
    });

    it('rejects an unreadable holder amount instead of silently dropping the row', () => {
      // safeBig's `catch { return 0n }` made a drifted amount a zero balance, the row was
      // skipped, and a whole top-20 of drifted rows landed on ScanError('empty') ->
      // "No holder data for this token" — a claim about the token, from unread bytes.
      const err = scanErrorFrom(() =>
        parseSolanaScan({
          ...ok,
          largest: { value: [{ address: 'TokAcctA', amount: '1.5e5' }, { address: 'TokAcctB', amount: '100' }] },
        }),
      );
      expect(err.code).toBe('network');
      expect(err.message).toMatch(/integer base-unit amount/);
    });

    it('rejects the shapes BigInt would silently accept', () => {
      // `0x10` -> 16n and ` 42 ` -> 42n are not errors to catch, they are wrong readings.
      for (const amount of ['0x10', ' 42 ', '1e3', '-5', '']) {
        const err = scanErrorFrom(() =>
          parseSolanaScan({ ...ok, largest: { value: [{ address: 'TokAcctA', amount }] } }),
        );
        expect(err.code).toBe('network');
      }
    });

    it('drops a zero-balance row without treating it as unreadable', () => {
      // A closed/drained ATA the node still lists is a real answer, not drift.
      const r = parseSolanaScan({
        ...ok,
        largest: { value: [{ address: 'TokAcctA', amount: '100' }, { address: 'TokAcctZero', amount: '0' }] },
        tokenAccounts: { value: [{ data: { parsed: { info: { owner: 'WalletW1' } } } }] },
        ownerAccounts: { value: [{ owner: SYSTEM_PROGRAM }] },
      });
      expect(r.enumeratedHolders).toBe(1);
    });

    it('refuses to invent an owner for a token account that vanished mid-read', () => {
      const err = scanErrorFrom(() =>
        parseSolanaScan({
          ...ok,
          largest: { value: [{ address: 'TokAcctA', amount: '100' }] },
          tokenAccounts: { value: [null] },
          ownerAccounts: { value: [{ owner: SYSTEM_PROGRAM }] },
        }),
      );
      expect(err.code).toBe('network');
      expect(err.message).toMatch(/no longer exists/);
    });

    it('rejects a largest-accounts row missing its address/amount pair', () => {
      const err = scanErrorFrom(() =>
        parseSolanaScan({ ...ok, largest: { value: [{ address: 'TokAcctA', amount: '100' }, { amount: '100' }] } }),
      );
      expect(err.code).toBe('network');
      expect(err.message).toMatch(/entry 1/);
    });

    it('keeps an explicit null owner account as "this address has no account"', () => {
      // getMultipleAccounts returns null for an address that does not exist. That is
      // an answer: not program-owned, so the holder counts as a wallet.
      const r = parseSolanaScan({
        ...ok,
        ownerAccounts: { value: [{ owner: SYSTEM_PROGRAM }, { owner: SYSTEM_PROGRAM }, null] },
      });
      expect(analyzeDistribution(r.input).holderCounts.excluded).toBe(0);
    });
  });
});

describe('fetchSolanaScan — the error taxonomy at the transport', () => {
  const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  /** Serve one body per successive fetch call (one per JSON-RPC batch). */
  function mockFetchSequence(bodies: unknown[]) {
    let i = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => bodies[i++] }) as unknown as Response),
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it('reports a -32602 on getTokenSupply as not-found — the node looked and there is no mint', () => {
    // The one RPC error that is evidence about the ADDRESS rather than about the
    // read. Hardening the rest must not blunt the common fat-fingered-address case.
    mockFetchSequence([
      [
        { id: 1, error: { code: -32602, message: 'Invalid param: could not find account' } },
        { id: 2, result: { value: null } },
        { id: 3, error: { code: -32602, message: 'Invalid param: could not find account' } },
      ],
    ]);
    return asyncScanErrorFrom(() => fetchSolanaScan(MINT)).then((err) => {
      expect(err.code).toBe('not-found');
    });
  });

  it('does NOT report any other RPC error as "is it a valid mint?"', async () => {
    mockFetchSequence([[{ id: 1, error: { code: -32603, message: 'internal error' } }]]);
    const err = await asyncScanErrorFrom(() => fetchSolanaScan(MINT));
    expect(err.code).toBe('network');
    expect(err.code).not.toBe('not-found');
    expect(err.message).toMatch(/internal error/);
  });

  it('does NOT report a 200 carrying neither result nor error as an absent mint', async () => {
    // Previously the batch map stored `undefined` for this, `supply?.value?.amount`
    // was falsy, and the user was told their address is not a valid mint.
    mockFetchSequence([[{ id: 1 }, { id: 2 }, { id: 3 }]]);
    const err = await asyncScanErrorFrom(() => fetchSolanaScan(MINT));
    expect(err.code).toBe('network');
    expect(err.message).toMatch(/neither a result nor an error/);
  });

  it('keeps an explicit null result out of the "no answer" bucket', async () => {
    // `result: null` on getTokenSupply IS an answer ("nothing token-like here") and
    // must reach the parser as such, landing on not-found rather than unreadable.
    mockFetchSequence([[{ id: 1, result: { value: null } }, { id: 2, result: { value: null } }, { id: 3, result: { value: [] } }]]);
    const err = await asyncScanErrorFrom(() => fetchSolanaScan(MINT));
    expect(err.code).toBe('not-found');
  });

  it('does NOT let arrival order decide whether an RPC error was seen', async () => {
    // A batch answering id 1 twice — once with an error, once with a result — used to keep
    // whichever landed last. In this order that produced ScanError('not-found'), i.e. "is it
    // a valid mint?", from a batch that literally contained an RPC error.
    mockFetchSequence([
      [
        { id: 1, error: { code: -32603, message: 'node internal error' } },
        { id: 1, result: { value: { amount: '300', decimals: 0 } } },
        { id: 2, result: { value: null } },
        { id: 3, result: { value: [] } },
      ],
    ]);
    const err = await asyncScanErrorFrom(() => fetchSolanaScan(MINT));
    expect(err.code).toBe('network');
    expect(err.message).toMatch(/more than once/);
  });

  it('is symmetric: the reverse duplicate order is unreadable too', async () => {
    mockFetchSequence([
      [
        { id: 1, result: { value: { amount: '300', decimals: 0 } } },
        { id: 1, error: { code: -32603, message: 'node internal error' } },
        { id: 2, result: { value: null } },
        { id: 3, result: { value: [] } },
      ],
    ]);
    expect((await asyncScanErrorFrom(() => fetchSolanaScan(MINT))).code).toBe('network');
  });

  it('does not resolve owners for rows the parser will discard', async () => {
    // fetch used to be STRICTER than parse: it resolved an owner for every top-20 row,
    // including zero-balance ones parse skips, so a routine null on a closed ATA aborted an
    // otherwise fully readable scan. Both now derive the same rows from largestEntries.
    mockFetchSequence([
      [
        { id: 1, result: { value: { amount: '300', decimals: 0 } } },
        { id: 2, result: { value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } } },
        {
          id: 3,
          result: { value: [{ address: 'TokAcctLive', amount: '100' }, { address: 'TokAcctClosed', amount: '0' }] },
        },
      ],
      [{ id: 1, result: { value: [{ data: { parsed: { info: { owner: 'WalletW1' } } } }] } }],
      [{ id: 1, result: { value: [{ owner: SYSTEM_PROGRAM }] } }],
    ]);
    const r = await fetchSolanaScan(MINT);
    expect(r.enumeratedHolders).toBe(1);
  });

  it('drives all three batches and groups a whale’s ATAs on the happy path', async () => {
    mockFetchSequence([
      [
        { id: 1, result: { value: { amount: '300', decimals: 0 } } },
        { id: 2, result: { value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } } },
        {
          id: 3,
          result: { value: [{ address: 'TokAcctA', amount: '100' }, { address: 'TokAcctB', amount: '200' }] },
        },
      ],
      [
        {
          id: 1,
          result: {
            value: [
              { data: { parsed: { info: { owner: 'WalletW1' } } } },
              { data: { parsed: { info: { owner: 'WalletW1' } } } },
            ],
          },
        },
      ],
      [{ id: 1, result: { value: [{ owner: SYSTEM_PROGRAM }, { owner: SYSTEM_PROGRAM }] } }],
    ]);
    const r = await fetchSolanaScan(MINT);
    expect(r.input.totalSupply).toBe(300n);
    expect(r.enumeratedHolders).toBe(1); // both ATAs collapse to WalletW1
    expect(r.input.hardFacts).toEqual({ mintAuthorityLive: false, freezeAuthorityLive: false });
  });
});

describe('parseEthereumScan', () => {
  const holders = Array.from({ length: 100 }, (_, i) => ({
    address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    balance: '1000000000000000000', // 1 token (18 dp) each
  }));

  it('parses the normalized route shape, filters junk, and marks partial coverage', () => {
    const result = parseEthereumScan('0xabc', {
      chain: 'ethereum',
      totalSupply: '100000000000000000000000', // far more than the 100 enumerated → tail exists
      decimals: 18,
      holdersCount: 5000,
      symbol: 'TEST',
      source: 'ethplorer',
      holders: [
        ...holders,
        { address: 'not-an-address', balance: '5' }, // dropped
        { address: '0x0000000000000000000000000000000000000abc', balance: '0' }, // zero → dropped
      ],
    });
    expect(result.enumeratedHolders).toBe(100);
    expect(result.holderCoverage).toBe('top-n'); // 100 enumerated < 5000 total
    expect(result.token.holdersCount).toBe(5000);
    expect(result.token.symbol).toBe('TEST');
    // No free hard-fact source for arbitrary ERC-20s ⇒ every hard fact unknown.
    expect(result.input.hardFacts).toEqual({});
  });

  it('throws when the route returns no usable holders', () => {
    expect(() => parseEthereumScan('0xabc', { holders: [] })).toThrowError(ScanError);
  });
});

describe('parseEthereumScan — a payload we could not read is never a finding', () => {
  // Same rule as the Solana block above, in the erc20scan route's dialect. Every
  // read has three outcomes and only two are answers; (c) COULD NOT READ IT must
  // never surface as a statement about somebody's token.
  //
  // A healthy fixture on purpose: 100 holders, the largest holding 3% of a 1e33
  // supply — so any red flag these tests see was MANUFACTURED, not observed.
  const SUPPLY = '1000000000000000000000000000000000'; // 1e33
  const holders = Array.from({ length: 100 }, (_, i) => ({
    address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    balance: i === 0 ? '30000000000000000000000000000000' : '1000000000000000000000000000000',
  }));
  const ok = { chain: 'ethereum', totalSupply: SUPPLY, decimals: 18, holdersCount: 1678265, source: 'ethplorer', holders };

  describe('the holder list', () => {
    it('does NOT report a body with no `holders` key as a token with no holders', () => {
      // ⚠ THE ORIGINAL BUG. `Array.isArray(json.holders) ? json.holders : []` made a
      // body we could not read byte-identical to a token nobody holds: both fell to
      // ScanError('empty'), which ScannerPage renders as "No holder data for this
      // token — double-check the address is a token (not a wallet or an NFT)".
      const err = scanErrorFrom(() => parseEthereumScan('0xabc', { totalSupply: SUPPLY }));
      expect(err.code).toBe('network');
      expect(err.code).not.toBe('empty');
      expect(err.message).toMatch(/no `holders` list/);
    });

    it('rejects a `holders` whose type drifted rather than reading "nobody" from it', () => {
      for (const drifted of [{}, 'none', 0, null]) {
        expect(scanErrorFrom(() => parseEthereumScan('0xabc', { ...ok, holders: drifted })).code).toBe('network');
      }
    });

    it('keeps a genuinely empty holder set as the real answer it is', () => {
      // The other side of the same coin — hardening must not turn "we read it and
      // nobody holds this" into a retry-me network error.
      expect(scanErrorFrom(() => parseEthereumScan('0xabc', { ...ok, holders: [] })).code).toBe('empty');
    });

    it('does not read a finding out of a body that is not even an object', () => {
      for (const body of [null, undefined, 'not json', 42, [1, 2]]) {
        expect(scanErrorFrom(() => parseEthereumScan('0xabc', body)).code).toBe('network');
      }
    });
  });

  describe('the denominator', () => {
    it('refuses a totalSupply that is not a plain decimal instead of mangling it', () => {
      // ⚠ THE WORST CASE, because it does not fail — it SUCCEEDS and renders a report.
      // `toBig` stripped a decimal tail and then every non-digit, so "1e+21" — which
      // is exactly what `String(n)` yields for any JSON number ≥ 1e21, the size a
      // meme-coin supply actually is — became 121n. Measured on THIS fixture:
      // top1ShareOfTotal 0.03 → 1, band "mixed" → "concentrated", and the
      // `single-holder-majority` gate FIRED. A maximum-severity red flag about a
      // healthy token, computed from a field the scan never managed to read.
      const err = scanErrorFrom(() => parseEthereumScan('0xabc', { ...ok, totalSupply: '1e+21' }));
      expect(err.code).toBe('network');
      expect(err.message).toMatch(/integer base-unit amount/);
    });

    it('rejects every other shape a base-unit integer never has', () => {
      // A caught exception would not be enough: BigInt('') is 0n and throws nothing,
      // BigInt('0x10') is 16n, BigInt(' 42 ') is 42n. Hence a digits-only match.
      for (const totalSupply of ['', 'abc', '1.5', '0x10', ' 42 ', '1,000', '-5', '1e33']) {
        const err = scanErrorFrom(() => parseEthereumScan('0xabc', { ...ok, totalSupply }));
        expect(err.code, `totalSupply ${JSON.stringify(totalSupply)}`).toBe('network');
      }
    });

    it('never returns a scan whose denominator was not actually read', () => {
      // The invariant behind the two cases above, stated without reference to a
      // message: if a scan comes back carrying a total at all, that total came off
      // the wire unmodified.
      const r = parseEthereumScan('0xabc', ok);
      expect(r.input.totalSupply).toBe(BigInt(SUPPLY));
    });

    it('keeps an absent total as the documented gap it is', () => {
      // The route documents `totalSupply: string | null` — the explorer does not
      // always report one. That is an ANSWER, and the core's fallback to the
      // enumerated sum is disclosed by the coverage notes as an upper bound. Only a
      // total that is PRESENT and unreadable is a failed read.
      for (const totalSupply of [null, undefined]) {
        const r = parseEthereumScan('0xabc', { ...ok, totalSupply });
        expect(r.input.totalSupply).toBeUndefined();
        expect(r.enumeratedHolders).toBe(100);
      }
    });
  });

  describe('holder balances', () => {
    it('never renders a whale as dust because its balance was unreadable', () => {
      // ⚠ THE FLATTERING DIRECTION. The same coercion, one field down: a top holder
      // reported as "9.9e32" was parsed as 9n — nine base units. Measured on this
      // fixture, that wallet really holds 99% of supply, and the mangled read
      // published top1ShareOfTotal 0.001, effectiveHolders 99, band
      // "well-distributed", and NO fired gate. A single wallet owning the entire
      // float, handed a clean bill of health on a page people use to decide whether
      // to trust that token.
      const whale = { address: `0x${'a'.repeat(40)}`, balance: '9.9e32' };
      const err = scanErrorFrom(() => parseEthereumScan('0xabc', { ...ok, holders: [whale, ...holders.slice(1)] }));
      expect(err.code).toBe('network');

      // The same row, readable, is exactly the finding the mangled one erased.
      const real = parseEthereumScan('0xabc', {
        ...ok,
        holders: [{ ...whale, balance: '990000000000000000000000000000000' }, ...holders.slice(1)],
      });
      const a = analyzeDistribution(real.input);
      expect(a.band).toBe('concentrated');
      expect(a.gate.findings.find((f) => f.id === 'single-holder-majority')?.fired).toBe(true);
    });

    it('rejects a row carrying no readable balance at all', () => {
      for (const balance of [null, undefined, '', 'abc', {}, true]) {
        const row = { address: `0x${'a'.repeat(40)}`, balance };
        expect(scanErrorFrom(() => parseEthereumScan('0xabc', { ...ok, holders: [row] })).code).toBe('network');
      }
    });

    it('rejects a JSON number whose low digits the parse already fabricated', () => {
      // BigInt(Math.trunc(1e21)) returns a confident-looking 1000000000000000000000n,
      // but every digit past 2^53 came from the float, not from the chain.
      for (const balance of [1e21, Number.MAX_VALUE, NaN, Infinity, -5, 1.5]) {
        const row = { address: `0x${'a'.repeat(40)}`, balance };
        expect(scanErrorFrom(() => parseEthereumScan('0xabc', { ...ok, holders: [row] })).code).toBe('network');
      }
    });

    it('still accepts the readable forms, including an exact number', () => {
      // Hardening must not narrow what the route can legitimately emit.
      const r = parseEthereumScan('0xabc', {
        ...ok,
        holders: [
          { address: `0x${'a'.repeat(40)}`, balance: '1000000000000000000' },
          { address: `0x${'b'.repeat(40)}`, balance: 4200 },
        ],
      });
      expect(r.input.holders.map((h) => h.balance)).toEqual([1000000000000000000n, 4200n]);
    });

    it('keeps dropping the junk it was always right to drop', () => {
      // A zero balance is a READ answer (nobody holds it) and a non-address row can
      // be attributed to nobody — both stay dropped, and dropping them must not be
      // confused with the unreadable cases above.
      const r = parseEthereumScan('0xabc', {
        ...ok,
        holders: [
          ...holders,
          { address: 'not-an-address', balance: '5' },
          { address: `0x${'c'.repeat(40)}`, balance: '0' },
        ],
      });
      expect(r.enumeratedHolders).toBe(100);
    });
  });
});

describe('fetchEthereumScan — the error taxonomy at the transport', () => {
  const CONTRACT = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D';

  function mockFetchOnce(r: { ok?: boolean; status?: number; json?: () => Promise<unknown> }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: r.ok ?? true,
            status: r.status ?? 200,
            json: r.json ?? (async () => ({})),
          }) as unknown as Response,
      ),
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it('reports the route’s uncached 502 as a failed read, never as an empty token', async () => {
    // This is the contract the server half depends on: erc20scan now answers 502
    // when the holder source was unreadable, precisely so it stops caching a 200
    // with no holders. That 502 must not resurface here as a claim about the token.
    const err = await asyncScanErrorFrom(() => fetchEthereumScan(CONTRACT));
    expect(err.code).toBe('network');

    mockFetchOnce({ ok: false, status: 502, json: async () => ({ error: 'upstream' }) });
    const e502 = await asyncScanErrorFrom(() => fetchEthereumScan(CONTRACT));
    expect(e502.code).toBe('network');
    expect(e502.code).not.toBe('empty');
    expect(e502.code).not.toBe('unavailable');
  });

  it('keeps the unconfigured-route 403 as the deployment gap it is', async () => {
    mockFetchOnce({ ok: false, status: 403, json: async () => ({ error: 'not enabled' }) });
    expect((await asyncScanErrorFrom(() => fetchEthereumScan(CONTRACT))).code).toBe('unavailable');
  });

  it('does not read a token verdict out of a 200 that is not JSON', async () => {
    mockFetchOnce({
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });
    expect((await asyncScanErrorFrom(() => fetchEthereumScan(CONTRACT))).code).toBe('network');
  });

  it('does not read a token verdict out of a 200 carrying no holder list', async () => {
    mockFetchOnce({ json: async () => ({ chain: 'ethereum', contract: CONTRACT, totalSupply: '1000' }) });
    const err = await asyncScanErrorFrom(() => fetchEthereumScan(CONTRACT));
    expect(err.code).toBe('network');
    expect(err.code).not.toBe('empty');
  });
});

describe('buildCoverageNotes', () => {
  it('discloses partial enumeration as an upper bound and flags un-run launch signals', () => {
    const notes = buildCoverageNotes({
      chain: 'solana',
      holderCoverage: 'top-n',
      enumeratedHolders: 20,
      holdersCount: null,
      bundlesResolved: false,
      snipersResolved: false,
    });
    expect(notes.join(' ')).toMatch(/upper bound/i);
    expect(notes.join(' ')).toMatch(/bundle/i);
    expect(notes.join(' ')).toMatch(/sniper/i);
  });
});

describe('scanToken orchestration', () => {
  it('rejects an invalid address before any fetch', async () => {
    await expect(
      scanToken('nope', { fetchFor: async () => ({}) as unknown as AdapterResult }),
    ).rejects.toBeInstanceOf(ScanError);
  });

  it('produces a well-distributed verdict for a broad equal holder set', async () => {
    const holders = Array.from({ length: 200 }, (_, i) => ({
      address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      balance: 100n,
    }));
    const adapter: AdapterResult = {
      input: { holders, totalSupply: 20000n, launch: { bundlesResolved: false, snipersResolved: false } },
      token: { name: null, symbol: null, decimals: 18, holdersCount: 200 },
      enumeratedHolders: 200,
      holderCoverage: 'full',
      source: 'test',
    };
    const outcome = await scanToken('0x420698CFdEDdEa6bc78D59bC17798113ad278F9D', {
      fetchFor: async () => adapter,
      observedAt: 1_700_000_000,
    });
    expect(outcome.chain).toBe('ethereum');
    expect(outcome.analysis.band).toBe('well-distributed');
    expect(outcome.analysis.observedAt).toBe(1_700_000_000);
    expect(outcome.analysis.gate.findings.some((f) => f.fired)).toBe(false);
  });

  it('surfaces a concentrated verdict when one wallet dominates', async () => {
    const adapter: AdapterResult = {
      input: {
        holders: [
          { address: `0x${'1'.padStart(40, '0')}`, balance: 900n },
          { address: `0x${'2'.padStart(40, '0')}`, balance: 100n },
        ],
        totalSupply: 1000n,
        launch: { bundlesResolved: false, snipersResolved: false },
      },
      token: { name: null, symbol: null, decimals: 18, holdersCount: 2 },
      enumeratedHolders: 2,
      holderCoverage: 'full',
      source: 'test',
    };
    const outcome = await scanToken('0x420698CFdEDdEa6bc78D59bC17798113ad278F9D', {
      fetchFor: async () => adapter,
    });
    // single-holder-majority gate (90% of total) floors the band
    expect(outcome.analysis.band).toBe('concentrated');
    expect(outcome.analysis.gate.findings.find((f) => f.id === 'single-holder-majority')?.fired).toBe(true);
  });
});
