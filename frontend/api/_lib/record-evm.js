// EVM chain reads for the birth record — Ethereum mainnet only.
//
// Produces a `LaunchFactSheet`-shaped object plus the extras `buildBirthRecord` needs.
// It deliberately does NOT run `runGate`: the record consumes nine sheet fields and none
// of the gate's tier/checks output, so pulling the gate in would drag policy into a
// document that is supposed to state facts.
//
// ## Ethereum mainnet only, and that is not a shortcut
//
// `DOPPLER_MAINNET.chainId` is 1 and it is the only address book in the repo; `ethcall.js`
// is hard-wired to `eth-mainnet`. There is no Base address book and no Base RPC anywhere
// server-side. `chain=base` therefore 404s rather than being answered with mainnet
// addresses — see record.js.
//
// ## The rule every read here obeys
//
// A failed read yields `null` and an `unread` entry. Never `''`, never `0n`, never a
// default. `eth_call` against a selector a contract does not implement returns `0x` on a
// contract with a fallback rather than throwing, so "the function is not there" and "the
// value is zero" are the same bytes — and only the decoders' `null` keeps them apart.

import { ethCall, ethGetCode, ethTxByHash, padAddr } from "./ethcall.js";
import { decodeAbiString, decodeUint, decodeUint8, decodeAddress, wordAt } from "./abi-decode.js";
import { cloneImplTarget, railDecimals } from "./record-core.js";

/** Canonical Doppler Airlock, Ethereum mainnet. Mirrors DOPPLER_MAINNET.airlock. */
export const AIRLOCK = "0xde3599a2ec440b296373a983c85c365da55d9dfa";

/**
 * DopplerERC20V1 implementation. A token whose clone target is this address came from
 * Doppler's own template, which is what makes `vestedTotalAmount()` and the fixed
 * 18 decimals trustworthy. Mirrors DOPPLER_MAINNET.contracts.dopplerErc20V1Impl.
 */
export const DOPPLER_ERC20_V1_IMPL = "0xdb7b520bb5c3a2c5d4871198081911359f93be87";

/**
 * Selectors, derived from the SAME ABI objects the browser uses.
 *
 * ⚠️ `record-evm.selectors.test.js` re-derives every one of these with viem's
 * `toFunctionSelector` from `collector.ts`'s `TOKEN_READER_ABI` and `ourLaunches.ts`'s
 * `AIRLOCK_GET_ASSET_DATA`, then regexes these literals out of this file and compares.
 * A hand-typed selector that does not exist on the target does not throw — most nodes
 * return `0x`, which decodes to `null`, which becomes a plausible-looking `unread`. The
 * repo has shipped exactly that twice (`streams(bytes32)`, `integratorFees(address,address)`).
 * Never add a selector here without adding it to that test.
 */
export const SELECTORS = Object.freeze({
  name: "0x06fdde03", // name()
  symbol: "0x95d89b41", // symbol()
  totalSupply: "0x18160ddd", // totalSupply()
  owner: "0x8da5cb5b", // owner()
  decimals: "0x313ce567", // decimals()
  vestedTotalAmount: "0xf68d90d8", // vestedTotalAmount()
  getAssetData: "0x1652e7b7", // getAssetData(address)
});

/**
 * `getAssetData` output words, in order. Word 4 (`poolInitializer`) is the ABSENCE
 * discriminator — a zero there means the Airlock has no record of this asset.
 *
 * NOT word 9 (`integrator`): a Doppler launch with no integrator is legitimate and one
 * exists on mainnet, so treating a zero integrator as "not a Doppler launch" would erase
 * real launches from the record.
 */
export const ASSET_DATA_WORDS = Object.freeze({
  numeraire: 0,
  timelock: 1,
  governance: 2,
  liquidityMigrator: 3,
  poolInitializer: 4,
  pool: 5,
  migrationPool: 6,
  numTokensToSell: 7,
  totalSupply: 8,
  integrator: 9,
});

/** `eth_call` that resolves to null on ANY failure, so one dead read cannot fail them all. */
async function tryCall(to, data) {
  try {
    return await ethCall(to, data);
  } catch {
    return null;
  }
}

/**
 * Read everything the record needs about one EVM token.
 *
 * Returns `{ absent: true, reason }` when nothing is deployed at the address, or
 * `{ input }` ready for `buildBirthRecord`. Throws only when the PRESENCE read itself
 * fails — that is "we could not ask the chain at all", which is a 502, not a 404.
 */
