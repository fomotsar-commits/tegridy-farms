import { describe, it, expect } from 'vitest';
import { analyzeDistribution } from '../detection';
import {
  detectChain,
  isValidTokenAddress,
  buildCoverageNotes,
  scanToken,
  ScanError,
  type AdapterResult,
} from './index';
import { parseSolanaScan, type SolanaScanRaw } from './solanaAdapter';
import { parseEthereumScan } from './ethereumAdapter';

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

  it('throws a typed error when there is no supply', () => {
    expect(() => parseSolanaScan({ ...raw, supply: undefined })).toThrowError(ScanError);
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
