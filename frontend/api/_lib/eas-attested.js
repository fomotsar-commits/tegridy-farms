// EAS `Attested` logs for one token under the site's disclosure schema, for the token page.
// The browser cannot ask: every RPC it reaches refuses an eth_getLogs over EAS's whole life, and
// keyless Blockscout answers it. The answer is only a hint: the browser re-reads each uid from
// the EAS contract. `{ attestations: [] }` means the history was read and holds none; a failed
// read is a 5xx, never `[]`. Dispatched from api/aggregator.js above `const provider`, lazily.

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { ETH_BLOCKSCOUT, addressTopic, blockscoutLogs, gate } from "./evm-birth.js";
import { logSafe } from "./logSafe.js";

// eas-attested.test.js pins all four to src/lib/launcher/attestation.ts, so none can drift.
export const EAS_MAINNET = "0xa1207f3bba224e2c9c3c6d5af63d0eb1582ce587";
export const ATTESTED_TOPIC0 = "0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35";
export const EAS_FROM_BLOCK = 16_756_728;
// The one schema the site reads, so this is not a free EAS search for anyone else.
export const FACT_SHEET_SCHEMA_UID = "0x0e4570dbb466fb8990c1ef51fce3f1c1877b3f2d49d9e02efceb18f01b3ab3b9";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WORD_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_TOPIC_RE = /^0x0{24}([0-9a-f]{40})$/;

/**
 * The attestations in Blockscout's answer, oldest first. Logs outside the filter are dropped
 * (an upstream that ignored a topic must not hand us another schema). A matching log that does
 * not decode throws: then we did not read them all.
 */
export function attestationsFrom(logs, want) {
  const out = [];
  for (const log of Array.isArray(logs) ? logs : []) {
    const topics = Array.isArray(log?.topics) ? log.topics.map((t) => String(t).toLowerCase()) : [];
    if (String(log?.address).toLowerCase() !== EAS_MAINNET) continue;
    if (topics[0] !== ATTESTED_TOPIC0 || topics[1] !== want.recipient || topics[3] !== want.schema) continue;
    const uid = String(log?.data ?? "").toLowerCase();
    const attester = ADDRESS_TOPIC_RE.exec(topics[2] ?? "");
    const block = Number(log?.blockNumber);
    const index = Number(log?.logIndex);
    if (!WORD_RE.test(uid) || !attester || !Number.isSafeInteger(block) || !Number.isSafeInteger(index)) {
      throw new Error("a matching log does not decode");
    }
    out.push({ uid, attester: "0x" + attester[1], block, index });
  }
  out.sort((a, b) => a.block - b.block || a.index - b.index);
  return out.map(({ uid, attester, block }) => ({ uid, attester, block }));
}

export async function handleEasAttested(req, res) {
  if (!(await gate(req, res))) return;
  const recipient = String(req.query.recipient ?? "");
  const schema = String(req.query.schema ?? "").toLowerCase();
  if (!ADDRESS_RE.test(recipient) || schema !== FACT_SHEET_SCHEMA_UID) {
    return res.status(400).json({ error: "Invalid recipient or schema" });
  }
  if (!(await checkRateLimit(req, res, { limit: 30, windowSec: 60, identifier: "eas-attested" }))) return;
  const underCap = await checkGlobalLimit(res, {
    limit: Number(process.env.EAS_ATTESTED_GLOBAL_RPM) || 120,
    windowSec: 60,
    identifier: "eas-attested",
  });
  if (!underCap) return;

  try {
    const want = { recipient: addressTopic(recipient), schema };
    const logs = await blockscoutLogs(ETH_BLOCKSCOUT, {
      address: EAS_MAINNET,
      topic0: ATTESTED_TOPIC0,
      topic1: want.recipient,
      topic3: schema,
      fromBlock: EAS_FROM_BLOCK,
    });
    const attestations = attestationsFrom(logs, want);
    // An attestation can land any minute after a launch, so "none" is cached briefly.
    res.setHeader("Cache-Control", attestations.length ? "s-maxage=300, stale-while-revalidate=900" : "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ attestations });
  } catch (err) {
    console.error("eas-attested upstream:", logSafe(err));
    return res.status(502).json({ error: "Attestations could not be looked up right now" });
  }
}
