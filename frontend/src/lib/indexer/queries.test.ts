// GROUND-TRUTH GUARD for the indexer documents.
//
// These queries are strings. Nothing in the TypeScript build knows whether
// `swaps` is a real field or whether `amountIn` is a real column — the first
// signal that a document drifted from indexer/ponder.schema.ts is a GraphQL
// error at runtime, which this client (correctly) reports as "indexer
// unavailable". Correct, and useless: the surface goes dark permanently and the
// message blames the service instead of the typo.
//
// So the schema file is parsed here and every selected field is checked against
// it. A column renamed in indexer/ fails this test in frontend/, which is the
// only place the coupling is visible.
//
// The other half is the honesty rail: every document must request
// `_meta { status }`, because a document that cannot report the indexer's sync
// position cannot tell a complete empty page from an incomplete one.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INDEXER_META_SELECTION, MAX_PAGE_LIMIT } from './client';
import {
  INDEXED_STAKING_HISTORY_QUERY,
  INDEXED_SWAPS_QUERY,
  STAKING_ACTION_TYPES,
  indexedStakingHistoryVariables,
  indexedSwapsVariables,
  isKnownStakingActionType,
  isStakingFlowAction,
} from './queries';

const repoRoot = join(process.cwd(), '..');
const ponderSchema = readFileSync(join(repoRoot, 'indexer', 'ponder.schema.ts'), 'utf8');
const ponderHandlers = readFileSync(join(repoRoot, 'indexer', 'src', 'index.ts'), 'utf8');

/** Column names declared on one `onchainTable` export. */
function columnsOf(tableExport: string): string[] {
  const start = ponderSchema.indexOf(`export const ${tableExport} = onchainTable(`);
  expect(start, `indexer/ponder.schema.ts has no table export named "${tableExport}"`).toBeGreaterThan(-1);
  const rest = ponderSchema.slice(start + 1);
  const end = rest.indexOf('\nexport const ');
  const block = end === -1 ? rest : rest.slice(0, end);
  return [...block.matchAll(/^\s*(\w+):\s*t\./gm)].map((m) => m[1]!);
}

/** Fields inside the `items { ... }` selection of a document. */
function selectedFields(document: string): string[] {
  const match = document.match(/items\s*\{([^}]*)\}/);
  expect(match, 'document has no items selection').not.toBeNull();
  return match![1]!.trim().split(/\s+/);
}

const DOCUMENTS = {
  INDEXED_SWAPS_QUERY: { document: INDEXED_SWAPS_QUERY, table: 'swap', field: 'swaps', filter: 'swapFilter' },
  INDEXED_STAKING_HISTORY_QUERY: {
    document: INDEXED_STAKING_HISTORY_QUERY,
    table: 'stakingAction',
    field: 'stakingActions',
    filter: 'stakingActionFilter',
  },
} as const;

describe('every document is checked against indexer/ponder.schema.ts', () => {
  for (const [name, { document, table, field, filter }] of Object.entries(DOCUMENTS)) {
    it(`${name} selects only columns that exist on \`${table}\``, () => {
      const columns = columnsOf(table);
      for (const selected of selectedFields(document)) {
        expect(columns, `${name} selects "${selected}"`).toContain(selected);
      }
    });

    it(`${name} queries the plural field \`${field}\` with the \`${filter}\` input`, () => {
      expect(document).toContain(`${field}(`);
      // Non-null on the VARIABLE even though the argument is nullable. Ponder's
      // where-builder does Object.entries(where) after an `=== undefined`
      // guard, so an explicit null throws inside the server and returns a 500.
      expect(document).toContain(`$where: ${filter}!`);
    });

    it(`${name} asks for the indexer's sync position`, () => {
      expect(document, 'a document without _meta cannot be freshness-gated').toContain(INDEXER_META_SELECTION);
    });

    it(`${name} does not ask for totalCount`, () => {
      // Selecting it makes Ponder run a second count(*) per request, behind a
      // proxy that rate-limits. pageInfo.hasNextPage answers what the UI asks.
      expect(document).not.toContain('totalCount');
    });
  }
});

describe('filter variables never send the shape that 500s the server', () => {
  it('sends an empty object, never null, when nothing is filtered', () => {
    expect(indexedSwapsVariables({}, 10).where).toEqual({});
    expect(indexedStakingHistoryVariables({}, 10).where).toEqual({});
  });

  it('lower-cases addresses', () => {
    // A casing mismatch would return an empty page, which reads as "this wallet
    // has never traded" — a false claim about somebody's wallet produced by a
    // formatting detail.
    const { where } = indexedSwapsVariables({ user: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01' }, 10);
    expect(where.user).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
  });

  it('sends a uint256 filter as a decimal string, not a number', () => {
    const { where } = indexedStakingHistoryVariables({ tokenId: 2n ** 70n }, 10);
    expect(where.tokenId).toBe('1180591620717411303424');
    expect(typeof where.tokenId).toBe('string');
  });

  it('clamps the page limit', () => {
    expect(indexedSwapsVariables({}, 10_000).limit).toBe(MAX_PAGE_LIMIT);
    expect(indexedStakingHistoryVariables({}, 10_000).limit).toBe(MAX_PAGE_LIMIT);
  });
});

describe('staking action types stay in step with the handlers', () => {
  it('lists every type indexer/src/index.ts writes to stakingAction', () => {
    // The schema comment drifted once already (`transfer` was added by the H-24
    // ERC-721 fix and never listed). Read the handlers instead of trusting it.
    const written = new Set(
      [...ponderHandlers.matchAll(/type:\s*"(\w+)"/g)].map((m) => m[1]!),
    );
    for (const type of STAKING_ACTION_TYPES) {
      expect(written, `"${type}" is no longer written by any handler`).toContain(type);
    }
  });

  it('does not reject an unrecognised type', () => {
    // A strict enum would blank a working history the first time the indexer
    // learns a new action. An unknown label is not corrupt data.
    expect(isKnownStakingActionType('stake')).toBe(true);
    expect(isKnownStakingActionType('somethingNew')).toBe(false);
  });

  it('marks `transfer` as custody, not flow', () => {
    // transfer rows carry amount 0 — counting them as actions taken would
    // present a wallet rotation as staking activity.
    expect(isStakingFlowAction('transfer')).toBe(false);
    expect(isStakingFlowAction('stake')).toBe(true);
  });
});
