import { describe, it, expect } from 'vitest';
import { getAddress, parseEther, type Address, type Hex } from 'viem';
import { buildCampaign, type CampaignManifest } from './campaign';
import { evaluateEligibility, type OnChainCampaign } from './eligibility';

/**
 * HONESTY GUARD for the claim verdict.
 *
 * The rule: `not-listed` is the ONLY negative this function may reach, and it may reach
 * it only after actually reading a list. Every missing input — no manifest, no campaign
 * read, no claimed-bit — must resolve to `unknown`, and `canClaim` must be false for
 * every status that is not `eligible`.
 *
 * The failure being pinned is specific and common: an RPC outage rendering "you are not
 * eligible". That sentence is about the wallet; the truth is about the page.
 */

const IN_LIST = '0xaaaa000000000000000000000000000000000001' as Address;
const NOT_IN_LIST = '0x000000000000000000000000000000000000dead' as Address;

const manifest: CampaignManifest = (() => {
  const m = buildCampaign([
    { account: IN_LIST, amount: parseEther('10') },
    { account: '0xbbbb000000000000000000000000000000000002' as Address, amount: parseEther('20') },
  ]);
  m.criteria = 'holders at block 25,900,000';
  return m;
})();

const onChain: OnChainCampaign = {
  merkleRoot: manifest.root,
  claimsOpen: true,
  expiresAt: 4_000_000_000,
  claimFeeWei: 0n,
};

describe('every missing input is unknown, never a verdict', () => {
  it('no wallet → no-wallet, and nothing is claimed to have been checked', () => {
    const r = evaluateEligibility({ manifest, account: null, onChain, claimed: false });
    expect(r.status).toBe('no-wallet');
    expect(r.canClaim).toBe(false);
    expect(r.detail).toMatch(/nothing has been checked/i);
  });

  it('no manifest → unknown, NOT not-listed', () => {
    const r = evaluateEligibility({ manifest: null, account: IN_LIST, onChain, claimed: false });
    expect(r.status).toBe('unknown');
    expect(r.title).toBe('No data');
    expect(r.detail).not.toMatch(/not eligible/i);
  });

  it('campaign read failed → unknown, and says which half is missing', () => {
    const r = evaluateEligibility({ manifest, account: IN_LIST, onChain: null, claimed: null });
    expect(r.status).toBe('unknown');
    expect(r.detail).toMatch(/could not be read/);
    // The list half IS known and is stated, so the wallet is not left guessing about
    // the part that did work.
    expect(r.detail).toMatch(/in the loaded list/);
    expect(r.canClaim).toBe(false);
  });

  it('claimed-bit read failed → unknown, not "still claimable"', () => {
    const r = evaluateEligibility({ manifest, account: IN_LIST, onChain, claimed: null });
    expect(r.status).toBe('unknown');
    expect(r.canClaim).toBe(false);
    expect(r.detail).toMatch(/did not return/);
  });
});

describe('the negatives each say something different', () => {
  it('absent from the list is the only "not eligible", and it prints the criteria', () => {
    const r = evaluateEligibility({ manifest, account: NOT_IN_LIST, onChain, claimed: false });
    expect(r.status).toBe('not-listed');
    expect(r.detail).toContain(NOT_IN_LIST);
    expect(r.detail).toContain('holders at block 25,900,000');
  });

  it('says so when the creator published no criteria, rather than implying there were none', () => {
    const bare = buildCampaign([{ account: IN_LIST, amount: 1n }]);
    const r = evaluateEligibility({ manifest: bare, account: NOT_IN_LIST, onChain: { ...onChain, merkleRoot: bare.root }, claimed: false });
    expect(r.detail).toMatch(/did not publish the selection criteria/);
  });

  it('already claimed names the index and where the tokens went', () => {
    const r = evaluateEligibility({ manifest, account: IN_LIST, onChain, claimed: true });
    expect(r.status).toBe('already-claimed');
    expect(r.detail).toContain('Index 0');
    // The LEAF's address, not the connected wallet's spelling of it — the distributor
    // pays the leaf, so that is the address a claimant needs to go looking at.
    expect(r.detail).toContain(getAddress(IN_LIST));
  });

  it('a closed window is its own verdict, with the closing time', () => {
    const r = evaluateEligibility({
      manifest,
      account: IN_LIST,
      onChain: { ...onChain, claimsOpen: false, expiresAt: 1_700_000_000 },
      claimed: false,
    });
    expect(r.status).toBe('window-closed');
    expect(r.detail).toMatch(/2023/);
  });

  it('a mismatched root is reported as the wrong list, not as ineligibility', () => {
    const r = evaluateEligibility({
      manifest,
      account: IN_LIST,
      onChain: { ...onChain, merkleRoot: `0x${'11'.repeat(32)}` as Hex },
      claimed: false,
    });
    expect(r.status).toBe('root-mismatch');
    // Checked BEFORE the row lookup: a wallet in the wrong list must not be told it
    // is eligible and sent into a claim that can only revert.
    expect(r.canClaim).toBe(false);
    expect(r.detail).toContain(manifest.root);
  });

  it('a damaged proof blames the manifest, not the wallet', () => {
    const damaged = buildCampaign([
      { account: IN_LIST, amount: parseEther('10') },
      { account: '0xbbbb000000000000000000000000000000000002' as Address, amount: parseEther('20') },
    ]);
    damaged.rows[0]!.proof = [`0x${'22'.repeat(32)}` as Hex];
    const r = evaluateEligibility({
      manifest: damaged,
      account: IN_LIST,
      onChain: { ...onChain, merkleRoot: damaged.root },
      claimed: false,
    });
    expect(r.status).toBe('proof-invalid');
    expect(r.detail).toMatch(/republish/);
  });
});

describe('canClaim is true for exactly one status', () => {
  it('is true only when the proof verified, the window is open and the slot is free', () => {
    const r = evaluateEligibility({ manifest, account: IN_LIST, onChain, claimed: false });
    expect(r.status).toBe('eligible');
    expect(r.canClaim).toBe(true);
    expect(r.row?.index).toBe(0);
  });

  it('is false for every other status the function can return', () => {
    const cases = [
      { manifest, account: null, onChain, claimed: false },
      { manifest: null, account: IN_LIST, onChain, claimed: false },
      { manifest, account: IN_LIST, onChain: null, claimed: null },
      { manifest, account: IN_LIST, onChain, claimed: null },
      { manifest, account: NOT_IN_LIST, onChain, claimed: false },
      { manifest, account: IN_LIST, onChain, claimed: true },
      { manifest, account: IN_LIST, onChain: { ...onChain, claimsOpen: false }, claimed: false },
    ];
    for (const input of cases) {
      const r = evaluateEligibility(input);
      expect(r.status, `${r.status} must not offer a claim button`).not.toBe('eligible');
      expect(r.canClaim).toBe(false);
    }
  });
});
