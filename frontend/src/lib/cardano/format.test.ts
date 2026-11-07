import { describe, expect, it } from 'vitest';
import { cardanoscanToken } from './format';

const POLICY = '29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6';

describe('cardanoscanToken', () => {
  it('links a coin by its whole hex id', () => {
    expect(cardanoscanToken(POLICY, '4d494e')).toBe(`https://cardanoscan.io/token/${POLICY}4d494e`);
    expect(cardanoscanToken(POLICY, '')).toBe(`https://cardanoscan.io/token/${POLICY}`);
  });

  it('never puts anything but hex in the link', () => {
    for (const [policy, name] of [
      ['javascript:alert(1)', ''],
      [POLICY, '"><img src=x onerror=alert(1)>'],
      [`${POLICY}/../../evil`, ''],
      [POLICY, '4d 49'],
    ]) {
      const url = cardanoscanToken(policy!, name!);
      expect(url).toBe('https://cardanoscan.io/');
    }
  });
});
