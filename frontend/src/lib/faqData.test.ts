import { describe, it, expect } from 'vitest';
import { venueFaq } from './faqData';
import { BUNGALOW_COUNT } from './bungalows';

// The island counts 12 bungalows and open lots. The registry keeps one open lot ('nb1',
// chain 'tbd') for its tile, so the FAQ reads the count that leaves it out.
describe('the FAQ counts bungalows the way the island does', () => {
  it('says how many bungalows there are, and the open lot is not one', () => {
    const answer = venueFaq(80).flatMap((s) => s.items).find((i) => i.q === 'What is a bungalow?')?.a;
    expect(answer).toContain(`There are ${BUNGALOW_COUNT} today.`);
  });
});

// Ethereum pairs never gate burn(), but the Solana pool program lets the team's vault switch
// withdrawals off on a pool (update_pool_status), so "any time" holds for one chain only.
describe('the FAQ says where removing can be paused', () => {
  it('promises removing any time only for Ethereum pools, and names the Solana pause', () => {
    const answer = venueFaq(80).flatMap((s) => s.items).find((i) => i.q === 'How does providing liquidity work?')?.a ?? '';
    expect(answer).not.toMatch(/withdraw any ?time/i);
    expect(answer).toContain('On Ethereum pools you can remove any time');
    expect(answer).toContain("the team's vault can pause removing");
  });
});
