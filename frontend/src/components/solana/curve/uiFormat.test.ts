// UX3: iOS Safari zooms the page when a text field under 16px gets focus, on iPhone
// and on iPad alike. index.css's site-wide `font-size: max(16px, inherit)` is invalid
// CSS (inherit is not allowed inside max()), so browsers drop it and it protects
// nothing: the field's own class must be 16px at EVERY breakpoint.
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PLATFORM_TREASURY_VAULT, describeTreasury } from '../../../lib/launcher/solana/curve';
import { inputCls, reserveDisclosure, supplySentence } from './uiFormat';

describe('curve form fields', () => {
  it('are at least 16px on every screen size', () => {
    const sizes = [...inputCls.matchAll(/(?:^|\s)(?:[a-z0-9-]+:)*text-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const px of sizes) expect(px).toBeGreaterThanOrEqual(16);
    // No named Tailwind size either (text-sm is 14px, text-xs 12px).
    expect(inputCls).not.toMatch(/(?:^|\s)(?:[a-z0-9-]+:)*text-(?:xs|sm)(?:\s|$)/);
  });
});

describe('supply sentence', () => {
  const other = describeTreasury(new PublicKey(new Uint8Array(32).fill(4)));
  it('says "the whole supply" only when there is no platform reserve', () => {
    expect(supplySentence(0n, other)).toMatch(/^The whole supply goes onto the curve\./);
    expect(supplySentence(369n, other)).not.toMatch(/whole supply/i);
    expect(supplySentence(369n, other)).toMatch(/^96\.31% of the supply goes onto the curve\. The other 3\.69%/);
  });

  it('says the reserve is sent at creation, never that it waits for graduation', () => {
    const s = supplySentence(369n, other);
    expect(s).toContain(`sent to ${other.name} in the same transaction that creates the token`);
    expect(s).not.toMatch(/graduat|release|held by the program/i);
  });
});

describe('reserve disclosure', () => {
  const other = describeTreasury(new PublicKey(new Uint8Array(32).fill(4)));
  const vault = describeTreasury(PLATFORM_TREASURY_VAULT);

  it('says when, to whom, and that the program does not stop the treasury selling', () => {
    expect(reserveDisclosure('3.69% of the supply', vault, 'will')).toBe(
      'When the token is created, the platform receives 3.69% of the supply, sent to the platform treasury (a multisig). ' +
        'The program does not stop the treasury selling those tokens, including while the curve is live.',
    );
    expect(reserveDisclosure('3.69% of the supply', vault, 'was')).toMatch(
      /^When this token was created, the platform received 3\.69% of the supply, sent to the platform treasury \(a multisig\)\./,
    );
  });

  it('calls the treasury a multisig only when it is the known vault', () => {
    const s = reserveDisclosure('3.69% of the supply', other, 'was');
    expect(s).not.toMatch(/\(a multisig\)/);
    expect(s).toContain('This page cannot confirm that the treasury is a multisig.');
    // An unread config names no one and claims nothing.
    expect(reserveDisclosure('3.69% of the supply', describeTreasury(null), 'will')).toContain(
      'sent to the platform treasury. This page cannot confirm',
    );
  });
});
