// Solana chain reads for the birth record: the mint account and nothing else. It gives the
// facts the precision law turns on (`decimals`, `total_supply`) and the mint and freeze
// authorities, the closest thing to a lock a mint can prove. name, symbol, plates, the fee
// instruction and the creator are declared `unread`, never guessed. It reads the upstream RPC
// directly: /api/solrpc is origin-gated, so a lambda-to-lambda call would get a 403 and spend
// the browser's shared per-IP budget.

/** SPL Token mint account layout — a fixed 82 bytes. */
const MINT_ACCOUNT_BYTES = 82;
/** COption<Pubkey> tag for mintAuthority. 0 = None, 1 = Some. */
const OFFSET_MINT_AUTHORITY_TAG = 0;
const OFFSET_SUPPLY = 36; // u64 LE
const OFFSET_DECIMALS = 44; // u8
const OFFSET_IS_INITIALIZED = 45; // u8
const OFFSET_FREEZE_AUTHORITY_TAG = 46; // COption tag

/** The only programs that may own a mint (ids as in src/lib/launcher/solana/curve/program.ts).
 *  The owner decides, never bytes alone: a 165-byte token account whose owner pubkey sets
 *  byte 45 to 1 and byte 44 to 18 or less would decode as a mint and publish a chosen
 *  supply, and such a keypair grinds in seconds. */
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_PROGRAM_IDS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", TOKEN_2022_PROGRAM_ID]);

/** A Token-2022 mint with extensions is longer than a token account's 165 bytes, and the byte
 *  after those 165 says Mint (1). 355 bytes is a multisig, a length Token-2022 never gives a
 *  mint. Recognised only to answer truly (BAYLA is one); this venue never decodes one. */
const OFFSET_ACCOUNT_TYPE = 165;
const ACCOUNT_TYPE_MINT = 1;
const MULTISIG_BYTES = 355;
const TOKEN_2022_MINT_REASON =
  "This is a Token-2022 mint. This venue's launcher makes no Token-2022 mints, and this record cannot read one that carries extensions.";

function isToken2022MintWithExtensions(owner, buf) {
  return (
    owner === TOKEN_2022_PROGRAM_ID &&
    buf.length !== MULTISIG_BYTES &&
    buf[OFFSET_ACCOUNT_TYPE] === ACCOUNT_TYPE_MINT &&
    buf[OFFSET_IS_INITIALIZED] === 1
  );
}

/** One call's bound, headers and body together: a host that stops part-way is a failed read. */
const RPC_TIMEOUT_MS = 6000;

function rpcUrl() {
  return process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
}

async function solRpc(method, params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  let json;
  try {
    const res = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`solana rpc ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  if (json.error) throw new Error(json.error.message || "solana rpc error");
  return json.result;
}

/** Decode the parts of an initialised 82-byte SPL mint we publish. Anything else returns
 *  null (a Token-2022 mint with extensions, a token account, a random address), so none of
 *  them reads as a mint with zero supply. The length is EXACT: a minimum admitted a 165-byte
 *  token account, whose bytes 44 and 45 sit inside its owner pubkey. */
export function decodeMintAccount(buf) {
  if (!buf || buf.length !== MINT_ACCOUNT_BYTES) return null;
  if (buf[OFFSET_IS_INITIALIZED] !== 1) return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // u64 LE. Read as two u32s and recombine as BigInt so no precision is lost.
  const lo = BigInt(view.getUint32(OFFSET_SUPPLY, true));
  const hi = BigInt(view.getUint32(OFFSET_SUPPLY + 4, true));
  const supply = (hi << 32n) | lo;

  const decimals = buf[OFFSET_DECIMALS];
  if (!Number.isInteger(decimals) || decimals > 18) return null;

  return {
    supply,
    decimals,
    mintAuthorityPresent: view.getUint32(OFFSET_MINT_AUTHORITY_TAG, true) === 1,
    freezeAuthorityPresent: view.getUint32(OFFSET_FREEZE_AUTHORITY_TAG, true) === 1,
  };
}

/**
 * Read everything the record needs about one Solana mint.
 *
 * Returns `{ absent: true, reason }` when the account does not exist or is not a mint.
 * Throws when the RPC itself could not be reached — a 502, not a 404.
 */
export async function readSolanaRecordInput(ca, opts = {}) {
  const observedAt = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const unread = new Set([
    // Named explicitly rather than left to fall out of empty values, so a consumer can
    // see that these were never attempted on this rail.
    "name",
    "symbol",
    "plates",
    "residual_powers",
  ]);

  const result = await solRpc("getAccountInfo", [ca, { encoding: "base64", commitment: "confirmed" }]);
  const value = result?.value;
  if (!value || !Array.isArray(value.data) || typeof value.data[0] !== "string") {
    return { absent: true, reason: "No account exists at this address." };
  }

  // The owning PROGRAM is what makes an account a mint. Bytes alone cannot say it — see
  // TOKEN_PROGRAM_IDS. Checked before decoding, so a hostile account never reaches the
  // offsets at all.
  if (!TOKEN_PROGRAM_IDS.has(value.owner)) {
    return { absent: true, reason: "That address is not an initialised SPL mint." };
  }

  const buf = Buffer.from(value.data[0], "base64");
  const mint = decodeMintAccount(buf);
  if (!mint) {
    const reason = isToken2022MintWithExtensions(value.owner, buf)
      ? TOKEN_2022_MINT_REASON
      : "That address is not an initialised SPL mint.";
    return { absent: true, reason };
  }

  // THE MINT IS THE FACT, not the launch config. `PoolConfig.tokenDecimal` is the
  // parameter we asked for; `mint.decimals` is what exists. A record must publish the
  // second one — wrong precision voids comparability across every plate we serve.
  const decimals = mint.decimals;

  // The closest thing to a lock the mint itself proves. Revoked mint authority is the
  // rail's central promise ("mint authority revoked at create"), so it is stated as a
  // lock rather than left implicit.
  const locks = mint.mintAuthorityPresent
    ? "Mint authority is STILL PRESENT: new supply can be created."
    : "Mint authority is revoked: no new supply can ever be created.";

  const sheet = {
    schemaVersion: 1,
    token: ca,
    chainId: 0, // Solana has no EVM chainId; the record's `chain` field carries the rail
    name: "",
    symbol: "",
    totalSupply: mint.supply,
    tokenFactory: null,
    templateCodehash: null,
    knownSafeTemplate: false,
    residualPowers: [],
    liquidity: { locked: false, locker: null, unlockAt: null, note: "" },
    feeConstitution: [],
    vesting: [],
    teamAllocationBps: 0,
    teamAllocationVestedBps: 0,
    tier: "none",
    gateChecks: [],
    observedAt,
  };

  return {
    input: {
      sheet,
      chain: "solana",
      creator: null,
      birthBlock: null,
      birthTx: null,
      gateDecisionId: null,
      decimals,
      liquidityReadable: false,
      unread: [...unread],
    },
    meta: {
      mintAuthorityPresent: mint.mintAuthorityPresent,
      freezeAuthorityPresent: mint.freezeAuthorityPresent,
      mintAuthorityNote: locks,
    },
  };
}
