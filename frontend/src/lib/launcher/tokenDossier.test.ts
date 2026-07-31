import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import {
  parseTokenParam,
  decodeAssetData,
  classifyProvenance,
  classifyGraduation,
  unverifiedGateChecks,
  powersWereRead,
  clipMessage,
  readAirlockAssetData,
  readTokenPresence,
  type AirlockRead,
  type GraduationState,
} from './tokenDossier';
import type { MigrationStream } from './lockerStream';
import { LAUNCHER_INTEGRATOR_ADDRESS } from './config';

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const OURS = LAUNCHER_INTEGRATOR_ADDRESS;
const THEIRS = '0x00000000000000000000000000000000DeaDBeef' as Address;
const INITIALIZER = '0x53b4C21a6cb61d64F636abBFa6e8e90e6558e8Ad' as Address;
const TOKEN = '0x000000000000000000000000000000000000dEaD' as Address;
const POOL_ID = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

/** A raw getAssetData tuple in the Airlock's own output order. */
function assetTuple(over: Partial<Record<number, unknown>> = {}): readonly unknown[] {
  const base: unknown[] = [
    ZERO, // 0 numeraire
    ZERO, // 1 timelock
    ZERO, // 2 governance
    ZERO, // 3 liquidityMigrator
    INITIALIZER, // 4 poolInitializer
    ZERO, // 5 pool
    ZERO, // 6 migrationPool
    0n, // 7 numTokensToSell
    1_000n, // 8 totalSupply
    OURS, // 9 integrator
  ];
  for (const [k, v] of Object.entries(over)) base[Number(k)] = v;
  return base;
}

function stream(over: Partial<MigrationStream> = {}): MigrationStream {
  return {
    graduated: false,
    numeraire: ZERO,
    poolId: POOL_ID,
    locker: null,
    locked: false,
    unlockAt: null,
    beneficiaries: [],
    ...over,
  };
}

describe('parseTokenParam', () => {
  it('accepts a checksummed address and returns it checksummed', () => {
    const r = parseTokenParam(OURS);
    expect(r).toEqual({ ok: true, address: OURS });
  });

  it('accepts lowercase and mixed-case input and normalises to EIP-55', () => {
    // A permalink is routinely copied from an explorer or one of our own lowercased
    // hrefs; case carries no on-chain meaning, so normalising invents nothing.
    expect(parseTokenParam(OURS.toLowerCase())).toEqual({ ok: true, address: OURS });
    expect(parseTokenParam(('0x' + OURS.slice(2).toUpperCase()) as Address)).toEqual({
      ok: true,
      address: OURS,
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseTokenParam(`  ${OURS}  `)).toEqual({ ok: true, address: OURS });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', '   '],
  ])('rejects %s as a missing address', (_label, input) => {
    const r = parseTokenParam(input as string | undefined | null);
    expect(r).toEqual({ ok: false, reason: 'No token address in the link.' });
  });

  it.each([
    ['no 0x prefix', 'D355A072d6bBbA275DBD83A3149f6347b06d1051'],
    ['too short', '0xD355A072d6bBbA275DBD83A3149f6347b06d10'],
    ['too long', '0xD355A072d6bBbA275DBD83A3149f6347b06d105111'],
    ['non-hex', '0xZZZZA072d6bBbA275DBD83A3149f6347b06d1051'],
    ['an ENS name', 'vitalik.eth'],
    ['a path traversal attempt', '../../etc/passwd'],
    ['a script tag', '<script>alert(1)</script>'],
    ['a tx hash', '0x' + 'ab'.repeat(32)],
  ])('rejects %s with the malformed-address reason, never throwing', (_label, input) => {
    const r = parseTokenParam(input);
    expect(r.ok).toBe(false);
    // Pinned on the SHAPE explanation, not just "some reason": the explicit guard
    // exists to tell the visitor what a token link should look like. Falling through
    // to the generic catch would be a silent regression in a user-facing message.
    if (!r.ok) expect(r.reason).toMatch(/0x followed by 40 hex characters/);
  });
});

describe('decodeAssetData', () => {
  it('reads the integrator from output index 9', () => {
    const r = decodeAssetData(assetTuple());
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.record.integrator).toBe(OURS);
  });

  it('accepts a named-object result as well as a tuple array', () => {
    const r = decodeAssetData({
      numeraire: ZERO,
      poolInitializer: INITIALIZER,
      migrationPool: ZERO,
      totalSupply: 5n,
      integrator: THEIRS,
    });
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.record.integrator).toBe(THEIRS);
  });

  it('treats an all-zero record as ABSENT — the mapping getter never reverts', () => {
    expect(decodeAssetData(assetTuple({ 4: ZERO, 8: 0n, 9: ZERO })).status).toBe('absent');
  });

  it('keys absence off poolInitializer, NOT the integrator', () => {
    // A real Doppler launch made without an integrator has integrator == 0. Keying
    // absence off that field would misreport it as "not a Doppler launch".
    const r = decodeAssetData(assetTuple({ 9: ZERO }));
    expect(r.status).toBe('found');
  });

  it('reports a non-object / short result as unreadable, never as absent', () => {
    expect(decodeAssetData(null).status).toBe('unreadable');
    expect(decodeAssetData('0x').status).toBe('unreadable');
    expect(decodeAssetData([ZERO]).status).toBe('unreadable');
  });
});

