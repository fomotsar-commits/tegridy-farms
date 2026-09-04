// THE INVOICE IS THE LINK.
//
// A merchant signs an EIP-712 document with their own wallet; the document plus
// the signature travel in the URL FRAGMENT; the buyer's browser verifies the
// signature against the merchant address before a single figure is rendered as a
// debt. No store, no migration, no server, no account. Lose the link and the
// merchant signs another.
//
// ─── WHY THE FRAGMENT AND NOT THE QUERY STRING ──────────────────────────────
//
// RFC 3986 §3.5: the fragment is dereferenced by the client and is NOT sent to
// the server. A payment document in `?i=` would be in every access log, every
// referrer header and every CDN cache along the way. In `#i=` it is only ever in
// the two browsers that hold the link.
//
// ─── WHAT THE SIGNATURE PROVES, AND WHAT IT DOES NOT ────────────────────────
//
// It proves INTEGRITY and SIGNER: nothing in the message changed since that
// wallet signed it, and that wallet signed it. It proves nothing about identity
// — a stranger can sign a perfectly valid invoice naming their own address. So
// the buyer's surface says, in words, to compare the merchant address with the
// one the merchant gave them, and the memo is labelled as the merchant's own
// unchecked words.
//
// ─── WHY chainId LIVES IN THE DOMAIN ────────────────────────────────────────
//
// The EIP-712 domain separator carries `chainId`, so a signature produced for
// chain 1 verifies false when the same message is presented as chain 8453. That
// is the cheapest possible defence against replaying a mainnet invoice onto an
// L2 where the same token address means something else, and it is why chainId is
// deliberately NOT a field of the message.
//
// There is no `verifyingContract`: no contract verifies these, none exists, and
// naming one would be describing a call nobody can make.
//
// ─── EVERY INPUT HERE COMES FROM A STRANGER ─────────────────────────────────
//
// A fragment is whatever the last person to touch the link typed. So the payload
// is size-capped BEFORE it is decoded or parsed, the signature is bounded at both
// ends, the transaction reference must be a 32-byte hash, and the invoice itself
// goes through `invoiceFromWire`, which returns null rather than defaulting a
// missing field. Nothing here has a fallback value; every failure is `unreadable`
// and `unreadable` says nothing about any merchant.

import { isAddress, type Hex } from 'viem';
import { SITE_URL } from '../constants';
import {
  INVOICE_ID_RE,
  invoiceFromWire,
  invoiceToWire,
  type Invoice,
} from './invoice';
import { TX_HASH_RE } from './settlement';

/** Bumped only for a change that makes an older link mean something different. */
export const PAYMENT_LINK_VERSION = 1;

export const LINK_FRAGMENT_KEY = 'i';
export const LINK_TX_KEY = 'tx';

/**
 * Payload ceiling, checked before any decode.
 *
 * 16 KiB is far above an honest invoice (a 200-character memo lands the whole
 * payload near 600 bytes) and far below anything worth spending CPU on. The
 * check exists so a hostile link cannot make this tab do work by being enormous.
 */
export const MAX_LINK_PAYLOAD_CHARS = 16_384;

/** 8 KiB of signature: an EOA needs 132 chars; the rest is headroom for ERC-6492 blobs. */
export const MAX_SIGNATURE_HEX_CHARS = 16_386;

/** `0x` + 65 bytes. Shorter than this is not a signature any verifier could use. */
export const MIN_SIGNATURE_HEX_CHARS = 132;

const HEX_RE = /^0x[0-9a-fA-F]*$/;

