import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import { hashLeaf, buildMerkleTree, merkleProof, verifyMerkleProof, type AirdropLeaf } from './core.js';

/**
 * A campaign manifest: the claim list, its root, and a proof per row.
 *
 * The manifest is the only thing that makes a campaign claimable. The chain stores
 * one 32-byte root and nothing else — no list, no proofs, no criteria — so whoever
 * creates a campaign is also responsible for publishing this file. A campaign whose
 * manifest is lost is unclaimable by everyone, and the claim surface says so rather
 * than telling a wallet it is ineligible.
 */

export interface CampaignEntry {
  account: Address;
  /** Base units. Decimal input is converted before it reaches this type. */
  amount: bigint;
}

export interface CampaignRow extends AirdropLeaf {
  leaf: Hex;
  proof: Hex[];
}

export interface CampaignManifest {
  /** Manifest format version — bumped only if the leaf encoding or ordering changes. */
  version: 1;
  root: Hex;
  /** Sum of every row, in base units. What the distributor must be funded with. */
  total: bigint;
  rows: CampaignRow[];
  /** Token the campaign distributes. Optional until the creator picks one. */
  token?: Address;
  /** Distributor address, filled in after `createCampaign` returns. */
  distributor?: Address;
  chainId?: number;
  /**
   * Free-text record of how the list was chosen — snapshot block, Heat floor,
   * exclusions. Printed verbatim on the claim surface: a wallet told it is not in the
   * list is owed the criteria that excluded it, not just the verdict.
   */
  criteria?: string;
  /**
   * True when `rows` holds only the rows this client ASKED for, not the campaign.
   *
   * The hosted store (src/lib/merkle/manifestStore.ts) serves one claimant's leaf and
   * never the list, so a manifest built from it has at most one row. Without this flag
   * `rows.length` reads as the campaign size, and a claim surface would tell a wallet
   * it is missing from "a list of 1 address". Anything that counts recipients must read
   * `recipientCount` and anything that phrases a negative verdict must say who did the
   * looking.
   */
  partial?: true;
  /**
   * How many addresses are in the WHOLE campaign, when that is known independently of
   * `rows`. Set by the store path; absent on a pasted manifest, where `rows.length`
   * already is the answer.
   */
  recipientCount?: number;
}

/**
 * Build the tree and every proof from a raw entry list.
 *
 * Ordering is by account ascending, not by input order. The index a row gets is the
 * bitmap slot it will occupy forever, so it has to be reproducible: anyone holding the
 * same address/amount pairs must be able to rebuild the identical root without also
 * holding the creator's spreadsheet row order.
 */
export function buildCampaign(entries: readonly CampaignEntry[]): CampaignManifest {
  if (entries.length === 0) throw new Error('campaign: the claim list is empty');

  const seen = new Map<string, number>();
  const normalised: CampaignEntry[] = entries.map((e, i) => {
    if (!isAddress(e.account)) throw new Error(`campaign: row ${i + 1} has an invalid address`);
    const account = getAddress(e.account);
    const previous = seen.get(account.toLowerCase());
    if (previous !== undefined) {
      // Two rows for one wallet could be summed, but summing changes the amount the
      // operator reviewed without saying so. Refused with both row numbers so the
      // source list can be fixed where the mistake actually is.
      throw new Error(`campaign: ${account} appears twice (rows ${previous + 1} and ${i + 1})`);
    }
    seen.set(account.toLowerCase(), i);
    return { account, amount: e.amount };
  });

  normalised.sort((a, b) => (a.account.toLowerCase() < b.account.toLowerCase() ? -1 : 1));

  const leaves = normalised.map((e, index) => hashLeaf({ index, account: e.account, amount: e.amount }));
  const tree = buildMerkleTree(leaves);

  const rows: CampaignRow[] = normalised.map((e, index) => ({
    index,
    account: e.account,
    amount: e.amount,
    leaf: leaves[index]!,
    proof: merkleProof(tree, index),
  }));

  const total = normalised.reduce((sum, e) => sum + e.amount, 0n);

  return { version: 1, root: tree.root, total, rows };
}

/** Locate a wallet's row. Case-insensitive; returns null when the wallet is absent. */
export function findRow(manifest: CampaignManifest, account: Address): CampaignRow | null {
  const needle = account.toLowerCase();
  return manifest.rows.find((r) => r.account.toLowerCase() === needle) ?? null;
}

