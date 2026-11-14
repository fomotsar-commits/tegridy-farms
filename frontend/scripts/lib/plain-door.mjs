/**
 * The plain door of a two-door send (KEEPER_TWO_DOORS; keeper/jito.ts PlainDoor): the signed
 * transaction a Jito bundle carries, handed to the usual RPC too. `sendRaw(raw)` is the RPC's
 * sendTransaction WITH its own test run (preflight) at the newest state: a trip that would fail
 * is refused there and never goes out by this door, so it costs nothing; one that passes goes out
 * at once, and to every RPC in `also` as it is (their answers are not waited for: more ways to a
 * leader, the same signature).
 *
 * What the RPC answers, as the sender reads it:
 *   sent     it took the transaction, or says the chain already has it
 *   refused  its test run failed (`why`: the instruction and the program's error, as the RPC words it)
 *   unread   anything else (too busy, unreachable, a blockhash a lagging node does not know yet):
 *            that says nothing about the trip, and is never counted as a refusal
 */

/** The RPC's refusal of a transaction, as a PlainDoor answer. */
export function doorOf(e) {
  const text = e instanceof Error ? e.message : String(e);
  if (/already been processed|AlreadyProcessed/i.test(text)) return { door: 'sent' };
  if (/blockhash not found|BlockhashNotFound/i.test(text)) return { door: 'unread', why: 'the RPC did not know the blockhash yet' };
  if (/simulation failed/i.test(text)) {
    const at = text.match(/Error processing Instruction (\d+): ([^\n.]+)/);
    if (at) return { door: 'refused', why: `instruction ${at[1]}: ${at[2].trim()}` };
    // No instruction named (the public RPC, 2026-11-14: "Transaction simulation failed. Logs: []"):
    // the last program failure in its logs when it gives them, else its own words without the tail
    // web3.js adds.
    const logs = Array.isArray(e?.logs) ? e.logs : [];
    const lastFail = logs.filter((l) => typeof l === 'string' && /failed/i.test(l)).at(-1);
    return { door: 'refused', why: (lastFail ?? text.split(/\s*Catch the /)[0]).replace(/\s+/g, ' ').slice(0, 140) };
  }
  return { door: 'unread', why: text.replace(/\s+/g, ' ').slice(0, 140) };
}

/**
 * A transaction the main RPC has taken (its test run passed there), handed as it is to each RPC in
 * `urls` too: no test run of theirs, no retries, and no answer waited for or thrown. The same
 * signature, so the chain takes it once whoever carries it.
 */
export function alsoSend(raw, urls, fetchImpl = fetch) {
  if (!urls.length) return;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [Buffer.from(raw).toString('base64'), { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] });
  for (const url of urls) {
    Promise.resolve()
      .then(() => fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5_000) }))
      .catch(() => {});
  }
}

export function plainDoor({ sendRaw, also = [], fetchImpl = fetch }) {
  return async (tx) => {
    const raw = tx.serialize();
    try {
      await sendRaw(raw);
    } catch (e) {
      return doorOf(e);
    }
    alsoSend(raw, also, fetchImpl);
    return { door: 'sent' };
  };
}