export const INVOICE_TYPES = {
  Invoice: [
    { name: 'id', type: 'string' },
    { name: 'merchant', type: 'address' },
    { name: 'settleToken', type: 'address' },
    { name: 'settleAmount', type: 'uint256' },
    { name: 'settleDecimals', type: 'uint8' },
    { name: 'settleSymbol', type: 'string' },
    { name: 'memo', type: 'string' },
    { name: 'createdAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export type InvoiceDomain = {
  name: string;
  version: string;
  chainId: number;
};

/**
 * A TYPE alias rather than an interface, deliberately: viem's typed-data
 * parameters require `Record<string, unknown>` assignability, and only a type
 * alias gets TypeScript's implicit index signature. An interface here compiles
 * everywhere except the one call that matters.
 */
export type InvoiceMessage = {
  id: string;
  merchant: `0x${string}`;
  settleToken: `0x${string}`;
  settleAmount: bigint;
  settleDecimals: number;
  settleSymbol: string;
  memo: string;
  createdAt: bigint;
  expiresAt: bigint;
};

export interface InvoiceTypedData {
  domain: InvoiceDomain;
  types: typeof INVOICE_TYPES;
  primaryType: 'Invoice';
  message: InvoiceMessage;
}

/**
 * The exact document a merchant signs and a buyer verifies.
 *
 * ONE implementation, used by the signer, the merchant's own self-check and the
 * buyer's verifier. A second copy of this shape anywhere would be a second
 * definition of what the merchant agreed to, and the two would diverge on the
 * day somebody added a field to one of them.
 */
export function invoiceTypedData(inv: Invoice): InvoiceTypedData {
  return {
    domain: { name: 'memetic.fun checkout', version: '1', chainId: inv.chainId },
    types: INVOICE_TYPES,
    primaryType: 'Invoice',
    message: {
      id: inv.id,
      merchant: inv.merchant,
      settleToken: inv.settleToken,
      settleAmount: inv.settleAmount,
      settleDecimals: inv.settleDecimals,
      settleSymbol: inv.settleSymbol,
      memo: inv.memo,
      createdAt: BigInt(inv.createdAt),
      expiresAt: BigInt(inv.expiresAt),
    },
  };
}

// ─── Carrying it ─────────────────────────────────────────────────────────────

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Null rather than a mangled string: `TextDecoder` is fatal so invalid UTF-8 throws. */
function fromBase64Url(payload: string): string | null {
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.length % 4 === 0 ? b64 : b64 + '='.repeat(4 - (b64.length % 4));
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The signed invoice and its signature, base64url-encoded. `invoiceToWire` keeps uint256 a string. */
export function encodePaymentLink(inv: Invoice, signature: Hex): string {
  return toBase64Url(JSON.stringify({ v: PAYMENT_LINK_VERSION, ...invoiceToWire(inv), sig: signature }));
}

/**
 * The URL a merchant hands out.
 *
 * SITE_URL, per lib/referrals/link.ts — one canonical origin for every link this
 * venue mints, so a merchant's invoice does not resolve on one host and 404 on
 * the other.
 */
export function paymentLinkUrl(payload: string, tx?: Hex | null): string {
  const base = `${SITE_URL}/checkout#${LINK_FRAGMENT_KEY}=${payload}`;
  return tx ? `${base}&${LINK_TX_KEY}=${tx}` : base;
}

/** `#i=…&tx=…` split into its two parts. Accepts the fragment with or without the leading `#`. */
export function parseFragment(hash: string): { i: string | null; tx: string | null } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length === 0) return { i: null, tx: null };
  const params = new URLSearchParams(raw);
  return { i: params.get(LINK_FRAGMENT_KEY), tx: params.get(LINK_TX_KEY) };
}

export type DecodedLink =
  /** No `#i=` at all. Not a failure — the visitor simply did not arrive on a link. */
  | { kind: 'none' }
  /** Something was there and this build cannot read it. Says nothing about any merchant. */
  | { kind: 'unreadable'; detail: string }
  | { kind: 'decoded'; invoice: Invoice; signature: Hex; payload: string; tx: Hex | null };

export function decodePaymentLink(hash: string): DecodedLink {
  const { i, tx } = parseFragment(hash);
  if (i === null || i.length === 0) return { kind: 'none' };

  // Before the decode and before JSON.parse, so an enormous fragment costs one
  // length read rather than a megabyte of work in a stranger's tab.
  if (i.length > MAX_LINK_PAYLOAD_CHARS) {
    return {
      kind: 'unreadable',
      detail: `This link carries more than ${MAX_LINK_PAYLOAD_CHARS} characters of payload, which no invoice this build mints ever does.`,
    };
  }

  const json = fromBase64Url(i);
  if (json === null) return { kind: 'unreadable', detail: 'The payload on this link is not readable text.' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { kind: 'unreadable', detail: 'The payload on this link is not a readable document.' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'unreadable', detail: 'The payload on this link is not a readable document.' };
  }

  const record = parsed as Record<string, unknown>;
  if (record.v !== PAYMENT_LINK_VERSION) {
    return {
      kind: 'unreadable',
      detail: `This link is version ${String(record.v)} and this build reads version ${PAYMENT_LINK_VERSION}. Nothing is assumed about the fields it carries.`,
    };
  }

  const sig = record.sig;
  if (typeof sig !== 'string' || !HEX_RE.test(sig)) {
    return { kind: 'unreadable', detail: 'This link carries no signature, so there is nothing to verify.' };
  }
  if (sig.length < MIN_SIGNATURE_HEX_CHARS || sig.length > MAX_SIGNATURE_HEX_CHARS) {
    return { kind: 'unreadable', detail: 'The signature on this link is not a length any signer produces.' };
  }

  // invoiceFromWire returns null on a fractional amount or a missing field
  // rather than filling one in — a defaulted figure in a document somebody is
  // about to pay against is the failure this whole module is arranged around.
  const invoice = invoiceFromWire(record);
  if (invoice === null) {
    return { kind: 'unreadable', detail: 'The invoice on this link is missing a field or carries one this build cannot read.' };
  }
  if (!isAddress(invoice.merchant) || !isAddress(invoice.settleToken)) {
    return { kind: 'unreadable', detail: 'The invoice on this link names something that is not a 20-byte address.' };
  }

  if (tx !== null && !TX_HASH_RE.test(tx)) {
    return {
      kind: 'unreadable',
      detail: 'The transaction reference on this link is not a 32-byte hash.',
    };
  }

  return {
    kind: 'decoded',
    invoice,
    signature: sig as Hex,
    payload: i,
    tx: tx === null ? null : (tx as Hex),
  };
}

// ─── Verifying it ────────────────────────────────────────────────────────────

export interface PaymentLinkVerifyArgs {
  address: `0x${string}`;
  domain: InvoiceDomain;
  types: typeof INVOICE_TYPES;
  primaryType: 'Invoice';
  message: InvoiceMessage;
  signature: Hex;
}

/**
 * Injected so the SAME verification runs in three places with one implementation:
 * the merchant's self-check, the buyer's browser, and the tests — which pass
 * viem's offline `verifyTypedData` and therefore prove the real cryptography
 * rather than a stub's opinion of it. Production passes
 * `publicClient.verifyTypedData`, which also settles ERC-1271/6492 smart
 * accounts with an eth_call.
 */
export type PaymentLinkVerifier = (args: PaymentLinkVerifyArgs) => Promise<boolean>;

export type LinkVerification =
  /** The verifier ran and said yes. */
  | { status: 'verified'; invoice: Invoice; signature: Hex }
  /** The verifier ran and said no. Somebody edited the link, or that wallet never signed it. */
  | { status: 'forged'; merchant: `0x${string}` }
  /** The verifier could not run. A fact about this browser, NOT about the link. */
  | { status: 'unverifiable'; detail: string };

/**
 * The three outcomes never collapse.
 *
 * A thrown verifier — no RPC, a rate limit, an offline laptop — is
 * `unverifiable`. Folding it into `forged` would accuse an honest merchant of a
 * forgery every time a public endpoint rate-limited a buyer, and folding it into
 * `verified` would offer a payment against a document nothing checked.
 */
export async function verifyPaymentLink(
  decoded: Extract<DecodedLink, { kind: 'decoded' }>,
  verifier: PaymentLinkVerifier,
): Promise<LinkVerification> {
  const { domain, types, primaryType, message } = invoiceTypedData(decoded.invoice);
  let ok: boolean;
  try {
    ok = await verifier({
      address: decoded.invoice.merchant,
      domain,
      types,
      primaryType,
      message,
      signature: decoded.signature,
    });
  } catch (err) {
    return {
      status: 'unverifiable',
      detail:
        (err as Error)?.message ??
        'The merchant signature could not be checked because nothing answered on this chain.',
    };
  }
  if (!ok) return { status: 'forged', merchant: decoded.invoice.merchant };
  return { status: 'verified', invoice: decoded.invoice, signature: decoded.signature };
}

// ─── Minting an id ───────────────────────────────────────────────────────────

/** Lowercase base32 (RFC 4648 without the padding), which INVOICE_ID_RE accepts. */
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const ID_BODY_CHARS = 12;

/**
 * A fresh invoice id from real randomness.
 *
 * `random` is injected so a test can prove the output shape across a thousand
 * draws without reaching for the global. Production passes
 * `crypto.getRandomValues`. There is no counter and no timestamp in the id: an
 * id a stranger can predict is an id a stranger can burn on a store that has
 * one, and it would leak how many invoices a merchant has written.
 */
export function newInvoiceId(random: (n: number) => Uint8Array): string {
  const bytes = random(ID_BODY_CHARS);
  let body = '';
  for (let i = 0; i < ID_BODY_CHARS; i++) {
    // charAt, not [], because an out-of-range index must not become `undefined`
    // in a string an invoice is identified by. A byte modulo 32 is always in range.
    body += ID_ALPHABET.charAt((bytes[i] ?? 0) % ID_ALPHABET.length);
  }
  return `inv-${body}`;
}

/** Randomness from the platform, for the production call site. */
export function browserRandomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export { INVOICE_ID_RE };
