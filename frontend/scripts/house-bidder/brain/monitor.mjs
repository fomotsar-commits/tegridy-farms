// The fill monitor. A collection bid cannot choose who sells into it, so every fill is checked
// after the fact, and the result feeds the breakers (risk.mjs):
//   - the seller, the fulfiller (the address that sent the transaction) and the wallet the NFT came
//     from (nftFrom) against the insiders
//     (insiders.json plus the built-in list), the house wallets and the venue's own contracts;
//   - the token's last 90 days of transfers, for an insider who held or passed it on;
//   - the seller's code: an EIP-7702 delegation (0xef0100...) or a contract is noted for a person;
//   - OpenSea's flags on the item: a disabled or suspicious item is treated as stolen.
// A read that fails is retried on later ticks; it is never taken as a pass.

import { BUILT_IN_INSIDERS, COLLECTIONS, VENUE_CONTRACTS } from './constants.mjs';
import { addr, toSec } from './util.mjs';

const DAY = 86_400;

/** Who must never trade with the house, as lowercased sets. */
export function counterpartySets({ insiders, houseWallets = [], house = null, fundingWallet = null }) {
  const people = new Set(BUILT_IN_INSIDERS);
  for (const w of insiders?.wallets ?? []) {
    const a = addr(typeof w === 'string' ? w : w.address);
    if (a) people.add(a);
  }
  // The funding wallet is the owner's: it may fund the house, never sell to it.
  if (addr(fundingWallet)) people.add(addr(fundingWallet));
  const contracts = new Set(VENUE_CONTRACTS);
  for (const c of insiders?.contracts ?? []) if (addr(c)) contracts.add(addr(c));
  const house_ = new Set(houseWallets.map(addr).filter(Boolean));
  if (addr(house)) house_.add(addr(house));
  return { people, contracts, house: house_ };
}

/**
 * Whose trades never count in the sales tape (its "insider" filter): the insiders AND the venue's
 * contracts (the treasury Safe, the loan contract and its liquidator, the JBAC vault, and every
 * insiders.json contract). A sale to or from one of them says nothing about what a stranger pays,
 * and the venue buying at a high price must not raise the fair value the house bids from.
 */
export const tapeInsiders = (sets) => [...sets.people, ...sets.contracts];

/**
 * @param {object} fill        { txHash, block, time, orderHash, slug, tokenId, unitPriceWei, seller, fulfiller, nftFrom? }
 * @param {object} deps
 * @param {ReturnType<typeof counterpartySets>} deps.sets
 * @param {object} deps.chain   { tokenProvenance(slug, tokenId, { sinceDays }), code(address) }
 * @param {object} deps.opensea { item(contract, tokenId) }
 * @param {number} deps.nowSec
 * @param {string[]} [deps.skip] checks already passed on an earlier try ('provenance', 'code', 'item')
 * @returns {Promise<{ verdict: 'ok'|'review'|'halt', integrity: {reason: string, detail: string}[], findings: {code: string, detail: string}[], pending: string[], passed: string[], stolen: boolean }>}
 */
export async function checkFill(fill, { sets, chain, opensea, nowSec, provenanceDays = 90, skip = [] }) {
  const integrity = [];
  const findings = [];
  const pending = [];
  const passed = [];
  let stolen = false;
  const seller = addr(fill.seller);
  const fulfiller = addr(fill.fulfiller);
  // The wallet the NFT itself left (the data layer reads it from the NFT's own Transfer log). In a
  // smart-account sale tx.from is a bundler and the WETH may go to another address, so this is the
  // only field that is always the holder who gave the token up. Older fills may not carry it.
  const nftFrom = addr(fill.nftFrom);

  for (const [role, who] of [['seller', seller], ['fulfiller', fulfiller], ['nftFrom', nftFrom]]) {
    if (!who) {
      if (role !== 'nftFrom') findings.push({ code: `${role}-unknown`, detail: `the fill names no ${role}` });
      continue;
    }
    if (sets.people.has(who)) integrity.push({ reason: 'insider-fill', detail: `the ${role} ${who} is an insider` });
    if (sets.contracts.has(who)) integrity.push({ reason: 'venue-contract-fill', detail: `the ${role} ${who} is a venue contract` });
    if (sets.house.has(who)) integrity.push({ reason: 'house-fill', detail: `the ${role} ${who} is a house wallet` });
  }

  if (!skip.includes('provenance')) {
    try {
      const since = nowSec - provenanceDays * DAY;
      // Only the token's past up to this fill: where the house sends it afterwards (back to the
      // funding wallet) is the house's own doing, not who sold it.
      const until = toSec(fill.time);
      const moves = await chain.tokenProvenance(fill.slug, fill.tokenId, { sinceDays: provenanceDays });
      for (const m of moves) {
        const t = toSec(m.time);
        if (t !== null && t < since) continue;
        if (t !== null && until !== null && t > until) continue;
        for (const side of ['from', 'to']) {
          const a = addr(m[side]);
          if (!a) continue;
          if (sets.people.has(a)) integrity.push({ reason: 'insider-provenance', detail: `token ${fill.tokenId} passed through insider ${a} in the last ${provenanceDays} days (tx ${m.txHash})` });
          // Venue contracts hold ordinary holders' tokens (staking, loans), so passing through one
          // is a note for a person, not a halt.
          else if (sets.contracts.has(a)) findings.push({ code: 'venue-contract-provenance', detail: `token ${fill.tokenId} passed through venue contract ${a} (tx ${m.txHash})` });
          else if (sets.house.has(a) && String(m.txHash).toLowerCase() !== String(fill.txHash).toLowerCase()) {
            findings.push({ code: 'house-in-provenance', detail: `token ${fill.tokenId} was the house's before (tx ${m.txHash})` });
          }
        }
      }
      passed.push('provenance');
    } catch (e) {
      pending.push('provenance');
      findings.push({ code: 'provenance-unread', detail: `token history not read: ${e?.message ?? e}` });
    }
  }

  if (!skip.includes('code') && seller) {
    try {
      const code = String(await chain.code(seller)).toLowerCase();
      if (code.startsWith('0xef0100')) findings.push({ code: 'seller-7702', detail: `the seller ${seller} has an EIP-7702 delegation to 0x${code.slice(8, 48)}` });
      else if (code !== '0x' && code !== '') findings.push({ code: 'seller-contract', detail: `the seller ${seller} is a contract` });
      passed.push('code');
    } catch (e) {
      pending.push('code');
      findings.push({ code: 'code-unread', detail: `the seller's code not read: ${e?.message ?? e}` });
    }
  }

  if (!skip.includes('item')) {
    try {
      const contract = COLLECTIONS[fill.slug]?.address;
      const item = await opensea.item(contract, fill.tokenId);
      if (item.isDisabled === true || item.isSuspicious === true) {
        stolen = true;
        integrity.push({ reason: 'flagged-item', detail: `OpenSea flags token ${fill.tokenId} (${item.isDisabled ? 'disabled' : 'suspicious'}): quarantined, never resold` });
      }
      passed.push('item');
    } catch (e) {
      pending.push('item');
      findings.push({ code: 'item-unread', detail: `OpenSea's item flags not read: ${e?.message ?? e}` });
    }
  }

  const review = findings.some((f) => !f.code.endsWith('-unread'));
  const verdict = integrity.length ? 'halt' : review ? 'review' : 'ok';
  return { verdict, integrity, findings, pending, passed, stolen };
}
