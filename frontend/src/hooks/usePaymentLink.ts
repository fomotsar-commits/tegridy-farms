import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePublicClient } from 'wagmi';
import type { Hex } from 'viem';
import type { Invoice } from '../lib/commerce/invoice';
import {
  decodePaymentLink,
  verifyPaymentLink,
  type PaymentLinkVerifier,
} from '../lib/commerce/paymentLink';

// Reading the invoice out of the URL fragment and asking the chain whether the
// merchant really signed it.
//
// SIX STATES, and the three that describe a failure are kept apart on purpose,
// because the sentence each one earns is addressed to a different party:
//
//   unreadable    this build cannot parse what is on the link. Says nothing
//                 about any merchant — the link may be from a newer build, or
//                 truncated by a chat app that ate the fragment.
//   forged        the verifier RAN and said no. Somebody edited the document
//                 after it was signed, or that wallet never signed it.
//   unverifiable  the verifier could not run: no RPC for that chain in this
//                 build, a rate limit, an offline laptop. A fact about this
//                 browser.
//
// Rendering `unverifiable` as `forged` accuses an honest merchant of a forgery
// every time a public endpoint throttles a buyer. Rendering it as `verified`
// offers a payment against a document nothing checked. So it is its own state,
// it carries a retry, and the copy on the surface says which kind of statement
// it is.
//
// The public client is looked up for the INVOICE's chain, not the wallet's: a
// buyer with no wallet at all still gets a real verification, which is the whole
// promise of a link that needs no account.

export type PaymentLinkState =
  | { status: 'none' }
  | { status: 'unreadable'; detail: string }
  | { status: 'verifying'; invoice: Invoice }
  | { status: 'verified'; invoice: Invoice; signature: Hex; payload: string; tx: Hex | null }
  | { status: 'forged'; merchant: `0x${string}` }
  | { status: 'unverifiable'; invoice: Invoice; detail: string; retry: () => void };

export interface UsePaymentLinkOptions {
  /**
   * Injection seam. Production passes nothing and the hook uses the public
   * client for the invoice's chain; tests pass viem's offline verifier so the
   * real cryptography runs without a network.
   */
  verifier?: PaymentLinkVerifier;
}

export function usePaymentLink(hash: string, opts: UsePaymentLinkOptions = {}): PaymentLinkState {
  const { verifier: injected } = opts;

  // Decoding is pure and cheap; re-running it on every render of a page that
  // re-renders on every keystroke would re-parse a stranger's payload each time.
  const decoded = useMemo(() => decodePaymentLink(hash), [hash]);

  const chainId = decoded.kind === 'decoded' ? decoded.invoice.chainId : undefined;
  const publicClient = usePublicClient({ chainId });

  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  const [verification, setVerification] = useState<
    | { phase: 'idle' }
    | { phase: 'verifying' }
    | { phase: 'verified'; signature: Hex }
    | { phase: 'forged' }
    | { phase: 'unverifiable'; detail: string }
  >({ phase: 'idle' });

  // LATCHED AT MOUNT, deliberately. The injected verifier is a test seam, and a
  // caller passing one writes `{ verifier: (args) => … }` inline — a new function
  // identity on every render. Keying the memo below on that identity re-runs the
  // effect, sets state, re-renders, and loops until the heap is gone. That is not
  // hypothetical; it is what happened the first time these tests ran.
  //
  // wagmi's own `publicClient` IS stable per chain, so it stays a real dependency
  // and a chain switch still re-verifies.
  const [injectedVerifier] = useState<PaymentLinkVerifier | null>(() => injected ?? null);

  // `blockTag` is named rather than left to viem's default because
  // BlockParameters is an exclusive union: with none of blockNumber/blockTag/
  // blockHash present it cannot pick a branch. 'latest' is also the right answer
  // on its merits — an ERC-1271 merchant's validator must accept the signature
  // NOW, not at some historical block.
  const verifier = useMemo<PaymentLinkVerifier | null>(() => {
    if (injectedVerifier) return injectedVerifier;
    if (!publicClient) return null;
    return (args) => publicClient.verifyTypedData({ ...args, blockTag: 'latest' });
  }, [injectedVerifier, publicClient]);

  // The payload is the identity of what is being verified: two different links
  // for the same invoice id are two different documents.
  const payload = decoded.kind === 'decoded' ? decoded.payload : null;

  useEffect(() => {
    if (decoded.kind !== 'decoded') {
      setVerification({ phase: 'idle' });
      return;
    }
    if (!verifier) {
      // No transport for this chain. Not a judgement on the link.
      setVerification({
        phase: 'unverifiable',
        detail: `This build has no RPC for chain ${decoded.invoice.chainId}, so the merchant signature could not be checked here`,
      });
      return;
    }

    let cancelled = false;
    setVerification({ phase: 'verifying' });
    void (async () => {
      const result = await verifyPaymentLink(decoded, verifier);
      if (cancelled) return;
      if (result.status === 'verified') setVerification({ phase: 'verified', signature: result.signature });
      else if (result.status === 'forged') setVerification({ phase: 'forged' });
      else setVerification({ phase: 'unverifiable', detail: result.detail });
    })();

    return () => {
      cancelled = true;
    };
    // `payload` carries every byte of the document; `decoded` itself is a fresh
    // object each render of a caller that rebuilds the hash string. `verifier`
    // and `attempt` are the only other things that should ever re-ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, verifier, attempt]);

  if (decoded.kind === 'none') return { status: 'none' };
  if (decoded.kind === 'unreadable') return { status: 'unreadable', detail: decoded.detail };

  switch (verification.phase) {
    case 'verified':
      return {
        status: 'verified',
        invoice: decoded.invoice,
        signature: verification.signature,
        payload: decoded.payload,
        tx: decoded.tx,
      };
    case 'forged':
      return { status: 'forged', merchant: decoded.invoice.merchant };
    case 'unverifiable':
      return { status: 'unverifiable', invoice: decoded.invoice, detail: verification.detail, retry };
    case 'idle':
    case 'verifying':
      // `idle` is the render between decode and the effect firing. It is a
      // moment of not-yet-knowing, and the only honest thing to show for it is
      // the same "checking" state — never the invoice's figures.
      return { status: 'verifying', invoice: decoded.invoice };
  }
}
