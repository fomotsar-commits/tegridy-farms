// The deploy's site record, as the batcher's deploy tool writes it (cardano/batcher src/deploy.ts
// records(), pinned in its test fixture site-record.json), is a record the site reads whole: the
// two packages cannot drift apart without one of them failing.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OwnPoolsDeploymentRecord } from '../../../../api/_lib/cardano-own-pools';
import { readOwnPoolsDeployment } from './deployment';

const FIXTURE = resolve(__dirname, '../../../../../cardano/batcher/test/fixtures/site-record.json');
const record = JSON.parse(readFileSync(FIXTURE, 'utf8')) as OwnPoolsDeploymentRecord;

describe("the deploy tool's site record", () => {
  it('is read whole, its order script reference and opening budget included', () => {
    const r = readOwnPoolsDeployment(record);
    expect(r).toMatchObject({ kind: 'deployed' });
    if (r.kind !== 'deployed') return;
    expect(r.pools.orderRef).toEqual({ txHash: record.orderRef.ref.split('#')[0], index: 0, scriptSize: record.orderRef.scriptSize });
    expect(r.pools.openingFee).toBe(73_000_000n);
    expect(r.pools.batcherFee).toBe(2_000_000n);
  });

  it('without its order script reference is refused, as before the tool wrote one', () => {
    const { orderRef: _gone, ...without } = record;
    expect(readOwnPoolsDeployment(without as OwnPoolsDeploymentRecord)).toMatchObject({ kind: 'refused' });
  });
});
