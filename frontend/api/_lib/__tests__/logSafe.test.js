// AUDIT R057: tests for the log-redaction wrapper used by api/ handlers.
//
// Coverage:
//   - 64-hex private keys redacted
//   - 12-24 word mnemonics redacted
//   - JWT (eyJ...) redacted
//   - Bearer tokens redacted
//   - 40-hex wallet addresses redacted
//   - key=value patterns where key matches secret regex
//   - URLs with secret querystring params redacted
//   - URLs with userinfo password redacted
//   - non-secret data preserved
//   - non-Error inputs (object, primitive, undefined) handled
//   - circular references handled

import { describe, it, expect } from 'vitest';
import { logSafe, __test__ } from '../logSafe.js';

describe('logSafe — secret redaction', () => {
  it('redacts 64-hex private keys', () => {
    const key = '0x' + 'a'.repeat(64);
    const out = logSafe(new Error(`failed with ${key}`));
    expect(out).not.toContain(key);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts 12-word BIP-39 mnemonics', () => {
    const mnemonic =
      'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const out = logSafe(new Error(`Wallet import failed: ${mnemonic}`));
    expect(out).not.toContain('abandon ability');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signaturepart';
    const out = logSafe(new Error(`token=${jwt}`));
    expect(out).not.toContain(jwt);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts Bearer tokens', () => {
    const out = logSafe(new Error('Authorization: Bearer abc123def456ghi'));
    expect(out).not.toContain('abc123def456ghi');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts 40-hex wallet addresses', () => {
    const wallet = '0x' + 'b'.repeat(40);
    const out = logSafe(new Error(`maker ${wallet} not found`));
    expect(out).not.toContain(wallet);
    expect(out).toContain('0x[REDACTED]');
  });
});

describe('logSafe — key-name redaction', () => {
  it('redacts apiKey=value patterns', () => {
    const out = logSafe(new Error('Request failed: apiKey=ABC123XYZ secret stuff'));
    expect(out).not.toContain('ABC123XYZ');
    expect(out).toContain('apiKey=[REDACTED]');
  });

  it('redacts api_key=value patterns', () => {
    const out = logSafe(new Error('api_key=plaintext_value here'));
    expect(out).not.toContain('plaintext_value');
    expect(out).toContain('api_key=[REDACTED]');
  });

  it('redacts authorization=value patterns', () => {
    const out = logSafe(new Error('authorization=mysecret123'));
    expect(out).not.toContain('mysecret123');
    expect(out).toContain('authorization=[REDACTED]');
  });

  it('redacts password=value patterns', () => {
    const out = logSafe(new Error('password=hunter2'));
    expect(out).not.toContain('hunter2');
    expect(out).toContain('password=[REDACTED]');
  });

  it('redacts x-api-key=value patterns', () => {
    const out = logSafe(new Error('x-api-key=secretkey12345'));
    expect(out).not.toContain('secretkey12345');
    expect(out).toContain('x-api-key=[REDACTED]');
  });

  it('redacts secret-named values in JSON-shaped objects', () => {
    const obj = {
      ok: false,
      apiKey: 'thisisasecret',
      authorization: 'Bearer xyz',
      message: 'request failed',
    };
    const out = logSafe(obj);
    expect(out).not.toContain('thisisasecret');
    expect(out).toContain('[REDACTED]');
    // Non-secret keys preserved
    expect(out).toContain('"ok"');
    expect(out).toContain('"message"');
  });
});