describe('classifyProvenance', () => {
  const found = (integrator: Address): AirlockRead => ({
    status: 'found',
    record: {
      numeraire: ZERO,
      poolInitializer: INITIALIZER,
      migrationPool: ZERO,
      totalSupply: 1n,
      integrator,
    },
  });

  it('claims a launch as ours only when the Airlock names our integrator', () => {
    expect(classifyProvenance(found(OURS)).kind).toBe('ours');
  });

  it('matches our integrator case-insensitively', () => {
    expect(classifyProvenance(found(OURS.toLowerCase() as Address)).kind).toBe('ours');
  });

  it('says plainly that a foreign integrator did NOT come through this rail', () => {
    const p = classifyProvenance(found(THEIRS));
    expect(p.kind).toBe('other-integrator');
    expect(p.detail).toMatch(/did not come through this rail/i);
  });

  it('does not claim an integrator-less Doppler launch as ours', () => {
    const p = classifyProvenance(found(ZERO));
    expect(p.kind).toBe('no-integrator');
    expect(p.detail).toMatch(/did not come through this rail/i);
  });

  it('never claims everything as ours when the configured integrator is zero', () => {
    // Same fail-closed guard filterOurAssets carries.
    expect(classifyProvenance(found(ZERO), ZERO).kind).toBe('no-integrator');
    expect(classifyProvenance(found(OURS), ZERO).kind).toBe('other-integrator');
  });

  it('reports an absent record as "not a Doppler launch"', () => {
    expect(classifyProvenance({ status: 'absent' }).kind).toBe('not-doppler');
  });

  it('reports an unreadable record as UNVERIFIED, never as "not ours" and never as ours', () => {
    const p = classifyProvenance({ status: 'unreadable', message: 'rpc down' });
    expect(p.kind).toBe('unreadable');
    expect(p.detail).toMatch(/cannot say/i);
    expect(p.detail).not.toMatch(/did not come through this rail/i);
  });
});

