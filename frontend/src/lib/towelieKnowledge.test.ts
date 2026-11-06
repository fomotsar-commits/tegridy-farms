// Towelie's Solana answers say what this build does: a swap at /solana, and our own curve
// at /curve-launch. Who may launch there follows the curves' launch switches (island answer
// twenty-six): while a rail's launching is closed, no answer says a token can be launched on it.
// The coins there are priced in SOL, so no answer calls them island coins.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KNOWLEDGE_BASE, answerQuestion, type KnowledgeEntry } from './towelieKnowledge';

/** The bank as a build with these launch switches serves it: the EVM curve's, then the Solana curve's. */
async function bankWith(evm: boolean, solana: boolean) {
  vi.resetModules();
  vi.doMock('./launcher/curveChains', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./launcher/curveChains')>()),
    isCurveLaunchOpen: () => evm,
  }));
  vi.doMock('./launcher/solana/curveWriteFlag', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./launcher/solana/curveWriteFlag')>()),
    isCurveWriteEnabled: () => solana,
  }));
  return import('./towelieKnowledge');
}

afterEach(() => {
  vi.doUnmock('./launcher/curveChains');
  vi.doUnmock('./launcher/solana/curveWriteFlag');
  vi.resetModules();
});

const answerOf = (bank: KnowledgeEntry[], keyword: string) => bank.find((e) => e.keywords.includes(keyword))!.answer;

// Every way an answer has said a token can be launched now: "can launch", "launches on Base",
// "live on Ethereum, Base and Robinhood Chain", "live launches", "the launchers run", "where a maker
// at Resident or better launches".
const SAYS_LAUNCHING_IS_OPEN =
  /\b(?:can|may) (?:launch|plant)\b|\blaunches (?:tokens? )?on\b|\blive on (?:ethereum|base|robinhood)|\blive launches\b|\blaunchers run\b|\bwhere a maker[^.]*\blaunches\b/i;

describe("Towelie's Solana answers", () => {
  it('a question about launching on Solana reaches the Solana launch answer', () => {
    for (const q of ['launch a token on solana', 'Can I launch on Solana?', 'solana launch', 'create a token on solana']) {
      expect(answerQuestion(q), q).toContain('/curve-launch');
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
    expect(answerQuestion('solana swap')).toMatch(/^Jupiter is one of the two routes behind \/solana: .* When one of our own pools pays you at least as much, the trade goes to that pool instead\./);
    expect(answerQuestion('limit order solana')).toBe(answerQuestion('limit order'));
    expect(answerQuestion('sol price impact')).toBe(answerQuestion('price impact'));
  });

  it('a several-word keyword can match', () => {
    expect(answerQuestion('swap solana')).toMatch(/^Jupiter is one of the two routes behind \/solana/);
    expect(answerQuestion('meteora bonding curve')).toMatch(/^We don't run on Meteora any more\./);
  });

  it('launching without Solana in the question still reaches the Ethereum curve', () => {
    expect(answerQuestion('how do I launch a token')).toContain('/eth-curve');
    expect(answerQuestion('bonding curve')).toContain('/eth-curve');
  });

  it('never calls these coins island coins', () => {
    const curve = KNOWLEDGE_BASE.filter((e) => e.answer.includes('/curve-launch')).map((e) => e.answer);
    expect(curve.length).toBeGreaterThanOrEqual(4);
    for (const a of curve) expect(a).not.toMatch(/island coin|born in \$?BAYLA/i);
  });

  it('the new Solana sentences add no em dash', async () => {
    for (const [evm, solana] of [[false, false], [true, true]] as const) {
      const { KNOWLEDGE_BASE: bank } = await bankWith(evm, solana);
      expect(answerOf(bank, 'solana'), `${evm}/${solana}`).not.toContain('—');
      expect(answerOf(bank, 'meteora'), `${evm}/${solana}`).not.toContain('—');
    }
  });
});

describe('while launching is closed on every rail (island answer twenty-six)', () => {
  it('no answer says a token can be launched', async () => {
    const { KNOWLEDGE_BASE: bank } = await bankWith(false, false);
    const claims = bank
      .filter((e) => SAYS_LAUNCHING_IS_OPEN.test(e.answer))
      .map((e) => `${e.keywords[0]}: "${e.answer.match(SAYS_LAUNCHING_IS_OPEN)![0]}"`);
    expect(claims).toEqual([]);
  });

  it('each answer that says where tokens launch says launching a new token is not switched on yet', async () => {
    const { KNOWLEDGE_BASE: bank, answerQuestion: ask } = await bankWith(false, false);
    for (const k of ['launch', 'network', 'solana', 'meteora', 'l2']) {
      expect(answerOf(bank, k), k).toMatch(/launching a new token[^.]* not switched on yet/i);
    }
    expect(ask('how do I launch a token')).toContain('/eth-curve');
    expect(ask('launch a token on solana')).toContain('/curve-launch');
  });
});

describe("once a curve's launching is open", () => {
  it('says who may launch, and through which gate', async () => {
    const { KNOWLEDGE_BASE: bank, answerQuestion: ask } = await bankWith(true, true);
    for (const q of ['launch a token on solana', 'Can I launch on Solana?', 'solana launch', 'create a token on solana']) {
      expect(ask(q), q).toContain('a maker at Resident or better');
    }
    for (const k of ['network', 'solana', 'meteora']) expect(answerOf(bank, k), k).toContain('a maker at Resident or better');
    const main = ask('launch a token on solana');
    expect(main).toContain('memetics.finance gate, which reads the maker\'s wallet at create');
    expect(main).toContain('The program itself accepts any wallet, so check the full token address before you buy.');
    expect(ask('how do I launch a token')).toContain('live on Ethereum, Base and Robinhood Chain at /eth-curve');
  });

  it('no Solana answer says launching is off, swap-only, or waiting on fresh programs', async () => {
    const { KNOWLEDGE_BASE: bank } = await bankWith(true, true);
    const solanaAnswers = bank.filter((e) => /solana/i.test(e.answer)).map((e) => e.answer);
    expect(solanaAnswers.length).toBeGreaterThan(3);
    for (const a of solanaAnswers) {
      expect(a).not.toMatch(
        /swap-only|isn't deployed yet|not live|not switched on|nothing can be launched on solana|can't launch a solana token|need fresh addresses|no solana launches/i,
      );
    }
  });

  it('an answer naming both curves says a launch is open only on the one that is', async () => {
    for (const [evm, solana] of [[true, false], [false, true]] as const) {
      const { KNOWLEDGE_BASE: bank } = await bankWith(evm, solana);
      const at = `EVM ${evm ? 'open' : 'closed'}, Solana ${solana ? 'open' : 'closed'}`;
      const chains = answerOf(bank, 'network');
      expect(chains.includes('the Memetics Curve also launches on Base and Robinhood Chain'), at).toBe(evm);
      expect(chains.includes('a maker at Resident or better can launch'), at).toBe(solana);
      const meteora = answerOf(bank, 'meteora');
      expect(meteora, at).not.toMatch(SAYS_LAUNCHING_IS_OPEN);
      expect(meteora, at).toContain(`launching a new token on ${evm ? 'Solana' : 'Ethereum, Base and Robinhood'} is not switched on yet`);
    }
  });
});
