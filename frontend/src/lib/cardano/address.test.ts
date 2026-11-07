import { describe, expect, it } from 'vitest';
import { composeAddress, parseAddressBech32, parseAddressHex, shortCardanoAddress } from './address';

// Real mainnet addresses (Minswap V2's deployed/mainnet/script.json, and a trader's from an order).
const POOL_CREATION = 'addr1z84q0denmyep98ph3tmzwsmw0j7zau9ljmsqx6a4rvaau66j2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pq777e2a';
const ORDER_ENTERPRISE = 'addr1w8p79rpkcdz8x9d6tft0x0dx5mwuzac2sa4gm8cvkw5hcnqst2ctf';
const TRADER = 'addr1qyawx3jznhwfhsen5kg3dq4nxgvkexrw7fa6uj8qkx95cynn60n5e0298xn7eyj7lzks2lv5tcmxsqsu7ne7sa7jf4xsulzg6g';

describe('Cardano addresses', () => {
  it('reads a script base address: payment script, stake key', () => {
    const a = parseAddressBech32(POOL_CREATION)!;
    expect(a.network).toBe(1);
    expect(a.payment).toEqual({ kind: 'script', hash: 'ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b' });
    expect(a.stake).toEqual({ kind: 'key', hash: '52563c5410bff6a0d43ccebb7c37e1f69f5eb260552521adff33b9c2' });
    expect(a.bech32).toBe(POOL_CREATION);
  });

  it('reads an enterprise address, with no stake part', () => {
    const a = parseAddressBech32(ORDER_ENTERPRISE)!;
    expect(a.payment).toEqual({ kind: 'script', hash: 'c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c' });
    expect(a.stake).toBeNull();
  });

  it('round-trips through hex and composes the same bytes', () => {
    const a = parseAddressBech32(TRADER)!;
    expect(parseAddressHex(a.hex)?.bech32).toBe(TRADER);
    expect(composeAddress(a.payment, a.stake).hex).toBe(a.hex);
  });

  it('refuses what it cannot pay: garbage, a wrong length, a reward address, a prefix that lies', () => {
    expect(parseAddressBech32('addr1notreal')).toBeNull();
    expect(parseAddressHex('01' + '00'.repeat(27))).toBeNull();
    expect(parseAddressHex('e1' + '00'.repeat(28))).toBeNull(); // reward address
    expect(parseAddressHex('zz')).toBeNull();
  });

  it('shortens for a chip only', () => {
    expect(shortCardanoAddress(TRADER)).toBe('addr1qyawx…ulzg6g');
  });
});
