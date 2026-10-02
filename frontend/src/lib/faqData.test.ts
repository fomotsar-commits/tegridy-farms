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