/**
 * Re-verify every row against the manifest's own root.
 *
 * Run before a manifest is published and again when one is loaded from an untrusted
 * source. A manifest that fails this cannot be repaired by the claim page — the proofs
 * and the root disagree, and only whoever holds the original list can say which is right.
 */
export function verifyManifest(manifest: CampaignManifest): { ok: boolean; badRows: number[] } {
  const badRows: number[] = [];
  for (const row of manifest.rows) {
    const leaf = hashLeaf({ index: row.index, account: row.account, amount: row.amount });
    if (leaf.toLowerCase() !== row.leaf.toLowerCase() || !verifyMerkleProof(row.proof, manifest.root, leaf)) {
      badRows.push(row.index);
    }
  }
  return { ok: badRows.length === 0, badRows };
}

// ─── Serialisation ────────────────────────────────────────────────────
// JSON has no bigint. Amounts cross the boundary as decimal strings of BASE UNITS,
// never as numbers: a 1e24-base-unit allocation does not survive an IEEE-754 double.

interface SerialRow {
  index: number;
  account: string;
  amount: string;
  leaf: string;
  proof: string[];
}

interface SerialManifest {
  version: number;
  root: string;
  total: string;
  rows: SerialRow[];
  token?: string;
  distributor?: string;
  chainId?: number;
  criteria?: string;
}

export function serializeManifest(manifest: CampaignManifest): string {
  const out: SerialManifest = {
    version: manifest.version,
    root: manifest.root,
    total: manifest.total.toString(),
    rows: manifest.rows.map((r) => ({
      index: r.index,
      account: r.account,
      amount: r.amount.toString(),
      leaf: r.leaf,
      proof: r.proof,
    })),
  };
  if (manifest.token) out.token = manifest.token;
  if (manifest.distributor) out.distributor = manifest.distributor;
  if (manifest.chainId !== undefined) out.chainId = manifest.chainId;
  if (manifest.criteria) out.criteria = manifest.criteria;
  return JSON.stringify(out, null, 2);
}

/**
 * Parse a manifest and reject anything that is not one.
 *
 * Throws rather than returning a partial object: a half-parsed manifest is how a claim
 * page ends up telling a wallet it is not in a list it never actually read.
 */
export function parseManifest(text: string): CampaignManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('manifest: not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('manifest: expected a JSON object');
  const m = raw as Partial<SerialManifest>;
  if (m.version !== 1) throw new Error(`manifest: unsupported version ${String(m.version)}`);
  if (typeof m.root !== 'string' || !isHex(m.root) || m.root.length !== 66) {
    throw new Error('manifest: root is not a 32-byte hex value');
  }
  if (!Array.isArray(m.rows) || m.rows.length === 0) throw new Error('manifest: rows are missing');

  const rows: CampaignRow[] = m.rows.map((r, i) => {
    if (typeof r !== 'object' || r === null) throw new Error(`manifest: row ${i} is not an object`);
    if (!Number.isInteger(r.index) || r.index < 0) throw new Error(`manifest: row ${i} has no index`);
    if (typeof r.account !== 'string' || !isAddress(r.account)) {
      throw new Error(`manifest: row ${i} has an invalid account`);
    }
    if (typeof r.amount !== 'string' || !/^\d+$/.test(r.amount)) {
      throw new Error(`manifest: row ${i} amount must be a decimal string of base units`);
    }
    if (typeof r.leaf !== 'string' || !isHex(r.leaf)) throw new Error(`manifest: row ${i} has no leaf`);
    if (!Array.isArray(r.proof) || r.proof.some((p) => typeof p !== 'string' || !isHex(p))) {
      throw new Error(`manifest: row ${i} has a malformed proof`);
    }
    return {
      index: r.index,
      account: getAddress(r.account),
      amount: BigInt(r.amount),
      leaf: r.leaf as Hex,
      proof: r.proof as Hex[],
    };
  });

  const total =
    typeof m.total === 'string' && /^\d+$/.test(m.total)
      ? BigInt(m.total)
      : rows.reduce((s, r) => s + r.amount, 0n);

  return {
    version: 1,
    root: m.root as Hex,
    total,
    rows,
    token: typeof m.token === 'string' && isAddress(m.token) ? getAddress(m.token) : undefined,
    distributor:
      typeof m.distributor === 'string' && isAddress(m.distributor) ? getAddress(m.distributor) : undefined,
    chainId: typeof m.chainId === 'number' ? m.chainId : undefined,
    criteria: typeof m.criteria === 'string' ? m.criteria : undefined,
  };
}
