// Towelie's Solana answers say what this build does: a swap at /solana, and our own curve
// at /curve-launch, where a maker at Resident or better launches through the heat door.
// The coins there are priced in SOL, so no answer calls them island coins.
import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_BASE, answerQuestion } from './towelieKnowledge';

const solanaAnswers = KNOWLEDGE_BASE.filter((e) => /solana/i.test(e.answer)).map((e) => e.answer);

describe("Towelie's Solana answers", () => {
  it('a question about launching on Solana reaches the Solana launch answer', () => {
    for (const q of ['launch a token on solana', 'Can I launch on Solana?', 'solana launch', 'create a token on solana']) {
      const a = answerQuestion(q);
      expect(a, q).toContain('/curve-launch');
      expect(a, q).toContain('a maker at Resident or better');
    }
  });

  it('a question about a curve or a memecoin on Solana reaches the Solana curve, not only the Ethereum one', () => {
    for (const q of [
      'is there a bonding curve on solana',
      'solana bonding curve',
      'curve on solana',
      'memecoin on solana',
      'graduate on solana',
    ]) {
      expect(answerQuestion(q), q).toContain('/curve-launch');
    }
  });

  it("a Solana question about a swap, a price or an order keeps its own answer", () => {
    expect(answerQuestion('solana swap')).toMatch(/^Jupiter is the router behind \/solana/);
    expect(answerQuestion('limit order solana')).toBe(answerQuestion('limit order'));
    expect(answerQuestion('sol price impact')).toBe(answerQuestion('price impact'));
  });

  it('a several-word keyword can match', () => {
    expect(answerQuestion('swap solana')).toMatch(/^Jupiter is the router behind \/solana/);
    expect(answerQuestion('meteora bonding curve')).toMatch(/^We don't run on Meteora any more\./);
  });

  it('launching without Solana in the question still reaches the Ethereum curve', () => {
    expect(answerQuestion('how do I launch a token')).toContain('/eth-curve');
    expect(answerQuestion('bonding curve')).toContain('/eth-curve');
  });

  it('no Solana answer says launching is off, swap-only, or waiting on fresh programs', () => {
    expect(solanaAnswers.length).toBeGreaterThan(3);
    for (const a of solanaAnswers) {
      expect(a).not.toMatch(
        /swap-only|isn't deployed yet|not live|nothing can be launched on solana|can't launch a solana token|need fresh addresses|no solana launches/i,
      );
    }
  });

  it('says who may launch on Solana, and never calls these coins island coins', () => {
    for (const k of ['network', 'solana', 'meteora']) {
      expect(KNOWLEDGE_BASE.find((e) => e.keywords.includes(k))!.answer, k).toContain('a maker at Resident or better');
    }
    const curve = KNOWLEDGE_BASE.filter((e) => e.answer.includes('/curve-launch')).map((e) => e.answer);
    expect(curve.length).toBeGreaterThanOrEqual(4);
    for (const a of curve) expect(a).not.toMatch(/island coin|born in \$?BAYLA/i);
    const main = answerQuestion('launch a token on solana');
    expect(main).toContain('memetics.finance gate, which reads the maker\'s wallet at create');
    expect(main).toContain('The program itself accepts any wallet, so check the full token address before you buy.');
  });

  it('the new Solana sentences add no em dash', () => {
    const solana = KNOWLEDGE_BASE.find((e) => e.keywords.includes('solana'))!.answer;
    const meteora = KNOWLEDGE_BASE.find((e) => e.keywords.includes('meteora'))!.answer;
    expect(solana).not.toContain('—');
    expect(meteora).not.toContain('—');
  });
});
