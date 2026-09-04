// These tests sign with a REAL key and verify with viem's REAL offline verifier.
//
// A stubbed verifier would prove only that this module calls the thing it was
// handed. What has to be true is that the signature actually binds every field a
// buyer reads, so each field is mutated by one unit and the verification must
// flip to `forged` — which is a property of the EIP-712 type list, not of any
// code in this file, and the only way to pin it is to do the cryptography.

import { describe, it, expect, vi } from 'vitest';
import { verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SITE_URL } from '../constants';
import { INVOICE_ID_RE, type Invoice } from './invoice';
import {
  decodePaymentLink,
  encodePaymentLink,
  invoiceTypedData,
  MAX_LINK_PAYLOAD_CHARS,
  newInvoiceId,
  parseFragment,
  paymentLinkUrl,
  verifyPaymentLink,
  type PaymentLinkVerifier,
} from './paymentLink';

const KEY = `0x${'11'.repeat(32)}` as const;
const merchant = privateKeyToAccount(KEY);

const NOW = 1_760_000_000;

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-abc234def567',
    merchant: merchant.address,
    chainId: 1,
    settleToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    settleSymbol: 'USDC',
    settleDecimals: 6,
    settleAmount: 100_000_000n,
    memo: 'one towel, delivered',
    expiresAt: NOW + 900,
    createdAt: NOW - 60,
    ...over,
  };
}

async function sign(inv: Invoice): Promise<`0x${string}`> {
  const { domain, types, primaryType, message } = invoiceTypedData(inv);
  return merchant.signTypedData({ domain, types, primaryType, message });
}

/** viem's own verifier, offline. The same call `publicClient.verifyTypedData` makes. */
const offlineVerifier: PaymentLinkVerifier = (args) => verifyTypedData(args);

async function verifyLink(inv: Invoice, signature: `0x${string}`) {
  const decoded = decodePaymentLink(`#i=${encodePaymentLink(inv, signature)}`);
  expect(decoded.kind).toBe('decoded');
  if (decoded.kind !== 'decoded') throw new Error('unreachable');
  return verifyPaymentLink(decoded, offlineVerifier);
}

describe('the link carries the invoice, byte for byte', () => {
  it('round-trips every field, with an amount well past 2^53', () => {
    const inv = invoice({ settleAmount: 2n ** 64n + 1n });
    const decoded = decodePaymentLink(`#i=${encodePaymentLink(inv, `0x${'ab'.repeat(65)}`)}`);
    expect(decoded.kind).toBe('decoded');
    if (decoded.kind !== 'decoded') return;
    expect(decoded.invoice).toEqual(inv);
    // The one that would silently round through a JSON number.
    expect(decoded.invoice.settleAmount).toBe(2n ** 64n + 1n);
  });

  it('survives a memo of non-ASCII text', () => {
    const inv = invoice({ memo: 'Grünkohl — 2 × ✓ 日本語' });
    const decoded = decodePaymentLink(`#i=${encodePaymentLink(inv, `0x${'ab'.repeat(65)}`)}`);
    if (decoded.kind !== 'decoded') throw new Error('expected decoded');
    expect(decoded.invoice.memo).toBe('Grünkohl — 2 × ✓ 日本語');
  });

  it('mints a link on the canonical origin, in the fragment', () => {
    const url = paymentLinkUrl('PAYLOAD');
    expect(url).toBe(`${SITE_URL}/checkout#i=PAYLOAD`);
    expect(url).toContain('#i=');
    // RFC 3986 §3.5: a fragment is never sent to a server. A `?` here would put
    // the whole document in every access log between the two browsers.
    expect(url.split('#')[0]).not.toContain('?');
  });

  it('appends a proof hash without disturbing the payload', () => {
    const hash = `0x${'cd'.repeat(32)}` as const;
    expect(paymentLinkUrl('PAYLOAD', hash)).toBe(`${SITE_URL}/checkout#i=PAYLOAD&tx=${hash}`);
    expect(parseFragment(`#i=PAYLOAD&tx=${hash}`)).toEqual({ i: 'PAYLOAD', tx: hash });
  });
});

describe('the signature binds every field a buyer reads', () => {
  it('verifies an untouched link', async () => {
    const inv = invoice();
    await expect(verifyLink(inv, await sign(inv))).resolves.toMatchObject({ status: 'verified' });
  });

  // ONE mutation per field, each of which must flip the verdict. A field left
  // out of INVOICE_TYPES would sail through its own case here and nowhere else.
  const mutations: Array<[string, Partial<Invoice>]> = [
    ['id', { id: 'inv-abc234def568' }],
    ['merchant', { merchant: '0x2222222222222222222222222222222222222222' }],
    ['settleToken', { settleToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }],
    ['settleAmount', { settleAmount: 100_000_001n }],
    ['settleDecimals', { settleDecimals: 18 }],
    ['settleSymbol', { settleSymbol: 'USDT' }],
    ['memo', { memo: 'one towel, delivered.' }],
    ['createdAt', { createdAt: NOW - 59 }],
    ['expiresAt', { expiresAt: NOW + 901 }],
  ];

  for (const [field, patch] of mutations) {
    it(`refuses a link whose ${field} was edited after signing`, async () => {
      const signed = invoice();
      const signature = await sign(signed);
      // Editing `merchant` is the attack that pays a stranger: the address in
      // the message is also the address the signature is checked against, so
      // re-pointing a valid signature recovers a third address and fails. What
      // this does NOT prevent — and the surface says so — is that stranger
      // signing their OWN invoice naming themselves.
      await expect(verifyLink({ ...signed, ...patch }, signature)).resolves.toMatchObject({ status: 'forged' });
    });
  }

  it('refuses a mainnet invoice re-presented as a Base one', async () => {
    // chainId lives in the EIP-712 DOMAIN, so a link cannot be moved between
    // chains — where the same token address means something else entirely.
    const signed = invoice({ chainId: 1 });
    const signature = await sign(signed);
    const moved = { ...signed, chainId: 8453 };
    await expect(verifyLink(moved, signature)).resolves.toMatchObject({ status: 'forged' });
  });

  it('refuses a signature from a different wallet for the same document', async () => {
    const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
    const inv = invoice();
    const { domain, types, primaryType, message } = invoiceTypedData(inv);
    const signature = await other.signTypedData({ domain, types, primaryType, message });
    await expect(verifyLink(inv, signature)).resolves.toMatchObject({ status: 'forged' });
  });
});

