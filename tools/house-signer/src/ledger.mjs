// The signer's two append-only files in the keys folder.
//
//   signer-audit.jsonl   one line per request received and one per decision (with the
//                        refusal reason, or the order/transaction hash). Never a key, a
//                        password or an endpoint URL.
//   signer-orders.jsonl  one line per order signed: hash, collection, quantity, unit price,
//                        expiry and the full parameters. signCancel and cancelOnChain only
//                        ever act on hashes found here, and an on-chain cancel is built
//                        from the parameters stored here, never from the bot's copy.
//
// Written with appendFileSync so a line is on disk before the signer answers.

import fs from 'node:fs';
import path from 'node:path';
import { hashOrderComponents } from './eip712.mjs';
import { fromJsonParameters } from './order.mjs';
import { eqAddr } from './hex.mjs';

export const AUDIT_FILE = 'signer-audit.jsonl';
export const ORDERS_FILE = 'signer-orders.jsonl';

export function openLedger(keysDir, { now = () => Date.now() } = {}) {
  const auditPath = path.join(keysDir, AUDIT_FILE);
  const ordersPath = path.join(keysDir, ORDERS_FILE);
  const append = (file, obj) => fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
  const stamp = () => new Date(now()).toISOString();

  return {
    auditPath,
    ordersPath,
    /** Throws if the line cannot be written; the caller decides what that blocks. */
    audit(entry) {
      append(auditPath, { t: stamp(), ...entry });
    },
    recordOrder(record) {
      append(ordersPath, { t: stamp(), ...record });
    },
    /**
     * Every order this house signed, keyed by lowercase order hash. A line whose stored
     * parameters do not hash to its recorded hash, or whose offerer is not the house, is
     * skipped and counted: an edited ledger can only lose orders, never add one.
     */
    loadOrders(house) {
      const orders = new Map();
      let skipped = 0;
      if (!fs.existsSync(ordersPath)) return { orders, skipped };
      for (const line of fs.readFileSync(ordersPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          const components = fromJsonParameters(rec.parameters);
          const hash = hashOrderComponents(components);
          if (hash !== String(rec.orderHash).toLowerCase() || !eqAddr(components.offerer, house)) {
            skipped++;
            continue;
          }
          orders.set(hash, { orderHash: hash, slug: rec.slug, qty: rec.qty, unitPriceWei: rec.unitPriceWei, endTime: rec.endTime, components });
        } catch {
          skipped++;
        }
      }
      return { orders, skipped };
    },
  };
}