export async function readEvmRecordInput(ca, opts = {}) {
  const observedAt = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const unread = new Set();

  // ── Wave 0: presence. Gates everything. A throw here is a transport failure and
  // propagates as a 502; `0x` is a definitive "nothing is deployed" and is a 404.
  const code = await ethGetCode(ca);
  if (typeof code !== "string" || code === "0x" || code === "0x0") {
    return { absent: true, reason: "No contract is deployed at this address." };
  }
  const impl = cloneImplTarget(code);
  const isDopplerTemplate = impl != null && impl.toLowerCase() === DOPPLER_ERC20_V1_IMPL;

  // ── Wave 1: the token + the Airlock record, concurrently.
  const padded = padAddr(ca);
  const [nameHex, symbolHex, supplyHex, ownerHex, decimalsHex, assetDataHex] = await Promise.all([
    tryCall(ca, SELECTORS.name),
    tryCall(ca, SELECTORS.symbol),
    tryCall(ca, SELECTORS.totalSupply),
    tryCall(ca, SELECTORS.owner),
    tryCall(ca, SELECTORS.decimals),
    tryCall(AIRLOCK, SELECTORS.getAssetData + padded),
  ]);

  const nameRes = decodeAbiString(nameHex);
  const symbolRes = decodeAbiString(symbolHex);
  const name = nameRes.ok ? nameRes.value : "";
  const symbol = symbolRes.ok ? symbolRes.value : "";
  if (!nameRes.ok) unread.add("name");
  if (!symbolRes.ok) unread.add("symbol");

  const supply = decodeUint(supplyHex);
  if (supply === null) unread.add("total_supply");

  if (decodeAddress(ownerHex) === null) unread.add("residual_powers");

  // ── Decimals: the CHAIN wins, the rail is only the fallback.
  //
  // `railDecimals('ethereum')` returns 18 with no read at all, which is a statement about
  // OUR template — and this route is per-address and public, so it will be asked about
  // tokens that are not ours. Publishing 18 for a 6-decimal token would misprice every
  // plate on the record by 10^12, which is the precision law's whole point.
  const readDecimals = decodeUint8(decimalsHex);
  let decimals;
  if (readDecimals !== null) {
    decimals = readDecimals;
    // Two sources that disagree means one is lying. The template hardcodes 18, so a
    // clone of it that answers otherwise is not what its bytecode says it is.
    if (isDopplerTemplate && readDecimals !== 18) {
      const err = new Error("decimals() disagrees with the token's own template provenance");
      err.contradiction = true;
      throw err;
    }
  } else if (isDopplerTemplate) {
    decimals = railDecimals("ethereum"); // provenance-backed: the template hardcodes 18
  } else {
    decimals = null; // builder adds 'decimals' to unread
  }

  // ── The Airlock record. Its absence is not an error: a token can exist without having
  // been launched through the Airlock, and the record should say so rather than 404.
  let airlockKnown = false;
  if (assetDataHex) {
    const poolInitializer = decodeAddress(wordAt(assetDataHex, ASSET_DATA_WORDS.poolInitializer));
    airlockKnown =
      poolInitializer !== null && poolInitializer !== "0x0000000000000000000000000000000000000000";
  }

  // ── Team allocation. ONLY meaningful for the Doppler template.
  //
  // `vestedTotalAmount()` is what makes the premine disclosure truthful, so a FAILED read
  // must not become 0 bps — that would publish a clean full-supply "Public sale" plate for
  // a token that may be 20% insider-held. Public RPCs 429 routinely, so this is a live
  // failure mode, not a theoretical one.
  let teamAllocationBps = 0;
  let teamAllocationVestedBps = 0;
  if (isDopplerTemplate && supply !== null && supply > 0n) {
    const vestedHex = await tryCall(ca, SELECTORS.vestedTotalAmount);
    const vestedTotal = decodeUint(vestedHex);
    if (vestedTotal === null) {
      unread.add("plates");
    } else {
      teamAllocationBps = Number((vestedTotal * 10_000n) / supply);
      teamAllocationVestedBps = teamAllocationBps; // vestedTotalAmount is BY DEFINITION vested
    }
  } else if (!isDopplerTemplate) {
    // We cannot enumerate insider holdings on an arbitrary token, and a silent 0 would
    // read as "no insider allocation".
    unread.add("plates");
  }

  // ── Birth provenance. Optional: needs an Etherscan key for the log enumeration.
  let birthBlock = null;
  let birthTx = null;
  let creator = null;
  if (airlockKnown && process.env.ETHERSCAN_API_KEY) {
    try {
      const { createLogFor } = await import("./launch-cohort.js");
      const log = await createLogFor(ca, process.env.ETHERSCAN_API_KEY);
      if (log && !log.truncated) {
        birthBlock = log.blockNumber;
        birthTx = log.transactionHash;
        const tx = await ethTxByHash(log.transactionHash).catch(() => null);
        // The create-tx SENDER. Chain-derivable, but not proof of authorship — a router
        // or relayer can be the sender. It is the best available answer and the record
        // says nothing stronger about it.
        if (tx && typeof tx.from === "string") creator = tx.from.toLowerCase();
      }
      // A truncated enumeration window means we did not find it, NOT that it is not
      // there. Leaving birthBlock null lets the builder declare it unread.
    } catch {
      // Etherscan down / rate-limited. Unread, never fabricated.
    }
  }

  const sheet = {
    schemaVersion: 1,
    token: ca,
    chainId: 1,
    name,
    symbol,
    totalSupply: supply ?? 0n,
    tokenFactory: null,
    templateCodehash: null,
    knownSafeTemplate: isDopplerTemplate,
    residualPowers: [],
    // THE LOCKER IS NOT QUERIED. `readMigrationStream` is inert against the V1 locker
    // (no token -> position-tokenId index exists), so there is nothing to read and the
    // record must make no claim. `liquidityReadable: false` below is what stops the
    // fact sheet's "Liquidity is not locked" sentence being published as machine truth.
    liquidity: { locked: false, locker: null, unlockAt: null, note: "" },
    // NOT ENUMERABLE, in any phase. The split exists only as calldata to Airlock.create,
    // and StreamableFeesLocker V1 is verify-if-known (`positions(uint256)`), never
    // enumerate — there is no token -> tokenId index on V1 at all. The builder adds
    // 'fee_instruction' to unread for an empty array; do not build a graduated branch
    // here, because it cannot fire.
    feeConstitution: [],
    vesting: [],
    teamAllocationBps,
    teamAllocationVestedBps,
    tier: "none",
    gateChecks: [],
    observedAt,
  };

  return {
    input: {
      sheet,
      chain: "ethereum",
      creator,
      birthBlock,
      birthTx,
      gateDecisionId: null, // lives in the launching browser's localStorage; never on chain
      decimals,
      liquidityReadable: false,
      unread: [...unread],
    },
    meta: { isDopplerTemplate, airlockKnown },
  };
}