describe('the three verification outcomes never collapse', () => {
  it('reports a thrown verifier as unverifiable, not as forged', async () => {
    const inv = invoice();
    const decoded = decodePaymentLink(`#i=${encodePaymentLink(inv, await sign(inv))}`);
    if (decoded.kind !== 'decoded') throw new Error('expected decoded');
    const verdict = await verifyPaymentLink(decoded, () => Promise.reject(new Error('rpc: 429 rate limited')));
    expect(verdict.status).toBe('unverifiable');
    if (verdict.status !== 'unverifiable') return;
    expect(verdict.detail).toContain('429');
  });

  it('reports a false verifier as forged, not as unverifiable', async () => {
    const inv = invoice();
    const decoded = decodePaymentLink(`#i=${encodePaymentLink(inv, await sign(inv))}`);
    if (decoded.kind !== 'decoded') throw new Error('expected decoded');
    const verdict = await verifyPaymentLink(decoded, () => Promise.resolve(false));
    expect(verdict.status).toBe('forged');
    if (verdict.status !== 'forged') return;
    expect(verdict.merchant).toBe(inv.merchant);
  });
});

describe('a fragment is a stranger\'s input and is bounded before it is trusted', () => {
  it('rejects an oversized payload without ever parsing it', () => {
    const spy = vi.spyOn(JSON, 'parse');
    const huge = 'A'.repeat(MAX_LINK_PAYLOAD_CHARS + 1);
    const decoded = decodePaymentLink(`#i=${huge}`);
    expect(decoded.kind).toBe('unreadable');
    // The cap has to come BEFORE the work, or it is a cap on nothing.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reads an empty fragment as none, which is not a failure', () => {
    expect(decodePaymentLink('').kind).toBe('none');
    expect(decodePaymentLink('#').kind).toBe('none');
    expect(decodePaymentLink('#tab=pay').kind).toBe('none');
  });

  const badPayloads: Array<[string, Record<string, unknown>]> = [
    ['a version this build does not read', { v: 2 }],
    ['no signature at all', { sig: undefined }],
    ['a signature that is not hex', { sig: `0xZZ${'ab'.repeat(64)}` }],
    ['a signature far too short', { sig: '0xabcd' }],
    ['a fractional amount', { settleAmount: '12.5' }],
    ['an amount that is not a number at all', { settleAmount: 'lots' }],
    ['a missing merchant', { merchant: undefined }],
    ['a merchant that is not an address', { merchant: '0xnope' }],
  ];

  for (const [label, patch] of badPayloads) {
    it(`refuses ${label}, with no invoice produced`, () => {
      const wire: Record<string, unknown> = {
        v: 1,
        id: 'inv-abc234def567',
        merchant: merchant.address,
        chainId: 1,
        settleToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        settleSymbol: 'USDC',
        settleDecimals: 6,
        settleAmount: '100000000',
        memo: '',
        expiresAt: NOW + 900,
        createdAt: NOW - 60,
        sig: `0x${'ab'.repeat(65)}`,
        ...patch,
      };
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete wire[k];
      const b64 = btoa(JSON.stringify(wire)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const decoded = decodePaymentLink(`#i=${b64}`);
      expect(decoded.kind).toBe('unreadable');
      expect(decoded).not.toHaveProperty('invoice');
    });
  }

  it('refuses a transaction reference that is not a 32-byte hash', () => {
    const payload = encodePaymentLink(invoice(), `0x${'ab'.repeat(65)}`);
    const decoded = decodePaymentLink(`#i=${payload}&tx=0xdeadbeef`);
    expect(decoded.kind).toBe('unreadable');
    if (decoded.kind !== 'unreadable') return;
    expect(decoded.detail).toMatch(/32-byte hash/);
  });

  it('refuses a payload that is not readable text', () => {
    // Valid base64 whose bytes are not valid UTF-8. A non-fatal decoder would
    // hand replacement characters to JSON.parse instead of saying it cannot read.
    expect(decodePaymentLink('#i=' + btoa('\xff\xfe\xfd')).kind).toBe('unreadable');
  });
});

describe('minting an invoice id', () => {
  it('always produces something the store and the validator both accept', () => {
    // A deterministic PRNG so the 1000 draws are the same 1000 every run; the
    // property under test is the SHAPE, and a flaky id regex is a flaky checkout.
    let seed = 0x2545f491;
    const random = (n: number) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        out[i] = (seed >>> 16) & 0xff;
      }
      return out;
    };
    for (let i = 0; i < 1000; i++) {
      const id = newInvoiceId(random);
      expect(id).toMatch(INVOICE_ID_RE);
      expect(id.startsWith('inv-')).toBe(true);
    }
  });

  it('does not repeat itself across draws from real randomness', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newInvoiceId((n) => crypto.getRandomValues(new Uint8Array(n)))));
    expect(ids.size).toBe(200);
  });
});
