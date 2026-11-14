import { describe, expect, it } from 'vitest';
import { cardanoscanToken } from './format';

// MIN on mainnet: policy id + asset name ("MIN" in hex).
const MIN_POLICY = '29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6';
const MIN_NAME = '4d494e';

describe('cardanoscanToken', () => {
  it('links a coin by its whole id, unchanged', () => {
    expect(cardanoscanToken(MIN_POLICY, MIN_NAME)).toBe(`https://cardanoscan.io/token/${MIN_POLICY}${MIN_NAME}`);
    expect(cardanoscanToken(MIN_POLICY, '')).toBe(`https://cardanoscan.io/token/${MIN_POLICY}`);
    expect(cardanoscanToken(MIN_POLICY.toUpperCase(), MIN_NAME)).toBe(`https://cardanoscan.io/token/${MIN_POLICY.toUpperCase()}${MIN_NAME}`);
  });

  it('never puts anything but hex in the link', () => {
    for (const [policy, name] of [
      [MIN_POLICY, '"><img src=x onerror=alert(1)>'],
      [MIN_POLICY, '4d494e/../../x'],
      [MIN_POLICY, '4d4'],
      [MIN_POLICY, 'ab'.repeat(33)],
      [`${MIN_POLICY.slice(0, 55)}"`, MIN_NAME],
      ['javascript:alert(1)', ''],
      [MIN_POLICY.slice(0, 54), MIN_NAME],
    ]) {
      expect(cardanoscanToken(policy, name)).toBe('https://cardanoscan.io/');
    }
  });
});