describe('logSafe — URL redaction', () => {
  it('redacts secret querystring params from valid URLs', () => {
    const out = logSafe(
      new Error('GET https://api.example.com/v1?token=abc123secret&user=foo failed')
    );
    expect(out).not.toContain('abc123secret');
    expect(out).toContain('user=foo');
    expect(out).toContain('token=%5BREDACTED%5D'); // url-encoded
  });

  it('redacts apiKey querystring param', () => {
    const out = logSafe(
      new Error('Upstash error: https://eu1-redis.upstash.io/get/key?apiKey=tokensecret')
    );
    expect(out).not.toContain('tokensecret');
    expect(out).toContain('eu1-redis.upstash.io');
  });

  it('redacts password from URL userinfo', () => {
    const out = logSafe(
      new Error('Connection failed: https://admin:supersecretpw@host.example.com/path')
    );
    expect(out).not.toContain('supersecretpw');
    expect(out).toContain('host.example.com');
  });

  it('preserves URLs with no secrets', () => {
    const url = 'https://api.example.com/path?id=42&name=test';
    const out = logSafe(new Error(`request to ${url} failed`));
    expect(out).toContain('id=42');
    expect(out).toContain('name=test');
  });

  // AUDIT R048: legacy Alchemy / Etherscan v1 embedded the API key as a URL
  // path segment. Even though we moved to header auth, residual error
  // messages — cached upstream HTML, third-party stack traces, etc. — can
  // still echo the old URL shape. logSafe must scrub those segments.
  it('redacts Alchemy-style path-segment API keys', () => {
    const fakeKey = 'ABCDEF1234567890ZZZZ_KEY';
    const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${fakeKey}/getFloorPrice?contractAddress=0xabc`;
    const out = logSafe(new Error(`upstream failed: ${url}`));
    expect(out).not.toContain(fakeKey);
    expect(out).toContain('eth-mainnet.g.alchemy.com');
    expect(out).toContain('getFloorPrice');
  });

  it('preserves short path slugs that are not key-shaped', () => {
    const url = 'https://api.opensea.io/api/v2/listings/collection/nakamigos/best';
    const out = logSafe(new Error(`hit ${url}`));
    expect(out).toContain('nakamigos');
    expect(out).toContain('listings');
  });
});

describe('logSafe — preserves non-secret data', () => {
  it('preserves a normal error message', () => {
    const out = logSafe(new Error('Order not found'));
    expect(out).toBe('Order not found');
  });

  it('preserves Supabase-style PostgrestError shape', () => {
    const pgErr = {
      message: 'duplicate key value violates unique constraint "siwe_nonces_pkey"',
      code: '23505',
      details: null,
      hint: null,
    };
    const out = logSafe(pgErr);
    expect(out).toContain('duplicate key value');
    expect(out).toContain('siwe_nonces_pkey');
  });

  it('preserves numeric and boolean primitives', () => {
    expect(logSafe(404)).toBe('404');
    expect(logSafe(true)).toBe('true');
  });
});

describe('logSafe — edge cases', () => {
  it('handles null/undefined', () => {
    expect(logSafe(null)).toBe('[no error]');
    expect(logSafe(undefined)).toBe('[no error]');
  });

  it('handles a string input', () => {
    const out = logSafe('plain string error apiKey=secretval');
    expect(out).not.toContain('secretval');
    expect(out).toContain('apiKey=[REDACTED]');
  });

  it('handles circular references safely', () => {
    const a = { name: 'a', token: 'realsecret' };
    a.self = a;
    const out = logSafe(a);
    expect(out).not.toContain('realsecret');
    expect(out).toContain('[Circular]');
  });

  it('handles Error subclass instances', () => {
    class MyErr extends Error {}
    const e = new MyErr('something broke at apiKey=oops');
    const out = logSafe(e);
    expect(out).not.toContain('oops');
    expect(out).toContain('apiKey=[REDACTED]');
  });

  it('caps very long output', () => {
    const long = 'x'.repeat(5000);
    const out = logSafe(new Error(long));
    expect(out.length).toBeLessThanOrEqual(2010);
  });

  it('handles error with empty message', () => {
    const e = new Error('');
    e.name = 'ValidationError';
    const out = logSafe(e);
    expect(out).toBe('ValidationError');
  });
});

describe('logSafe — internal helpers', () => {
  it('SECRET_KEY_RE matches expected key names', () => {
    const re = __test__.SECRET_KEY_RE;
    expect(re.test('authorization')).toBe(true);
    expect(re.test('cookie')).toBe(true);
    expect(re.test('apiKey')).toBe(true);
    expect(re.test('api_key')).toBe(true);
    expect(re.test('api-key')).toBe(true);
    expect(re.test('x-api-key')).toBe(true);
    expect(re.test('secret')).toBe(true);
    expect(re.test('token')).toBe(true);
    expect(re.test('password')).toBe(true);
    // Non-secret keys
    expect(re.test('username')).toBe(false);
    expect(re.test('email')).toBe(false);
    expect(re.test('description')).toBe(false);
  });

  it('redactUrlsInString preserves http URL structure', () => {
    const out = __test__.redactUrlsInString('hit https://x.com/?token=abc');
    expect(out).toContain('https://x.com/');
    expect(out).not.toContain('abc');
  });
});