describe('classifyGraduation', () => {
  it('renders an unsupported read as CANNOT-VERIFY, not as "not graduated"', () => {
    // The whole lesson of lockerStream.ts: an unreadable locker looked identical to
    // an empty one for weeks.
    const g = classifyGraduation(stream({ unsupported: true }));
    expect(g.kind).toBe('cannot-verify');
    expect(g.label).not.toMatch(/not graduated/i);
    expect(g.detail).toMatch(/not a finding about the token/i);
  });

  it('leaves lock state NULL when unverifiable — never false', () => {
    const g = classifyGraduation(stream({ unsupported: true, locked: false }));
    expect(g.locked).toBeNull();
    expect(g.unlockAt).toBeNull();
  });

  it('reports a real empty read as not-graduated', () => {
    expect(classifyGraduation(stream()).kind).toBe('not-graduated');
  });

  it('surfaces real lock state and beneficiaries once graduated', () => {
    const g = classifyGraduation(
      stream({
        graduated: true,
        locked: true,
        unlockAt: 1_900_000_000,
        beneficiaries: [{ beneficiary: OURS, shares: 10n }],
      }),
    );
    expect(g.kind).toBe('graduated');
    expect(g.locked).toBe(true);
    expect(g.unlockAt).toBe(1_900_000_000);
    expect(g.beneficiaries).toHaveLength(1);
  });

  it('carries the derived poolId through every branch', () => {
    expect(classifyGraduation(stream({ unsupported: true })).poolId).toBe(POOL_ID);
    expect(classifyGraduation(stream()).poolId).toBe(POOL_ID);
  });
});

describe('unverifiedGateChecks — separating conservative defaults from readings', () => {
  const graduated: GraduationState = classifyGraduation(
    stream({ graduated: true, locked: true, unlockAt: 1_900_000_000 }),
  );
  const unverifiable: GraduationState = classifyGraduation(stream({ unsupported: true }));

  it('marks every power check UNKNOWN on an unrecognised template', () => {
    // collector.ts reports all dangerous powers as PRESENT when it cannot recognise the
    // template. Publishing that verbatim would accuse a contract nobody inspected.
    const u = unverifiedGateChecks(false, graduated);
    for (const id of ['no-mint', 'no-transfer-tax', 'no-blacklist', 'no-upgrade', 'no-pause']) {
      expect(u[id]).toMatch(/not read/i);
    }
  });

  it('marks BOTH allocation checks UNKNOWN on an unrecognised template', () => {
    // The collector leaves teamAllocationBps at 0 there, which the gate renders as
    // "No team/insider allocation." AND as a PASSING "Team allocation 0 bps (flagship
    // cap 2000 bps)." — two fabricated clean bills of health from one unread number.
    const u = unverifiedGateChecks(false, graduated);
    expect(u['team-allocation-vested']).toMatch(/not read/i);
    expect(u['insider-float-cap']).toMatch(/not read/i);
  });

  it('marks the ownership check UNKNOWN on an unrecognised template', () => {
    // safeRead falls back to a null owner when owner() reverts, so a contract with no
    // owner() at all would otherwise be published as "Ownership renounced." ✓.
    expect(unverifiedGateChecks(false, graduated)['admin-renounced-or-timelock']).toMatch(/not read/i);
  });

  it('leaves every check as a real reading on the recognised template', () => {
    expect(unverifiedGateChecks(true, graduated)).toEqual({});
  });

  it('marks both LP-lock checks UNKNOWN whenever lock state was not read', () => {
    const u = unverifiedGateChecks(true, unverifiable);
    expect(u['lp-lock-floor']).toMatch(/not read/i);
    expect(u['lp-lock-12mo']).toMatch(/not read/i);
    expect(u['no-mint']).toBeUndefined();
  });

  it('does not mark LP-lock unknown when the lock WAS read', () => {
    expect(unverifiedGateChecks(true, graduated)['lp-lock-floor']).toBeUndefined();
  });

  it('powersWereRead tracks template recognition', () => {
    expect(powersWereRead(true)).toBe(true);
    expect(powersWereRead(false)).toBe(false);
  });
});

