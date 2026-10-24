// lib/dropRules.ts tells the NFT owner panel which template a collection runs and
// where its 24-hour changes stand. The keys and the flag are the contract's own: if
// TegridyDropV2.sol renames one, these fail rather than the panel reading a clock
// that never moves.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak256, toBytes, toFunctionSelector } from 'viem';
import {
  DROP_PROPOSAL_VALIDITY_SECONDS, DROP_TIMELOCK_KEYS, cloneImplementation, isPricingModeSwitch, proposalState, rulesFromCode,
} from './dropRules';

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'contracts', 'src', 'TegridyDropV2.sol'),
  'utf-8',
);

describe('the contract\'s own names', () => {
  it.each([
    ['mintPrice', 'MINT_PRICE_CHANGE'],
    ['dutchAuction', 'DUTCH_CONFIG_CHANGE'],
    ['merkleRoot', 'MERKLE_ROOT_CHANGE'],
  ] as const)('%s is keccak256 of the string %s hashes', (ours, constant) => {
    const m = new RegExp(`${constant} = keccak256\\("([^"]+)"\\)`).exec(SOURCE);
    expect(m, `${constant} not found in TegridyDropV2.sol`).not.toBeNull();
    expect(DROP_TIMELOCK_KEYS[ours]).toBe(keccak256(toBytes(m![1]!)));
  });

  it('the new-price flag is a public bool of the source, so its getter is in the dispatcher', () => {
    expect(SOURCE).toMatch(/bool public fixedPriceNeedsProposal;/);
  });

  it('a proposal expires 7 days after it is ready, as TimelockAdmin says', () => {
    const base = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'contracts', 'src', 'base', 'TimelockAdmin.sol'), 'utf-8');
    expect(base).toMatch(/PROPOSAL_VALIDITY = 7 days;/);
    expect(DROP_PROPOSAL_VALIDITY_SECONDS).toBe(7 * 86_400);
  });
});

describe('reading a collection\'s template', () => {
  const template = 'a35ec3e20c4361144b0d99573dea00b67873e872';
  const clone = `0x363d3d373d3d3d363d73${template}5af43d82803e903d91602b57fd5bf3` as const;

  it('finds the template a minimal-proxy clone delegates to', () => {
    expect(cloneImplementation(clone)).toBe(`0x${template}`);
  });

  it('reads anything else as not a clone', () => {
    expect(cloneImplementation('0x6080604052')).toBeNull();
    expect(cloneImplementation(`${clone}00`)).toBeNull();
  });

  it('tells the fixed template by its dispatcher entry for fixedPriceNeedsProposal', () => {
    const sel = toFunctionSelector('fixedPriceNeedsProposal()').slice(2);
    expect(rulesFromCode(`0x608060${'00'.repeat(8)}63${sel}14`)).toBe('needs-new-price');
    // The selector's bytes as data, without PUSH4 in front, are not a dispatcher entry.
    expect(rulesFromCode(`0x608060${sel}00`)).toBe('instant-switch');
  });
});

describe('where a change stands', () => {
  it('none, waiting, ready, then expired after 7 days', () => {
    expect(proposalState(0n, 1_000)).toBe('none');
    expect(proposalState(2_000n, 1_999)).toBe('waiting');
    expect(proposalState(2_000n, 2_000)).toBe('ready');
    expect(proposalState(2_000n, 2_000 + 7 * 86_400)).toBe('ready');
    expect(proposalState(2_000n, 2_001 + 7 * 86_400)).toBe('expired');
  });

  it('a switch between a fixed price and an auction, either way, is a pricing-mode switch', () => {
    expect(isPricingModeSwitch(2, 3)).toBe(true);
    expect(isPricingModeSwitch(1, 3)).toBe(true);
    expect(isPricingModeSwitch(3, 2)).toBe(true);
    expect(isPricingModeSwitch(0, 3)).toBe(false);
    expect(isPricingModeSwitch(3, 0)).toBe(false);
    expect(isPricingModeSwitch(1, 2)).toBe(false);
  });
});
