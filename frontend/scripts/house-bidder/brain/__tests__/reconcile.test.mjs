// @vitest-environment node
//
// Books against the chain (BUILD-SPEC 3.5 step 4, "ledger vs chain mismatch"): the approval is
// what the house approved less what its fills pulled; the counter moves only when the bot bumps
// it; WETH leaves only through fills and the house's own transactions. All at one block.
import { describe, it, expect } from 'vitest';
import { reconcile } from '../reconcile.mjs';
import { milli } from '../../exec/__tests__/fakes.mjs';

const snap = (block, house) => ({ block, house: { weth: milli(200), allowance: 0n, counter: 7n, ...house } });
const fields = (r) => r.mismatches.map((m) => m.field);

describe('reconcile', () => {
  it('agrees when the approval is what was approved less the fills since', () => {
    const r = reconcile({ snapshot: snap(110, { allowance: milli(70) }), lastApproval: { amountWei: milli(105), block: 100 }, fills: [{ block: 105, unitPriceWei: milli(35) }], expectedCounter: 7n, prevWeth: null });
    expect(r.ok).toBe(true);
  });

  it('flags an approval lower than the books (WETH pulled by something else) or higher (approved by something else)', () => {
    const base = { lastApproval: { amountWei: milli(105), block: 100 }, fills: [], expectedCounter: 7n, prevWeth: null };
    expect(fields(reconcile({ ...base, snapshot: snap(110, { allowance: milli(70) }) }))).toEqual(['allowance']);
    expect(fields(reconcile({ ...base, snapshot: snap(110, { allowance: milli(140) }) }))).toEqual(['allowance']);
  });

  it('does not count a fill the snapshot’s block has not reached', () => {
    const r = reconcile({ snapshot: snap(104, { allowance: milli(105) }), lastApproval: { amountWei: milli(105), block: 100 }, fills: [{ block: 105, unitPriceWei: milli(35) }], expectedCounter: 7n, prevWeth: null });
    expect(r.ok).toBe(true);
  });

  it('accepts either order for a fill in the approval’s own block', () => {
    const args = { lastApproval: { amountWei: milli(105), block: 100 }, fills: [{ block: 100, unitPriceWei: milli(35) }], expectedCounter: 7n, prevWeth: null };
    expect(reconcile({ ...args, snapshot: snap(101, { allowance: milli(105) }) }).ok).toBe(true);
    expect(reconcile({ ...args, snapshot: snap(101, { allowance: milli(70) }) }).ok).toBe(true);
    expect(reconcile({ ...args, snapshot: snap(101, { allowance: milli(60) }) }).ok).toBe(false);
  });

  it('flags any approval when the house never approved, and skips the check for an approval mined at an unknown block', () => {
    expect(fields(reconcile({ snapshot: snap(1, { allowance: 1n }), lastApproval: null, fills: [], expectedCounter: null, prevWeth: null }))).toEqual(['allowance']);
    expect(reconcile({ snapshot: snap(1, { allowance: milli(105) }), lastApproval: undefined, fills: [], expectedCounter: null, prevWeth: null }).ok).toBe(true);
  });

  it('flags a counter bump the bot did not ask for, and accepts its own', () => {
    const args = { snapshot: snap(1, { counter: 8n }), lastApproval: null, fills: [], expectedCounter: 7n, prevWeth: null };
    expect(fields(reconcile(args))).toEqual(['counter']);
    expect(reconcile({ ...args, counterBumpPending: true }).ok).toBe(true);
    expect(fields(reconcile({ ...args, snapshot: snap(1, { counter: 6n }), counterBumpPending: true }))).toEqual(['counter']);
  });

  it('flags WETH that left by a path the bot does not know, and accepts funding', () => {
    const prevWeth = { weth: milli(200), block: 100 };
    const args = { lastApproval: null, expectedCounter: null, prevWeth };
    expect(reconcile({ ...args, snapshot: snap(110, { weth: milli(165) }), fills: [{ block: 105, unitPriceWei: milli(35) }] }).ok).toBe(true);
    expect(fields(reconcile({ ...args, snapshot: snap(110, { weth: milli(150) }), fills: [{ block: 105, unitPriceWei: milli(35) }] }))).toEqual(['weth']);
    expect(reconcile({ ...args, snapshot: snap(110, { weth: milli(300) }), fills: [] }).ok).toBe(true);
    expect(reconcile({ ...args, snapshot: snap(110, { weth: milli(100) }), fills: [], ownTxs: [{ block: 106, wethOut: milli(100) }] }).ok).toBe(true);
  });
});