describe('clipMessage', () => {
  it('bounds a viem transport error so its JSON-RPC body cannot flood the page', () => {
    const viemish =
      'HTTP request failed. URL: https://eth.merkle.io/ Request body: ' +
      JSON.stringify({ topics: ['0x' + 'ab'.repeat(32), '0x' + 'cd'.repeat(32), '0x' + 'ef'.repeat(32)] });
    const out = clipMessage(viemish);
    expect(out.length).toBeLessThanOrEqual(181);
    expect(out).toMatch(/^HTTP request failed\. URL: https:\/\/eth\.merkle\.io\//);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves a short message untouched and collapses whitespace', () => {
    expect(clipMessage('  rpc   down ')).toBe('rpc down');
  });
});

describe('I/O wrappers degrade instead of throwing', () => {
  it('readAirlockAssetData turns a thrown RPC error into an unreadable status', async () => {
    const client = {
      readContract: async () => {
        throw new Error('HTTP 429');
      },
    };
    const r = await readAirlockAssetData(client, TOKEN);
    expect(r.status).toBe('unreadable');
    if (r.status === 'unreadable') expect(r.message).toContain('429');
  });

  it('readAirlockAssetData decodes a successful read', async () => {
    const client = { readContract: async () => assetTuple() };
    const r = await readAirlockAssetData(client, TOKEN);
    expect(r.status).toBe('found');
  });

  it('readTokenPresence distinguishes no-code from unreadable', async () => {
    expect(await readTokenPresence({ readContract: async () => null, getCode: async () => '0x60006000' }, TOKEN)).toBe('contract');
    expect(await readTokenPresence({ readContract: async () => null, getCode: async () => '0x' }, TOKEN)).toBe('no-code');
    expect(await readTokenPresence({ readContract: async () => null, getCode: async () => undefined }, TOKEN)).toBe('no-code');
    expect(
      await readTokenPresence(
        {
          readContract: async () => null,
          getCode: async () => {
            throw new Error('nope');
          },
        },
        TOKEN,
      ),
    ).toBe('unreadable');
    // A client that cannot answer the question at all is unreadable, not "no code".
    expect(await readTokenPresence({ readContract: async () => null }, TOKEN)).toBe('unreadable');
  });
});

// A FAILED READ ON THE RECOGNISED TEMPLATE IS THE DANGEROUS CASE.
//
// The template-branch suppressions only fire when the contract is NOT the known Doppler
// template — but every launch through our own rail IS that template, and collector.safeRead
// degrades an individual failed view call to a conservative fallback. The gate reads that
// fallback as a PASS and the page renders it as a green statement of fact:
//   owner unread       -> null -> "Ownership renounced."        (INVERTED, not merely unknown)
//   totalSupply unread -> 0n   -> "No team/insider allocation." + the flagship cap passes
// One rate-limited call inside a Promise.all does it, and public RPCs return 429/1015 routinely.
describe('unverifiedGateChecks — unread fields on the RECOGNISED template', () => {
  const graduated: GraduationState = { locked: true, unsupported: false, locker: null, unlockAt: null };

  it('suppresses the ownership check when owner() did not land', () => {
    const out = unverifiedGateChecks(true, graduated, ['owner']);
    expect(out['admin-renounced-or-timelock']).toMatch(/not read/i);
  });

  it('suppresses BOTH allocation checks when totalSupply did not land', () => {
    const out = unverifiedGateChecks(true, graduated, ['totalSupply']);
    expect(out['team-allocation-vested']).toMatch(/not read/i);
    // insider-float-cap compares the same unread 0 against the flagship cap and would
    // otherwise render as a clean pass.
    expect(out['insider-float-cap']).toMatch(/not read/i);
  });

  it('suppresses nothing when every read landed (no false "unknown" either)', () => {
    const out = unverifiedGateChecks(true, graduated, []);
    expect(out['admin-renounced-or-timelock']).toBeUndefined();
    expect(out['team-allocation-vested']).toBeUndefined();
    expect(out['insider-float-cap']).toBeUndefined();
  });

  it('an unread owner is suppressed even on an UNRECOGNISED template (both paths agree)', () => {
    const out = unverifiedGateChecks(false, graduated, ['owner']);
    expect(out['admin-renounced-or-timelock']).toMatch(/not read/i);
  });
});
