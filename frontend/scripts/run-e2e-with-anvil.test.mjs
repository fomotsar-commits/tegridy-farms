// @vitest-environment node
//
// NODE, not the project's jsdom default — this is a CLI orchestrator, and the
// subject is a pure string classifier with no DOM in sight.
//
// PINS FOR `diagnoseFork`, the function that decides what a dead fork endpoint
// is TOLD to be.
//
// WHY THIS FILE EXISTS. On 2026-09-09 publicnode began answering anvil's fork
// handshake with HTTP 403 "Archive requests require a personal token". anvil
// died in two seconds, the orchestrator polled a dead port for twenty more, and
// the job headline read `anvil did not bind within 20s` — a timeout, which
// reads as a slow runner. Trunk and every open PR carried that red while the
// five money-path specs ran ZERO tests. `diagnoseFork` is the fix for the
// legibility half of that, and its branches cannot be exercised by running the
// script: each one needs an upstream failing in that exact way at that exact
// moment. Without these pins, three of the four sit unverified until the
// outage they exist to explain.
//
// THAT IS NOT HYPOTHETICAL — THEY SHIPPED BROKEN ONCE. The word boundaries in
// the 401/403, 429 and 404/410 patterns survived authoring as raw 0x08
// BACKSPACE bytes, so those regexes read `/\x08(401|403)\x08/` and could never
// match an anvil log. The live publicnode reproduction passed anyway, because
// the archive-token branch is the one branch that carries no word boundary. A
// green headline test over three dead branches is exactly the shape this job
// was built to stop.
import { describe, it, expect } from 'vitest';
import { diagnoseFork } from './run-e2e-with-anvil.mjs';

// Verbatim from anvil 1.5.1. The blank line and the `Context:` header are part
// of the real output; keep them, so a future parser change is tested against
// what anvil actually prints rather than a tidied paraphrase.
const HANDSHAKE = 'Error: failed to get fork block number\n\nContext:\n';

// The exact body publicnode returned on the day, reproduced locally against
// anvil 1.5.1 and byte-identical to CI run 34431729183.
const PUBLICNODE_403 =
  HANDSHAKE +
  '- HTTP error 403 with body: {"jsonrpc":"2.0","error":{"code":-32602,' +
  '"message":"Archive requests require a personal token. Get one at: ' +
  'https://www.allnodes.com/publicnode"},"id":1}';

describe('diagnoseFork', () => {
  it('names the archive-token gate that took trunk red, ahead of the bare 403', () => {
    const verdict = diagnoseFork(PUBLICNODE_403);
    expect(verdict).toMatch(/ARCHIVE/);
    // Ordering is load-bearing: this body carries a 403 too, and the generic
    // auth branch would swallow it and lose the one detail that says "a fork IS
    // an archive request, so waiting will not clear this".
    expect(verdict).not.toMatch(/AUTH reasons/);
  });

  it.each([
    ['403 with no archive wording', '- HTTP error 403 with body: {"message":"forbidden"}', /AUTH reasons/],
    ['401 api-key gate', '- HTTP error 401 with body: {"message":"api key required"}', /AUTH reasons/],
    ['429 rate limit', '- HTTP error 429 with body: {"message":"too many requests"}', /RATE-LIMITED/],
    ['410 gone, as 1rpc.io returns', '- HTTP error 410 with body: gone', /GONE/],
  ])('classifies %s', (_label, detail, want) => {
    expect(diagnoseFork(HANDSHAKE + detail)).toMatch(want);
  });

  it('separates a retryable 429 from an auth gate that waiting cannot clear', () => {
    // The whole point of splitting these: one says "try again", the other says
    // "go change the endpoint". Collapsing them sends the next reader to wait.
    expect(diagnoseFork(HANDSHAKE + '- HTTP error 429')).toMatch(/may clear on a retry/);
    expect(diagnoseFork(HANDSHAKE + '- HTTP error 403')).toMatch(/waiting does not clear/);
  });

  it('admits it does not recognise a handshake failure rather than guessing', () => {
    const verdict = diagnoseFork(HANDSHAKE + '- error sending request for url (https://eth.example/)');
    expect(verdict).toMatch(/could not complete the fork handshake/);
    expect(verdict).not.toMatch(/AUTH|RATE-LIMITED|GONE|ARCHIVE/);
  });

  it('returns null when anvil died of something that is not a fork problem', () => {
    // A port clash must NOT be dressed up as a refused endpoint — that would
    // send the reader to replace a working RPC.
    expect(diagnoseFork('Address already in use (os error 98)')).toBeNull();
    expect(diagnoseFork('')).toBeNull();
  });

  it('does not classify a status code that is only in the URL, not the failure', () => {
    // A status-code substring can appear in an endpoint name. Without a real
    // word boundary `403` matches inside `40399`, which is how the 0x08 bug
    // above would have been caught the first time.
    expect(diagnoseFork(HANDSHAKE + '- HTTP error 500 with body: node-40399 unavailable'))
      .toMatch(/could not complete the fork handshake/);
  });
});
